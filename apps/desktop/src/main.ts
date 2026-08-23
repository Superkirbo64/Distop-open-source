/**
 * Proceso principal de la app de escritorio (§15).
 * El cascarón hace tres cosas y nada más: servir el cliente web empaquetado
 * (app://distop), hospedar la instancia local cuando se pide, y contar lo que
 * solo un proceso nativo puede saber (bandeja, juego abierto, actualizaciones).
 * Toda la lógica de comunidades sigue viviendo en el cliente web compartido.
 */
import { BrowserWindow, app, globalShortcut, ipcMain } from "electron";
import { join } from "node:path";
import { APP_ORIGIN, registerAppProtocol } from "./protocol";
import { hardenSession, hardenWindow } from "./security";
import { type AppViews, createAppViews } from "./apps";
import { isTabId } from "./apps-policy";
import { webDistPath } from "./paths";
import { hostStatus, onHostStatus, startHost, stopHost } from "./host";
import { currentGame, lastGameScan, onGameChange, startGameWatch } from "./games";
import { setupTray } from "./tray";
import { setupUpdates } from "./updates";
import { createVoiceOverlay } from "./voice-overlay";

// La presentación completa acompaña el reveal de Universfield sin cortarlo.
const MIN_SPLASH_MS = 3_050;
const SPLASH_EXIT_MS = 260;

// Alto de la franja de aplicaciones, que ocupa el sitio de la barra de título.
const TAB_STRIP_H = 36;

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
  let apps: AppViews | null = null;
  let splash: BrowserWindow | null = null;
  let splashStartedAt = 0;
  let revealing = false;

  const toggleFullscreen = (): void => {
    if (!win || win.isDestroyed()) return;
    win.setFullScreen(!win.isFullScreen());
  };

  /* F11 pertenece al cascarón, no a la vista que tenga el foco. Pantalla
     completa real: la vista ocupa también los 36 px de la franja y esta queda
     completamente tapada hasta volver a pulsar F11. */
  app.on("web-contents-created", (_event, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (
        input.type !== "keyDown" ||
        (input.key !== "F11" && input.code !== "F11") ||
        input.isAutoRepeat
      ) return;
      event.preventDefault();
      toggleFullscreen();
    });
  });

  const createSplash = (): void => {
    splashStartedAt = Date.now();
    splash = new BrowserWindow({
      width: 580,
      height: 360,
      transparent: true,
      backgroundColor: "#00000000",
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: true,
      skipTaskbar: true,
      show: false,
      center: true,
      hasShadow: true,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        devTools: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });

    splash.setMenuBarVisibility(false);
    splash.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    splash.webContents.on("will-navigate", (event) => event.preventDefault());
    splash.once("ready-to-show", () => splash?.show());
    splash.once("closed", () => {
      splash = null;
    });
    void splash.loadFile(join(__dirname, "..", "src", "splash.html")).catch(() => {
      splash?.destroy();
      splash = null;
    });
  };

  /** La splash nunca retrasa una carga lenta: espera a la app real. Solo fija
      un mínimo para que la entrada no sea un destello en equipos rápidos. */
  const revealMain = (): void => {
    if (revealing || !win) return;
    revealing = true;
    const wait = splash ? Math.max(0, MIN_SPLASH_MS - (Date.now() - splashStartedAt)) : 0;
    setTimeout(() => {
      const currentSplash = splash;
      if (!currentSplash || currentSplash.isDestroyed()) {
        win?.show();
        win?.focus();
        return;
      }
      void currentSplash.webContents
        .executeJavaScript('document.body.classList.add("is-leaving")')
        .catch(() => undefined)
        .finally(() => {
          setTimeout(() => {
            if (!currentSplash.isDestroyed()) currentSplash.close();
            win?.show();
            win?.focus();
          }, SPLASH_EXIT_MS);
        });
    }, wait);
  };

  const createWindow = (): void => {
    win = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 720,
      minHeight: 480,
      backgroundColor: "#0b0a14",
      show: false,
      autoHideMenuBar: true,
      // F11 usa el modo de pantalla completa real de Windows. Si esto queda en
      // false, Electron recibe el atajo pero Windows rechaza el cambio.
      fullscreenable: true,
      icon: join(__dirname, "..", "build", "icon.ico"),
      // Windows no deja añadir nada a su barra de título: o da la suya entera,
      // o la dibuja la app y el sistema pinta encima sus tres botones. Aquí la
      // dibujamos para poder cambiar entre Distop, WhatsApp y Telegram (§15).
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#0b0a14", symbolColor: "#e8eaf2", height: TAB_STRIP_H },
      webPreferences: {
        preload: join(__dirname, "shell-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // La ventana solo contiene la franja; las aplicaciones son vistas hijas.
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    void win.loadFile(join(__dirname, "..", "src", "shell.html"));

    apps = createAppViews(
      win,
      TAB_STRIP_H,
      process.env.DISTOP_DEV_URL ?? `${APP_ORIGIN}/index.html`,
      join(__dirname, "preload.js"),
    );
    hardenWindow(apps.distop.webContents);
    win.on("resize", () => apps?.layout());
    win.on("enter-full-screen", () => apps?.layout());
    win.on("leave-full-screen", () => apps?.layout());

    /* Chromium/Windows puede reservar F11 antes de entregárselo a la vista.
       El acelerador nativo evita ese hueco, pero solo se registra mientras
       Distop tiene el foco para no robar F11 a juegos u otras aplicaciones. */
    const registerFullscreenShortcut = (): void => {
      if (!globalShortcut.isRegistered("F11")) globalShortcut.register("F11", toggleFullscreen);
    };
    const unregisterFullscreenShortcut = (): void => {
      if (globalShortcut.isRegistered("F11")) globalShortcut.unregister("F11");
    };
    win.on("focus", registerFullscreenShortcut);
    win.on("blur", unregisterFullscreenShortcut);
    win.on("closed", unregisterFullscreenShortcut);

    // Manda el cliente, no la ventana: la franja está lista mucho antes que él.
    // Y una URL rota no debe dejar a nadie mirando la splash para siempre.
    apps.distop.webContents.once("did-finish-load", revealMain);
    apps.distop.webContents.once("did-fail-load", revealMain);
  };

  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    createSplash();
    registerAppProtocol(webDistPath());
    hardenSession(() => win);

    ipcMain.handle("host:start", () => startHost());
    ipcMain.handle("host:stop", () => stopHost());
    ipcMain.handle("host:status", () => hostStatus());
    ipcMain.handle("games:current", () => currentGame());
    ipcMain.handle("games:scan", () => lastGameScan());

    ipcMain.on("shell:switch", (_event, id: unknown) => {
      if (isTabId(id)) apps?.show(id);
    });

    onHostStatus((status) => apps?.distop.webContents.send("host:status", status));
    onGameChange((game) => apps?.distop.webContents.send("games:change", game));

    createWindow();
    if (win) {
      setupTray(win);
      const voiceOverlay = createVoiceOverlay(win);
      ipcMain.on("voice-overlay:update", (event, payload: unknown) => {
        // Solo el cliente Distop, nunca WhatsApp/Telegram, puede alimentar esta
        // ventana que queda por encima de las demás aplicaciones.
        if (event.sender === apps?.distop.webContents) voiceOverlay.update(payload);
      });
    }
    setupUpdates();
    startGameWatch();
  });

  // Con bandeja, cerrar la última ventana no significa salir: en Windows la app
  // sigue en la bandeja (y la instancia local, si corre, sigue sirviendo).
  app.on("window-all-closed", () => {
    if (process.platform !== "win32") app.quit();
  });
}
