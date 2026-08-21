/**
 * Dónde están las piezas empaquetadas.
 * La disposición replica el repo a propósito: el node-server localiza el
 * cliente web en `../web/dist` relativo a sí mismo, y así funciona idéntico
 * dentro del instalador y en un checkout de desarrollo, sin variables extra.
 */
import { app } from "electron";
import { join } from "node:path";

/** Carpeta con el build de Vite que sirve el protocolo app:// */
export function webDistPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "web", "dist")
    : join(__dirname, "..", "..", "web", "dist");
}

/** Carpeta con el código del node-server que arranca "Hospedar aquí". */
export function serverPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "node-server")
    : join(__dirname, "..", "..", "node-server");
}

/** Datos de la instancia local: base de datos, archivos y secreto. */
export function instanceDataPath(): string {
  return join(app.getPath("userData"), "instance");
}
