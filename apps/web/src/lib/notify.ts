/**
 * Avisos de mensaje nuevo (§9.2).
 *
 * Dos canales distintos, y los dos se pueden apagar por separado:
 *   · el pack SND01 adaptado e incluido en la propia aplicación;
 *   · una notificación del sistema, que exige permiso explícito del navegador
 *     y solo se pide cuando la persona lo activa a mano en Ajustes.
 *
 * Nada de esto se dispara si estás mirando el canal: avisar de lo que ya tienes
 * delante entrena a la gente a ignorar los avisos.
 */

export type NotifyLevel = "all" | "mentions" | "off";

/**
 * Un AudioContext por pestaña, creado al primer aviso.
 * Los navegadores lo dejan suspendido hasta que hay un gesto de la persona; por
 * eso se intenta reanudar en cada aviso en vez de darlo por muerto.
 */
let audio: AudioContext | null = null;
let soundsEnabled = true;
const cache = new Map<string, Promise<AudioBuffer>>();
const UI_VOLUME = 0.46;

export type UiSound =
  | "message"
  | "mention"
  | "on"
  | "off"
  | "voice_join"
  | "voice_leave"
  | "mute_on"
  | "mute_off"
  | "deafen_on"
  | "deafen_off"
  | "camera_on"
  | "camera_off"
  | "screen_on"
  | "screen_off";

/** Evita importar el store aquí: el store ya importa este módulo. */
export function setSoundsEnabled(enabled: boolean): void {
  soundsEnabled = enabled;
}

function context(): AudioContext {
  audio ??= new AudioContext();
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

function loadUiSound(name: UiSound): Promise<AudioBuffer> {
  const existing = cache.get(name);
  if (existing) return existing;
  const ctx = context();
  const pending = fetch(`/sounds/${name}.wav`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .then((bytes) => ctx.decodeAudioData(bytes));
  cache.set(name, pending);
  pending.catch(() => cache.delete(name));
  return pending;
}

/** Reproduce un sample local; la segunda vez ya está decodificado en memoria. */
export function playUi(name: UiSound): void {
  if (!soundsEnabled || typeof AudioContext !== "function") return;
  try {
    const ctx = context();
    void loadUiSound(name)
      .then((buffer) => {
        const source = ctx.createBufferSource();
        const gain = ctx.createGain();
        gain.gain.value = UI_VOLUME;
        source.buffer = buffer;
        source.connect(gain).connect(ctx.destination);
        source.start();
      })
      .catch((error: unknown) => console.warn(`[Distop] No se pudo reproducir /sounds/${name}.wav`, error));
  } catch (error) {
    console.warn(`[Distop] No hay salida de audio para /sounds/${name}.wav`, error);
  }
}

function canNotify(): boolean {
  return typeof Notification !== "undefined";
}

export function notifyPermission(): NotificationPermission | "unsupported" {
  return canNotify() ? Notification.permission : "unsupported";
}

/** Solo desde un gesto de la persona: los navegadores rechazan el resto. */
export async function askNotifyPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!canNotify()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

export interface NotifyInput {
  title: string;
  body: string;
  /** Uno por canal: veinte mensajes seguidos no apilan veinte notificaciones. */
  tag: string;
  mention: boolean;
  level: NotifyLevel;
  sound: boolean;
  onClick?: (() => void) | undefined;
}

export function notify(input: NotifyInput): void {
  if (input.level === "off") return;
  if (input.level === "mentions" && !input.mention) return;

  if (input.sound) playUi(input.mention ? "mention" : "message");

  // La notificación del sistema solo cuando la ventana no está a la vista: si
  // está delante, el sonido y el contador de la barra lateral ya lo dicen.
  if (!document.hidden || notifyPermission() !== "granted") return;
  try {
    const notification = new Notification(input.title, {
      body: input.body.slice(0, 240),
      tag: input.tag,
      // Nunca renotifica el mismo canal: sustituye la anterior en silencio.
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      input.onClick?.();
      notification.close();
    };
  } catch {
    // Safari en iOS no la deja construir fuera de un service worker.
  }
}
