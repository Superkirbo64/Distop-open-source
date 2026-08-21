/**
 * Actualizaciones de la app (§15) contra GitHub Releases: el único canal de
 * distribución que no cuesta nada (§3). electron-updater lee el feed que
 * electron-builder deja escrito en el paquete (app-update.yml).
 *
 * Solo avisa y descarga; instalar es decisión de la persona al cerrar. Una
 * actualización jamás interrumpe una llamada.
 */
import { app } from "electron";

export function setupUpdates(): void {
  // En desarrollo no hay paquete ni feed: no hay nada que comprobar.
  if (!app.isPackaged) return;

  void (async () => {
    try {
      const { autoUpdater } = await import("electron-updater");
      autoUpdater.autoDownload = true;
      autoUpdater.autoInstallOnAppQuit = true;
      await autoUpdater.checkForUpdatesAndNotify();
      // Quien deja la app abierta días también se entera (§28.6).
      setInterval(() => void autoUpdater.checkForUpdatesAndNotify().catch(() => {}), 4 * 60 * 60_000);
    } catch {
      // Sin red o sin release publicada: la app funciona igual; se reintenta al
      // siguiente arranque.
    }
  })();
}
