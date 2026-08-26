/**
 * Voz en el navegador (§9.4).
 * La voz usa el gateway de la instancia: si la aplicación abre, la voz tiene el
 * mismo camino y no exige STUN, TURN ni puertos adicionales. El vídeo puede ir
 * por la instancia o directo con WebRTC, según lo que elija quien hospeda.
 *
 * Quién ofrece y quién responde se decide comparando ids, no por orden de
 * llegada: si los dos ofrecen a la vez, la negociación se rompe (glare).
 */
import type { Snowflake, VideoSource, VoiceAction, VoiceSoundRejectReason } from "@distop/protocol";
import { onMedia, sendMedia, sendCommand } from "./gateway.ts";
import * as relay from "./relay.ts";
import { playUi } from "./notify.ts";

export interface VoiceLocalState {
  channelId: Snowflake | null;
  /** Lo que ha pedido quien está delante. No es el estado real: ver `forcedMuted`. */
  muted: boolean;
  deafened: boolean;
  /**
   * Callado o ensordecido por la instancia, no por uno mismo: moderación (§11) o
   * entrar sin permiso de hablar.
   * Va aparte de `muted`/`deafened` porque si se mezclaran, al devolverte la voz
   * un moderador el cliente creería que el silencio fue decisión tuya y volvería
   * a callarte solo.
   */
  forcedMuted: boolean;
  forcedDeafened: boolean;
  /** Quién está hablando ahora mismo, yo incluida. */
  speaking: Set<Snowflake>;
  /** Qué estoy publicando: cámara, pantalla o nada. */
  video: VideoSource | null;
  /** Mi propio vídeo, para verme sin esperar a que vuelva de la red. */
  localVideo: MediaStream | null;
  /** Vídeo que llega de cada par. Existe aunque esté apagado: la pista se reserva al conectar. */
  videos: Map<Snowflake, MediaStream>;
  /** Fluidez medida de lo que estoy enviando, o null si aún no hay medida. */
  videoFps: number | null;
  /** ¿La pantalla que comparto trae sonido? Si no, el botón de silenciarlo sobra. */
  shareAudio: boolean;
  /** Sonido de la pantalla apagado, sin tocar el micrófono. */
  shareMuted: boolean;
  /**
   * Estado real de la conexión con cada par.
   * Sin esto, "no se ve tu vídeo" y "no hay conexión con esa persona" se
   * parecen demasiado desde la interfaz, y se depura a ciegas.
   */
  peerStates: Map<Snowflake, RTCPeerConnectionState>;
  /** ¿Llegó a descubrirse la dirección pública? Distingue "falta STUN" de "hace falta TURN". */
  reflexive: boolean;
  /**
   * Por dónde va la llamada de verdad: en directo entre los dos aparatos, o
   * reenviada por un relevo porque las dos redes no se dejaban conectar.
   * Se enseña siempre: que la conversación pase por un tercero no es un detalle
   * que se pueda callar, aunque vaya cifrada.
   */
  route: "direct" | "relay" | null;
  error: string | null;
  videoError: string | null;
  /** Fallo visible de la última acción de la tabla de sonidos. */
  soundError: VoiceSoundIssue | null;
  /**
   * La sala en la que estoy es una reunión con turno de palabra.
   *
   * Va aquí y no en el store porque el gate del micrófono se decide en este
   * módulo: si viviera solo en React, un repintado tardío dejaría el micrófono
   * abierto un rato después de que la reunión pasara a modo turno.
   */
  pushToTalk: boolean;
  /** Estoy pulsando para hablar ahora mismo. */
  holdingFloor: boolean;
}

export type VoiceSoundIssue = VoiceSoundRejectReason | Exclude<relay.ClipPlaybackIssue, "deafened">;

type Listener = (state: VoiceLocalState) => void;

const state: VoiceLocalState = {
  channelId: null,
  muted: false,
  deafened: false,
  forcedMuted: false,
  forcedDeafened: false,
  speaking: new Set(),
  video: null,
  localVideo: null,
  videos: new Map(),
  videoFps: null,
  shareAudio: false,
  shareMuted: false,
  peerStates: new Map(),
  reflexive: false,
  route: null,
  error: null,
  videoError: null,
  soundError: null,
  pushToTalk: false,
  holdingFloor: false,
};
const listeners = new Set<Listener>();

let selfId: Snowflake = "";
let iceServers: RTCIceServer[] = [];
let localStream: MediaStream | null = null;
let videoStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;

interface Peer {
  connection: RTCPeerConnection;
  /**
   * Por dónde sale mi vídeo hacia este par.
   * Lo crea quien ofrece; quien responde lo recibe ya hecho al aplicar la oferta
   * (ver handleSignal), y hasta entonces es null.
   */
  videoSender: RTCRtpSender | null;
  /** Candidatos que llegaron antes que la descripción remota (ver handleSignal). */
  pending: RTCIceCandidateInit[];
  /**
   * Cuándo entró esta persona a la sala, según el servidor.
   * Es lo que distingue "sigue ahí" de "recargó y ahora es otro navegador": el id
   * de usuario no cambia al recargar, así que sin esto la conexión se queda
   * apuntando a una pestaña que ya no existe.
   */
  joinedAt: number;
  /** Reintentos de ICE gastados. Se reinicia en cuanto la conexión se establece. */
  attempts: number;
  retryTimer?: number | undefined;
  analyser?: AnalyserNode;
}
const peers = new Map<Snowflake, Peer>();
/** Última hora de entrada conocida de cada quien, para no reconstruir un par recién hecho. */
const roster = new Map<Snowflake, number>();

function snapshot(): VoiceLocalState {
  return {
    ...state,
    speaking: new Set(state.speaking),
    videos: new Map(state.videos),
    peerStates: new Map(state.peerStates),
  };
}

function emit(): void {
  for (const listener of listeners) listener(snapshot());
}

