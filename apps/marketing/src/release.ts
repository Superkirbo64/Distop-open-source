/**
 * De dónde se descarga Distop y con qué nombre llega el archivo.
 *
 * Todo esto se salió de sitio una vez: la guía decía «Distop Setup 0.1.1.exe»
 * mientras el instalador era 0.1.0, y el botón apuntaba a un archivo subido a
 * mano que nadie podía verificar contra ningún commit. Las dos cosas eran el
 * mismo fallo —una constante copiada en varios sitios— así que aquí hay una
 * sola, y el resto la lee.
 *
 * La versión sale del `package.json` que **construye el instalador**, no de una
 * cadena escrita aparte: si sube la del paquete, sube la de la guía, y no hay
 * ninguna forma de que discrepen.
 */
import desktop from "../../desktop/package.json";

/** El repositorio. Lo usan la descarga, el pie de página y la portada. */
export const REPO_URL = "https://github.com/Superkirbo64/Distop-open-source";

/** La versión que se está ofreciendo, tal cual la lleva el instalador. */
export const APP_VERSION: string = desktop.version;

/** El tag que publica esa versión (`.github/workflows/release.yml` escucha `v*`). */
export const RELEASE_TAG = `v${APP_VERSION}`;

/**
 * El nombre del archivo tal como lo escribe electron-builder y tal como lo
 * guarda el navegador: con espacios. Es el que la persona ve en su carpeta de
 * descargas, así que es el que debe aparecer en la guía.
 */
export const INSTALLER_NAME = `Distop Setup ${APP_VERSION}.exe`;

/**
 * La descarga directa del artefacto publicado en la release.
 *
 * GitHub sustituye los espacios del nombre por puntos al servir el activo, de
 * ahí la diferencia con `INSTALLER_NAME`. Esta URL solo funciona una vez que
 * existe el tag: sin release publicada, el enlace da 404 —que es preferible a
 * ofrecer un archivo viejo como si fuera el actual.
 */
export const DOWNLOAD_URL = `${REPO_URL}/releases/download/${RELEASE_TAG}/${INSTALLER_NAME.replace(/ /g, ".")}`;

/** La página de la release, para quien quiera ver el resto de archivos y el hash. */
export const RELEASE_URL = `${REPO_URL}/releases/tag/${RELEASE_TAG}`;
