/**
 * Voz y vídeo a través de la instancia (§9.4, §9.5).
 *
 * Nada de esto va de navegador a navegador: sube al equipo que hospeda y este lo
 * reparte, igual que hace ya con los mensajes, los canales y los permisos. Es el
 * modelo de un servidor de juego —tu máquina da vida a la sala y al apagarla se
 * acaba— y tiene una propiedad que el P2P no tiene: **si ves la aplicación,
 * funciona**. La conexión con la instancia ya existe y ya atraviesa lo que haya
 * en medio. Sin STUN, sin TURN, sin abrir puertos, sin cuenta en ningún servicio.
 *
 * Lo que cuesta, dicho claro: la subida de quien hospeda se multiplica por cada
 * persona que mira. El audio no se nota (~4 KB/s por persona); el vídeo sí, y por
 * eso se puede elegir dejarlo directo desde Ajustes.
 *
 * Y una trampa del transporte: el socket es TCP, así que un paquete perdido
 * retiene a los siguientes. La respuesta no es esperar —eso solo acumula
 * retardo— sino TIRAR lo que no cabe. Por eso el servidor descarta cuando la cola
 * crece y aquí se pide un fotograma clave al reengancharse.
 */
import type { Snowflake } from "@distop/protocol";

/**
 * Todavía no está en los tipos del DOM que trae TypeScript, aunque lleva años en
 * Chrome y derivados. Se declara lo justo que se usa en vez de traerse un paquete
 * de tipos entero, y `supported()` comprueba en tiempo real que exista.
 */
declare class MediaStreamTrackProcessor<T = AudioData> {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<T>;
}

/**
 * El camino de vuelta: convierte los fotogramas ya decodificados otra vez en una
 * pista de vídeo normal. Gracias a esto la interfaz no se entera de nada —sigue
 * siendo un `<video>` con su `srcObject`, con su pantalla completa y su recorte—
 * en vez de tener que pintar a mano sobre un lienzo.
 */
declare class MediaStreamTrackGenerator extends MediaStreamTrack {
  constructor(init: { kind: "video" | "audio" });
  readonly writable: WritableStream<VideoFrame>;
}

/** Tipos de paquete. El primer byte de cada envío. */
const KIND_AUDIO = 0;
/** 1/2 se aceptan para clientes anteriores; 3/4 incluyen el tiempo real del frame. */
const KIND_VIDEO_KEY = 1;
const KIND_VIDEO_DELTA = 2;
const KIND_VIDEO_KEY_TIMED = 3;
const KIND_VIDEO_DELTA_TIMED = 4;

/** Antepone el tipo a los datos, que es lo que espera la instancia. */
function packet(kind: number, data: ArrayBuffer | Uint8Array): Uint8Array {
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = kind;
  out.set(body, 1);
  return out;
}

/**
 * [tipo][timestamp µs, 8 bytes][VP8]. Antes el receptor inventaba 30 FPS y una
 * fuente de 60/120 quedaba temporizada como si aún fuera de 30.
 */
function videoPacket(kind: number, timestamp: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(9 + data.length);
  out[0] = kind;
  new DataView(out.buffer).setBigUint64(1, BigInt(Math.max(0, Math.round(timestamp))));
  out.set(data, 9);
  return out;
}

/** Opus trabaja siempre a 48 kHz; todo se normaliza a eso antes de codificar. */
const SAMPLE_RATE = 48_000;
const BITRATE = 32_000;
/** Colchón antes de reproducir: la red no entrega a ritmo constante. */
const JITTER = 0.08;
/** Retraso acumulado a partir del cual se recorta: mejor un salto que hablar con eco. */
const MAX_LAG = 0.5;
/** Duración de un paquete, en microsegundos, para numerarlos al decodificar. */
const FRAME_US = 20_000;

export function supported(): boolean {
  return typeof AudioEncoder === "function" && typeof MediaStreamTrackProcessor === "function";
}

