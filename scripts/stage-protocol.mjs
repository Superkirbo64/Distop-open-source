/**
 * Transpila @distop/protocol a JavaScript para el empaquetado de escritorio.
 *
 * En el repo, el node-server ejecuta el protocolo como .ts porque el workspace
 * es un symlink y Node lo resuelve a su ruta real (packages/…). Empaquetado,
 * el paquete vive FÍSICAMENTE bajo node_modules, y ahí Node se niega a hacer
 * type stripping (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING). Así que al
 * paquete instalado se le entrega JS ya listo — mismo código, sin tipos.
 *
 * Salen DOS copias, del mismo fuente y por la misma razón invertida:
 *
 *   protocol/      ESM  → el node-server embebido, que es `type: module`.
 *   protocol-cjs/  CJS  → el proceso principal de Electron, que tsc compila a
 *                         CommonJS y por tanto hace `require("@distop/protocol")`.
 *
 * La segunda existe desde A1 final, cuando el vigilante de la bandeja pasó a
 * verificar cadenas de sucesión: esas reglas viven en el protocolo y tenerlas
 * copiadas en el escritorio sería exactamente la duplicación que C3 quitó.
 *
 *   node scripts/stage-protocol.mjs
 * → apps/desktop/staging/protocol/{package.json, *.js}
 * → apps/desktop/staging/protocol-cjs/{package.json, *.js}
 */
import ts from "typescript";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "packages", "protocol", "src");
const stagingDir = join(root, "apps", "desktop", "staging");

/** @type {Array<{ dir: string, module: ts.ModuleKind, type: "module" | "commonjs" }>} */
const salidas = [
  { dir: "protocol", module: ts.ModuleKind.ESNext, type: "module" },
  { dir: "protocol-cjs", module: ts.ModuleKind.CommonJS, type: "commonjs" },
];

for (const salida of salidas) {
  const outDir = join(stagingDir, salida.dir);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(join(srcDir, file), "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: salida.module, target: ts.ScriptTarget.ES2022 },
      fileName: file,
    });
    /* Los imports relativos siguen diciendo "./rings.ts"; el fichero ya es .js.
       En CommonJS la referencia ha pasado por require(), así que hay que
       reescribir las dos formas o el paquete no encuentra su propio módulo. */
    const rewritten = outputText
      .replace(/(from\s+["']\.[^"']*)\.ts(["'])/g, "$1.js$2")
      .replace(/(require\(["']\.[^"']*)\.ts(["']\))/g, "$1.js$2");
    writeFileSync(join(outDir, file.replace(/\.ts$/, ".js")), rewritten);
  }

  writeFileSync(
    join(outDir, "package.json"),
    `${JSON.stringify(
      {
        name: "@distop/protocol",
        version: "0.1.0",
        private: true,
        type: salida.type,
        main: "./index.js",
        exports: { ".": "./index.js" },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`protocolo (${salida.type}) listo en ${outDir}`);
}
