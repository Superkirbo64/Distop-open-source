/**
 * Genera el catálogo de emojis Unicode del selector: qué emojis hay, en qué
 * grupo va cada uno y con qué palabras se encuentran en los tres idiomas (§32).
 *
 * Como fetch-animated-emoji.mjs, es un script de una vez: la salida se versiona
 * en el repo para que clonar el proyecto no dependa de que unicode.org o CLDR
 * sigan sirviendo esto. Se vuelve a correr el día que Unicode publique una
 * tanda nueva de emojis.
 *
 *   node scripts/fetch-emoji-catalog.mjs
 *
 * Fuentes (licencia Unicode, permisiva; el crédito se muestra en el selector):
 *   - unicode.org/Public/emoji/16.0/emoji-test.txt — qué emojis existen, en qué
 *     orden y bajo qué grupo. Es la lista canónica; escribirla a mano
 *     garantizaría olvidos y un orden arbitrario.
 *   - CLDR annotations — nombre y palabras clave por idioma. Sin esto, buscar
 *     "corazón" no encontraría el emoji salvo que alguien redactara 1900 fichas.
 *
 * Escribe cuatro ficheros y no uno solo a propósito:
 *   - emojiCatalog.generated.ts: solo los caracteres y su grupo (~30 KB). Es lo
 *     único que la rejilla necesita para pintarse.
 *   - emojiIndex.<idioma>.generated.ts: nombres y palabras clave. Pesan de
 *     verdad, se piden en diferido y solo el del idioma activo, igual que los
 *     diccionarios de i18n.ts.
 *
 * Quedan fuera:
 *   - Las variantes de tono de piel: multiplican por seis la rejilla sin añadir
 *     un emoji distinto. El de base sigue estando.
 *   - El grupo "Component" (tonos y componentes sueltos): no son emojis que
 *     nadie mande por sí solos.
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(root, "apps", "web", "src", "lib");
const EMOJI_TEST = "https://unicode.org/Public/emoji/16.0/emoji-test.txt";
const CLDR = "https://raw.githubusercontent.com/unicode-org/cldr/main/common";

/** Idioma de la aplicación -> fichero de anotaciones de CLDR. */
const LANGS = { es: "es", "pt-BR": "pt", en: "en" };

/** Grupo de emoji-test.txt -> clave estable que traducen los locales. */
const GROUPS = {
  "Smileys & Emotion": "smileys",
  "People & Body": "people",
  "Animals & Nature": "nature",
  "Food & Drink": "food",
  "Travel & Places": "travel",
  Activities: "activities",
  Objects: "objects",
  Symbols: "symbols",
  Flags: "flags",
};

const SKIN_TONE = /1F3F[B-F]/;
/** Selector de variación: CLDR nombra la forma sin él. */
const VS16 = "️";