/** El vídeo pide dos cosas más: codificarlo y volver a montar la pista al recibirlo. */
export function videoSupported(): boolean {
  return supported() && typeof VideoEncoder === "function" && typeof MediaStreamTrackGenerator === "function";
}

/**
 * Elegir por qué altavoz suena (`setSinkId` en el contexto de audio) existe en
 * Chrome desde la 110, pero todavía no está en los tipos del DOM. Se declara lo
 * justo y se comprueba en tiempo real: donde no exista, la opción no se enseña
 * en vez de fallar en silencio (§29.3).
 */
interface SinkContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

let context: AudioContext | null = null;
function audio(): AudioContext {
  if (!context) {
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (outDevice) void applySink(context, outDevice);
  }
  // Entrar a la llamada es un gesto de la persona, que es lo que exige el
  // navegador para dejar sonar algo.
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Volumen reciente de cada quien, para el indicador de quién habla. */
export const levels = new Map<Snowflake, number>();

/* ── volumen y dispositivos (§10.2) ───────────────────────────────────────
   Cuatro mandos y ninguno de pago: lo que entra por el micrófono, lo que sale
   por los altavoces, el volumen de cada persona por separado y qué aparato se
   usa para cada cosa.

   El volumen por persona NO viaja a ninguna parte: es "yo te oigo demasiado
   fuerte", no "tú hablas fuerte". Bajárselo a alguien para toda la sala sería
   moderación, y la moderación ya tiene sus botones y sus permisos (§11).

   Todo esto se guarda aquí y no en las preferencias de la aplicación porque es
   de este aparato —estos altavoces, este micrófono— y porque un mapa por persona
   no cabe en una preferencia suelta. */

/** 200%: recuperar a quien tiene el micro bajo sin obligarle a arreglarlo. */
const MAX_VOLUME = 2;

function clamp(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_VOLUME, Math.max(0, value)) : 1;
}

/** Un almacenamiento bloqueado (ventana privada, permisos) no debe tirar el audio. */
function remember(key: string, value: string): void {
  try {
    localStorage.setItem("distop." + key, value);
  } catch {
    // Sin sitio donde guardar, el ajuste vale para esta sesión y ya está.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem("distop." + key);
  } catch {
    return null;
  }
}

function recallVolume(key: string): number {
  const raw = recall(key);
  return raw === null ? 1 : clamp(Number(raw));
}

let micLevel = recallVolume("micVolume");
let outLevel = recallVolume("outVolume");
let outDevice = recall("outDevice") ?? "";
let micNode: GainNode | null = null;
let master: GainNode | null = null;

/** Todo lo que suena pasa por aquí: es el punto donde se baja el volumen general. */
function output(ctx: AudioContext): GainNode {
  if (!master) {
    master = ctx.createGain();
    master.gain.value = deafened ? 0 : outLevel;
    master.connect(ctx.destination);
  }
  return master;
}

export function micVolume(): number {
  return micLevel;
}

export function outputVolume(): number {
  return outLevel;
}

export function setMicVolume(value: number): void {
  micLevel = clamp(value);
  remember("micVolume", String(micLevel));
  if (micNode) micNode.gain.value = micLevel;
}

export function setOutputVolume(value: number): void {
  outLevel = clamp(value);
  remember("outVolume", String(outLevel));
  // Ensordecido manda: subir el volumen no puede devolver el sonido por detrás.
  if (master && !deafened) master.gain.value = outLevel;
}

/** Volumen de una persona, solo para quien lo ajusta. 1 = como todo el mundo. */
export function userVolume(id: Snowflake): number {
  return volumes.get(id) ?? 1;
}

export function setUserVolume(id: Snowflake, value: number): void {
  const level = clamp(value);
  // El 100% no se guarda: es lo de todos, y guardarlo llenaría el almacenamiento
  // de gente a la que nunca se le tocó nada.
  if (level === 1) volumes.delete(id);
  else volumes.set(id, level);
  remember("userVolumes", JSON.stringify(Object.fromEntries(volumes)));

  const player = players.get(id);
  if (player) player.gain.gain.value = level;
}

