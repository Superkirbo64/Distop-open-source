/**
 * Formatos que los navegadores actuales pueden producir con MediaRecorder.
 * El orden favorece Opus porque da voz clara con archivos pequeños; Safari
 * suele caer en MP4/AAC y Firefox puede preferir Ogg.
 */
export const VOICE_MESSAGE_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
] as const;

export function voiceMessagesSupported(): boolean {
  return (
    typeof MediaRecorder === "function" &&
    typeof navigator.mediaDevices?.getUserMedia === "function"
  );
}

export function chooseVoiceMessageMime(
  supported: (mime: string) => boolean = (mime) =>
    typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(mime),
): string | undefined {
  return VOICE_MESSAGE_MIME_TYPES.find(supported);
}

/** La cabecera HTTP no lleva el parámetro codecs: la instancia valida el tipo base. */
export function baseAudioMime(mime: string): string {
  const base = mime.split(";", 1)[0]?.trim().toLowerCase();
  return base?.startsWith("audio/") ? base : "audio/webm";
}

export function audioExtension(mime: string): "webm" | "ogg" | "m4a" {
  const base = baseAudioMime(mime);
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  return "webm";
}

export function formatVoiceMessageTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * Cuántas barras enseña la insignia mientras grabas.
 *
 * Pocas y a propósito: es un pulso que dice «te estoy oyendo», no un editor de
 * audio. Con más barras la insignia crecería hasta competir con el cuadro de
 * escribir, que es lo que se estaba mirando.
 */
export const WAVE_BARS = 18;

/**
 * Mete una muestra nueva por la derecha y tira la más vieja: el rastro avanza
 * como en WhatsApp en vez de repintarse entero.
 */
export function pushWaveSample(bars: readonly number[], level: number): number[] {
  const acotado = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return [...bars, acotado].slice(-WAVE_BARS);
}

/**
 * De cuánto suena a cuánto se ve.
 *
 * El nivel crudo de un micrófono normal se queda en la parte baja del rango y
 * pintado tal cual da una línea plana que parece que no graba. La raíz sube los
 * niveles bajos sin saturar los altos, y el mínimo deja la barra visible en
 * silencio: una barra de altura cero se lee como «se colgó», no como «callado».
 */
export function waveHeight(level: number): number {
  const acotado = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  return Math.min(1, 0.16 + Math.sqrt(acotado) * 0.84);
}
