/**
 * Self-check de "jugando a…" (§9.1): lo que ve una comunidad, lo que guarda el
 * historial y —sobre todo— lo que los interruptores de privacidad cortan.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const workdir = mkdtempSync(join(tmpdir(), "distop-game-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { server } = await import("./server.ts");
const { setPlaying, clearPlaying, sweepStale } = await import("./gamePresence.ts");

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
  server.closeAllConnections();
  server.close();
  await new Promise((r) => setTimeout(r, 150));
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

interface Client {
  socket: WebSocket;
  inbox: Array<{ t: string; d: any }>;
}

const clients: Client[] = [];

function open(token: string): Promise<Client> {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
  const client: Client = { socket, inbox: [] };
  clients.push(client);
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) client.inbox.push(JSON.parse(String(raw)) as { t: string; d: any });
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(client));
    socket.once("error", reject);
  });
}

async function waitFor(client: Client, type: string, matches?: (data: any) => boolean, timeoutMs = 4000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const index = client.inbox.findIndex((event) => event.t === type && (!matches || matches(event.d)));
    if (index !== -1) return client.inbox.splice(index, 1)[0]!.d;
    if (Date.now() > deadline) throw new Error(`sin evento ${type} en ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* Comunidad compartida por toda la suite: ana hospeda, leo es co-miembro. */
let ana: any;
let leo: any;
let communityId = "";
let clientLeo: Client;

test("abrir un juego se ve en vivo, el heartbeat no reinicia la partida y el bootstrap lo trae", async () => {
  ana = (await call("POST", "/api/v1/auth/register", { body: { username: "ana", password: "contrasena-larga-1" } })).json;
  leo = (await call("POST", "/api/v1/auth/register", { body: { username: "leo", password: "contrasena-larga-2" } })).json;
  const community = (await call("POST", "/api/v1/communities", { token: ana.access_token, body: { name: "Jugones" } })).json;
  communityId = community.id;
  const invite = (await call("POST", `/api/v1/communities/${communityId}/invites`, { token: ana.access_token, body: {} })).json;
  await call("POST", `/api/v1/invites/${invite.code}/join`, { token: leo.access_token });

  clientLeo = await open(leo.access_token);
  await waitFor(clientLeo, "READY");
  clientLeo.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: communityId } }));

  const put = await call("PUT", "/api/v1/users/me/game-presence", { token: ana.access_token, body: { game_name: "Rocket League" } });
  assert.equal(put.status, 204);

  const seen = await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.some((p: any) => p.user_id === ana.user.id));
  const mine = seen.presences.find((p: any) => p.user_id === ana.user.id);
  assert.equal(mine.game_name, "Rocket League");
  const startedAt = mine.started_at as number;

  // El heartbeat repite el PUT: ni evento nuevo (nada cambió) ni partida nueva.
  await call("PUT", "/api/v1/users/me/game-presence", { token: ana.access_token, body: { game_name: "Rocket League" } });
  const boot = (await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: leo.access_token })).json;
  assert.equal(boot.game_presences.length, 1, "el que llega tarde también lo ve, por el bootstrap");
  assert.equal(boot.game_presences[0].started_at, startedAt, "late: el started_at original se conserva");
});

test("cerrar el juego lo quita en vivo, y un abrir-y-cerrar no ensucia el historial", async () => {
  const del = await call("DELETE", "/api/v1/users/me/game-presence", { token: ana.access_token });
  assert.equal(del.status, 204);
  await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.length === 0);

  // La sesión duró segundos: menos de un minuto no es una partida.
  const history = await call("GET", `/api/v1/users/${ana.user.id}/game-history`, { token: leo.access_token });
  assert.deepEqual(history.json, []);
});

test("una partida de verdad sí entra al historial, con su duración", async () => {
  const before = Date.now() - 5 * 60_000;
  setPlaying(ana.user.id, "Stardew Valley", before);
  clearPlaying(ana.user.id);

  const history = (await call("GET", "/api/v1/users/me/game-history", { token: ana.access_token })).json;
  assert.equal(history.length, 1);
  assert.equal(history[0].game_name, "Stardew Valley");
  assert.ok(history[0].ended_at - history[0].started_at >= 5 * 60_000 - 1000);
});