const volumes = loadVolumes();

function loadVolumes(): Map<Snowflake, number> {
  try {
    const raw: unknown = JSON.parse(recall("userVolumes") ?? "{}");
    if (!raw || typeof raw !== "object") return new Map();
    return new Map(Object.entries(raw as Record<string, unknown>).map(([id, v]) => [id, clamp(Number(v))]));
  } catch {
    // Un JSON corrupto se descarta entero: son ajustes de comodidad, no datos.
    return new Map();
  }
}

/** ¿Deja este navegador elegir el altavoz? Si no, la opción no se enseña (§29.3). */
export function canPickOutput(): boolean {
  return typeof AudioContext === "function" && typeof (AudioContext.prototype as SinkContext).setSinkId === "function";
}

export function outputDevice(): string {
  return outDevice;
}

async function applySink(ctx: AudioContext, id: string): Promise<void> {
  try {
    await (ctx as SinkContext).setSinkId?.(id);
  } catch {
    // El aparato pudo desaparecer entre elegirlo y aplicarlo: sigue el de siempre.
  }
}

/** Cambia el altavoz en caliente: la llamada en curso no se corta. */
export async function setOutputDevice(id: string): Promise<void> {
  outDevice = id;
  remember("outDevice", id);
  if (context) await applySink(context, id);
}

/* ── envío ─────────────────────────────────────────────────────────────── */

let encoder: AudioEncoder | null = null;
let capture: { track: MediaStreamTrack; source: AudioNode; mix: AudioNode } | null = null;
let sending = true;

export function setSending(on: boolean): void {
  sending = on;
}

/* ── sonido de lo que se comparte ─────────────────────────────────────────
   Compartir una pantalla sin su sonido es enseñar un vídeo en mudo. El navegador
   lo entrega como una pista aparte, pero aquí se MEZCLA con el micrófono en el
   mismo grafo de audio en vez de mandarse por su cuenta: un solo flujo que
   codificar, un solo flujo que decodificar, y llega sincronizado con la voz por
   construcción.

   ponytail: mezclado significa que quien escucha no puede bajarle el volumen sin
   bajar también la voz. Para separarlo haría falta un segundo flujo por persona;
   si alguien lo pide, el formato de paquete ya tiene sitio para otro tipo. */

let shared: { source: MediaStreamAudioSourceNode; gain: GainNode } | null = null;
let shareMuted = false;

export function setShareAudio(stream: MediaStream | null): void {
  shared?.source.disconnect();
  shared?.gain.disconnect();
  shared = null;

  const track = stream?.getAudioTracks()[0];
  if (!track || !capture) return;

  const ctx = audio();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const gain = ctx.createGain();
  gain.gain.value = shareMuted ? 0 : 1;
  source.connect(gain).connect(capture.mix);
  shared = { source, gain };
}

/** ¿Hay sonido que compartir? Si el sistema no lo dio, el botón sobra. */
export function hasShareAudio(): boolean {
  return shared !== null;
}

export function setShareMuted(muted: boolean): void {
  shareMuted = muted;
  if (shared) shared.gain.gain.value = muted ? 0 : 1;
}

