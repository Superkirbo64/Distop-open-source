/**
 * Qué cuenta como «estar sentado delante del ordenador» (§22, §26).
 *
 * Es la comprobación que decide si se puede reclamar una instancia o volver a
 * entrar sin contraseña, así que equivocarse aquí regala el servidor de alguien.
 * Antes bastaba con que hubiera un túnel abierto para que nadie fuese local, y
 * eso dejaba a quien hospeda fuera de su propia casa. Ahora se distingue por las
 * marcas que el borde de Cloudflare pone en lo que reenvía, y esta suite existe
 * para que esa distinción no se rompa en silencio.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-local-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.SETUP_CODE = "CODIGO-DE-PRUEBA";

const { server } = await import("./server.ts");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

/** `headers` simula de dónde llega la petición, igual que haría el agente del túnel. */
async function info(headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1/info`, { headers });
  return (await res.json()) as { setup_requires_code: boolean; recoverable: unknown[] };
}

test("desde el propio equipo no se pide código", async () => {
  const { setup_requires_code } = await info();
  assert.equal(setup_requires_code, false);
});

test("lo que llega reenviado por el túnel NO es local", async () => {
  // Cloudflare pone estas marcas y quien viene de internet no puede quitarlas.
  for (const marca of ["cf-ray", "cf-connecting-ip", "cf-visitor", "x-forwarded-for"]) {
    const { setup_requires_code } = await info({ [marca]: "prueba" });
    assert.equal(setup_requires_code, true, `con ${marca} la petición viene de fuera`);
  }
});

test("una cuenta sin contraseña no se ofrece a quien llega por el túnel", async () => {
  const claim = await fetch(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Kirbo" }),
  });
  assert.equal(claim.status, 200);

  const dentro = await info();
  assert.equal(dentro.recoverable.length, 1, "delante del ordenador sí se ofrece");

  const fuera = await info({ "cf-ray": "prueba" });
  assert.equal(fuera.recoverable.length, 0, "por el túnel no se enseña a nadie a quien suplantar");
});

test("recuperar por el túnel exige el código, y uno falso no vale", async () => {
  const sinCodigo = await fetch(`${base}/api/v1/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "prueba" },
    body: JSON.stringify({ username: "kirbo" }),
  });
  assert.notEqual(sinCodigo.status, 200, "sin código, desde fuera no se entra");

  const codigoMalo = await fetch(`${base}/api/v1/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "prueba" },
    body: JSON.stringify({ username: "kirbo", setup_code: "NO-ES-EL-CODIGO" }),
  });
  assert.notEqual(codigoMalo.status, 200, "un código inventado tampoco");
});
