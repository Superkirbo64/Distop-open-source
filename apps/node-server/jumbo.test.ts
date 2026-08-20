/**
 * Un mensaje que es solo emojis se pinta en grande, y "solo emojis" incluye los
 * de Unicode y no solo los personalizados. Estas comprobaciones existen porque
 * la primera version miraba unicamente `<:nombre:id>`: un 👏 suelto se pintaba
 * del tamano del texto.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isJumbo } from "@distop/protocol";

test("solo emojis se pinta en grande", () => {
  for (const contenido of [
    "👏",
    "😀😀😀",
    "👍🏽", // con modificador de tono
    "👨‍👩‍👧", // varios pictogramas cosidos con ZWJ
    "❤️", // con selector de variacion
    "🇪🇸🇧🇷", // banderas: dos indicadores regionales cada una
    "🙂 🙃", // los espacios entre medias no cuentan
    "<:kirbo:0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d>", // personalizado
    "👏 <:kirbo:0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d>", // mezclados
  ]) {
    assert.equal(isJumbo(contenido), true, contenido);
  }
});

test("cualquier otra cosa se queda del tamano del texto", () => {
  for (const contenido of [
    "hola",
    "123", // \p{Emoji} daria estos por buenos; \p{Extended_Pictographic} no
    "#",
    "👏 hola", // un emoji dentro de una frase es un adorno, no el mensaje
    "a👏",
    "",
    "   ",
  ]) {
    assert.equal(isJumbo(contenido), false, JSON.stringify(contenido));
  }
});