export async function startCapture(mic: MediaStream, send: (frame: ArrayBuffer) => void): Promise<boolean> {
  if (!supported()) return false;
  stopCapture();

  const ctx = audio();
  /* Se pasa el micrófono por el grafo de audio antes de codificar. No es adorno:
     cada aparato entrega la frecuencia y los canales que le da la gana, y el
     codificador exige exactamente 48 kHz mono. Esto lo convierte por el camino. */
  const source = ctx.createMediaStreamSource(mic);
  const destination = ctx.createMediaStreamDestination();
  destination.channelCount = 1;
  destination.channelCountMode = "explicit";
  /* El volumen del micrófono se aplica ANTES de codificar: subirlo después es
     imposible, y bajarlo en el receptor sería pedirle a cada persona de la sala
     que arregle un micro que no es suyo.

     ponytail: por encima del 100% se amplifica y puede saturar, como en
     cualquier otra aplicación de voz. Un compresor lo evitaría; hasta que
     alguien se queje, el tope del 200% y el aviso en Ajustes bastan. */
  micNode = ctx.createGain();
  micNode.gain.value = micLevel;
  source.connect(micNode).connect(destination);

  const track = destination.stream.getAudioTracks()[0];
  if (!track) return false;
  // `destination` es también el punto donde se engancha el sonido de la pantalla.
  capture = { track, source, mix: destination };

  encoder = new AudioEncoder({
    output: (chunk) => {
      // Se codifica siempre pero solo se envía sin silenciar: cortar la entrada
      // del codificador le deja un hueco en la numeración y suena a chasquido.
      if (!sending) return;
      const frame = new Uint8Array(chunk.byteLength);
      chunk.copyTo(frame);
      send(packet(KIND_AUDIO, frame).buffer as ArrayBuffer);
    },
    error: () => stopCapture(),
  });
  encoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1, bitrate: BITRATE });

  const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();

  void (async () => {
    while (capture?.track === track) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      if (encoder?.state === "configured") encoder.encode(value);
      value.close();
    }
    reader.cancel().catch(() => {});
  })();

  return true;
}

export function stopCapture(): void {
  encoder?.close();
  encoder = null;
  setShareAudio(null);
  capture?.track.stop();
  capture?.source.disconnect();
  micNode?.disconnect();
  micNode = null;
  capture = null;
}

/* ── recepción ─────────────────────────────────────────────────────────── */

interface Player {
  decoder: AudioDecoder;
  gain: GainNode;
  /** Cuándo debe empezar el siguiente trozo, en el reloj del contexto de audio. */
  next: number;
  /** Numeración creciente que exige el decodificador. */
  timestamp: number;
}

const players = new Map<Snowflake, Player>();
let deafened = false;
const activeClips = new Set<AudioBufferSourceNode>();

/* Ensordecer es el volumen general a cero, no el de cada quien: así el volumen
   que se le puso a una persona sigue ahí al volver a oír. */
export function setDeafened(on: boolean): void {
  deafened = on;
  if (master) master.gain.value = on ? 0 : outLevel;
}

/* ── tabla de sonidos (§9.4) ───────────────────────────────────────────
   Por el socket llega un id, no audio: el archivo se pide una vez a la
   instancia y se queda decodificado en memoria. Un botón de sonidos se pulsa
   muchas veces seguidas y volver a bajar el mismo mp3 en cada pulsación sería
   pagar la misma descarga en bucle, además de retrasar el sonido.

   Va por el AudioContext de la llamada y no por un `new Audio()` suelto: es el
   que ya despertó el gesto de entrar a la sala, y así "ensordecido" apaga
   también esto y no solo las voces. */
export type ClipPlaybackIssue = "deafened" | "unsupported" | "blocked" | "download" | "decode" | "too_long";
export type ClipPlaybackResult = { ok: true } | { ok: false; reason: ClipPlaybackIssue };

const MAX_CACHED_CLIPS = 12;
const MAX_CLIP_SECONDS = 30;
const clips = new Map<string, Promise<AudioBuffer>>();

class ClipLoadFailure extends Error {
  constructor(readonly reason: "download" | "decode" | "too_long") {
    super(reason);
  }
}

function loadClip(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const cached = clips.get(url);
  if (cached) {
    // Map conserva el orden de inserción: reinsertar convierte esto en una LRU.
    clips.delete(url);
    clips.set(url, cached);
    return cached;
  }

  const pending = (async () => {
    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new ClipLoadFailure("download");
    }
    if (!response.ok) throw new ClipLoadFailure("download");

    const raw = await response.arrayBuffer();
    if (raw.byteLength === 0) throw new ClipLoadFailure("download");
    try {
      const decoded = await ctx.decodeAudioData(raw);
      // El coste real en memoria es el PCM decodificado, no el MP3 comprimido.
      if (!Number.isFinite(decoded.duration) || decoded.duration > MAX_CLIP_SECONDS)
        throw new ClipLoadFailure("too_long");
      return decoded;
    } catch (error) {
      if (error instanceof ClipLoadFailure) throw error;
      throw new ClipLoadFailure("decode");
    }
  })();

  clips.set(url, pending);
  void pending
    .then(() => {
      while (clips.size > MAX_CACHED_CLIPS) clips.delete(clips.keys().next().value!);
    })
    // Un fallo no se cachea: recuperar la red o reemplazar el archivo debe bastar.
    .catch(() => clips.delete(url));
  return pending;
}

