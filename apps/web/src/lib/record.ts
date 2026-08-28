/**
 * Grabación local de una reunión (V3 §8.9): un fichero en TU ordenador, no una
 * nube que se alquila.
 *
 * El orden importa y es el del plan: primero el AVISO a la sala (CONSENTING),
 * y solo cuando la instancia lo confirma empieza la captura y se declara
 * RECORDING. Avisar después de grabar el primer segundo no es avisar.
 *
 * Se graba el audio de la reunión (lo que suena + mi micrófono tal y como sale
 * a la sala, ver `startRecordTap`) y la imagen que quien graba elija en el
 * selector del sistema: la ventana de la reunión, otra ventana o el monitor
 * entero. Sin selector, o si lo cancela, queda la grabación de solo audio.
 *
 * El vídeo pesa —VP9 a 2,5 Mbps son ~1,1 GB por hora— y los trozos viven en
 * memoria hasta que se para, que es justo el riesgo que §8.9 avisa: reuniones
 * largas grabadas en pantalla se llevan la RAM del que graba.
 * ponytail: si molesta, `recorder.start(1000)` ya trocea; volcar cada trozo a
 * un File System Access handle en vez de a `chunks` quita el techo.
 */
import type { MeetingRecording, Snowflake } from "@distop/protocol";
import { sendCommand } from "./gateway.ts";
import { startRecordTap, stopRecordTap } from "./relay.ts";
import { currentChannel } from "./voice.ts";

type Phase = "idle" | "waiting" | "starting" | "recording" | "saving";

let phase: Phase = "idle";
let channelId: Snowflake | null = null;
let startedAt = 0;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let pantalla: MediaStream | null = null;

function ordenar(canal: Snowflake, state: MeetingRecording["state"]): void {
  sendCommand({ t: "MEETING_RECORD", d: { channel_id: canal, state } });
}

function soltar(stream: MediaStream | null): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

function reposo(): void {
  soltar(pantalla);
  pantalla = null;
  phase = "idle";
  channelId = null;
  startedAt = 0;
  recorder = null;
  chunks = [];
}

export function recordingSupported(): boolean {
  return typeof MediaRecorder === "function";
}

/** ¿Este cliente está grabando (o arrancando la grabación de) este canal? */
export function recordingLocally(canal: Snowflake): boolean {
  return channelId === canal && phase !== "idle";
}

/**
 * Pide grabar. Hay que estar DENTRO de la llamada: sin la mezcla de audio no
 * hay nada que capturar, y pedir el aviso sin poder cumplirlo dejaría a la
 * sala mirando un "va a grabar" eterno.
 */
export function requestRecording(canal: Snowflake): void {
  if (phase !== "idle" || !recordingSupported()) return;
  if (currentChannel() !== canal) return;
  phase = "waiting";
  channelId = canal;
  ordenar(canal, "CONSENTING");
}

/**
 * Parar, cuando quien graba quiera. Tres casos:
 * - aún no grababa (waiting): se cancela el aviso con FAILED, que es la única
 *   salida de CONSENTING que no es empezar;
 * - grabando aquí: se cierra el fichero y se entrega;
 * - la grabación es mía pero no de este cliente (otro dispositivo, o un
 *   recargo a mitad): se corta con FAILED, que `advanceRecording` permite a
 *   quien graba desde cualquier estado vivo.
 */
export function stopRecording(canal: Snowflake): void {
  if (channelId === canal && (phase === "waiting" || phase === "starting")) {
    ordenar(canal, "FAILED");
    reposo();
    return;
  }
  if (channelId === canal && phase === "recording") {
    terminar(true);
    return;
  }
  if (phase === "idle") ordenar(canal, "FAILED");
}

/** El store llama aquí con cada RECORDING_UPDATE. */
export function onRecordingUpdate(
  canal: Snowflake,
  grabacion: MeetingRecording | null,
  selfId: Snowflake | undefined,
): void {
  if (!selfId) return;

  // La instancia confirmó mi aviso: ahora sí, a capturar.
  if (
    phase === "waiting" &&
    channelId === canal &&
    grabacion?.recorder_id === selfId &&
    grabacion.state === "CONSENTING"
  ) {
    void empezar(canal);
    return;
  }

  // Un moderador la marcó fallida (o la reunión terminó): se corta, y lo ya
  // grabado se entrega igual —es el disco de quien graba, no del moderador.
  if (
    phase === "recording" &&
    channelId === canal &&
    grabacion?.recorder_id === selfId &&
    (grabacion.state === "FAILED" || grabacion.state === "DELETED")
  ) {
    terminar(false);
  }
}

