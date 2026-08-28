/**
 * La polaridad de la máscara del fondo de cámara.
 *
 * Estas pruebas existen por un fallo real: dar por hecho que la categoría 0 es
 * el fondo. Con el Selfie Segmenter —cuya única etiqueta es "selfie"— el 0 es
 * la PERSONA y el fondo es el 255, así que esa suposición invertía el recorte:
 * se borraba a quien habla y se enseñaba la habitación entera. Es un fallo
 * silencioso —la imagen sigue saliendo, sin error ninguno— y solo se ve mirando
 * el resultado, así que queda fijado aquí.
 *
 *   node --test "src/lib/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";

import { NO_CATEGORY, backgroundValueFor, coverRect, isPerson } from "./cameraMask.ts";

test("un modelo de una sola clase marca el fondo con 255, no con 0", () => {
  const background = backgroundValueFor(["selfie"]);
  assert.equal(background, NO_CATEGORY);

  // 0 es la categoría "selfie": la persona.
  assert.equal(isPerson(0, background), true);
  assert.equal(isPerson(255, background), false);
});

test("un modelo con categoría de fondo explícita usa su índice", () => {
  const labels = ["background", "hair", "body-skin", "face-skin", "clothes"];
  const background = backgroundValueFor(labels);
  assert.equal(background, 0);

  assert.equal(isPerson(0, background), false, "el fondo declarado no es persona");
  assert.equal(isPerson(1, background), true, "el pelo sí es persona");
  assert.equal(isPerson(4, background), true, "la ropa sí es persona");
  // Sin categoría tampoco es persona, aunque el fondo declarado sea otro valor.
  assert.equal(isPerson(NO_CATEGORY, background), false);
});

test("la etiqueta de fondo se reconoce en español y sin distinguir mayúsculas", () => {
  assert.equal(backgroundValueFor(["persona", "Fondo"]), 1);
  assert.equal(backgroundValueFor(["BACKGROUND", "person"]), 0);
});

test("un modelo sin etiquetas no confunde el 0 con el fondo", () => {
  // Peor caso: getLabels() vacío. Debe caer al 255, que es lo que MediaPipe
  // pone donde no hay categoría; tomar el 0 borraría a la persona.
  assert.equal(backgroundValueFor([]), NO_CATEGORY);
  assert.equal(isPerson(0, backgroundValueFor([])), true);
});

test("el fondo cubre el hueco entero sin deformarse", () => {
  // Fondo apaisado en un hueco más cuadrado: sobra ancho, se recorta a los lados.
  const ancho = coverRect(1280, 720, 640, 480);
  assert.equal(ancho.h, 480, "cubre todo el alto");
  assert.ok(ancho.w >= 640, "y el ancho no se queda corto");
  assert.ok(ancho.x < 0, "lo que sobra se reparte fuera, a ambos lados");
  assert.equal(ancho.y, 0);
  // Centrado: lo que sobra por la izquierda es lo mismo que por la derecha.
  assert.equal(Math.round(ancho.x + ancho.w), Math.round(640 - ancho.x));

  // Misma proporción: encaja exacto, sin recorte ni márgenes.
  const exacto = coverRect(1280, 720, 640, 360);
  assert.deepEqual(exacto, { x: 0, y: 0, w: 640, h: 360 });
});
