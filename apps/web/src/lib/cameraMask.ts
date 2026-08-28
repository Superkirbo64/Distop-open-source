/**
 * Cómo se lee la máscara de segmentación y dónde va el fondo.
 *
 * Vive aparte de cameraBackground.ts por una razón concreta: ese módulo importa
 * el runtime WebAssembly con `?url`, que solo entiende el empaquetador, así que
 * no se puede cargar desde un test de Node. Y justo aquí está la decisión que
 * más daño hace si se equivoca —qué píxel es persona y cuál es fondo—, porque
 * al revés borra a la persona y enseña la habitación entera: exactamente lo
 * contrario de lo que promete el ajuste. Separada, se puede fijar con pruebas.
 */

/**
 * Valor que MediaPipe pone donde el píxel no pertenece a ninguna categoría.
 * En un modelo de una sola clase, eso ES el fondo.
 */
export const NO_CATEGORY = 255;

/**
 * Qué valor de la máscara significa "fondo", según las etiquetas del modelo.
 *
 * Dos convenciones, y confundirlas invierte el recorte:
 *
 *   - Una sola clase, como el Selfie Segmenter que usa Distop: `getLabels()`
 *     devuelve `["selfie"]`. Los píxeles de la persona llevan el índice de esa
 *     categoría (el 0) y todo lo demás queda sin categoría, con 255. El fondo
 *     es el 255 — no el 0, que es la trampa evidente.
 *   - Varias clases con un "background" explícito: el fondo es su índice, y
 *     persona es cualquier otra categoría.
 */
export function backgroundValueFor(labels: readonly string[]): number {
  const found = labels.findIndex((label) => /background|fondo/i.test(label));
  return found >= 0 ? found : NO_CATEGORY;
}

/** ¿Este píxel es de la persona? Lo que no lo es, se sustituye por el fondo. */
export function isPerson(value: number, backgroundValue: number): boolean {
  // El 255 se descarta siempre: en un modelo multiclase marca "ninguna
  // categoría", que tampoco es persona.
  return value !== backgroundValue && value !== NO_CATEGORY;
}

/**
 * Coloca una imagen cubriendo el hueco entero sin deformarla, recortando lo que
 * sobra por el lado largo. Un fondo estirado se nota inmediatamente.
 */
export function coverRect(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
): { x: number; y: number; w: number; h: number } {
  const scale = Math.max(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const w = sourceWidth * scale;
  const h = sourceHeight * scale;
  return { x: (targetWidth - w) / 2, y: (targetHeight - h) / 2, w, h };
}