/** El estado actual, para quien se monte con la llamada ya empezada. */
export function voiceSnapshot(): VoiceLocalState {
  return snapshot();
}

export function onVoice(listener: Listener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function configureVoice(userId: Snowflake, servers: RTCIceServer[]): void {
  selfId = userId;
  iceServers = servers;
}

/** Cambiar el relevo desde Ajustes tiene que valer para la siguiente llamada, sin recargar. */
export function setIceServers(servers: RTCIceServer[]): void {
  iceServers = servers;
}

/**
 * Por dónde va la imagen, según lo que diga la instancia.
 * Con "host" no se abre ninguna conexión directa con nadie: ni para hablar ni
 * para ver. Es lo que hace que funcione en redes donde el P2P simplemente no.
 */
let videoViaHost = true;

export function setVideoMode(mode: "host" | "direct"): void {
  videoViaHost = mode !== "direct";
}

/** Silencia el sonido de la pantalla compartida sin tocar el micrófono. */
export function setShareMuted(muted: boolean): void {
  state.shareMuted = muted;
  relay.setShareMuted(muted);
  emit();
}

/**
 * Diagnóstico de red, sin llamar a nadie (§26).
 * Levanta una conexión de mentira solo para ver qué caminos encuentra el
 * navegador. Es la diferencia entre "no se ve nada" y saber exactamente qué
 * falta, y es lo único que detecta a tiempo un relevo que está apuntado pero
 * caído — que se comporta igual que no tener ninguno.
 */
export async function probeNetwork(servers: RTCIceServer[]): Promise<{ host: boolean; stun: boolean; relay: boolean }> {
  const connection = new RTCPeerConnection({ iceServers: servers });
  const seen = new Set<string>();

  connection.onicecandidate = (event) => {
    if (event.candidate?.type) seen.add(event.candidate.type);
  };
  // Sin nada que transmitir no se recogen candidatos: un canal de datos basta.
  connection.createDataChannel("probe");
  await connection.setLocalDescription(await connection.createOffer());

  await new Promise((done) => {
    const timer = setTimeout(done, 8000);
    connection.onicegatheringstatechange = () => {
      if (connection.iceGatheringState === "complete") {
        clearTimeout(timer);
        done(null);
      }
    };
  });
  connection.close();

  return { host: seen.has("host"), stun: seen.has("srflx"), relay: seen.has("relay") };
}

/* ── quién habla ───────────────────────────────────────────────────────
   Un medidor de volumen sencillo sobre el análisis de frecuencias. No es
   detección de voz de verdad (no distingue voz de un portazo), pero es lo que
   hace que la interfaz se sienta viva y no cuesta ni una dependencia. */

const SPEAKING_THRESHOLD = 18;

function watchLevel(id: Snowflake, stream: MediaStream): AnalyserNode | undefined {
  try {
    audioContext ??= new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    return analyser;
  } catch {
    return undefined;
  }
}

const meters = new Map<Snowflake, AnalyserNode>();
let meterTimer: number | undefined;

/** Volumen a partir del cual se considera que alguien está hablando, ya decodificado. */
const REMOTE_THRESHOLD = 0.02;

function pollLevels(): void {
  let changed = false;
  const buffer = new Uint8Array(256);

  const mark = (id: Snowflake, active: boolean): void => {
    if (active === state.speaking.has(id)) return;
    if (active) state.speaking.add(id);
    else state.speaking.delete(id);
    changed = true;
  };

  // El micrófono propio se mide del grafo de audio, antes de codificar.
  for (const [id, analyser] of meters) {
    analyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (const value of buffer) sum += value;
    /* Quien está en silencio no "habla" aunque su micro capte algo. Y el nivel
       propio se pesa con el volumen del micrófono: con el mando a cero se envía
       silencio, así que enseñar el aro de "hablando" sería mentir. */
    const level = (sum / buffer.length) * (id === selfId ? relay.micVolume() : 1);
    mark(id, level > SPEAKING_THRESHOLD && !(id === selfId && !sendingNow()));
  }

  /* El de los demás sale de lo que ya se decodificó para reproducirlo: no hay
     que analizar nada aparte. Si alguien deja de mandar, su nivel se queda
     congelado, así que se va apagando solo. */
  for (const [id, level] of relay.levels) {
    mark(id, level > REMOTE_THRESHOLD);
    relay.levels.set(id, level * 0.6);
  }

  if (changed) emit();
}

/* ── conexiones ────────────────────────────────────────────────────── */

function createPeer(remoteId: Snowflake, joinedAt = 0): Peer {
  const connection = new RTCPeerConnection({ iceServers });

  /* Aquí ya NO va el audio: eso pasa por la instancia (ver lib/audio.ts). Esta
     conexión solo existe para el vídeo y la pantalla, y solo se crea cuando
     alguno de los dos lados los enciende. Mientras se hable y ya está, no hay
     ninguna conexión directa que negociar, así que no hay nada que pueda fallar. */

  /* El hueco de vídeo se negocia al conectar aunque nadie tenga la cámara puesta:
     encenderla después es solo `replaceTrack`, sin renegociar, que es donde una
     malla sin SFU se rompe.

     Pero solo lo crea quien ofrece. Al aplicar una oferta, el navegador NO
     reutiliza un transceptor creado a mano con addTransceiver: fabrica uno nuevo
     para esa línea, en recvonly. El transceptor propio se quedaba suelto, sin
     línea en el SDP, y su `replaceTrack` funcionaba sin enviar nada a ninguna
     parte: la cámara se veía en local y el otro lado solo veía negro. */
  const videoTransceiver = shouldOffer(remoteId)
    ? connection.addTransceiver("video", { direction: "sendrecv" })
    : null;
  if (videoTransceiver) preferVideoCodecs(videoTransceiver);
  const videoSender = videoTransceiver?.sender ?? null;

  // Quien llega tarde a la sala tiene que recibir el vídeo ya encendido, y con
  // los mismos ajustes de fluidez que el resto.
  const localTrack = videoStream?.getVideoTracks()[0];
  const source = state.video;
  if (videoSender && localTrack && source) {
    void videoSender.replaceTrack(localTrack).then(() => tuneSender(videoSender, source));
  }

  connection.ontrack = (event) => {
    // El vídeo llega por `replaceTrack`, que no arrastra el MediaStream de origen:
    // hay que envolver la pista aquí. La pista es estable, así que este stream
    // vale para toda la llamada aunque el par cambie de cámara a pantalla.
    if (event.track.kind !== "video") return;
    state.videos.set(remoteId, new MediaStream([event.track]));
    emit();
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.channelId) return;
    /* Si el STUN funciona, el navegador descubre su dirección pública y aparece
       un candidato "srflx". Sin ninguno, el fallo es que no hay STUN; con ellos
       y aun así sin conexión, el problema es un NAT que exige TURN. Distinguirlo
       cambia por completo el consejo que se le da a quien hospeda. */
    if (event.candidate.type === "srflx" || event.candidate.type === "prflx") state.reflexive = true;
    sendCommand({
      t: "VOICE_SIGNAL",
      d: { channel_id: state.channelId, to_user_id: remoteId, payload: { candidate: event.candidate } },
    });
  };

  connection.onconnectionstatechange = () => {
    const status = connection.connectionState;
    state.peerStates.set(remoteId, status);
    emit();

    /* Antes, un "failed" borraba el par entero. Eso hacía dos daños a la vez:
       la conexión no volvía nunca (nadie la reconstruía) y el aviso que explica
       QUÉ falta —STUN o relevo— se borraba en el mismo instante, porque se pinta
       a partir de este estado. Ahora el fallo se queda a la vista y se reintenta. */
    if (status === "failed") retryPeer(remoteId);
    if (status === "closed") dropPeer(remoteId);
    if (status === "connected") {
      const peer = peers.get(remoteId);
      if (peer) peer.attempts = 0;
    }
  };

  const peer: Peer = { connection, videoSender, pending: [], joinedAt, attempts: 0 };
  peers.set(remoteId, peer);
  return peer;
}

