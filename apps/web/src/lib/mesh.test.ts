/**
 * Self-check de las reglas de la voz directa (§9.4).
 *   node --test "src/lib/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { hostAudioNeeded, meshOverflowed, MESH_BACK, MESH_MAX } from "./mesh.ts";

test("la malla se desborda al llegar al techo y no vuelve hasta bajar del suelo", () => {
  assert.equal(meshOverflowed(4, false), false, "una sala pequeña va en directo");
  assert.equal(meshOverflowed(MESH_MAX, false), true, "al llegar al techo, toda la sala por la instancia");

  // La franja intermedia conserva el modo: es lo que evita que alguien entrando
  // y saliendo cambie la llamada entera cada pocos segundos.
  for (let gente = MESH_BACK + 1; gente < MESH_MAX; gente++) {
    assert.equal(meshOverflowed(gente, true), true, `${gente} no devuelve a directo por sí solo`);
    assert.equal(meshOverflowed(gente, false), false, `${gente} tampoco desborda por sí solo`);
  }

  assert.equal(meshOverflowed(MESH_BACK, true), false, "por debajo del suelo sí vuelve a directo");
});

test("el codificador de la instancia solo se enciende si alguien lo necesita", () => {
  const routes = new Map<string, "p2p" | "host">();

  // Modo host: siempre hace falta, no hay nada que negociar.
  assert.equal(hostAudioNeeded(false, [], routes), true);

  // Voz directa, sala recién empezada: nadie tiene ruta todavía y hace falta,
  // porque la alternativa sería no oírse durante la negociación.
  routes.set("ana", "host");
  routes.set("luis", "host");
  assert.equal(hostAudioNeeded(true, ["ana", "luis"], routes), true);

  // Uno ya va en directo y el otro no: sigue haciendo falta por el segundo.
  routes.set("ana", "p2p");
  assert.equal(hostAudioNeeded(true, ["ana", "luis"], routes), true);

  // Todos en directo: aquí es donde se deja de gastar la subida del anfitrión.
  routes.set("luis", "p2p");
  assert.equal(hostAudioNeeded(true, ["ana", "luis"], routes), false);

  // Entra alguien nuevo sin ruta: vuelve a hacer falta hasta que conecte.
  routes.set("marta", "host");
  assert.equal(hostAudioNeeded(true, ["ana", "luis", "marta"], routes), true);

  // Y una sala donde estás solo no necesita subir nada a ninguna parte.
  assert.equal(hostAudioNeeded(true, [], routes), false);
});
