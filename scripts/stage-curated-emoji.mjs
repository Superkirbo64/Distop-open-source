/**
 * Set curado de emojis animados para el instalador de escritorio (§16, plan de
 * RAM Fase 5). El pack completo (878 JSON, ~68 MB) se queda en el repo y en
 * web/dist — las instancias self-hosted y el host-bundle lo sirven entero —
 * pero el NSIS solo embarca los ~50 del picker: para el resto, el cliente cae
 * a la fuente Noto de Google en caliente y, sin red, al carácter plano
 * (AnimatedEmoji.tsx). Disco post-install: ~60 MB menos por copia.
 *
 * Corre dentro de `npm run dist` del desktop, antes de electron-builder, igual
 * que stage-protocol.mjs. La lista curada ES la del picker (lib/emojiPopular.ts): una
 * sola fuente de verdad, leída de ahí para que añadir un emoji a esa lista lo
 * añada también al instalador sin tocar este script.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POPULAR = join(root, "apps", "web", "src", "lib", "emojiPopular.ts");
const MAP = join(root, "apps", "web", "src", "lib", "animatedEmoji.generated.ts");
const SRC_DIR = join(root, "apps", "web", "public", "emoji-animated");
const OUT_DIR = join(root, "apps", "desktop", "staging", "emoji-curated");

/** La lista de siempre del picker, extraída del fuente (no hay runtime TS aquí). */
function pickerEmojis() {
  const source = readFileSync(POPULAR, "utf8");
  const match = source.match(/POPULAR_EMOJI: readonly string\[\] = \[([\s\S]*?)\];/);
  if (!match) throw new Error("emojiPopular.ts ya no declara POPULAR_EMOJI — actualizar este script.");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** char -> id de fichero, del mapa generado (mismo formato "1f321_fe0f"). */
function animatedMap() {
  const source = readFileSync(MAP, "utf8");
  const map = new Map();
  for (const m of source.matchAll(/^\s{2}"((?:\\.|[^"\\])+)": "([^"]+)",$/gmu) ?? []) {
    map.set(JSON.parse(`"${m[1]}"`), m[2]);
  }
  if (map.size === 0) throw new Error("animatedEmoji.generated.ts sin entradas — ¿cambió el formato?");
  return map;
}

const map = animatedMap();
const curated = pickerEmojis()
  .map((char) => map.get(char))
  .filter((id) => id !== undefined);

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

let bytes = 0;
for (const id of curated) {
  const file = `${id}.json`;
  copyFileSync(join(SRC_DIR, file), join(OUT_DIR, file));
  bytes += readFileSync(join(OUT_DIR, file)).length;
}

console.log(`${curated.length} emojis curados (${(bytes / 1024 / 1024).toFixed(1)} MB) en ${OUT_DIR}`);