/**
 * Volver a intentarlo cuando ICE se rinde.
 * Una red móvil que cambia de antena, un wifi que salta de banda o un router que
 * cierra el agujero rompen la conexión sin que nadie se haya ido de la llamada.
 * Reintentar es lo que hace la diferencia entre "se cortó" y "hay que salir y
 * volver a entrar" — que es lo que había antes.
 *
 * Reofrece solo quien ofrece, igual que en la negociación inicial: si los dos
 * reintentan a la vez, se pisan.
 */
const MAX_RETRIES = 4;

function retryPeer(remoteId: Snowflake): void {
  const peer = peers.get(remoteId);
  if (!peer || peer.retryTimer || !state.channelId) return;
  // Agotados los intentos se deja en "failed" a propósito: el aviso de la
  // interfaz dice qué falta, y seguir reintentando en bucle no lo arregla.
  if (peer.attempts >= MAX_RETRIES || !shouldOffer(remoteId)) return;

  const wait = 1000 * 2 ** peer.attempts++;
  peer.retryTimer = window.setTimeout(() => {
    peer.retryTimer = undefined;
    void (async () => {
      try {
        const offer = await peer.connection.createOffer({ iceRestart: true });
        await peer.connection.setLocalDescription(offer);
        sendCommand({
          t: "VOICE_SIGNAL",
          d: { channel_id: state.channelId!, to_user_id: remoteId, payload: { sdp: offer } },
        });
      } catch {
        // Conexión ya cerrada mientras esperaba: no hay nada que reintentar.
      }
    })();
  }, wait);
}

function dropPeer(remoteId: Snowflake): void {
  const peer = peers.get(remoteId);
  if (!peer) return;
  clearTimeout(peer.retryTimer);
  peer.connection.onconnectionstatechange = null;
  peer.connection.close();
  peers.delete(remoteId);
  state.videos.delete(remoteId);
  state.peerStates.delete(remoteId);
  emit();
}

/** El id mayor ofrece: regla estable que evita que los dos lados ofrezcan a la vez. */
function shouldOffer(remoteId: Snowflake): boolean {
  return selfId > remoteId;
}

export interface PeerInfo {
  user_id: Snowflake;
  joined_at: number;
  video: VideoSource | null;
  muted?: boolean;
  deafened?: boolean;
}

/**
 * Lo que la instancia dice de uno mismo (§11).
 *
 * Manda ella: puede callar a quien no tiene permiso de hablar o a quien moderó
 * alguien, y el cliente debe reflejarlo en vez de enseñar un micrófono abierto
 * que no sale de la máquina. La diferencia en el otro sentido —ella cree que
 * hablas y tú te has callado— es un mensaje perdido o un moderador devolviendo
 * la voz: se reenvía la intención local.
 *
 * No se toca `state.muted`: es la intención de quien está delante, y machacarla
 * con el eco de la instancia hace parpadear el botón en cada actualización.
 */
function reconcileSelf(self: PeerInfo): void {
  const serverMuted = Boolean(self.muted);
  const serverDeafened = Boolean(self.deafened);

  const forcedMuted = serverMuted && !state.muted;
  const forcedDeafened = serverDeafened && !state.deafened;
  if (forcedMuted !== state.forcedMuted || forcedDeafened !== state.forcedDeafened) {
    state.forcedMuted = forcedMuted;
    state.forcedDeafened = forcedDeafened;
    applyOutput();
    if (effectiveMuted()) state.speaking.delete(selfId);
    emit();
  }

  /* Solo se reenvía cuando lo local es MÁS restrictivo. Al revés sería pelearse
     con la instancia —que calla a quien no puede hablar— y el mensaje daría la
     vuelta para siempre. */
  if ((state.muted && !serverMuted) || (state.deafened && !serverDeafened)) pushVoiceState();
}