/** Descarga, decodifica y reproduce un efecto con un resultado que la UI puede explicar. */
export async function playClip(url: string): Promise<ClipPlaybackResult> {
  if (deafened) return { ok: false, reason: "deafened" };
  // Reproducir un archivo solo necesita Web Audio. No debe depender de que el
  // navegador también sepa codificar Opus con WebCodecs.
  if (typeof AudioContext !== "function") return { ok: false, reason: "unsupported" };

  const ctx = audio();
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch {
      return { ok: false, reason: "blocked" };
    }
  }
  if (ctx.state !== "running") return { ok: false, reason: "blocked" };

  let buffer: AudioBuffer;
  try {
    buffer = await loadClip(ctx, url);
  } catch (error) {
    return { ok: false, reason: error instanceof ClipLoadFailure ? error.reason : "decode" };
  }

  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(output(ctx));
  activeClips.add(node);
  node.onended = () => {
    activeClips.delete(node);
    node.disconnect();
  };
  node.start();
  return { ok: true };
}

function stopClips(): void {
  for (const node of activeClips) {
    node.onended = null;
    node.stop();
    node.disconnect();
  }
  activeClips.clear();
}

function play(id: Snowflake, player: Player, data: AudioData): void {
  const ctx = audio();
  const buffer = ctx.createBuffer(1, data.numberOfFrames, data.sampleRate);
  const samples = buffer.getChannelData(0);
  data.copyTo(samples, { planeIndex: 0, format: "f32-planar" });
  data.close();

  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  levels.set(id, Math.sqrt(sum / samples.length));

  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(player.gain);

  /* Se encadena un trozo detrás de otro. Si se acumuló retraso —una ráfaga que
     llega junta tras un parón— se tira lo viejo y se vuelve al presente: hablar
     con medio segundo de retardo es peor que perder una sílaba. */
  const start = Math.max(ctx.currentTime + JITTER, player.next);
  const when = start - ctx.currentTime > MAX_LAG ? ctx.currentTime + JITTER : start;
  node.start(when);
  player.next = when + buffer.duration;
}

function playerFor(id: Snowflake): Player {
  const existing = players.get(id);
  if (existing) return existing;

  const ctx = audio();
  const gain = ctx.createGain();
  gain.gain.value = userVolume(id);
  gain.connect(output(ctx));

  const player: Player = {
    gain,
    next: 0,
    timestamp: 0,
    decoder: new AudioDecoder({ output: (data) => play(id, player, data), error: () => drop(id) }),
  };
  player.decoder.configure({ codec: "opus", sampleRate: SAMPLE_RATE, numberOfChannels: 1 });
  players.set(id, player);
  return player;
}

/** Un paquete recién llegado de la instancia, sea de voz o de imagen. */
export function receive(id: Snowflake, kind: number, payload: Uint8Array): void {
  if (kind !== KIND_AUDIO) return receiveVideo(id, kind, payload);
  if (!supported()) return;

  const player = playerFor(id);
  if (player.decoder.state !== "configured") return;

  // Todos los paquetes de Opus son independientes: no hay fotograma clave que
  // esperar, así que uno perdido solo cuesta sus 20 ms.
  player.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: player.timestamp, data: payload }));
  player.timestamp += FRAME_US;
}

/* ── vídeo ─────────────────────────────────────────────────────────────
   Mismo camino que la voz, con dos diferencias que importan: pesa cien veces
   más, así que se limita de verdad; y no todos los fotogramas valen por sí solos
   —los intermedios dependen del anterior—, así que hay que empezar por uno
   completo y repetirlo cada pocos segundos para quien llegue tarde. */

