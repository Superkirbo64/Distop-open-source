/**
 * Volver a entrar sin contraseña (§7.2, §26).
 *
 * Salió de un fallo real: quien pone en marcha la instancia crea su cuenta
 * antes que su primera comunidad. La lista de cuentas recuperables exigía tener
 * comunidad, así que en ese rato la persona no aparecía en ninguna parte: sin
 * contraseña que escribir, sin nada que recuperar, y con la pantalla de acceso
 * empujándola a crearse OTRA cuenta —esa sí, con contraseña obligatoria— que
 * además ya no sería la dueña de la instancia.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-recover-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

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

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

test("sin comunidad todavía, quien hospeda sigue pudiendo volver a entrar", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Kirbo" } });
  assert.equal(claim.status, 200);

  // Aquí es donde se cerraba la puerta: cuenta creada, ninguna comunidad aún.
  const info = await call("GET", "/api/v1/info");
  assert.equal(info.json.setup_required, false, "ya hay dueño: la pantalla pasa a ser la de entrar");

  const cuentas = info.json.recoverable as Array<{ username: string; community: string | null }>;
  assert.equal(cuentas.length, 1, "la cuenta recién creada tiene que poder recuperarse");
  assert.equal(cuentas[0]?.community, null, "y se admite que todavía no tenga comunidad");

  const vuelta = await call("POST", "/api/v1/auth/recover", { body: { username: cuentas[0]?.username } });
  assert.equal(vuelta.status, 200, "desde el propio equipo se vuelve a entrar sin contraseña");
  assert.ok(vuelta.json.access_token, "y con sesión de verdad, no un vistazo");
});

test("la comunidad aparece en la etiqueta en cuanto existe", async () => {
  const cuentas = (await call("GET", "/api/v1/info")).json.recoverable;
  const vuelta = await call("POST", "/api/v1/auth/recover", { body: { username: cuentas[0].username } });
  await call("POST", "/api/v1/communities", {
    token: vuelta.json.access_token,
    body: { name: "La Partida" },
  });

  const info = await call("GET", "/api/v1/info");
  assert.equal(info.json.recoverable[0].community, "La Partida");
});

test("un invitado de paso no se cuela en la lista de recuperables", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "curioso" } });
  assert.equal(visita.status, 200);

  const info = await call("GET", "/api/v1/info");
  const nombres = (info.json.recoverable as Array<{ display_name: string }>).map((c) => c.display_name);
  assert.deepEqual(nombres, ["Kirbo"], "sin comunidad propia, un invitado no sale en la pantalla de entrada");
});