/** Última foto de la sala, para rehacer las conexiones al encender la cámara. */
let lastRoom: { channelId: Snowflake; participants: PeerInfo[] } | null = null;

export async function syncPeers(channelId: Snowflake, participants: PeerInfo[]): Promise<void> {
  if (state.channelId !== channelId) return;
  lastRoom = { channelId, participants };

  const self = participants.find((p) => p.user_id === selfId);
  if (self) reconcileSelf(self);

  const others = participants.filter((p) => p.user_id !== selfId);
  roster.clear();
  for (const p of others) roster.set(p.user_id, p.joined_at);

  // Quien se fue o apagó la cámara deja de necesitar decodificador: si no, se
  // queda un fotograma congelado y un proceso trabajando para nadie.
  const emitiendo = new Set(others.filter((p) => p.video !== null).map((p) => p.user_id));
  for (const id of [...state.videos.keys()]) {
    if (emitiendo.has(id) || id === selfId) continue;
    relay.dropVideo(id);
    state.videos.delete(id);
  }

  /* Solo hay conexión directa con quien tenga vídeo de por medio, y solo si la
     instancia dice que el vídeo va directo. Si va por ella, aquí no se negocia
     nada con nadie: una conexión que no transporta nada solo puede fallar. */
  const needed = new Map(
    videoViaHost
      ? []
      : others.filter((p) => state.video !== null || p.video !== null).map((p) => [p.user_id, p] as const),
  );
  for (const id of [...peers.keys()]) if (!needed.has(id)) dropPeer(id);

  for (const { user_id: remoteId, joined_at: joinedAt } of needed.values()) {
    const existing = peers.get(remoteId);
    // Mismo id, otra entrada a la sala = otra pestaña. La conexión anterior apunta
    // a un navegador que ya no está: hay que tirarla y empezar de cero, o esa
    // persona se queda en "conectando" hasta que alguien salga de la llamada.
    if (existing && existing.joinedAt === joinedAt) continue;
    if (existing) dropPeer(remoteId);

    const peer = createPeer(remoteId, joinedAt);
    if (!shouldOffer(remoteId)) continue;

    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    sendCommand({ t: "VOICE_SIGNAL", d: { channel_id: channelId, to_user_id: remoteId, payload: { sdp: offer } } });
  }
}

/**
 * Reconexión del gateway (§28.1).
 * Perder el socket no tira la llamada —WebRTC va por su cuenta— pero sí deja al
 * servidor creyendo que te fuiste, y a la otra persona hablando con una conexión
 * que puede estar muerta. Al volver se anuncia la entrada otra vez y se rehacen
 * todas las conexiones: es lo único simétrico, porque el resto también verá que
 * tu hora de entrada cambió y hará lo mismo.
 */
export function resumeVoice(): void {
  if (!state.channelId) return;
  for (const id of [...peers.keys()]) dropPeer(id);
  sendCommand({ t: "VOICE_JOIN", d: { channel_id: state.channelId } });
  pushVoiceState();
  if (state.video) sendCommand({ t: "VOICE_VIDEO", d: { channel_id: state.channelId, source: state.video } });
}

export async function handleSignal(from: Snowflake, payload: unknown): Promise<void> {
  if (!state.channelId || !payload || typeof payload !== "object") return;
  const message = payload as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  const peer = peers.get(from) ?? createPeer(from, roster.get(from) ?? 0);

  if (message.sdp) {
    await peer.connection.setRemoteDescription(message.sdp);

    if (message.sdp.type === "offer") {
      /* La línea de vídeo la trae la oferta y el navegador la deja en recvonly:
         solo para recibir. Ponerla en sendrecv ANTES de responder es lo que hace
         que la respuesta anuncie que este lado también manda vídeo. Sin esto,
         quien responde nunca transmitía y el otro veía un recuadro negro. */
      const videoTransceiver = peer.connection.getTransceivers().find((t) => t.receiver.track?.kind === "video");
      if (videoTransceiver) {
        videoTransceiver.direction = "sendrecv";
        peer.videoSender = videoTransceiver.sender;

        const track = videoStream?.getVideoTracks()[0];
        if (track && state.video) {
          await peer.videoSender.replaceTrack(track);
          await tuneSender(peer.videoSender, state.video);
        }
      }

      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      sendCommand({ t: "VOICE_SIGNAL", d: { channel_id: state.channelId, to_user_id: from, payload: { sdp: answer } } });
    }

    // Lo que llegó antes de tiempo, ahora sí entra.
    for (const early of peer.pending.splice(0)) {
      await peer.connection.addIceCandidate(early).catch(() => {});
    }
    return;
  }

  if (message.candidate) {
    /* Un candidato solo se puede añadir DESPUÉS de conocer la descripción
       remota; antes, el navegador lo rechaza. En la misma máquina la respuesta
       llega tan rápido que nunca se notaba, pero entre un móvil y un PC por un
       túnel el orden se invierte con facilidad: los candidatos se perdían en
       silencio —el catch se los tragaba— y la llamada se quedaba "conectando"
       para siempre. Por eso ahora esperan en cola en vez de desaparecer. */
    if (!peer.connection.remoteDescription) {
      peer.pending.push(message.candidate);
      return;
    }
    try {
      await peer.connection.addIceCandidate(message.candidate);
    } catch {
      // Candidato tardío tras cerrar la conexión: no es un fallo que contar.
    }
  }
}

/* ── micrófono elegido (§10.2) ─────────────────────────────────────────
   Qué aparato se usa es de este equipo, no de la cuenta: los cascos están
   enchufados aquí. Por eso se guarda en el navegador y no viaja a la instancia. */

let micDevice = localStorage.getItem("distop.micDevice") ?? "";

