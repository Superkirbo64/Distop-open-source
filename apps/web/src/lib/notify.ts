/**
 * Avisos de mensaje nuevo (§9.2).
 *
 * Dos canales distintos, y los dos se pueden apagar por separado:
 *   · un sonido corto, sintetizado aquí mismo — ningún archivo que descargar,
 *     ninguna petición extra, y funciona igual en una instancia sin internet;
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

function beep(mention: boolean): void {
  try {
    audio ??= new AudioContext();
    if (audio.state === "suspended") void audio.resume();

    const now = audio.currentTime;
    // Una mención suena a dos notas ascendentes; un mensaje normal, a una sola.
    // Se distinguen sin mirar la pantalla, que es justo para lo que sirve.
    const notes = mention ? [660, 880] : [520];

    notes.forEach((frequency, index) => {
      const oscillator = audio!.createOscillator();
      const gain = audio!.createGain();
      const start = now + index * 0.09;

      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      // Rampa en vez de corte seco: un corte suena a "clic" en cualquier altavoz.
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(mention ? 0.08 : 0.05, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);

      oscillator.connect(gain).connect(audio!.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.18);
    });
  } catch {
    // Sin salida de audio no pasa nada: el aviso visual sigue estando.
  }
}

export function canNotify(): boolean {
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

  if (input.sound) beep(input.mention);

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
