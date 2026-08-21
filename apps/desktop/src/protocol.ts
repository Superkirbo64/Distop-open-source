/**
 * El origen de la aplicación: app://distop
 *
 * El cliente web viaja DENTRO de la app y se sirve desde este protocolo, no
 * desde ninguna instancia (§4): así la pantalla de conexión existe aunque no
 * haya ningún servidor vivo, y una instancia caída nunca deja la app en blanco.
 * El esquema se registra como `standard + secure` para que las rutas absolutas
 * del build de Vite (/assets/…) resuelvan contra este origen sin tocar el build.
 */
import { net, protocol } from "electron";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

export const APP_ORIGIN = "app://distop";

// Antes de app.ready o no vale: Electron lo exige para esquemas privilegiados.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

/**
 * El cliente empaquetado habla con instancias arbitrarias elegidas por la
 * persona, así que connect/img/media admiten http(s) y ws(s) genéricos; lo que
 * queda cerrado es de dónde puede venir CÓDIGO: solo de la propia app.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https: http:",
  "media-src 'self' blob: https: http:",
  "connect-src 'self' https: http: wss: ws:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
].join("; ");

export function registerAppProtocol(webDist: string): void {
  const root = normalize(webDist);

  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    if (url.host !== "distop") return new Response("", { status: 404 });

    const asked = normalize(join(root, decodeURIComponent(url.pathname)));
    // Path traversal: nada fuera del build del cliente, ni con ../ codificados.
    if (asked !== root && !asked.startsWith(root + "\\") && !asked.startsWith(root + "/")) {
      return new Response("", { status: 403 });
    }

    // Rutas del SPA (/invite/abc) no son ficheros: caen al index, como en la instancia.
    const file = existsSync(asked) && statSync(asked).isFile() ? asked : join(root, "index.html");
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set("content-security-policy", CSP);
    return new Response(res.body, { status: res.status, headers });
  });
}