export type InputProfile = "custom" | "clear" | "natural";

function savedInputProfile(): InputProfile {
  const saved = localStorage.getItem("distop.inputProfile");
  return saved === "clear" || saved === "natural" ? saved : "custom";
}

let micProfile = savedInputProfile();

export function inputDevice(): string {
  return micDevice;
}

export function inputProfile(): InputProfile {
  return micProfile;
}

function micConstraints(): MediaTrackConstraints {
  const processing: MediaTrackConstraints =
    micProfile === "clear"
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : micProfile === "natural"
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : {};

  return {
    ...processing,
    /* `ideal` y no `exact`: si el aparato elegido ya no está —unos cascos USB
       desenchufados— se entra con el que haya en vez de quedarse sin llamada. */
    ...(micDevice ? { deviceId: { ideal: micDevice } } : {}),
  };
}

/**
 * Cambiar de micrófono en mitad de una llamada.
 * Se pide el nuevo ANTES de soltar el viejo: si el navegador lo niega, la
 * llamada sigue con el que había en vez de quedarse muda.
 */
export async function setInputDevice(id: string): Promise<void> {
  micDevice = id;
  localStorage.setItem("distop.micDevice", id);
  await refreshInput();
}

/** El perfil también cambia en caliente y, como el aparato, solo vive en este PC. */
export async function setInputProfile(profile: InputProfile): Promise<void> {
  micProfile = profile;
  localStorage.setItem("distop.inputProfile", profile);
  await refreshInput();
}

async function refreshInput(): Promise<void> {
  if (!state.channelId) return;

  let next: MediaStream;
  try {
    next = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  } catch (err) {
    state.error = err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "nodevice";
    emit();
    return;
  }

  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = next;
  const analyser = watchLevel(selfId, next);
  if (analyser) meters.set(selfId, analyser);

  state.error = null;
  if (!(await relay.startCapture(next, sendMedia))) state.error = "unsupported";
  // Volver a capturar tira el sonido de la pantalla compartida: se reengancha.
  if (state.video === "screen") relay.setShareAudio(videoStream);
  emit();
}

/* ── entrar y salir ────────────────────────────────────────────────── */

export async function joinVoice(channelId: Snowflake): Promise<boolean> {
  if (state.channelId === channelId) return true;
  // Cambiar de canal es una sola transición: no encadenamos “colgar” y
  // “conectar”, que sonaría como si la llamada hubiera fallado.
  if (state.channelId) disconnectVoice(false);

  state.error = null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(), video: false });
  } catch (err) {
    // Sin micrófono no hay llamada, y el motivo importa: permiso denegado y
    // "no hay dispositivo" se arreglan de formas distintas.
    state.error = err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "nodevice";
    emit();
    return false;
  }

  state.channelId = channelId;
  const analyser = watchLevel(selfId, localStream);
  if (analyser) meters.set(selfId, analyser);
  meterTimer ??= window.setInterval(pollLevels, 180);
  watchStats(true);

  /* La voz sube a la instancia y ella la reparte. Se engancha aquí, después de
     tener el micrófono: pulsar "entrar" es el gesto que el navegador exige para
     dejar sonar nada, y de paso arranca el reloj del audio. */
  onMedia((id, kind, payload) => relay.receive(id, kind, payload));
  relay.onVideoStream((id, stream) => {
    state.videos.set(id, stream);
    emit();
  });
  applyOutput();
  if (!(await relay.startCapture(localStream, sendMedia))) state.error = "unsupported";

  sendCommand({ t: "VOICE_JOIN", d: { channel_id: channelId } });
  /* Callarse o ensordecerse se puede hacer desde la barra de usuario ANTES de
     entrar. Sin esto se llegaba a la sala con el micro cerrado en el navegador
     pero abierto para la instancia, y el resto hablaba creyendo que oías. */
  pushVoiceState();
  emit();
  playUi("voice_join");
  return true;
}

function disconnectVoice(announce: boolean): void {
  const wasConnected = state.channelId !== null;
  if (state.channelId) sendCommand({ t: "VOICE_LEAVE", d: { channel_id: state.channelId } });

  for (const id of [...peers.keys()]) dropPeer(id);
  onMedia(null);
  relay.onVideoStream(null);
  relay.stopCapture();
  relay.stopVideo();
  relay.dropAll();
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;
  stopLocalVideo();
  watchStats(false);

  meters.clear();
  roster.clear();
  lastRoom = null;
  state.speaking.clear();
  state.videos.clear();
  state.peerStates.clear();
  state.channelId = null;
  state.muted = false;
  state.deafened = false;
  state.forcedMuted = false;
  state.forcedDeafened = false;
  state.video = null;
  state.videoError = null;
  state.soundError = null;
  /* El modo turno es de la sala que se deja, no de la persona: quedárselo
     puesto cerraría el micrófono en la siguiente sala, que puede no tenerlo. */
  state.pushToTalk = false;
  state.holdingFloor = false;

  if (meterTimer) {
    clearInterval(meterTimer);
    meterTimer = undefined;
  }
  emit();
  if (announce && wasConnected) playUi("voice_leave");
}

export function leaveVoice(): void {
  disconnectVoice(true);
}

/**
 * Dispara un sonido de la tabla para toda la sala (§9.4).
 *
 * No suena aquí mismo: se manda el id y se espera el eco del servidor, que
 * vuelve a todos —incluido quien pulsa— por el mismo camino. Sonarlo en local
 * al pulsar habría sido una línea menos y una mentira: quien lo dispara lo
 * oiría antes que los demás, y seguiría oyéndolo cuando el servidor lo descarta
 * por estar silenciado o por pasarse del límite.
 */
export function playSound(soundId: Snowflake): void {
  if (!state.channelId) return;
  if (effectiveMuted()) {
    setSoundError("muted");
    return;
  }
  setSoundError(null);
  sendCommand({ t: "VOICE_SOUND", d: { channel_id: state.channelId, sound_id: soundId } });
}

