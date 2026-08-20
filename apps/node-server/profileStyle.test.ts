/**
 * El id del catalogo acaba pegado a un nombre de clase CSS (`plate-${id}`) en
 * cada perfil que se pinta. Si el cliente pudiera colar ahi un valor propio,
 * seria una via de inyeccion en la lista de miembros de toda la comunidad
 * (§22) — asi que lo que se comprueba aqui es que NADA que no este en el
 * catalogo sobrevive a toProfileStyle, ni al guardar ni al leer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PROFILE_STYLE, RING_IDS, toProfileStyle } from "@distop/protocol";

test("un id fuera del catalogo cae al valor por defecto", () => {
  const sucio = toProfileStyle({
    nameplate: "../../etc/passwd",
    name_font: "<script>",
    name_effect: "gradient</style>",
    profile_effect: "no-existe",
  });

  assert.deepEqual(sucio, DEFAULT_PROFILE_STYLE);
});

test("los colores solo pasan si son hex de seis digitos", () => {
  const style = toProfileStyle({
    name_color: "#a1b2c3",
    theme_a: "red", // nombre CSS: no
    theme_b: "#fff", // tres digitos: tampoco, el patron pide seis
  });

  assert.equal(style.name_color, "#a1b2c3");
  assert.equal(style.theme_a, null);
  assert.equal(style.theme_b, null);
});

test("un valor valido del catalogo se conserva", () => {
  const style = toProfileStyle({ nameplate: "mist", name_effect: "neon" });

  assert.equal(style.nameplate, "mist");
  assert.equal(style.name_effect, "neon");
});

test("cualquier basura de entrada devuelve un perfil valido", () => {
  // Una fila vieja sin la columna, un JSON corrupto, o alguien tocando el
  // fichero SQLite a mano: ninguno de los tres puede romper el render (§28.6).
  for (const entrada of [null, undefined, "texto", 42, [], { nameplate: 7 }]) {
    assert.deepEqual(toProfileStyle(entrada), DEFAULT_PROFILE_STYLE, JSON.stringify(entrada));
  }
});

test("la decoracion propia solo acepta rutas de la instancia o enlaces http(s)", () => {
  // Acaba en un <img src>. Se comprueba por lista blanca: lo que no encaje, null.
  assert.equal(toProfileStyle({ avatar_deco_url: "/api/v1/files/abc" }).avatar_deco_url, "/api/v1/files/abc");
  assert.equal(toProfileStyle({ avatar_deco_url: "https://ejemplo.org/aro.png" }).avatar_deco_url, "https://ejemplo.org/aro.png");

  for (const malo of ["javascript:alert(1)", "data:image/svg+xml,<svg onload=alert(1)>", "vbscript:x", "", "x".repeat(400)]) {
    assert.equal(toProfileStyle({ avatar_deco_url: malo }).avatar_deco_url, null, malo.slice(0, 30));
  }
});

test("el aro solo pasa si esta en el catalogo", () => {
  // Compone /rings/<id>.png: un id libre seria pedir cualquier fichero (§22).
  assert.equal(toProfileStyle({ avatar_ring: RING_IDS[0] }).avatar_ring, RING_IDS[0]);

  for (const malo of ["../../etc/passwd", "no-existe", "aurora-weave.png", "", 7, null]) {
    assert.equal(toProfileStyle({ avatar_ring: malo }).avatar_ring, null, String(malo));
  }
});
