/**
 * Enchufe de Electron para la vigilancia de instancias (§2.2 del plan).
 *
 * Aquí solo vive lo que necesita Electron: dónde guarda el estado la
 * aplicación, y qué significa "avisar" y "abrir". El motor está en
 * availability-watcher, sin Electron, para poder probarlo entero.
 */
import { Notification, app, type BrowserWindow } from "electron";
import { join } from "node:path";
import { createAvailabilityWatcher, type AvailabilityWatcher, type AvailabilityWatchInput } from "./availability-watcher";

export type { AvailabilityWatchInput };

let windowRef: BrowserWindow | null = null;
let watcher: AvailabilityWatcher | null = null;

export function setupAvailability(win: BrowserWindow): void {
  windowRef = win;
  watcher = createAvailabilityWatcher({
    statePath: join(app.getPath("userData"), "availability-watch.json"),
    notify(body, url) {
      if (!Notification.isSupported()) return;
      const notification = new Notification({ title: "Distop", body });
      notification.on("click", () => {
        windowRef?.show();
        windowRef?.focus();
        windowRef?.webContents.send("availability:open", url);
      });
      notification.show();
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