export function setSoundError(error: VoiceSoundIssue | null): void {
  if (state.soundError === error) return;
  state.soundError = error;
  emit();
}

/** ¿Sale mi voz de verdad? Lo que impone la instancia cuenta igual que el botón. */
function effectiveMuted(): boolean {
  return state.muted || state.forcedMuted;
}

/** ¿Oigo la sala de verdad? */
function effectiveDeafened(): boolean {
  return state.deafened || state.forcedDeafened;
}

/**
 * El estado de voz es UNO y viaja entero.
 *
 * Mandar solo la bandera que cambiaba era el fallo: al quitarse el
 * ensordecimiento no se enviaba nada, la instancia seguía creyéndote sordo y
 * dejaba de reenviarte audio —para siempre, hasta salir de la llamada— mientras
 * la interfaz ya decía que oías.
 */
function pushVoiceState(): void {
  if (!state.channelId) return;
  sendCommand({
    t: "VOICE_MUTE",
    d: { channel_id: state.channelId, muted: state.muted, deafened: state.deafened },
  });
}

/**
 * ¿Está saliendo mi voz de verdad, ahora mismo?
 *
 * Tres cosas la cierran y ninguna sustituye a las otras: el botón de silencio,
 * lo que impuso la instancia, y —en una reunión con turno— no tener la palabra.
 */
function sendingNow(): boolean {
  return !effectiveMuted() && (!state.pushToTalk || state.holdingFloor);
}

/** Micrófono y altavoces siguen al estado real, no solo a la propia intención. */
function applyOutput(): void {
  relay.setSending(sendingNow());
  relay.setDeafened(effectiveDeafened());
}

/**
 * Entrar o salir del modo turno de palabra.
 *
 * Lo llama la interfaz de la reunión al recibir la reunión y en cada
 * `MEETING_UPDATE`: `push_to_talk` puede encenderse a mitad de reunión, y en
 * ese instante el micrófono tiene que cerrarse sin esperar a nada más.
 */
export function setPushToTalkMode(on: boolean): void {
  if (state.pushToTalk === on) return;
  state.pushToTalk = on;
  /* Al entrar en modo turno no se conserva la palabra: si la tuviera guardada
     de antes, encender el modo dejaría a esa persona hablando sola por defecto. */
  if (on) state.holdingFloor = false;
  applyOutput();
  if (!sendingNow()) state.speaking.delete(selfId);
  emit();
}

/**
 * Pedir o soltar la palabra.
 *
 * El corte de verdad lo hace la instancia en `relayMedia`: aquí solo se cierra
 * el envío para no gastar subida en algo que va a descartarse, y para que el
 * aro de "hablando" no se encienda cuando no me oye nadie. Quién tiene la
 * palabra lo dice el servidor por `MEETING_FLOOR`, no esta bandera.
 *
 * No pasa por `setMuted`: ese camino desensordece, manda un `VOICE_MUTE` por el
 * socket y suena un pitido — tres cosas insoportables al ritmo de una tecla.
 */
export function holdFloor(hold: boolean): void {
  if (!state.channelId || state.holdingFloor === hold) return;
  state.holdingFloor = hold;
  applyOutput();
  if (!sendingNow()) state.speaking.delete(selfId);
  sendCommand({ t: "MEETING_FLOOR", d: { channel_id: state.channelId, hold } });
  emit();
}

/** Levantar o bajar la mano. La cola la ordena la instancia por hora de llegada. */
export function raiseHand(raised: boolean): void {
  if (!state.channelId) return;
  sendCommand({ t: "MEETING_HAND", d: { channel_id: state.channelId, raised } });
}

function updateMuted(muted: boolean, announce: boolean): void {
  const changed = state.muted !== muted || (!muted && state.deafened);
  if (!changed) return;
  state.muted = muted;
  /* Quitarse el silencio es también dejar de estar sordo: la instancia obliga a
     que quien no oye tampoco hable, así que "hablando y ensordecido" no existe.
     Sin esto el botón se encendía, el micrófono capturaba, y la instancia tiraba
     cada paquete: quien lo pulsaba creía estar hablando y no le oía nadie. */
  if (!muted && state.deafened) state.deafened = false;
  applyOutput();
  if (effectiveMuted()) state.speaking.delete(selfId);
  pushVoiceState();
  emit();
  if (announce) playUi(muted ? "mute_on" : "mute_off");
}

export function setMuted(muted: boolean): void {
  updateMuted(muted, true);
}

export function setDeafened(deafened: boolean): void {
  if (state.deafened === deafened) return;
  state.deafened = deafened;
  // Ensordecer implica callar: si no oyes a nadie, hablar es de mala educación.
  if (deafened) {
    // Es una sola intención y por eso tiene una única confirmación sonora.
    if (state.muted) {
      applyOutput();
      pushVoiceState();
      emit();
    } else updateMuted(true, false);
    playUi("deafen_on");
    return;
  }
  applyOutput();
  pushVoiceState();
  emit();
  playUi("deafen_off");
}

export function currentChannel(): Snowflake | null {
  return state.channelId;
}

/* ── vídeo y pantalla (§9.5) ───────────────────────────────────────────
   La imagen puede ir por la instancia o directa entre navegadores. Cámara y
   pantalla comparten un único hueco de vídeo, así que encender una apaga la otra.

   ponytail: en una malla el permiso se comprueba en tres sitios (botón, estado
   del servidor, y quien recibe solo pinta lo que el servidor anunció), pero los
   bytes salen igual porque nadie intermedia el flujo. Cortarlo de verdad exige
   un SFU que sea quien reenvía; entonces basta con que deje de hacerlo. */

/** En móvil no existe compartir pantalla: el botón no debe ni aparecer. */
export function canShareScreen(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === "function";
}

