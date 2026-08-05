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
const KIND_VIDEO_KEY = 1;
const KIND_VIDEO_DELTA = 2;

/** Antepone el tipo a los datos, que es lo que espera la instancia. */
function packet(kind: number, data: ArrayBuffer | Uint8Array): Uint8Array {
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);
  const out = new Uint8Array(1 + body.length);
  out[0] = kind;
  out.set(body, 1);
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

let context: AudioContext | null = null;
function audio(): AudioContext {
  context ??= new AudioContext({ sampleRate: SAMPLE_RATE });
  // Entrar a la llamada es un gesto de la persona, que es lo que exige el
  // navegador para dejar sonar algo.
  if (context.state === "suspended") void context.resume();
  return context;
}

/** Volumen reciente de cada quien, para el indicador de quién habla. */
export const levels = new Map<Snowflake, number>();

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
  source.connect(destination);

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

export function setDeafened(on: boolean): void {
  deafened = on;
  for (const player of players.values()) player.gain.gain.value = on ? 0 : 1;
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
  gain.gain.value = deafened ? 0 : 1;
  gain.connect(ctx.destination);

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
 * Techo de calidad, que sale de la subida de quien hospeda multiplicada por cada
 * persona que mira. La pantalla pide más que la cámara: texto y bordes duros se
 * ensucian mucho antes que una cara.
 *
 * No hay límite artificial aquí — quien hospeda sube esto desde Ajustes hasta
 * donde le dé su conexión (§10.3).
 */
const QUALITY = {
  low: { camera: 1_000_000, screen: 1_500_000, fps: 24 },
  medium: { camera: 2_500_000, screen: 4_000_000, fps: 30 },
  high: { camera: 5_000_000, screen: 8_000_000, fps: 60 },
} as const;

export type Quality = keyof typeof QUALITY;
let quality: Quality = "medium";

export function setQuality(value: Quality): void {
  quality = QUALITY[value] ? value : "medium";
}

/** Cada cuánto se manda un fotograma completo: es por donde se engancha quien llega. */
const KEYFRAME_MS = 2000;
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
  send: (frame: ArrayBuffer) => void,
  source: "camera" | "screen",
): Promise<boolean> {
  stopVideo();
  if (!videoSupported()) return false;

  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const { width = 1280, height = 720 } = track.getSettings();
  const preset = QUALITY[quality];
  const bitrate = preset[source];

  videoEncoder = new VideoEncoder({
    output: (chunk) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      send(packet(chunk.type === "key" ? KIND_VIDEO_KEY : KIND_VIDEO_DELTA, data).buffer as ArrayBuffer);
    },
    error: () => stopVideo(),
  });
  // "realtime" le dice al codificador que prefiera llegar a tiempo antes que
  // apurar la calidad: es exactamente el compromiso de una llamada.
  videoEncoder.configure({
    codec: VIDEO_CODEC,
    width,
    height,
    bitrate,
    framerate: preset.fps,
    latencyMode: "realtime",
  });

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

      const keyFrame = now - lastKey >= KEYFRAME_MS;
      if (keyFrame) lastKey = now;
      lastFrame = now;
      videoEncoder.encode(value, { keyFrame });
      value.close();

      // Se cuenta aquí porque es el único sitio que sabe lo que salió de verdad,
      // después de los descartes de arriba.
      sent.frames++;
      if (now - sent.since >= 1000) {
        sent = { frames: 0, since: now, fps: Math.round((sent.frames * 1000) / (now - sent.since)) };
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

  const key = kind === KIND_VIDEO_KEY;
  // Empezar por la mitad de una secuencia solo produce basura verde: se espera.
  if (!viewer.ready && !key) return;
  viewer.ready = true;
  if (viewer.decoder.state !== "configured") return;

  viewer.decoder.decode(
    new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: viewer.timestamp, data: payload }),
  );
  // Marca de tiempo creciente: al decodificador le basta con que avance, no tiene
  // que coincidir con los fps reales de quien emite.
  viewer.timestamp += 33_333;
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
}