/**
 * Resolución, fotogramas y bitrate de TU cámara y TU pantalla. Es tuyo, como el
 * volumen del micrófono: no toca a la instancia ni a quien hospeda, así que
 * cada quien elige lo que le dé su propia conexión (§10.2).
 *
 * Son tres resoluciones concretas —720p, 1080p y 1440p— y el techo vale igual
 * para la pantalla que para la cámara: compartir un monitor 4K con 720p elegido
 * recorta de verdad los píxeles que salen, no solo el bitrate. Es un máximo y no
 * un objetivo: una fuente más pequeña que el techo no se amplía.
 *
 * No hay límite artificial aquí.
 */
const QUALITY = {
  low: {
    camera: { bitrate: 1_500_000, fps: 30, width: 1280, height: 720 },
    screen: { bitrate: 3_000_000, fps: 30, width: 1280, height: 720 },
  },
  medium: {
    camera: { bitrate: 4_000_000, fps: 60, width: 1920, height: 1080 },
    screen: { bitrate: 8_000_000, fps: 60, width: 1920, height: 1080 },
  },
  high: {
    camera: { bitrate: 12_000_000, fps: 120, width: 2560, height: 1440 },
    screen: { bitrate: 24_000_000, fps: 120, width: 2560, height: 1440 },
  },
} as const;

export type Quality = keyof typeof QUALITY;

function recallQuality(): Quality {
  const raw = recall("videoQuality");
  return raw !== null && raw in QUALITY ? (raw as Quality) : "medium";
}

let quality: Quality = recallQuality();

export function videoQuality(): Quality {
  return quality;
}

export function setQuality(value: Quality): void {
  quality = QUALITY[value] ? value : "medium";
  remember("videoQuality", quality);
}

/**
 * Qué sacrificar cuando no alcanza para todo, que con vídeo es siempre: el
 * bitrate es un techo y hay que repartirlo entre fotogramas por segundo y
 * detalle por fotograma.
 *
 *   fluid    — movimiento suave: se conservan los fps y se cede resolución.
 *   balanced — lo de siempre: la cámara privilegia movimiento y la pantalla
 *              conserva letras y bordes. Es lo correcto para casi todo el mundo.
 *   sharp    — imagen definida: mitad de fotogramas, el doble de bits por cada
 *              uno. Para enseñar texto, diagramas o detalle fino.
 */
export type Priority = "fluid" | "balanced" | "sharp";

function recallPriority(): Priority {
  const raw = recall("videoPriority");
  return raw === "fluid" || raw === "sharp" ? raw : "balanced";
}

let priority: Priority = recallPriority();

export function setPriority(value: Priority): void {
  priority = value === "fluid" || value === "sharp" ? value : "balanced";
  remember("videoPriority", priority);
}

export function videoPriority(): Priority {
  return priority;
}

export interface VideoProfile {
  bitrate: number;
  fps: number;
  /** Techo de resolución: la cámara lo pide como ideal y la pantalla, como máximo. */
  width: number;
  height: number;
}

/** El mismo perfil gobierna captura, WebRTC directo y WebCodecs por instancia. */
export function videoProfile(source: "camera" | "screen"): VideoProfile {
  const base: VideoProfile = QUALITY[quality][source];
  /* Nitidez: mitad de fps al mismo bitrate = el doble de bits por fotograma.
     El suelo de 24 existe porque por debajo deja de parecer vídeo. */
  if (priority === "sharp") return { ...base, fps: Math.max(24, Math.round(base.fps / 2)) };
  /* Fluidez: menos píxeles por fotograma para que el codificador no se ahogue
     en movimiento. Solo la cámara: reducir una pantalla vuelve ilegible el texto. */
  if (priority === "fluid" && source === "camera")
    return { ...base, width: Math.round((base.width * 2) / 3 / 2) * 2, height: Math.round((base.height * 2) / 3 / 2) * 2 };
  return base;
}

