/**
 * El contrato del sidecar de vigilancia que usa el cascarón Tauri.
 *
 * El motor ya está probado entero en `availability-watch.test.ts`, y Tauri usa
 * ESE motor, no una copia — de eso trata `apps/desktop-tauri/src-tauri/src/
 * availability.rs`. Lo único sin cubrir era el pegamento: las líneas JSON que
 * entran y salen por los pipes.
 *
 * Se prueba contra la carpeta de staging real, que es lo que acaba dentro del
 * instalador. Sin staging la prueba se salta en vez de fallar: quien toca el
 * cliente web no tiene por qué haber construido el cascarón Tauri.
 *
 *   node --test "src/*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STAGING = join(import.meta.dirname, "..", "..", "desktop-tauri", "src-tauri", "staging", "watcher");
const hayStaging = existsSync(join(STAGING, "main.ts"));

/** Arranca el sidecar, le mete líneas, cierra la entrada y devuelve lo que dijo. */
function correr(lineas: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const hijo = spawn(process.execPath, ["main.ts"], {
      cwd: STAGING,
      env: { ...process.env, DISTOP_WATCH_STATE: join(mkdtempSync(join(tmpdir(), "distop-watch-")), "state.json") },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let out = "";
    let err = "";
    hijo.stdout.on("data", (trozo) => (out += String(trozo)));
    hijo.stderr.on("data", (trozo) => (err += String(trozo)));
    hijo.on("error", reject);
    hijo.on("close", (code) => resolve({ code, out, err }));

    for (const linea of lineas) hijo.stdin.write(`${linea}\n`);
    hijo.stdin.end();

    /* Si algo se cuelga, mejor un fallo con mensaje que una suite parada. */
    const corte = setTimeout(() => hijo.kill(), 15_000);
    hijo.on("close", () => clearTimeout(corte));
  });
}

test("el sidecar arranca, acepta las tres órdenes y termina al cerrarle la entrada", { skip: !hayStaging }, async () => {
  const { code, err } = await correr([
    JSON.stringify({ cmd: "replace", items: [] }),
    JSON.stringify({ cmd: "status", url: "https://ejemplo.invalid", connected: true }),
    JSON.stringify({ cmd: "forget", url: "https://ejemplo.invalid" }),
  ]);

  assert.equal(err, "", "no debería quejarse de nada");
  assert.equal(code, 0, "cerrar el pipe es la señal de apagado: no hace falta matarlo");
});

test("una línea rota no tumba la vigilancia", { skip: !hayStaging }, async () => {
  /* El emisor es el propio cascarón, así que esto solo puede pasar por un fallo
     de escritura. Perder una orden es mucho mejor que perder el proceso: con el
     sidecar muerto nadie se entera de que su comunidad volvió, y encima en
     silencio. */
  const { code, err } = await correr([
    "{esto no es json",
    "",
    JSON.stringify({ cmd: "replace", items: [] }),
  ]);

  assert.equal(err, "");
  assert.equal(code, 0);
});

test("una orden desconocida se ignora sin ruido", { skip: !hayStaging }, async () => {
  const { code, err } = await correr([
    JSON.stringify({ cmd: "haz_algo_raro" }),
    JSON.stringify({ cmd: "status", url: "https://ejemplo.invalid" }),
    JSON.stringify({ items: [] }),
  ]);

  assert.equal(err, "");
  assert.equal(code, 0);
});

test("sin DISTOP_WATCH_STATE se niega a arrancar, y lo dice", { skip: !hayStaging }, async () => {
  /* Arrancar sin sitio donde guardar el estado dejaría una vigilancia que se
     reinicia en cada arranque: avisaría de "volvió" cada vez, para siempre. */
  const salida = await new Promise<{ code: number | null; err: string }>((resolve) => {
    const entorno = { ...process.env };
    delete entorno.DISTOP_WATCH_STATE;
    const hijo = spawn(process.execPath, ["main.ts"], { cwd: STAGING, env: entorno, stdio: ["pipe", "pipe", "pipe"] });
    let err = "";
    hijo.stderr.on("data", (trozo) => (err += String(trozo)));
    hijo.stdin.end();
    hijo.on("close", (code) => resolve({ code, err }));
  });

  assert.equal(salida.code, 2);
  assert.match(salida.err, /DISTOP_WATCH_STATE/);
});

test("el motor que corre en Tauri es el MISMO fichero que el de Electron", { skip: !hayStaging }, async () => {
  /* Esta es la propiedad que justifica todo el sidecar. Si alguien copiara el
     motor en vez de escenificarlo, los dos cascarones podrían acabar opinando
     distinto sobre si una comunidad volvió o se trasladó — y el que se
     equivocara mandaría a su gente a un servidor que ya no es el suyo. */
  const { readFileSync } = await import("node:fs");
  for (const fichero of ["availability-policy.ts", "availability-watcher.ts"]) {
    assert.equal(
      readFileSync(join(STAGING, fichero), "utf8"),
      readFileSync(join(import.meta.dirname, fichero), "utf8"),
      `${fichero} se separó de su original: hay que volver a escenificarlo`,
    );
  }
});
