/**
 * Descarga el modelo de segmentación de persona que usa el fondo de cámara
 * (difuminar o sustituir el fondo en las llamadas, §9.5 / §10).
 *
 * Como fetch-emoji-catalog.mjs, es un script de una vez: el modelo se versiona
 * en el repo para que clonar y self-hostear no dependa de que Google siga
 * sirviendo el archivo, ni meta una descarga a un tercero en mitad de una
 * llamada. Se vuelve a correr solo si algún día conviene otra versión.
 *
 *   node scripts/fetch-segmenter-model.mjs
 *
 * Fuente (Apache-2.0, el aviso va en THIRD_PARTY_NOTICES.md):
 *   MediaPipe Selfie Segmenter, variante "landscape" en float16 (~250 KB).
 *   La variante landscape existe justo para videollamada: entrada 256×144,
 *   más rápida que la cuadrada y pensada para cámaras apaisadas.
 *
 * El runtime WASM que ejecuta el modelo NO se descarga aquí: viene del paquete
 * npm @mediapipe/tasks-vision y Vite lo empaqueta con el resto de la app.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "apps", "web", "public", "models");
const OUT = join(OUT_DIR, "selfie_segmenter_landscape.tflite");

// "latest" a propósito: el script se corre a mano y lo que queda fijado es el
// archivo versionado en el repo, no la URL.
const URL_MODEL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter_landscape/float16/latest/selfie_segmenter_landscape.tflite";

const response = await fetch(URL_MODEL);
if (!response.ok) {
  console.error(`Descarga fallida: ${response.status} ${response.statusText}`);
  process.exit(1);
}
const bytes = new Uint8Array(await response.arrayBuffer());
// Un tflite real empieza por su cabecera FlatBuffers; un HTML de error, no.
const magic = String.fromCharCode(...bytes.slice(4, 8));
if (magic !== "TFL3") {
  console.error(`El archivo descargado no parece un modelo tflite (cabecera "${magic}").`);
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, bytes);
console.log(`Modelo guardado en ${OUT} (${(bytes.length / 1024).toFixed(0)} KB)`);
