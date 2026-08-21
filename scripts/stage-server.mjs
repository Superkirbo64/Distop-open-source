/**
 * Empaqueta el node-server transpilado a JavaScript, listo para correr donde
 * no hay type stripping ni Node 24:
 *
 *   node scripts/stage-server.mjs --mobile [destino]
 *
 * Con --mobile produce el proyecto Node que Capacitor-NodeJS embebe en el APK
 * (motor nodejs-mobile = Node 18): ESM a ES2022, `node:sqlite` sustituido por
 * el shim WASM (scripts/mobile/sqlite-shim.js), `import.meta.dirname` (Node
 * 20.11+) reescrito, y el lanzador start.cjs que fija rutas de datos vía el
 * bridge del plugin. Destino por defecto: apps/mobile/nodejs-staging/
 *
 * Deja fuera los tests y no toca el repo: todo cae en el destino.
 */
import ts from "typescript";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mobile = process.argv.includes("--mobile");
const outArg = process.argv.find((arg, i) => i >= 2 && !arg.startsWith("--"));
const out = outArg ?? join(root, "apps", "mobile", "nodejs-staging");

function transpile(source, fileName) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName,
  });
  // Cubre `from "./x.ts"`, `import "./x.ts"` (solo efectos) e `import("./x.ts")`.
  let code = outputText.replace(/((?:\bfrom\b|\bimport\b)\s*\(?\s*["']\.[^"']*)\.ts(["'])/g, "$1.js$2");
  if (mobile) {
    // Node 18 no trae node:sqlite ni import.meta.dirname.
    code = code.replace(/(["'])node:sqlite\1/g, '"./sqlite-shim.js"');
    if (code.includes("import.meta.dirname")) {
      code =
        'import { fileURLToPath as __distopDirname } from "node:url";\n' +
        code.replaceAll("import.meta.dirname", '__distopDirname(new URL(".", import.meta.url))');
    }
  }
  return code;
}

function stageDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const file of readdirSync(srcDir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    writeFileSync(join(destDir, file.replace(/\.ts$/, ".js")), transpile(readFileSync(join(srcDir, file), "utf8"), file));
  }
}

rmSync(out, { recursive: true, force: true });

/* servidor */
const serverOut = join(out, "node-server");
stageDir(join(root, "apps", "node-server"), serverOut);
writeFileSync(join(serverOut, "package.json"), `${JSON.stringify({ name: "distop-node-server", private: true, type: "module" }, null, 2)}\n`);
if (mobile) cpSync(join(root, "scripts", "mobile", "sqlite-shim.js"), join(serverOut, "sqlite-shim.js"));

/* protocolo, como paquete resoluble */
const protoOut = join(serverOut, "node_modules", "@distop", "protocol");
stageDir(join(root, "packages", "protocol", "src"), protoOut);
writeFileSync(
  join(protoOut, "package.json"),
  `${JSON.stringify({ name: "@distop/protocol", version: "0.1.0", private: true, type: "module", main: "./index.js", exports: { ".": "./index.js" } }, null, 2)}\n`,
);

/* dependencias reales: ws siempre; el sqlite WASM solo en el móvil */
cpSync(join(root, "node_modules", "ws"), join(serverOut, "node_modules", "ws"), { recursive: true });
if (mobile) cpSync(join(root, "node_modules", "node-sqlite3-wasm"), join(serverOut, "node_modules", "node-sqlite3-wasm"), { recursive: true });

/* lanzador del APK */
if (mobile) {
  cpSync(join(root, "scripts", "mobile", "start.cjs"), join(out, "start.cjs"));
  writeFileSync(join(out, "package.json"), `${JSON.stringify({ name: "distop-phone-server", private: true, main: "./start.cjs" }, null, 2)}\n`);
}

console.log(`servidor ${mobile ? "móvil (Node 18 + sqlite WASM)" : "JS"} listo en ${out}`);
