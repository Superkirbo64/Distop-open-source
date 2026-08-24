/**
 * Genera el latest.json que lee tauri-plugin-updater (etapa B3.6).
 *
 * Uso, tras `tauri build` firmado (TAURI_SIGNING_PRIVATE_KEY_PATH puesto):
 *   node scripts/make-latest-json.mjs [tag]
 * → src-tauri/target/release/bundle/nsis/latest.json
 *
 * Subir a la MISMA GitHub Release que ya publica electron-builder: el
 * instalador NSIS, su .sig y este latest.json. El endpoint configurado en
 * tauri.conf.json apunta a releases/latest/download/latest.json.
 *
 * Ojo: GitHub sustituye los espacios del nombre del asset por puntos; la URL
 * de aquí ya lo hace. Verificar tras subir que la URL responde.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "src-tauri", "target", "release", "bundle", "nsis");
const conf = JSON.parse(readFileSync(join(here, "..", "src-tauri", "tauri.conf.json"), "utf8"));

const version = conf.version;
const tag = process.argv[2] ?? `v${version}`;
const setup = readdirSync(bundle).find((f) => f.endsWith("-setup.exe"));
if (!setup) throw new Error(`sin instalador en ${bundle} — corre tauri build primero`);
let signature;
try {
  signature = readFileSync(join(bundle, `${setup}.sig`), "utf8").trim();
} catch {
  throw new Error(`falta ${setup}.sig — el build no se firmó (TAURI_SIGNING_PRIVATE_KEY_PATH)`);
}

const assetName = setup.replaceAll(" ", ".");
const manifest = {
  version,
  notes: `Distop Tauri ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature,
      url: `https://github.com/Superkirbo64/Distop-open-source/releases/download/${tag}/${assetName}`,
    },
  },
};
writeFileSync(join(bundle, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`latest.json listo (${assetName} @ ${tag})`);
