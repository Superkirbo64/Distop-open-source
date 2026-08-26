/**
 * Enchufe de Electron para la vigilancia de instancias (§2.2 y §6.4 del plan).
 *
 * Aquí solo vive lo que necesita Electron: dónde guarda el estado la
 * aplicación, qué significa "avisar" y "abrir", y por dónde le llega a la
 * interfaz lo que no se cuenta con una ventana emergente. El motor está en
 * availability-watcher, sin Electron, para poder probarlo entero.
 */
import { Notification, app, type BrowserWindow } from "electron";
import { join } from "node:path";
import {
  createAvailabilityWatcher,
  type AvailabilityWatcher,
  type AvailabilityWatchInput,
  type WatchAlert,
  type WatchNotice,
} from "./availability-watcher";

export type { AvailabilityWatchInput };

let windowRef: BrowserWindow | null = null;
let watcher: AvailabilityWatcher | null = null;

/**
 * Dos textos y ni uno más.
 *
 * "Volvió" y "se trasladó" no son matices del mismo aviso: el primero lleva a
 * la misma dirección de siempre y el segundo lleva a un equipo distinto. Decir
 * "volvió" cuando en realidad cambió de máquina sería mentir sobre lo único que
 * el aviso tiene que dejar claro.
 */
function texto(notice: WatchNotice): { body: string; open: string } {
  if (notice.kind === "moved") {
    return { body: `${notice.name} se trasladó a otro equipo. Toca para continuar allí.`, open: notice.origin };
  }
  return { body: `${notice.name} volvió a estar disponible.`, open: notice.url };
}

export function setupAvailability(win: BrowserWindow): void {
  windowRef = win;
  watcher = createAvailabilityWatcher({
    statePath: join(app.getPath("userData"), "availability-watch.json"),
    notify(notice) {
      if (!Notification.isSupported()) return;
      const { body, open } = texto(notice);
      const notification = new Notification({ title: "Distop", body });
      notification.on("click", () => {
        windowRef?.show();
        windowRef?.focus();
        windowRef?.webContents.send("availability:open", open);
      });
      notification.show();
    },
    /* Sin ventana emergente a propósito. Un conflicto de identidad no se mira
       de reojo en una esquina mientras haces otra cosa: se guarda y se enseña
       al abrir, con contexto y con la opción de no aceptar nada. */
    alert(alert: WatchAlert) {
      windowRef?.webContents.send("availability:alert", alert);
    },
  });
  watcher.start();
}

export function replaceAvailabilityWatches(input: AvailabilityWatchInput[]): void {
  watcher?.replace(input);
}

export function setAvailabilityConnection(url: string, connected: boolean): void {
  watcher?.setConnection(url, connected);
}

/** La instancia dejó de reconocer a esta persona: fuera vigilancia y fuera nombre. */
export function forgetAvailabilityWatch(url: string): boolean {
  return watcher?.forget(url) ?? false;
}
