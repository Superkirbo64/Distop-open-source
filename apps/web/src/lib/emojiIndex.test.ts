/**
 * El buscador del selector de emojis. Lo que se prueba aquí no es que el
 * catálogo exista, sino que escribir encuentre: sin tildes, por el principio
 * de la palabra, y con el nombre por delante del sinónimo.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emojiName, normalizar, searchEmoji } from "./emojiIndex.ts";
import { EMOJI_INDEX } from "./emojiIndex.es.generated.ts";
import { EMOJI_GROUPS } from "./emojiCatalog.generated.ts";
import { POPULAR_EMOJI } from "./emojiPopular.ts";

test("el catálogo trae los nueve grupos y ningún emoji repetido", () => {
  assert.equal(EMOJI_GROUPS.length, 9);
  const todos = EMOJI_GROUPS.flatMap((g) => [...g.emojis]);
  assert.ok(todos.length > 1500, `solo ${todos.length} emojis`);
  assert.equal(new Set(todos).size, todos.length);
});

test("cada emoji del catálogo tiene ficha en el índice", () => {
  const sinFicha = EMOJI_GROUPS.flatMap((g) => [...g.emojis]).filter((c) => !EMOJI_INDEX[c]);
  assert.deepEqual(sinFicha, []);
});

test("los populares del selector están en el catálogo", () => {
  const catalogo = new Set(EMOJI_GROUPS.flatMap((g) => [...g.emojis]));
  assert.deepEqual(
    POPULAR_EMOJI.filter((c) => !catalogo.has(c)),
    [],
  );
});

test("busca por nombre", () => {
  assert.ok(searchEmoji(EMOJI_INDEX, "pizza").includes("🍕"));
  assert.ok(searchEmoji(EMOJI_INDEX, "corona").includes("👑"));
});

test("las tildes no hacen falta ni estorban", () => {
  assert.ok(searchEmoji(EMOJI_INDEX, "corazon").includes("❤️"));
  assert.ok(searchEmoji(EMOJI_INDEX, "corazón").includes("❤️"));
  assert.equal(normalizar("Corazón"), "corazon");
});

test("vale con escribir el principio de la palabra", () => {
  assert.ok(searchEmoji(EMOJI_INDEX, "son").includes("😀"));
});

test("por el medio de una palabra no busca: devolvería ruido", () => {
  assert.ok(!searchEmoji(EMOJI_INDEX, "ona").includes("👑"));
});

test("el que acierta el nombre va antes que el que acierta un sinónimo", () => {
  const gatos = searchEmoji(EMOJI_INDEX, "gato");
  assert.ok(gatos.includes("🐈"));
  assert.ok(gatos.includes("🐱"));
});

test("todas las palabras escritas tienen que aparecer", () => {
  const dos = searchEmoji(EMOJI_INDEX, "cara gato");
  assert.ok(dos.includes("🐱"));
  assert.ok(!dos.includes("🍕"));
});

test("sin índice o sin texto no inventa resultados", () => {
  assert.deepEqual(searchEmoji(undefined, "pizza"), []);
  assert.deepEqual(searchEmoji(EMOJI_INDEX, "   "), []);
  assert.deepEqual(searchEmoji(EMOJI_INDEX, "asdfghjkl"), []);
});

test("el nombre para el tooltip; sin índice, el propio emoji", () => {
  assert.equal(emojiName(EMOJI_INDEX, "🍕"), "pizza");
  assert.equal(emojiName(EMOJI_INDEX, "❤️"), "corazón rojo");
  assert.equal(emojiName(undefined, "🍕"), "🍕");
  assert.equal(emojiName(EMOJI_INDEX, "no-es-un-emoji"), "no-es-un-emoji");
});
