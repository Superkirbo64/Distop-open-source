/**
 * El catalogo de aros y su coreografia viven en dos ficheros distintos:
 * rings.ts (generado desde rings.json) dice que movimiento tiene cada pieza, y
 * styles.css dice como se mueve ese movimiento. Nadie avisa si se separan: un
 * aro nuevo con un perfil sin regla no falla, simplemente se queda quieto y con
 * los tiempos genericos, que es exactamente el bug que hubo antes.
 *
 * Esto no necesita navegador: es leer los dos ficheros y comprobar que hablan
 * del mismo conjunto de nombres.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RINGS } from "@distop/protocol";

const css = readFileSync(join(import.meta.dirname, "../web/src/styles.css"), "utf8");

test("cada perfil de movimiento tiene su regla en el CSS", () => {
  for (const motion of new Set(RINGS.map((r) => r.motion))) {
    assert.ok(
      css.includes(`.ring-stack[data-ring="${motion}"]`),
      `el aro con motion "${motion}" no tiene coreografia en styles.css`,
    );
  }
});

test("toda animacion del aro apunta a unos @keyframes que existen", () => {
  const definidos = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]));

  // Las dos formas que se usan: `animation-name: x` y el atajo `animation: x 4s ...`.
  for (const linea of css.split("\n").filter((l) => l.includes(".ring-"))) {
    const nombre = /animation(?:-name)?:\s*([\w-]+)/.exec(linea)?.[1];
    if (!nombre || nombre === "none") continue;
    assert.ok(definidos.has(nombre), `@keyframes ${nombre} no existe (${linea.trim()})`);
  }
});
