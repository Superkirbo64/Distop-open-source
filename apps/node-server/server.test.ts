/**
 * Self-check de la instancia: el camino real de una comunidad de principio a fin
 * más las dos piezas donde un fallo silencioso sería grave (permisos y jerarquía).
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-test-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.PUBLIC_DISCOVERY_ENABLED = "true";

const { server } = await import("./server.ts");
const { PERMISSIONS, has, toBits, uuidv7 } = await import("@distop/protocol");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.close();
  // Windows no borra el directorio mientras SQLite mantenga abiertos los ficheros WAL.
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("health reporta el estado real de la instancia", async () => {
  const { status, json } = await call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "ONLINE");
  assert.equal(json.protocol, "v1");
});

test("registro, comunidad, canal y mensaje: el camino completo", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "ana", password: "contrasena-larga-1" },
  });
  assert.equal(owner.status, 200);
  const token = owner.json.access_token as string;

  const community = await call("POST", "/api/v1/communities", { token, body: { name: "Mi Comunidad" } });
  assert.equal(community.status, 200);
  assert.equal(community.json.slug, "mi-comunidad");

  const boot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  assert.equal(boot.json.channels.length, 3, "la comunidad nace con general, anuncios y voz");
  assert.ok(has(toBits(boot.json.permissions), PERMISSIONS.ADMINISTRATOR), "quien crea es administrador");

  const channel = boot.json.channels.find((c: any) => c.name === "general");
  const sent = await call("POST", `/api/v1/channels/${channel.id}/messages`, { token, body: { content: "hola" } });
  assert.equal(sent.status, 200);

  const history = await call("GET", `/api/v1/channels/${channel.id}/messages`, { token });
  assert.equal(history.json.length, 1);
  assert.equal(history.json[0].content, "hola");

  // La exportación es la garantía anti-lock-in (§21): tiene que traer los mensajes.
  const dump = await call("GET", `/api/v1/communities/${community.json.id}/export`, { token });
  assert.equal(dump.json.manifest.format, "distop-community-export");
  assert.equal(dump.json.messages.general.length, 1);
});

test("un extraño no ve la comunidad y un invitado sí puede entrar por enlace", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "beto", password: "contrasena-larga-2" },
  });
  const ownerToken = owner.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token: ownerToken, body: { name: "Privada" } });

  const stranger = await call("POST", "/api/v1/auth/guest", { body: { display_name: "curioso" } });
  const strangerToken = stranger.json.access_token as string;

  const denied = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token: strangerToken });
  assert.equal(denied.status, 404, "sin membresía la comunidad ni siquiera existe");

  const invite = await call("POST", `/api/v1/communities/${community.json.id}/invites`, {
    token: ownerToken,
    body: { max_uses: 1 },
  });
  const joined = await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: strangerToken });
  assert.equal(joined.status, 200);

  const allowed = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token: strangerToken });
  assert.equal(allowed.status, 200);
  assert.ok(!has(toBits(allowed.json.permissions), PERMISSIONS.MANAGE_CHANNELS), "un miembro nuevo no administra");

  // La invitación era de un solo uso.
  const second = await call("POST", "/api/v1/auth/guest", { body: { display_name: "tarde" } });
  const rejected = await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: second.json.access_token });
  assert.equal(rejected.status, 404);
});

test("nadie puede concederse permisos que no tiene", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "carla", password: "contrasena-larga-3" },
  });
  const ownerToken = owner.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token: ownerToken, body: { name: "Jerarquia" } });
  const communityId = community.json.id as string;

  // Rol de moderación que puede gestionar roles pero no ser administrador.
  const modRole = await call("POST", `/api/v1/communities/${communityId}/roles`, {
    token: ownerToken,
    body: { name: "Mods", permissions: PERMISSIONS.MANAGE_ROLES.toString(), position: 10 },
  });
  assert.equal(modRole.status, 200);

  const mod = await call("POST", "/api/v1/auth/register", {
    body: { username: "dario", password: "contrasena-larga-4" },
  });
  const modToken = mod.json.access_token as string;
  const invite = await call("POST", `/api/v1/communities/${communityId}/invites`, { token: ownerToken, body: {} });
  await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: modToken });
  await call("PATCH", `/api/v1/communities/${communityId}/members/${mod.json.user.id}`, {
    token: ownerToken,
    body: { role_ids: [modRole.json.id] },
  });

  const escalation = await call("POST", `/api/v1/communities/${communityId}/roles`, {
    token: modToken,
    body: { name: "Trampa", permissions: PERMISSIONS.ADMINISTRATOR.toString() },
  });
  assert.equal(escalation.status, 403, "un moderador no puede fabricar un rol de administrador");
});

test("uuidv7 ordena por tiempo de creación", () => {
  const ids = Array.from({ length: 50 }, uuidv7);
  assert.deepEqual([...ids].sort(), ids, "el orden lexicográfico coincide con el de creación");
});