test("si el equipo del jugador desaparece, el barrido lo limpia y avisa", async () => {
  await call("PUT", "/api/v1/users/me/game-presence", { token: ana.access_token, body: { game_name: "Factorio" } });
  await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.some((p: any) => p.game_name === "Factorio"));

  // Tres heartbeats perdidos, sin esperar tres minutos de reloj.
  const gone = sweepStale(Date.now() + 10 * 60_000);
  assert.ok(gone.includes(ana.user.id));
  await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.length === 0);
});

test("no compartir corta en origen, limpia lo visible y el PUT devuelve 403", async () => {
  await call("PUT", "/api/v1/users/me/game-presence", { token: ana.access_token, body: { game_name: "Celeste" } });
  await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.some((p: any) => p.game_name === "Celeste"));

  await call("PATCH", "/api/v1/users/me", { token: ana.access_token, body: { settings: { share_game_activity: false } } });
  await waitFor(clientLeo, "GAME_PRESENCE_UPDATE", (d) => d.presences.length === 0);

  const denied = await call("PUT", "/api/v1/users/me/game-presence", { token: ana.access_token, body: { game_name: "Celeste" } });
  assert.equal(denied.status, 403);

  await call("PATCH", "/api/v1/users/me", { token: ana.access_token, body: { settings: {} } });
});

test("invisible también es invisible para el juego", async () => {
  await call("PUT", "/api/v1/users/me/game-presence", { token: leo.access_token, body: { game_name: "Hades" } });

  const clientAna = await open(ana.access_token);
  await waitFor(clientAna, "READY");
  clientAna.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: communityId } }));
  await waitFor(clientAna, "GAME_PRESENCE_UPDATE", (d) => d.presences.some((p: any) => p.user_id === leo.user.id)).catch(async () => {
    // Puede haber llegado antes de suscribirse: el bootstrap es la otra vía.
    const boot = (await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: ana.access_token })).json;
    assert.ok(boot.game_presences.some((p: any) => p.user_id === leo.user.id));
  });

  await call("PATCH", "/api/v1/users/me", { token: leo.access_token, body: { status: "invisible" } });
  await waitFor(clientAna, "GAME_PRESENCE_UPDATE", (d) => !d.presences.some((p: any) => p.user_id === leo.user.id));

  await call("PATCH", "/api/v1/users/me", { token: leo.access_token, body: { status: "online" } });
  await call("DELETE", "/api/v1/users/me/game-presence", { token: leo.access_token });
});

test("el historial es para gente que ya se ve, y su dueño puede ocultarlo", async () => {
  // ana tiene una partida guardada (Stardew Valley). leo comparte comunidad: la ve.
  const shared = await call("GET", `/api/v1/users/${ana.user.id}/game-history`, { token: leo.access_token });
  assert.equal(shared.status, 200);
  assert.ok(shared.json.some((s: any) => s.game_name === "Stardew Valley"));

  // Su dueño lo oculta: vacío, no 403 — un "prohibido" ya contaría algo.
  await call("PATCH", "/api/v1/users/me", { token: ana.access_token, body: { settings: { show_game_history: false } } });
  const hidden = await call("GET", `/api/v1/users/${ana.user.id}/game-history`, { token: leo.access_token });
  assert.equal(hidden.status, 200);
  assert.deepEqual(hidden.json, []);
  await call("PATCH", "/api/v1/users/me", { token: ana.access_token, body: { settings: {} } });

  // Un desconocido sin comunidad en común ni siquiera encuentra el recurso.
  const stranger = (await call("POST", "/api/v1/auth/guest", { body: { display_name: "curioso" } })).json;
  const denied = await call("GET", `/api/v1/users/${ana.user.id}/game-history`, { token: stranger.access_token });
  assert.equal(denied.status, 404);
});
