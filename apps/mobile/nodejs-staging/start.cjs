/**
 * Arranque del servidor dentro del APK (nodejs-mobile / Capacitor-NodeJS).
 *
 * CJS a propósito: es lo que el runtime móvil ejecuta como entrada, y desde
 * aquí se hace import() del servidor ESM. Fuera del móvil (pruebas en un
 * escritorio con Node) también corre: el módulo `bridge` solo existe dentro
 * de la app, y sin él los datos van a un directorio corriente.
 */
const path = require("node:path");
const os = require("node:os");

let dataRoot = path.join(os.homedir() || os.tmpdir(), "distop-phone-data");
try {
  // Solo existe dentro del APK: la ruta de datos privada y persistente de la app.
  const bridge = require("bridge");
  dataRoot = path.join(bridge.getDataPath(), "distop");
} catch {
  // Pruebas en escritorio: seguimos con el directorio corriente.
}

process.env.PORT = process.env.PORT || "5000";
process.env.HOST = process.env.HOST || "0.0.0.0";
process.env.DATABASE_PATH = process.env.DATABASE_PATH || path.join(dataRoot, "app.db");
process.env.DEFAULT_STORAGE_PATH = process.env.DEFAULT_STORAGE_PATH || path.join(dataRoot, "uploads");
// El teléfono no reparte el cliente web: quien entra desde otro aparato usa su
// propia app. Una ruta que no existe hace que el servidor sirva solo la API.
process.env.WEB_DIST_PATH = process.env.WEB_DIST_PATH || path.join(__dirname, "sin-cliente");

// Node 18 aún no expone webcrypto como global `crypto` (llegó en Node 19).
if (!globalThis.crypto) globalThis.crypto = require("node:crypto").webcrypto;

import("./node-server/server.js").catch((err) => {
  console.error("[distop] el servidor no arrancó:", err);
});