async function texto(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

function desescapar(xml) {
  return xml
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Sin tildes y en minúsculas: quien busca "corazon" quiere el corazón igual. */
function plano(str) {
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

/* ---------------------------------------------------------------- catálogo */

console.log(`Descargando ${EMOJI_TEST} …`);
const test = await texto(EMOJI_TEST);

const grupos = new Map(Object.values(GROUPS).map((key) => [key, []]));
let grupoActual = null;

for (const linea of test.split("\n")) {
  const cabecera = linea.match(/^# group: (.+)$/);
  if (cabecera) {
    grupoActual = GROUPS[cabecera[1].trim()] ?? null;
    continue;
  }
  const entrada = linea.match(/^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*(\S+)/);
  if (!entrada || !grupoActual) continue;
  // El tono de piel es una variante del mismo emoji, no otro emoji.
  if (SKIN_TONE.test(entrada[1])) continue;
  grupos.get(grupoActual).push(entrada[2]);
}

const total = [...grupos.values()].reduce((n, lista) => n + lista.length, 0);
console.log(`${total} emojis en ${grupos.size} grupos.`);

const cuerpoCatalogo = [...grupos.entries()]
  .map(([key, lista]) => `  { key: "${key}", emojis: [${lista.map((c) => JSON.stringify(c)).join(", ")}] },`)
  .join("\n");

const clavesGrupo = Object.values(GROUPS)
  .map((k) => `"${k}"`)
  .join(", ");

writeFileSync(
  join(LIB, "emojiCatalog.generated.ts"),
  `/**
 * Generado por scripts/fetch-emoji-catalog.mjs. No editar a mano.
 * Emojis Unicode del selector, en el orden y los grupos de emoji-test.txt
 * (Unicode 16.0). Sin nombres ni palabras clave: eso vive en
 * emojiIndex.<idioma>.generated.ts, que se pide aparte (§10.3).
 */
export const EMOJI_GROUP_KEYS = [${clavesGrupo}] as const;

export type EmojiGroupKey = (typeof EMOJI_GROUP_KEYS)[number];

export const EMOJI_GROUPS: ReadonlyArray<{ readonly key: EmojiGroupKey; readonly emojis: readonly string[] }> = [
${cuerpoCatalogo}
];
`,
);
console.log(`Catálogo escrito en ${join(LIB, "emojiCatalog.generated.ts")}`);

/* ------------------------------------------------------------------ índices */

/** cp -> { nombre, claves[] } de un XML de anotaciones. */
function anotaciones(xml, destino = new Map()) {
  for (const m of xml.matchAll(/<annotation cp="([^"]*)"(\s+type="tts")?>([^<]*)<\/annotation>/g)) {
    const cp = desescapar(m[1]);
    const valor = desescapar(m[3]).trim();
    const ficha = destino.get(cp) ?? { nombre: "", claves: [] };
    if (m[2]) ficha.nombre = valor;
    else ficha.claves = valor.split("|").map((k) => k.trim()).filter(Boolean);
    destino.set(cp, ficha);
  }
  return destino;
}

/* CLDR nombra el emoji por su forma mínima (sin el selector de variación).
   Se prueban las dos antes de rendirse: si no, media lista queda sin nombre. */
function buscar(mapa, char) {
  return mapa.get(char) ?? mapa.get(char.replaceAll(VS16, "")) ?? mapa.get(char + VS16);
}

/** Nombre en inglés de emoji-test.txt: el último recurso si CLDR no lo trae. */
const nombresIngles = new Map();
for (const linea of test.split("\n")) {
  const m = linea.match(/^[0-9A-F ]+?\s*;\s*fully-qualified\s*#\s*(\S+)\s+E[\d.]+\s+(.+)$/);
  if (m) nombresIngles.set(m[1], m[2].trim());
}

const todos = [...grupos.values()].flat();

for (const [locale, cldr] of Object.entries(LANGS)) {
  console.log(`Descargando anotaciones de ${cldr} …`);
  const mapa = anotaciones(await texto(`${CLDR}/annotations/${cldr}.xml`));
  // Las derivadas (banderas, familias, teclas) viven en otro fichero.
  anotaciones(await texto(`${CLDR}/annotationsDerived/${cldr}.xml`), mapa);

  const lineas = [];
  let sinNombre = 0;
  for (const char of todos) {
    const ficha = buscar(mapa, char);
    const nombre = ficha?.nombre || nombresIngles.get(char) || "";
    if (!ficha?.nombre) sinNombre++;

    /* Términos de búsqueda: el nombre más las claves, sin tildes, sin repetir
       y sin las palabras que ya están en el nombre. Diez como mucho: la cola
       de sinónimos de CLDR engorda el fichero sin encontrar nada nuevo. */
    const palabrasNombre = new Set(
      plano(nombre)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
    const extra = [];
    for (const clave of ficha?.claves ?? []) {
      for (const palabra of plano(clave).split(/[^\p{L}\p{N}]+/u)) {
        if (!palabra || palabrasNombre.has(palabra) || extra.includes(palabra)) continue;
        extra.push(palabra);
      }
      if (extra.length >= 10) break;
    }
    const terminos = [...palabrasNombre, ...extra.slice(0, 10)].join(" ");
    lineas.push(`  ${JSON.stringify(char)}: ${JSON.stringify(`${nombre}\t${terminos}`)},`);
  }

  const fichero = join(LIB, `emojiIndex.${locale}.generated.ts`);
  writeFileSync(
    fichero,
    `/**
 * Generado por scripts/fetch-emoji-catalog.mjs. No editar a mano.
 * emoji -> "nombre" + tabulador + "términos de búsqueda", en ${locale} (CLDR).
 * Se descarga en diferido: solo el idioma activo, y solo al abrir el selector.
 */
export const EMOJI_INDEX: Record<string, string> = {
${lineas.join("\n")}
};
`,
  );
  console.log(`  ${lineas.length} fichas en ${fichero} (${sinNombre} sin nombre propio de CLDR).`);
}