/** Cada cuánto se manda un fotograma completo: es por donde se engancha quien llega. */
const KEYFRAME_MS = 1000;
/** VP8 porque sus paquetes se bastan solos: el decodificador no necesita que le
    manden antes una cabecera aparte, como sí ocurre con H.264. */
const VIDEO_CODEC = "vp8";

let videoEncoder: VideoEncoder | null = null;
let videoStop: (() => void) | null = null;
let sent = { frames: 0, since: 0, fps: 0 };

/** Fotogramas que salen de verdad, no los que pide la cámara. */
export function videoFps(): number | null {
  return videoEncoder ? sent.fps : null;
}

export async function startVideo(
  stream: MediaStream,
  send: (frame: ArrayBuffer) => boolean | void,
  source: "camera" | "screen",
): Promise<boolean> {
  stopVideo();
  if (!videoSupported()) return false;

  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const { width = 1280, height = 720 } = track.getSettings();
  const preset = videoProfile(source);
  let forceKeyFrame = true;

  const fallbackConfig: VideoEncoderConfig = {
    codec: VIDEO_CODEC,
    width,
    height,
    bitrate: preset.bitrate,
    framerate: preset.fps,
    latencyMode: "realtime",
  };
  const preferredConfig: VideoEncoderConfig = {
    ...fallbackConfig,
    bitrateMode: "variable",
    hardwareAcceleration: "prefer-hardware",
  };
  let encoderConfig = fallbackConfig;
  try {
    const support = await VideoEncoder.isConfigSupported(preferredConfig);
    if (support.supported) encoderConfig = preferredConfig;
  } catch {
    // Implementación antigua: el perfil básico VP8 sigue siendo compatible.
  }

  videoEncoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      const kind = chunk.type === "key" ? KIND_VIDEO_KEY_TIMED : KIND_VIDEO_DELTA_TIMED;
      const accepted = send(videoPacket(kind, chunk.timestamp, data).buffer as ArrayBuffer);
      if (accepted === false) forceKeyFrame = true;
    },
    error: () => stopVideo(),
  });
  // "realtime" le dice al codificador que prefiera llegar a tiempo antes que
  // apurar la calidad: es exactamente el compromiso de una llamada.
  try {
    videoEncoder.configure(encoderConfig);
  } catch {
    stopVideo();
    return false;
  }

  const reader = new MediaStreamTrackProcessor<VideoFrame>({ track }).readable.getReader();
  let running = true;
  let lastKey = 0;
  let lastFrame = 0;
  sent = { frames: 0, since: performance.now(), fps: 0 };
  videoStop = () => {
    running = false;
    void reader.cancel().catch(() => {});
  };

  void (async () => {
    while (running) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const now = performance.now();

      /* Tres motivos para tirar un fotograma sin mirarlo siquiera: que la cámara
         vaya más rápida del techo, que el codificador se esté quedando atrás, o
         que ya no estemos enviando. Tirarlo aquí es gratis; encolarlo se paga en
         retardo que ya no se recupera. */
      const tooSoon = now - lastFrame < 1000 / preset.fps - 1;
      if (!running || tooSoon || (videoEncoder?.encodeQueueSize ?? 0) > 2 || videoEncoder?.state !== "configured") {
        value.close();
        continue;
      }

      const keyFrame = forceKeyFrame || now - lastKey >= KEYFRAME_MS;
      if (keyFrame) lastKey = now;
      forceKeyFrame = false;
      lastFrame = now;
      videoEncoder.encode(value, { keyFrame });
      value.close();

      // Se cuenta aquí porque es el único sitio que sabe lo que salió de verdad,
      // después de los descartes de arriba.
      sent.frames++;
      if (now - sent.since >= 1000) {
        const elapsed = now - sent.since;
        const fps = Math.round((sent.frames * 1000) / elapsed);
        sent = { frames: 0, since: now, fps };
      }
    }
  })();

  return true;
}