/**
 * La imagen la elige quien graba en el selector del propio sistema (en el
 * escritorio, el de la app): la reunión entera, una ventana o una pestaña. Si
 * lo cancela, o el navegador no sabe capturar pantalla —móvil—, se graba solo
 * el audio, que es lo que había antes: cancelar el selector no debe tirar una
 * grabación ya anunciada a la sala.
 */
async function pedirPantalla(): Promise<MediaStream | null> {
  if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") return null;
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 30 } },
      // El sonido de la sala ya viene por el tap; el del sistema duplicaría voces.
      audio: false,
    });
  } catch {
    return null;
  }
}

function elegirMime(conVideo: boolean): string | undefined {
  const candidatos = conVideo
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["audio/webm;codecs=opus", "audio/webm"];
  return candidatos.find(
    (candidate) => typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(candidate),
  );
}

async function empezar(canal: Snowflake): Promise<void> {
  phase = "starting";
  const video = await pedirPantalla();
  // Pararon mientras el selector estaba abierto: `reposo` ya dejó esto en idle.
  if (phase !== "starting" || channelId !== canal) {
    soltar(video);
    return;
  }

  let stream: MediaStream;
  try {
    stream = startRecordTap();
  } catch {
    soltar(video);
    ordenar(canal, "FAILED");
    reposo();
    return;
  }

  pantalla = video;
  const pistaVideo = video?.getVideoTracks()[0] ?? null;
  const mezcla = new MediaStream([...stream.getAudioTracks(), ...(pistaVideo ? [pistaVideo] : [])]);
  const mime = elegirMime(Boolean(pistaVideo));
  try {
    recorder = new MediaRecorder(mezcla, {
      ...(mime ? { mimeType: mime } : {}),
      audioBitsPerSecond: 96_000,
      ...(pistaVideo ? { videoBitsPerSecond: 2_500_000 } : {}),
    });
  } catch {
    stopRecordTap();
    ordenar(canal, "FAILED");
    reposo();
    return;
  }

  // "Dejar de compartir" desde el aviso del navegador es parar de grabar: lo ya
  // grabado se entrega, seguir en audio a solas sorprendería a quien lo cortó.
  pistaVideo?.addEventListener("ended", () => {
    if (phase === "recording") terminar(true);
  });

  chunks = [];
  startedAt = Date.now();
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
    // Colgar o cambiar de sala también es parar: el tic de un segundo es el
    // sitio barato para notarlo sin acoplar este módulo al ciclo de la voz.
    if (phase === "recording" && currentChannel() !== channelId) terminar(true);
  };
  recorder.onerror = () => {
    if (phase === "recording") terminar(false);
  };
  recorder.start(1000);
  phase = "recording";
  ordenar(canal, "RECORDING");
}

function terminar(limpio: boolean): void {
  const canal = channelId;
  const inicio = startedAt;
  const activo = recorder;
  phase = "saving";
  recorder = null;
  if (!canal) {
    reposo();
    return;
  }
  if (!activo || activo.state === "inactive") {
    concluir(canal, limpio, inicio);
    return;
  }
  activo.onstop = () => concluir(canal, limpio, inicio);
  try {
    activo.stop();
  } catch {
    concluir(canal, limpio, inicio);
  }
}

function concluir(canal: Snowflake, limpio: boolean, inicio: number): void {
  stopRecordTap();
  if (limpio) ordenar(canal, "FINALIZING");
  const partes = chunks;
  chunks = [];
  // Se entrega SIEMPRE lo que haya: aunque el cierre fuera sucio, ese audio es
  // de quien grabó. Lo que cambia es lo que se afirma a la sala.
  const entregado = partes.length > 0 && guardar(partes, inicio);
  ordenar(canal, limpio && entregado ? "AVAILABLE" : "FAILED");
  reposo();
}

function guardar(partes: Blob[], inicio: number): boolean {
  try {
    const blob = new Blob(partes, { type: partes[0]?.type || "audio/webm" });
    const marca = new Date(inicio || Date.now()).toISOString().replace(/:/g, "-").slice(0, 19);
    const enlace = document.createElement("a");
    enlace.href = URL.createObjectURL(blob);
    enlace.download = `distop-reunion-${marca}.webm`;
    document.body.appendChild(enlace);
    enlace.click();
    enlace.remove();
    // Tiempo de sobra para que el navegador lea el blob; después, fuera.
    setTimeout(() => URL.revokeObjectURL(enlace.href), 60_000);
    return true;
  } catch {
    return false;
  }
}