/**
 * El techo de resolución elegido, en el idioma de getUserMedia.
 *
 * `max` es lo que hace el recorte de verdad —un monitor 4K compartido con 720p
 * elegido baja a 720p— e `ideal` es lo que permite volver a subir cuando el
 * ajuste sube con la cámara ya encendida: medido en Chrome, un `max` a secas
 * baja pero luego no recupera, ni soltándolo. Una fuente más pequeña que el
 * techo se queda como está: `ideal` es una preferencia, no una exigencia.
 */
function sizeLimits(profile: relay.VideoProfile): MediaTrackConstraints {
  return {
    width: { ideal: profile.width, max: profile.width },
    height: { ideal: profile.height, max: profile.height },
    frameRate: { ideal: profile.fps, max: profile.fps },
  };
}

function capture(source: VideoSource): Promise<MediaStream> {
  const profile = relay.videoProfile(source);
  return source === "screen"
    ? navigator.mediaDevices.getDisplayMedia({
        video: sizeLimits(profile),
        /* El sonido de lo que se comparte. `ideal` y no `exact`: si el sistema no
           sabe entregarlo —Linux con algunos escritorios, o compartir una ventana
           en vez de una pestaña— se comparte igual, en mudo, en vez de fallar
           entera la captura. */
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
    : navigator.mediaDevices.getUserMedia({
        video: sizeLimits(profile),
        audio: false,
      });
}

/** VP9 conserva más detalle al mismo bitrate; la negociación cae a H.264/VP8 si falta. */
function preferVideoCodecs(transceiver: RTCRtpTransceiver): void {
  const codecs = RTCRtpSender.getCapabilities?.("video")?.codecs;
  if (!codecs || typeof transceiver.setCodecPreferences !== "function") return;
  const score = (codec: { mimeType: string }): number => {
    const name = codec.mimeType.toLowerCase();
    if (name === "video/vp9") return 0;
    if (name === "video/h264") return 1;
    if (name === "video/vp8") return 2;
    return 3;
  };
  transceiver.setCodecPreferences([...codecs].sort((a, b) => score(a) - score(b)));
}

/**
 * Capturar a 60 no basta: el codificador de WebRTC recorta por su cuenta cuando
 * va justo de CPU o de red, y por defecto prefiere sacrificar fluidez antes que
 * nitidez. Aquí se invierte esa preferencia y se le da techo de bitrate, que sin
 * él es lo primero que estrangula los fps.
 */
async function tuneSender(sender: RTCRtpSender, source: VideoSource): Promise<void> {
  const profile = relay.videoProfile(source);
  const params = sender.getParameters();
  // Antes de negociar, `encodings` puede llegar vacío; setParameters lo exige.
  if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];

  /* Qué recorta el codificador cuando no llega: lo decide la prioridad elegida
     en Ajustes. En "balanced", lo de siempre — cámara: movimiento fluido;
     pantalla: texto nítido y resolución estable. */
  const pref = relay.videoPriority();
  params.degradationPreference =
    pref === "fluid"
      ? "maintain-framerate"
      : pref === "sharp"
        ? "maintain-resolution"
        : source === "screen"
          ? "maintain-resolution"
          : "maintain-framerate";
  params.encodings[0]!.maxFramerate = profile.fps;
  params.encodings[0]!.maxBitrate = profile.bitrate;

  try {
    await sender.setParameters(params);
  } catch {
    // Navegador que no acepta alguna clave: se queda con lo que ya tenía en vez
    // de tirar la llamada por un ajuste de calidad.
  }
}

function stopLocalVideo(): void {
  for (const track of videoStream?.getTracks() ?? []) track.stop();
  videoStream = null;
  state.localVideo = null;
}

export async function setVideoSource(source: VideoSource | null): Promise<void> {
  if (!state.channelId || state.video === source) return;
  const previousSource = state.video;
  state.videoError = null;

  let track: MediaStreamTrack | null = null;
  if (source) {
    let stream: MediaStream;
    try {
      stream = await capture(source);
    } catch (err) {
      // Cancelar el diálogo de compartir pantalla es NotAllowedError igual que
      // denegar el permiso: en los dos casos simplemente no se enciende nada.
      state.videoError = err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "nodevice";
      emit();
      return;
    }

    track = stream.getVideoTracks()[0] ?? null;
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      state.videoError = "nodevice";
      emit();
      return;
    }

    stopLocalVideo();
    videoStream = stream;
    state.localVideo = stream;
    // La pista le dice al codificador qué es: con prioridad elegida manda esa;
    // en equilibrado, una cámara privilegia movimiento y una pantalla, letras.
    const hintPref = relay.videoPriority();
    track.contentHint =
      hintPref === "fluid" ? "motion" : hintPref === "sharp" ? "detail" : source === "screen" ? "detail" : "motion";
    // "Dejar de compartir" desde el propio navegador también tiene que apagarlo aquí.
    track.addEventListener("ended", () => void setVideoSource(null));
  } else {
    stopLocalVideo();
  }

  // El sonido de la pantalla se mezcla con el micrófono: llega sincronizado y no
  // hace falta un segundo flujo. Al dejar de compartir, se quita.
  relay.setShareAudio(source === "screen" ? videoStream : null);
  state.shareAudio = relay.hasShareAudio();

  if (videoViaHost) {
    // Por la instancia: se codifica aquí y sale por el mismo socket que la voz.
    if (source && videoStream) {
      const started = await relay.startVideo(videoStream, sendMedia, source).catch(() => false);
      if (!started) {
        relay.setShareAudio(null);
        state.shareAudio = false;
        stopLocalVideo();
        state.videoError = "unsupported";
        emit();
        return;
      }
    } else relay.stopVideo();
  } else {
    for (const peer of peers.values()) {
      const sender = peer.videoSender;
      // Sin emisor todavía (par que aún no ha negociado): al hacerlo cogerá la
      // pista que ya esté encendida.
      if (!sender) continue;
      void sender.replaceTrack(track).then(() => (source ? tuneSender(sender, source) : undefined));
    }
  }

  state.video = source;
  sendCommand({ t: "VOICE_VIDEO", d: { channel_id: state.channelId, source } });
  if (!source) {
    state.videoFps = null;
    lastFrames = null;
  }
  // Encender o apagar la cámara cambia con quién hace falta conexión directa:
  // mientras solo se hable no hay ninguna, y al encenderla aparecen.
  if (lastRoom) void syncPeers(lastRoom.channelId, lastRoom.participants);
  emit();
  if (source === "camera") playUi("camera_on");
  else if (source === "screen") playUi("screen_on");
  else if (previousSource === "camera") playUi("camera_off");
  else if (previousSource === "screen") playUi("screen_off");
}

