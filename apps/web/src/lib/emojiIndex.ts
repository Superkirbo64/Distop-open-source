/**
 * Nombres y búsqueda de los emojis Unicode del selector (§10.3, §32).
 *
 * El catálogo (qué emojis hay y en qué grupo) va en el bundle: son 20 KB y la
 * rejilla no puede pintarse sin él. Los nombres y las palabras clave NO: son
 * ~130 KB por idioma y solo hacen falta cuando alguien abre el selector. Se
 * piden en diferido y solo el del idioma activo, con rutas literales en el
 * import() para que Vite pueda partirlos en chunks — la misma decisión, y por
 * el mismo motivo, que los diccionarios de i18n.ts.
 *
 * Los términos vienen ya en minúsculas y sin tildes desde el generador: buscar
 * "corazon" encuentra "corazón" sin normalizar 1900 fichas en cada tecla.
 */
import type { Locale } from "../i18n.ts";
import { EMOJI_GROUPS } from "./emojiCatalog.generated.ts";

/** emoji -> "nombre" + tabulador + "términos de búsqueda". */
export type EmojiIndex = Record<string, string>;

const CARGADOS: Partial<Record<Locale, EmojiIndex>> = {};
const EN_VUELO: Partial<Record<Locale, Promise<EmojiIndex>>> = {};

/** Ya cargado, si lo está: la segunda vez que se abre el selector no parpadea. */
export function emojiIndexCargado(locale: Locale): EmojiIndex | undefined {
  return CARGADOS[locale];
}

export function loadEmojiIndex(locale: Locale): Promise<EmojiIndex> {
  const listo = CARGADOS[locale];
  if (listo) return Promise.resolve(listo);

  const pendiente =
    EN_VUELO[locale] ??
    (
      locale === "en"
        ? import("./emojiIndex.en.generated.ts")
        : locale === "pt-BR"
          ? import("./emojiIndex.pt-BR.generated.ts")
          : import("./emojiIndex.es.generated.ts")
    ).then((m) => {
      CARGADOS[locale] = m.EMOJI_INDEX;
      return m.EMOJI_INDEX;
    });
  EN_VUELO[locale] = pendiente;
  return pendiente;
}

/** El nombre legible, para el `title` del botón. Sin índice, el propio emoji. */
export function emojiName(index: EmojiIndex | undefined, char: string): string {
  const ficha = index?.[char];
  if (!ficha) return char;
  const corte = ficha.indexOf("\t");
  return corte === -1 ? ficha : ficha.slice(0, corte);
}

/** Igual que el generador: minúsculas y sin tildes, para comparar peras con peras. */
export function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Tope de resultados: más de esto ya nadie lo mira, y sí cuesta pintarlo. */
const MAX_RESULTADOS = 300;

/** ¿Aparece la palabra al principio de alguno de los términos? */
function empiezaAlguno(terminos: string, palabra: string): boolean {
  return terminos.startsWith(palabra) || terminos.includes(` ${palabra}`);
}

/**
 * Todas las palabras escritas tienen que aparecer, y por el principio de
 * alguna: "cara son" encuentra "cara sonriendo", pero "ona" no encuentra
 * "corona" — buscar por el medio de una palabra devuelve ruido, no emojis.
 *
 * Quien acierta el nombre va primero: escribir "gato" da 🐱 antes que "cara de
 * gato sonriendo con lágrimas", aunque los dos valgan.
 */
export function searchEmoji(index: EmojiIndex | undefined, query: string): string[] {
  const palabras = normalizar(query).split(/\s+/).filter(Boolean);
  if (!index || palabras.length === 0) return [];

  const porNombre: string[] = [];
  const porClave: string[] = [];

  for (const grupo of EMOJI_GROUPS) {
    for (const char of grupo.emojis) {
      const ficha = index[char];
      if (!ficha) continue;
      const corte = ficha.indexOf("\t");
      const terminos = ficha.slice(corte + 1);
      if (!palabras.every((p) => empiezaAlguno(terminos, p))) continue;

      /* Los términos empiezan por las palabras del nombre (así los ordena el
         generador), así que basta con mirar ese prefijo para saber si el
         acierto fue en el nombre o en un sinónimo. */
      const nombre = normalizar(ficha.slice(0, corte));
      (palabras.every((p) => empiezaAlguno(nombre, p)) ? porNombre : porClave).push(char);

      if (porNombre.length + porClave.length >= MAX_RESULTADOS) return [...porNombre, ...porClave];
    }
  }
  return [...porNombre, ...porClave];
}
