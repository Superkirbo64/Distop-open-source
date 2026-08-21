/**
 * Proceso principal de la app de escritorio (§15).
 * El cascarón hace tres cosas y nada más: servir el cliente web empaquetado
 * (app://distop), hospedar la instancia local cuando se pide, y contar lo que
 * solo un proceso nativo puede saber (bandeja, juego abierto, actualizaciones).
 * Toda la lógica de comunidades sigue viviendo en el cliente web compartido.
 */
import { BrowserWindow, app, ipcMain } from "electron";
import { join } from "node:path";
import { APP_ORIGIN, registerAppProtocol } from "./protocol";
import { hardenSession, hardenWindow } from "./security";
import { webDistPath } from "./paths";
import { hostStatus, onHostStatus, startHost, stopHost } from "./host";
import { currentGame, onGameChange, startGameWatch } from "./games";
import { setupTray } from "./tray";
import { setupUpdates } from "./updates";

// El nombre manda sobre el del paquete npm: decide la carpeta de userData
// (AppData/Roaming/Distop), donde viven la instancia local y las preferencias.
app.setName("Distop");
// Sin esto las notificaciones en Windows salen como "electron.app.Electron".
app.setAppUserModelId("com.distop.app");

// Dos copias de la app pelearían por la bandeja y por el puerto de la instancia.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: "#0b0a14",
      show: false,
      autoHideMenuBar: true,
      icon: join(__dirname, "..", "build", "icon.ico"),
      webPreferences: {
        preload: join(__dirname, "preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    hardenWindow(win);
    win.once("ready-to-show", () => win?.show());
    void win.loadURL(process.env.DISTOP_DEV_URL ?? `${APP_ORIGIN}/index.html`);
  };

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    registerAppProtocol(webDistPath());
    hardenSession();

    ipcMain.handle("host:start", () => startHost());
    ipcMain.handle("host:stop", () => stopHost());
    ipcMain.handle("host:status", () => hostStatus());
    ipcMain.handle("games:current", () => currentGame());

    onHostStatus((status) => win?.webContents.send("host:status", status));
    onGameChange((game) => win?.webContents.send("games:change", game));

    createWindow();
    if (win) setupTray(win);
    setupUpdates();
    startGameWatch();
  });

  // Con bandeja, cerrar la última ventana no significa salir: en Windows la app
  // sigue en la bandeja (y la instancia local, si corre, sigue sirviendo).
  app.on("window-all-closed", () => {
    if (process.platform !== "win32") app.quit();
  });
}
