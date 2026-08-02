/**
 * Self-check del gateway: dos personas conectadas al mismo canal se ven escribir.
 * Es el corazón del producto (§36) y es lo que las pruebas REST no tocan.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const workdir = mkdtempSync(join(tmpdir(), "distop-ws-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { server } = await import("./server.ts");

let base = "";
let wsBase = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/realtime`;
});

after(async () => {
  for (const client of clients) client.socket.terminate();
  // Sin esto el proceso no termina: los sockets ya actualizados a WebSocket
  // siguen vivos aunque el servidor deje de aceptar conexiones nuevas.
  server.closeAllConnections();
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

/**
 * Cliente con buzón: READY llega en el mismo instante del upgrade, así que hay
 * que estar escuchando desde antes de que la promesa de "open" se resuelva.
 */
interface Client {
  socket: WebSocket;
  inbox: Array<{ t: string; d: any }>;
}

const clients: Client[] = [];

function open(token: string): Promise<Client> {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
  const client: Client = { socket, inbox: [] };
  clients.push(client);
  socket.on("message", (raw) => client.inbox.push(JSON.parse(String(raw)) as { t: string; d: any }));

  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(client));
    socket.once("error", reject);
  });
}

/**
 * Espera un evento del tipo pedido (opcionalmente el primero que cumpla algo),
 * o falla en 4 s en vez de colgar la suite. El predicado importa porque la
 * presencia emite varias veces mientras la gente va entrando.
 */
async function waitFor(client: Client, type: string, matches?: (data: any) => boolean, timeoutMs = 4000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = client.inbox.findIndex((event) => event.t === type && (!matches || matches(event.d)));
    if (index !== -1) return client.inbox.splice(index, 1)[0]!.d;
    if (Date.now() > deadline) throw new Error(`sin evento ${type} en ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("el gateway rechaza una conexión sin token válido", async () => {
  const socket = new WebSocket(`${wsBase}?token=inventado`);
  const error = await new Promise<Error>((resolve) => socket.once("error", resolve));
  assert.match(error.message, /401/);
});

test("dos personas en el mismo canal se ven escribir en tiempo real", async () => {
  const ana = await call("POST", "/api/v1/auth/register", { body: { username: "ana", password: "contrasena-larga-1" } });
  const leo = await call("POST", "/api/v1/auth/register", { body: { username: "leo", password: "contrasena-larga-2" } });

  const community = await call("POST", "/api/v1/communities", { token: ana.access_token, body: { name: "Tiempo Real" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, { token: ana.access_token, body: {} });
  await call("POST", `/api/v1/invites/${invite.code}/join`, { token: leo.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: ana.access_token });
  const channel = boot.channels.find((c: any) => c.name === "general");

  const clientAna = await open(ana.access_token);
  const clientLeo = await open(leo.access_token);

  const readyAna = await waitFor(clientAna, "READY");
  assert.equal(readyAna.user.username, "ana");
  assert.equal(readyAna.instance.status, "ONLINE");
  await waitFor(clientLeo, "READY");

  clientAna.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));
  clientLeo.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));

  // Ana ve entrar a Leo en la lista de conectados.
  const presence = await waitFor(clientAna, "PRESENCE_UPDATE", (d) => d.online.includes(leo.user.id));
  assert.ok(presence.online.includes(leo.user.id), "la presencia refleja quién está dentro");

  // Leo recibe el mensaje que Ana manda por REST, sin recargar nada.
  await call("POST", `/api/v1/channels/${channel.id}/messages`, {
    token: ana.access_token,
    body: { content: "¿me lees?" },
  });
  const message = await waitFor(clientLeo, "MESSAGE_CREATE");
  assert.equal(message.content, "¿me lees?");
  assert.equal(message.author_id, ana.user.id);

  // Y ve el indicador de escritura.
  clientAna.socket.send(JSON.stringify({ t: "TYPING", d: { channel_id: channel.id } }));
  assert.equal((await waitFor(clientLeo, "TYPING_START")).user_id, ana.user.id);

  // Al cerrar Ana, Leo la ve desaparecer de conectados.
  clientAna.socket.close();
  const departure = await waitFor(clientLeo, "PRESENCE_UPDATE", (d) => !d.online.includes(ana.user.id));
  assert.ok(!departure.online.includes(ana.user.id));

  clientLeo.socket.close();
});

test("un canal sin permiso de lectura no se emite a quien no lo ve", async () => {
  const ada = await call("POST", "/api/v1/auth/register", { body: { username: "ada", password: "contrasena-larga-3" } });
  const nino = await call("POST", "/api/v1/auth/register", { body: { username: "nino", password: "contrasena-larga-4" } });

  const community = await call("POST", "/api/v1/communities", { token: ada.access_token, body: { name: "Reservada" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, { token: ada.access_token, body: {} });
  await call("POST", `/api/v1/invites/${invite.code}/join`, { token: nino.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: ada.access_token });
  const channel = boot.channels.find((c: any) => c.name === "general");
  const everyone = boot.roles.find((r: any) => r.is_default);

  // Se le quita VIEW_CHANNEL a @everyone: el canal pasa a ser privado.
  const { PERMISSIONS } = await import("@distop/protocol");
  await call("PUT", `/api/v1/channels/${channel.id}/permissions/${everyone.id}`, {
    token: ada.access_token,
    body: { target_type: "role", allow: "0", deny: PERMISSIONS.VIEW_CHANNEL.toString() },
  });

  const clientNino = await open(nino.access_token);
  await waitFor(clientNino, "READY");
  clientNino.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));

  await call("POST", `/api/v1/channels/${channel.id}/messages`, {
    token: ada.access_token,
    body: { content: "esto no debería salir" },
  });
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(
    !clientNino.inbox.some((event) => event.t === "MESSAGE_CREATE"),
    "el mensaje de un canal privado no llega a quien no puede verlo",
  );

  const visible = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: nino.access_token });
  assert.ok(!visible.channels.some((c: any) => c.id === channel.id), "y el canal tampoco aparece en su lista");

  clientNino.socket.close();
});
