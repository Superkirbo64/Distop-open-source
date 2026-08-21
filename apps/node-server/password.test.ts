/**
 * Self-check del cambio de contraseña (§22).
 * Cambiarla es la palanca ante una fuga: tiene que pedir la actual, cerrar las
 * demás sesiones y dejar dentro —con tokens nuevos— a quien hizo el cambio.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const workdir = mkdtempSync(join(tmpdir(), "distop-pass-"));
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

test("cambiar la contraseña pide la actual, echa a las demás sesiones y no rompe la propia", async () => {
  const alta = await call("POST", "/api/v1/auth/register", {
    body: { username: "cauta", password: "primera-clave-larga" },
  });
  assert.equal(alta.status, 200);
  const token = alta.json.access_token as string;
  assert.equal(alta.json.user.has_password, true, "el cliente sabe que esta cuenta ya tiene contraseña");

  // Una segunda sesión de la misma persona: la que debe quedar fuera.
  const otra = await call("POST", "/api/v1/auth/login", {
    body: { username: "cauta", password: "primera-clave-larga" },
  });
  assert.equal(otra.status, 200);

  // La otra sesión tiene además un socket abierto: revocar filas no basta si
  // el socket sigue escuchando eventos en vivo.
  const socket = new WebSocket(
    `${base.replace("http", "ws")}/realtime?token=${encodeURIComponent(otra.json.access_token as string)}`,
  );
  const closed = new Promise<number>((done) => socket.once("close", (code) => done(code)));
  await new Promise((done, fail) => {
    socket.once("open", done);
    socket.once("error", fail);
  });

  const mal = await call("POST", "/api/v1/users/me/password", {
    token,
    body: { current_password: "no-es-esta", password: "segunda-clave-larga" },
  });
  assert.equal(mal.status, 401, "sin la contraseña actual no hay cambio");

  const bien = await call("POST", "/api/v1/users/me/password", {
    token,
    body: { current_password: "primera-clave-larga", password: "segunda-clave-larga" },
  });
  assert.equal(bien.status, 200);
  assert.ok(bien.json.access_token, "la sesión que cambió recibe tokens nuevos");

  const conNuevo = await call("GET", "/api/v1/users/me", { token: bien.json.access_token });
  assert.equal(conNuevo.status, 200, "el token nuevo sirve al momento");

  const conViejo = await call("GET", "/api/v1/users/me", { token: otra.json.access_token });
  assert.equal(conViejo.status, 401, "las demás sesiones quedaron revocadas");

  assert.equal(await closed, 4001, "y su socket abierto se cerró: dejó de escuchar al instante");

  const loginViejo = await call("POST", "/api/v1/auth/login", {
    body: { username: "cauta", password: "primera-clave-larga" },
  });
  assert.equal(loginViejo.status, 401, "la contraseña vieja ya no abre");

  const loginNuevo = await call("POST", "/api/v1/auth/login", {
    body: { username: "cauta", password: "segunda-clave-larga" },
  });
  assert.equal(loginNuevo.status, 200, "la nueva sí");
});

test("una cuenta sin contraseña no puede 'cambiarla': para eso está el upgrade", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  assert.equal(visita.status, 200);
  assert.equal(visita.json.user.has_password, false, "el cliente sabe que aquí toca ofrecer el upgrade");

  const intento = await call("POST", "/api/v1/users/me/password", {
    token: visita.json.access_token,
    body: { current_password: "lo-que-sea", password: "una-clave-larga-nueva" },
  });
  assert.equal(intento.status, 409);
});
