/**
 * Prepara el sidecar de "Hospedar aquí" para el paquete Tauri (etapa B3.1 del
 * PLAN-PARIDAD.md). Replica EXACTAMENTE lo que electron-builder.yml empaqueta
 * para el cascarón Electron — mismo server, misma forma del repo:
 *
 *   src-tauri/binaries/node-x86_64-pc-windows-msvc.exe   (Node oficial v24)
 *   src-tauri/staging/node-server/*.ts + package.json    (el MISMO server)
 *   src-tauri/staging/node-server/node_modules/@distop/protocol  (transpilado)
 *   src-tauri/staging/node-server/node_modules/ws
 *   src-tauri/staging/web/dist                           (cliente que la
 *       instancia sirve a los navegadores; sin sourcemaps ni pack de emoji,
 *       con el set curado — los mismos filtros que electron-builder.yml)
 *
 * El binario de Node NO se versiona en git (~85MB): se descarga del canal
 * oficial nodejs.org la primera vez y queda cacheado en binaries/.
 */
import { spawnSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const srcTauri = join(here, "..", "src-tauri");
const staging = join(srcTauri, "staging");
const binaries = join(srcTauri, "binaries");

const NODE_EXE = join(binaries, "node-x86_64-pc-windows-msvc.exe");
// Canal oficial: la última v24 (la misma major que embebe Electron 40, con
// type stripping estable y node:sqlite). latest-v24.x apunta siempre al
// último parche publicado por nodejs.org.
const NODE_URL = "https://nodejs.org/dist/latest-v24.x/win-x64/node.exe";

/* ── 1. Node oficial como sidecar ──────────────────────────────────────── */
if (!existsSync(NODE_EXE)) {
  mkdirSync(binaries, { recursive: true });
  console.log(`descargando ${NODE_URL} …`);
  const res = await fetch(NODE_URL);
  if (!res.ok || !res.body) throw new Error(`descarga de Node falló: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(`${NODE_EXE}.part`));
  cpSync(`${NODE_EXE}.part`, NODE_EXE);
  rmSync(`${NODE_EXE}.part`);
}
const version = spawnSync(NODE_EXE, ["--version"], { encoding: "utf8" });
if (version.status !== 0) throw new Error("el node.exe descargado no arranca");
console.log(`sidecar Node ${version.stdout.trim()} listo`);

/* ── 2. El server, tal cual (mismos filtros que electron-builder.yml) ──── */
const serverSrc = join(root, "apps", "node-server");
const serverOut = join(staging, "node-server");
rmSync(serverOut, { recursive: true, force: true });
mkdirSync(serverOut, { recursive: true });
for (const file of readdirSync(serverSrc)) {
  if (file === "package.json" || (file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    cpSync(join(serverSrc, file), join(serverOut, file));
  }
}

/* ── 3. @distop/protocol transpilado (bajo node_modules Node rechaza .ts) ── */
const ts = (await import("typescript")).default;
const protoSrc = join(root, "packages", "protocol", "src");
const protoOut = join(serverOut, "node_modules", "@distop", "protocol");
mkdirSync(protoOut, { recursive: true });
for (const file of readdirSync(protoSrc)) {
  if (!file.endsWith(".ts")) continue;
  const { outputText } = ts.transpileModule(readFileSync(join(protoSrc, file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: file,
  });
  writeFileSync(join(protoOut, file.replace(/\.ts$/, ".js")), outputText.replace(/(from\s+["']\.[^"']*)\.ts(["'])/g, "$1.js$2"));
}
writeFileSync(
  join(protoOut, "package.json"),
  `${JSON.stringify({ name: "@distop/protocol", version: "0.1.0", private: true, type: "module", main: "./index.js", exports: { ".": "./index.js" } }, null, 2)}\n`,
);

/* ── 4. ws, la única dependencia runtime del server ────────────────────── */
cpSync(join(root, "node_modules", "ws"), join(serverOut, "node_modules", "ws"), { recursive: true });

/* ── 5. El cliente que la instancia sirve a los navegadores ────────────── */
const webSrc = join(root, "apps", "web", "dist");
if (!existsSync(join(webSrc, "index.html"))) {
  throw new Error("apps/web/dist no está compilado: corre `npm run build -w @distop/web` primero");
}
const webOut = join(staging, "web", "dist");
rmSync(join(staging, "web"), { recursive: true, force: true });
cpSync(webSrc, webOut, {
  recursive: true,
  filter: (source) => {
    const rel = source.slice(webSrc.length).replaceAll("\\", "/");
    return !rel.startsWith("/nodejs") && !rel.startsWith("/emoji-animated") && !rel.endsWith(".map");
  },
});
// El set curado de emojis del picker (2.1MB), como en el instalador Electron.
const curated = join(root, "apps", "desktop", "staging", "emoji-curated");
if (!existsSync(curated)) {
  const staged = spawnSync(process.execPath, [join(root, "scripts", "stage-curated-emoji.mjs")], { stdio: "inherit" });
  if (staged.status !== 0) throw new Error("stage-curated-emoji.mjs falló");
}
cpSync(curated, join(webOut, "emoji-animated"), { recursive: true });

/* ── 6. El vigilante de instancias (A1), con el MISMO motor que Electron ──
   No es una copia del código: son los mismos dos ficheros del cascarón
   Electron, puestos donde el sidecar pueda ejecutarlos. Si se tocan allí, aquí
   cambian solos — que es justo lo que impide que los dos cascarones acaben
   opinando distinto sobre si una comunidad volvió o se trasladó. */
const watcherOut = join(staging, "watcher");
rmSync(watcherOut, { recursive: true, force: true });
mkdirSync(watcherOut, { recursive: true });
const desktopSrc = join(root, "apps", "desktop", "src");
for (const file of ["availability-policy.ts", "availability-watcher.ts"]) {
  cpSync(join(desktopSrc, file), join(watcherOut, file));
}
cpSync(join(srcTauri, "watcher", "main.ts"), join(watcherOut, "main.ts"));
// El protocolo otra vez: el motor lo importa para verificar la sucesión.
cpSync(protoOut, join(watcherOut, "node_modules", "@distop", "protocol"), { recursive: true });
writeFileSync(
  join(watcherOut, "package.json"),
  `${JSON.stringify({ name: "@distop/watcher", version: "0.1.0", private: true, type: "module" }, null, 2)}\n`,
);

console.log(`staging del sidecar listo en ${staging}`);
