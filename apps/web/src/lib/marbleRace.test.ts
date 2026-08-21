/**
 * Lo único que de verdad puede romper la carrera: que una canica se quede
 * encajada en un embudo y la carrera no termine nunca. Los embudos y las aspas
 * dejan huecos ajustados a propósito — ahí está la gracia — y basta con
 * estrecharlos un poco para que doce canicas se atasquen para siempre.
 *
 *   node --test "apps/web/src/lib/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { STEP, TRACK_W, MARBLE_R, WORLDS, createRace, stepRace, closestOnSegment, type Racer } from "./marbleRace.ts";

/** Tres minutos de carrera a paso fijo: de sobra para cualquiera de los mundos. */
const MAX_STEPS = Math.ceil(180 / STEP);
/** Una sala llena: doce personas es más de lo que aguanta una llamada por la instancia. */
const RACERS = 12;
const gente: Racer[] = Array.from({ length: RACERS }, (_, i) => ({
  id: `u${i}`,
  name: `Persona ${i}`,
  hue: i * 30,
  initials: `P${i}`,
}));

for (const [index, spec] of WORLDS.entries()) {
  test(`${spec.key}: todas las canicas llegan a la meta`, () => {
    // Varias semillas: un atasco puede depender de dónde caiga cada canica.
    for (const seed of [1, 20_260_821, 987_654_321]) {
      const race = createRace(index, seed, gente);

      let steps = 0;
      while (race.finished < RACERS && steps < MAX_STEPS) {
        stepRace(race, STEP);
        steps += 1;
      }

      assert.equal(
        race.finished,
        RACERS,
        `${spec.key} con semilla ${seed}: solo llegaron ${race.finished} de ${RACERS}`,
      );
      // Los puestos son 1..12 sin repetir: el orden de llegada es el resultado.
      assert.deepEqual(
        race.marbles.map((m) => m.place).sort((a, b) => a - b),
        Array.from({ length: RACERS }, (_, i) => i + 1),
      );
      // Y nadie salió de la pista por un choque mal resuelto.
      for (const m of race.marbles) {
        assert.ok(
          m.x >= MARBLE_R - 1 && m.x <= TRACK_W - MARBLE_R + 1,
          `${m.racer.name} acabó fuera de la pista en x=${m.x}`,
        );
      }
    }
  });
}

test("la misma semilla da exactamente el mismo podio", () => {
  // Es lo que sostiene la carrera compartida: la instancia solo reparte semilla
  // y parrilla, así que si dos simulaciones iguales divergen, dos personas ven
  // ganadores distintos.
  for (const world of [0, 1, 2]) {
    const orden = [0, 1].map(() => {
      const race = createRace(world, 4242, gente);
      while (race.finished < RACERS) stepRace(race, STEP);
      return race.marbles.map((m) => `${m.racer.id}:${m.place}`).join(" ");
    });
    assert.equal(orden[0], orden[1]);
  }
});

test("el punto más cercano del segmento se queda dentro del segmento", () => {
  assert.deepEqual(closestOnSegment(5, 10, 0, 0, 10, 0), [5, 0]);
  // Más allá del extremo: se devuelve el extremo, no la prolongación.
  assert.deepEqual(closestOnSegment(50, 3, 0, 0, 10, 0), [10, 0]);
  assert.deepEqual(closestOnSegment(-7, -7, 0, 0, 10, 0), [0, 0]);
  // Segmento degenerado: sin dividir por cero.
  assert.deepEqual(closestOnSegment(4, 4, 2, 2, 2, 2), [2, 2]);
});