export function stopVideo(): void {
  videoStop?.();
  videoStop = null;
  if (videoEncoder && videoEncoder.state !== "closed") videoEncoder.close();
  videoEncoder = null;
}

interface Viewer {
  decoder: VideoDecoder;
  writer: WritableStreamDefaultWriter<VideoFrame>;
  stream: MediaStream;
  /** Hasta que no llega un fotograma completo, los intermedios no significan nada. */
  ready: boolean;
  timestamp: number;
}

const viewers = new Map<Snowflake, Viewer>();
let onStream: ((id: Snowflake, stream: MediaStream) => void) | null = null;

/** La interfaz recibe la pista ya montada y la trata como cualquier otra. */
export function onVideoStream(handler: ((id: Snowflake, stream: MediaStream) => void) | null): void {
  onStream = handler;
}

function receiveVideo(id: Snowflake, kind: number, payload: Uint8Array): void {
  if (!videoSupported()) return;
  let viewer = viewers.get(id);

  if (!viewer) {
    const generator = new MediaStreamTrackGenerator({ kind: "video" });
    const stream = new MediaStream([generator]);
    const created: Viewer = {
      stream,
      writer: generator.writable.getWriter(),
      ready: false,
      timestamp: 0,
      decoder: new VideoDecoder({
        output: (frame) => {
          // TrackGenerator también tiene cola. Si la pantalla no pinta a tiempo,
          // conservar un frame viejo solo añade latencia y memoria.
          if ((created.writer.desiredSize ?? 1) <= 0) {
            frame.close();
            return;
          }
          void created.writer.write(frame).catch(() => frame.close());
        },
        error: () => dropVideo(id),
      }),
    };
    created.decoder.configure({ codec: VIDEO_CODEC, optimizeForLatency: true });
    viewers.set(id, created);
    viewer = created;
    onStream?.(id, stream);
  }

  const timed = kind === KIND_VIDEO_KEY_TIMED || kind === KIND_VIDEO_DELTA_TIMED;
  const key = kind === KIND_VIDEO_KEY || kind === KIND_VIDEO_KEY_TIMED;
  if (kind !== KIND_VIDEO_KEY && kind !== KIND_VIDEO_DELTA && !timed) return;
  if (timed && payload.byteLength <= 8) return;
  // Empezar por la mitad de una secuencia solo produce basura verde: se espera.
  if (!viewer.ready && !key) return;
  // Si decodificar ya va muy por detrás, se salta hasta el próximo keyframe. Un
  // delta posterior depende de lo descartado y solo consumiría CPU para fallar.
  if (!key && viewer.decoder.decodeQueueSize > 4) {
    viewer.ready = false;
    return;
  }
  if (key && viewer.decoder.decodeQueueSize > 4) {
    viewer.decoder.reset();
    viewer.decoder.configure({ codec: VIDEO_CODEC, optimizeForLatency: true });
  }
  viewer.ready = true;
  if (viewer.decoder.state !== "configured") return;

  const timestamp = timed
    ? Number(new DataView(payload.buffer, payload.byteOffset, 8).getBigUint64(0))
    : viewer.timestamp;
  const data = timed ? payload.subarray(8) : payload;

  viewer.decoder.decode(
    new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data }),
  );
  // Marca de tiempo creciente: al decodificador le basta con que avance, no tiene
  // que coincidir con los fps reales de quien emite.
  if (!timed) viewer.timestamp += 33_333;
}

export function dropVideo(id: Snowflake): void {
  const viewer = viewers.get(id);
  if (!viewer) return;
  if (viewer.decoder.state !== "closed") viewer.decoder.close();
  void viewer.writer.close().catch(() => {});
  viewers.delete(id);
}

export function drop(id: Snowflake): void {
  const player = players.get(id);
  if (!player) return;
  if (player.decoder.state !== "closed") player.decoder.close();
  player.gain.disconnect();
  players.delete(id);
  levels.delete(id);
}

export function dropAll(): void {
  for (const id of [...players.keys()]) drop(id);
  for (const id of [...viewers.keys()]) dropVideo(id);
  stopClips();
}
