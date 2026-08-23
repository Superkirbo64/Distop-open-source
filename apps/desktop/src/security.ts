/**
 * Postura de seguridad del cascarón (§22).
 * El renderer es el cliente web completo hablando con instancias ajenas: se le
 * trata como a un navegador, no como a código de confianza. Nada navega fuera
 * del origen de la app, los enlaces se abren en el navegador del sistema y los
 * permisos delicados se conceden por lista blanca.
 */
import { BrowserWindow, type WebContents, session, shell } from "electron";
import { APP_ORIGIN } from "./protocol";
import { pickSource } from "./picker";

/** Permisos que el cliente usa de verdad; el resto se deniega sin preguntar. */
const GRANTED = new Set(["media", "notifications", "fullscreen", "clipboard-sanitized-write", "display-capture"]);

export function hardenSession(getWindow: () => BrowserWindow | null): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED.has(permission));
  });

  /* En Electron getDisplayMedia no trae selector propio: sin esto, compartir
     pantalla se queda colgado. La ventana de picker.ts da la misma elección
     con miniaturas que el selector del navegador (§15). */
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    void pickSource(getWindow()).then((picked) => {
      if (!picked) {
        callback({});
        return;
      }
      callback(picked.audio ? { video: picked.source, audio: "loopback" } : { video: picked.source });
    });
  });
}

export function hardenWindow(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    // Un enlace de un mensaje abre en el navegador del sistema, jamás en una
    // ventana con acceso al preload. Esquemas raros (file:, app:) ni eso.
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });

  wc.on("will-navigate", (event, url) => {
    const dev = process.env.DISTOP_DEV_URL;
    if (url.startsWith(APP_ORIGIN) || (dev && url.startsWith(dev))) return;
    event.preventDefault();
  });
}
