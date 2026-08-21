/**
 * Transpila @distop/protocol a JavaScript para el empaquetado de escritorio.
 *
 * En el repo, el node-server ejecuta el protocolo como .ts porque el workspace
 * es un symlink y Node lo resuelve a su ruta real (packages/…). Empaquetado,
 * el paquete vive FÍSICAMENTE bajo node_modules, y ahí Node se niega a hacer
 * type stripping (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Así que al
 * paquete instalado se le entrega JS ya listo — mismo código, sin tipos.
 *
 *   node scripts/stage-protocol.mjs
 * → apps/desktop/staging/protocol/{package.json, *.js}
 */
import ts from "typescript";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "packages", "protocol", "src");
const outDir = join(root, "apps", "desktop", "staging", "protocol");

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

for (const file of readdirSync(srcDir)) {
  if (!file.endsWith(".ts")) continue;
  const source = readFileSync(join(srcDir, file), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  // Los imports relativos siguen diciendo "./rings.ts"; el fichero ya es .js.
  const rewritten = outputText.replace(/(from\s+["']\.[^"']*)\.ts(["'])/g, "$1.js$2");
  writeFileSync(join(outDir, file.replace(/\.ts$/, ".js")), rewritten);
  console.log(`${file} → ${file.replace(/\.ts$/, ".js")}`);
}

writeFileSync(
  join(outDir, "package.json"),
  `${JSON.stringify({ name: "@distop/protocol", version: "0.1.0", private: true, type: "module", main: "./index.js", exports: { ".": "./index.js" } }, null, 2)}\n`,
);
console.log(`protocolo listo en ${outDir}`);
