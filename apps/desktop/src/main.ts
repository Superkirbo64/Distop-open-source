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
import { currentGame, lastGameScan, onGameChange, startGameWatch, stopGameWatch } from "./games";
import { setupTray } from "./tray";
import { setupUpdates } from "./updates";
import { type VoiceOverlayHandle, createVoiceOverlay } from "./voice-overlay";
import { type DesktopPrefs, loadDesktopPrefs, saveDesktopPrefs } from "./desktop-prefs";
import {
  forgetAvailabilityWatch,
  replaceAvailabilityWatches,
  setAvailabilityConnection,
  setupAvailability,
  type AvailabilityWatchInput,
} from "./availability";

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

/* Experimento A/B del plan de RAM (medir con DISTOP_METRICS antes de opinar):
   funde el proceso GPU en el principal (~30-80 MB menos de working set). NUNCA
   por defecto: la splash y el overlay usan ventanas transparentes, combinación
   con historial de fallos de composición con GPU in-process. Si algo se ve
   mal con la variable puesta, el veredicto es no-go y se borra este bloque. */
if (process.env["DISTOP_GPU_IN_PROCESS"]) {
  app.commandLine.appendSwitch("in-process-gpu");
}

// Dos copias de la app pelearían por la bandeja y por el puerto de la instancia.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow | null = null;
  let apps: AppViews | null = null;
  let splash: BrowserWindow | null = null;
  let splashStartedAt = 0;
  let revealing = false;
  let prefs: DesktopPrefs = { whatsapp: true, telegram: true, gameWatch: true };

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
    prefs = loadDesktopPrefs();
    createSplash();
    registerAppProtocol(webDistPath());
    hardenSession(() => win);

    ipcMain.handle("host:start", () => startHost());
    ipcMain.handle("host:stop", () => stopHost());
    ipcMain.handle("host:status", () => hostStatus());
    ipcMain.handle("games:current", () => currentGame());
    ipcMain.handle("games:scan", () => lastGameScan());
    ipcMain.handle("availability:replace", (_event, input: unknown) => {
      if (!Array.isArray(input)) return false;
      replaceAvailabilityWatches(input as AvailabilityWatchInput[]);
      return true;
    });
    ipcMain.on("availability:status", (_event, url: unknown, connected: unknown) => {
      if (typeof url !== "string" || typeof connected !== "boolean") return;
      setAvailabilityConnection(url, connected);
    });
    /* La instancia dejó de reconocer a esta persona como miembro. Eso solo lo
       ve la interfaz —el vigilante sondea sin credenciales, y sin ellas no hay
       forma de preguntarlo—, así que es la interfaz quien lo dice. */
    ipcMain.handle("availability:forget", (_event, url: unknown) =>
      typeof url === "string" && forgetAvailabilityWatch(url));

    /* Vigilancia de juegos bajo demanda: el toggle de Ajustes apaga el sondeo
       local entero (tasklist + registro), no solo el reporte al servidor. */
    ipcMain.handle("games:watch", () => prefs.gameWatch);
    ipcMain.handle("games:setWatch", (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") return prefs.gameWatch;
      if (enabled !== prefs.gameWatch) {
        prefs.gameWatch = enabled;
        saveDesktopPrefs(prefs);
        if (enabled) startGameWatch();
        else stopGameWatch();
      }
      return prefs.gameWatch;
    });

    /* Aplicaciones integradas: apagada = su pestaña desaparece y, si su vista
       vivía, se destruye entera. La sesión queda en disco (partition persist:). */
    ipcMain.handle("apps:prefs", () => ({ whatsapp: prefs.whatsapp, telegram: prefs.telegram }));
    ipcMain.handle("apps:set", (_event, id: unknown, enabled: unknown) => {
      if ((id !== "whatsapp" && id !== "telegram") || typeof enabled !== "boolean") return null;
      prefs[id] = enabled;
      saveDesktopPrefs(prefs);
      if (!enabled) apps?.disable(id);
      win?.webContents.send("shell:tabs", { whatsapp: prefs.whatsapp, telegram: prefs.telegram });
      return { whatsapp: prefs.whatsapp, telegram: prefs.telegram };
    });
    ipcMain.handle("shell:tabs", () => ({ whatsapp: prefs.whatsapp, telegram: prefs.telegram }));

    ipcMain.on("shell:switch", (_event, id: unknown) => {
      if (!isTabId(id)) return;
      // main es la autoridad: un id desactivado se ignora aunque llegue el IPC.
      if (id !== "distop" && !prefs[id]) return;
      apps?.show(id);
    });

    onHostStatus((status) => apps?.distop.webContents.send("host:status", status));
    onGameChange((game) => apps?.distop.webContents.send("games:change", game));

    createWindow();
    if (win) {
      setupAvailability(win);
      setupTray(win);

      /* El widget de llamada nace con la primera llamada y muere al colgar: en
         reposo no existe su renderer. El mismo aviso gobierna el throttling de
         la vista Distop: solo corre sin freno mientras hay llamada. */
      let voiceOverlay: VoiceOverlayHandle | null = null;
      let throttled = true;
      ipcMain.on("voice-overlay:update", (event, payload: unknown) => {
        // Solo el cliente Distop, nunca WhatsApp/Telegram, puede alimentar esta
        // ventana que queda por encima de las demás aplicaciones.
        if (event.sender !== apps?.distop.webContents || !win) return;
        const inCall =
          typeof payload === "object" &&
          payload !== null &&
          typeof (payload as Record<string, unknown>)["channelId"] === "string";

        if (apps && inCall === throttled) {
          throttled = !inCall;
          apps.distop.webContents.setBackgroundThrottling(throttled);
        }

        if (!voiceOverlay) {
          if (!inCall) return;
          voiceOverlay = createVoiceOverlay(win);
        }
        if (inCall) {
          voiceOverlay.update(payload);
        } else {
          voiceOverlay.destroy();
          voiceOverlay = null;
        }
      });
    }
    setupUpdates();
    if (prefs.gameWatch) startGameWatch();

    /* Medición A/B del plan de RAM: DISTOP_METRICS=1 vuelca el working set de
       cada proceso cada 20 s. Cuenta páginas compartidas varias veces: sirve
       para comparar deltas del mismo escenario, no como cifra absoluta. */
    if (process.env["DISTOP_METRICS"]) {
      setInterval(() => {
        const rows = app.getAppMetrics().map((metric) => ({
          type: metric.type,
          pid: metric.pid,
          svc: metric.serviceName ?? metric.name ?? "",
          wsMB: Math.round(metric.memory.workingSetSize / 1024),
        }));
        const total = rows.reduce((sum, row) => sum + row.wsMB, 0);
        console.log(`[mem] total=${total}MB`, JSON.stringify(rows));
      }, 20_000);
    }
  });

  // Con bandeja, cerrar la última ventana no significa salir: en Windows la app
  // sigue en la bandeja (y la instancia local, si corre, sigue sirviendo).
  app.on("window-all-closed", () => {
    if (process.platform !== "win32") app.quit();
  });
}
