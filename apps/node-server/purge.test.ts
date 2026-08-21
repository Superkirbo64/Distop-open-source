/**
 * Self-check de la limpieza de datos (§28.4).
 * Vaciar el historial recupera disco sin tocar la comunidad: se van los
 * mensajes y sus archivos; se quedan la comunidad, sus canales y sus miembros.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-purge-"));
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

test("limpiar datos vacía el historial pero no toca la comunidad, y solo puede quien hospeda", async () => {
  // La dueña reclama la instancia y monta su comunidad con un canal.
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Dueña Prueba" } });
  assert.equal(claim.status, 200);
  const token = claim.json.access_token as string;

  const community = await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });
  assert.equal(community.status, 200);
  const boot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  const channel = boot.json.channels.find((c: { kind: string }) => c.kind !== "voice");
  assert.ok(channel, "la comunidad nueva trae al menos un canal de texto");

  const sent = await call("POST", `/api/v1/channels/${channel.id}/messages`, {
    token,
    body: { content: "esto va a desaparecer", attachment_ids: [], reply_to_id: null },
  });
  assert.equal(sent.status, 200);

  // Un invitado no puede limpiar el disco de otra persona.
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  const ajeno = await call("POST", "/api/v1/instance/purge", { token: visita.json.access_token });
  assert.equal(ajeno.status, 403);

  const purge = await call("POST", "/api/v1/instance/purge", { token });
  assert.equal(purge.status, 200);
  assert.equal(purge.json.messages, 1, "informa de cuánto se llevó por delante");

  const despues = await call("GET", `/api/v1/channels/${channel.id}/messages?limit=50`, { token });
  assert.equal(despues.status, 200);
  assert.equal(despues.json.length, 0, "el historial quedó vacío");

  const reboot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  assert.equal(reboot.status, 200, "la comunidad sigue existiendo");
  assert.ok(
    reboot.json.channels.some((c: { id: string }) => c.id === channel.id),
    "los canales se quedan: fue una limpieza, no un cierre",
  );

  // Y quedó constancia en la auditoría de la comunidad.
  const log = await call("GET", `/api/v1/communities/${community.json.id}/audit`, { token });
  assert.equal(log.status, 200);
  assert.ok(
    (log.json as Array<{ action: string }>).some((entry) => entry.action === "instance.purge"),
    "sus miembros tienen derecho a saber quién vació el historial",
  );
});
