/**
 * El vigilante de instancias, para el cascarón Tauri.
 *
 * Es el MISMO motor que usa Electron (`apps/desktop/src/availability-watcher.ts`),
 * corriendo como sidecar de Node y hablando por líneas JSON. No es un puerto a
 * Rust a propósito: verificar una cadena de sucesión son firmas ES256 sobre
 * JSON canónico, y esas reglas viven en un solo sitio —`@distop/protocol`—
 * justo para que dos cascarones no lleguen a conclusiones distintas sobre si
 * una comunidad "volvió" o "se trasladó". Un segundo juego de reglas en otro
 * lenguaje es exactamente el fallo que esa decisión evita.
 *
 * El precio es un `node.exe` vivo mientras hay algo que vigilar. Por eso lo
 * arranca y lo para el lado Rust según haya vigilancias o no: quien no use la
 * función no paga la memoria.
 *
 * Entrada (una línea JSON por orden):
 *   {"cmd":"replace","items":[…]}
 *   {"cmd":"status","url":"https://…","connected":true}
 *   {"cmd":"forget","url":"https://…"}
 *
 * Salida (una línea JSON por aviso):
 *   {"event":"notice","notice":{…}}
 *   {"event":"alert","alert":{…}}
 */
import { createInterface } from "node:readline";
import { createAvailabilityWatcher, type AvailabilityWatchInput } from "./availability-watcher.ts";

const estado = process.env.DISTOP_WATCH_STATE;
if (!estado) {
  process.stderr.write("falta DISTOP_WATCH_STATE\n");
  process.exit(2);
}

/** Una línea por mensaje: si el JSON llevara saltos, el otro lado los partiría. */
function emitir(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

const vigilante = createAvailabilityWatcher({
  statePath: estado,
  notify: (notice) => emitir({ event: "notice", notice }),
  alert: (alert) => emitir({ event: "alert", alert }),
});

vigilante.start();

const lineas = createInterface({ input: process.stdin });

lineas.on("line", (linea) => {
  if (!linea.trim()) return;
  let orden: unknown;
  try {
    orden = JSON.parse(linea);
  } catch {
    /* Una línea rota no tumba la vigilancia: se ignora y se sigue. El emisor
       es el propio cascarón, así que esto solo puede pasar por un fallo de
       escritura, y perder una orden es mejor que perder el proceso. */
    return;
  }
  if (!orden || typeof orden !== "object") return;
  const mensaje = orden as { cmd?: unknown; items?: unknown; url?: unknown; connected?: unknown };

  if (mensaje.cmd === "replace" && Array.isArray(mensaje.items)) {
    vigilante.replace(mensaje.items as AvailabilityWatchInput[]);
    return;
  }
  if (mensaje.cmd === "status" && typeof mensaje.url === "string" && typeof mensaje.connected === "boolean") {
    vigilante.setConnection(mensaje.url, mensaje.connected);
    return;
  }
  if (mensaje.cmd === "forget" && typeof mensaje.url === "string") {
    vigilante.forget(mensaje.url);
  }
});

/* Cerrar la entrada es la señal de apagado: el cascarón suelta el pipe y este
   proceso termina solo, sin necesitar que nadie lo mate. */
lineas.on("close", () => {
  vigilante.stop();
  process.exit(0);
});