/**
 * Aplicar en caliente la resolución o la prioridad que se acaban de cambiar en
 * Ajustes. Sin esto el ajuste es cierto pero solo a partir de la próxima vez que
 * se enciende la cámara, que desde fuera se ve igual que un ajuste que no hace
 * nada. Reaprovecha el `MediaStream` que ya estaba: volver a pedirlo abriría otra
 * vez el diálogo de compartir pantalla.
 */
export async function retuneVideo(): Promise<void> {
  const source = state.video;
  const track = videoStream?.getVideoTracks()[0];
  if (!source || !track || !videoStream) return;

  await track.applyConstraints(sizeLimits(relay.videoProfile(source))).catch(() => {
    // Fuente que no admite reconfigurarse en caliente: se queda como estaba y
    // el ajuste entra al volver a encenderla.
  });

  const hint = relay.videoPriority();
  track.contentHint = hint === "fluid" ? "motion" : hint === "sharp" ? "detail" : source === "screen" ? "detail" : "motion";

  if (videoViaHost) {
    // El codificador se configuró con un tamaño fijo; con otro tamaño de
    // fotograma hay que rehacerlo, sobre la misma pista ya capturada.
    relay.stopVideo();
    await relay.startVideo(videoStream, sendMedia, source).catch(() => false);
  } else {
    for (const peer of peers.values()) if (peer.videoSender) await tuneSender(peer.videoSender, source);
  }
}

/**
 * Lo que está pasando de verdad, no lo que se pidió.
 * Dos cosas que solo se saben preguntándole a la conexión: por dónde va la
 * llamada (directa o por relevo) y a cuántos fotogramas sale el vídeo, que no es
 * el de la captura —el codificador recorta cuando va justo de CPU o de red—.
 *
 * Corre durante toda la llamada, no solo con la cámara puesta: la ruta importa
 * aunque solo se hable, y es la única forma honesta de enseñar si la
 * conversación está pasando por un tercero.
 */
let statsTimer: number | undefined;
let lastFrames: { frames: number; at: number } | null = null;

function watchStats(on: boolean): void {
  if (!on) {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = undefined;
    lastFrames = null;
    state.videoFps = null;
    state.route = null;
    return;
  }
  statsTimer ??= window.setInterval(() => void pollStats(), 2000);
}

async function pollStats(): Promise<void> {
  // Con el vídeo pasando por la instancia no hay conexión que interrogar: los
  // fotogramas los cuenta quien los codifica, y la ruta la sabemos de antemano.
  if (videoViaHost) {
    const fps = relay.videoFps();
    if (fps !== state.videoFps) {
      state.videoFps = fps;
      emit();
    }
    return;
  }

  const peer = peers.values().next().value;
  if (!peer) return;

  const report = await peer.connection.getStats();
  let route: VoiceLocalState["route"] = null;
  let fps: number | null = null;

  for (const entry of report.values()) {
    if (entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated) {
      // Basta con que UNO de los dos extremos vaya por relevo: a partir de ahí los
      // paquetes pasan por él, aunque cifrados de extremo a extremo.
      const local = report.get(entry.localCandidateId) as { candidateType?: string } | undefined;
      const remote = report.get(entry.remoteCandidateId) as { candidateType?: string } | undefined;
      route = local?.candidateType === "relay" || remote?.candidateType === "relay" ? "relay" : "direct";
      continue;
    }
    if (entry.type !== "outbound-rtp" || entry.kind !== "video") continue;

    // framesPerSecond solo aparece cuando ya hay flujo; hasta entonces se
    // calcula a mano con framesSent, que existe desde el primer instante.
    const measured =
      typeof entry.framesPerSecond === "number"
        ? entry.framesPerSecond
        : lastFrames && entry.timestamp > lastFrames.at
          ? ((entry.framesSent - lastFrames.frames) * 1000) / (entry.timestamp - lastFrames.at)
          : null;

    lastFrames = { frames: entry.framesSent, at: entry.timestamp };
    fps = measured === null ? null : Math.round(measured);
  }

  const routeChanged = route !== state.route;
  if (routeChanged || fps !== state.videoFps) {
    state.route = route;
    state.videoFps = fps;
    emit();
  }
  // Al descubrir que la llamada está pasando por un relevo hay que reajustar lo
  // que ya se estaba enviando: el techo se decidió cuando aún no se sabía.
  if (routeChanged && state.video) {
    for (const other of peers.values()) if (other.videoSender) void tuneSender(other.videoSender, state.video);
  }
}

/**
 * Acciones de moderación sobre otra persona de la sala (§11).
 * No cambian nada en local: se piden y se espera al VOICE_STATE_UPDATE. Si el
 * permiso no da, la instancia calla y la interfaz no llega a mentir diciendo que
 * silenció a alguien que sigue hablando.
 */
export function moderateVoice(channelId: string, userId: string, action: VoiceAction): void {
  sendCommand({ t: "VOICE_MODERATE", d: { channel_id: channelId, user_id: userId, action } });
}
