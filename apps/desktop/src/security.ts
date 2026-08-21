/**
 * Postura de seguridad del cascarón (§22).
 * El renderer es el cliente web completo hablando con instancias ajenas: se le
 * trata como a un navegador, no como a código de confianza. Nada navega fuera
 * del origen de la app, los enlaces se abren en el navegador del sistema y los
 * permisos delicados se conceden por lista blanca.
 */
import { BrowserWindow, Menu, desktopCapturer, session, shell } from "electron";
import { APP_ORIGIN } from "./protocol";

/** Permisos que el cliente usa de verdad; el resto se deniega sin preguntar. */
const GRANTED = new Set(["media", "notifications", "fullscreen", "clipboard-sanitized-write", "display-capture"]);

export function hardenSession(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED.has(permission));
  });

  /* En Electron getDisplayMedia no trae selector propio: sin esto, compartir
     pantalla se queda colgado. Un menú nativo con pantallas y ventanas es la
     selección que pide §15, sin inventar una UI aparte. */
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void desktopCapturer.getSources({ types: ["screen", "window"] }).then((sources) => {
      let answered = false;
      const pick = (source: Electron.DesktopCapturerSource) => {
        answered = true;
        callback({ video: source, audio: "loopback" });
      };
      const menu = Menu.buildFromTemplate(
        sources.map((source) => ({ label: source.name.slice(0, 60) || "—", click: () => pick(source) })),
      );
      menu.popup({
        callback: () => {
          // Cerrar el menú sin elegir es "no quiero compartir", no un error.
          setTimeout(() => {
            if (!answered) callback({});
          }, 0);
        },
      });
    });
  });
}

export function hardenWindow(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Un enlace de un mensaje abre en el navegador del sistema, jamás en una
    // ventana con acceso al preload. Esquemas raros (file:, app:) ni eso.
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    const dev = process.env.DISTOP_DEV_URL;
    if (url.startsWith(APP_ORIGIN) || (dev && url.startsWith(dev))) return;
    event.preventDefault();
  });
}
