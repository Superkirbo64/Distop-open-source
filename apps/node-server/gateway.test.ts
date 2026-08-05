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
  /** Paquetes de voz: llegan en binario por el mismo socket, no son JSON. */
  audio: Buffer[];
}

const clients: Client[] = [];

function open(token: string): Promise<Client> {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
  const client: Client = { socket, inbox: [], audio: [] };
  clients.push(client);
  socket.on("message", (raw, isBinary) => {
    if (isBinary) client.audio.push(raw as Buffer);
    else client.inbox.push(JSON.parse(String(raw)) as { t: string; d: any });
  });

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

test("el vídeo se anuncia a la sala y respeta el permiso de cada fuente", async () => {
  const rita = await call("POST", "/api/v1/auth/register", { body: { username: "rita", password: "contrasena-larga-5" } });
  const tom = await call("POST", "/api/v1/auth/register", { body: { username: "tom", password: "contrasena-larga-6" } });

  const community = await call("POST", "/api/v1/communities", { token: rita.access_token, body: { name: "Vídeo" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, { token: rita.access_token, body: {} });
  await call("POST", `/api/v1/invites/${invite.code}/join`, { token: tom.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: rita.access_token });
  const channel = boot.channels.find((c: any) => c.kind === "voice");
  const everyone = boot.roles.find((r: any) => r.is_default);

  // Cámara sí, pantalla no: son permisos distintos y se comprueban por separado.
  const { PERMISSIONS } = await import("@distop/protocol");
  await call("PUT", `/api/v1/channels/${channel.id}/permissions/${everyone.id}`, {
    token: rita.access_token,
    body: { target_type: "role", allow: "0", deny: PERMISSIONS.STREAM.toString() },
  });

  const clientTom = await open(tom.access_token);
  await waitFor(clientTom, "READY");
  clientTom.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));

  clientTom.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
  const joined = await waitFor(clientTom, "VOICE_STATE_UPDATE", (d) => d.states.length === 1);
  assert.equal(joined.states[0].user_id, tom.user.id);
  assert.equal(joined.states[0].video, null, "se entra sin vídeo");

  // Sin STREAM la pantalla no se anuncia: nadie la verá aunque su navegador capture.
  clientTom.socket.send(JSON.stringify({ t: "VOICE_VIDEO", d: { channel_id: channel.id, source: "screen" } }));
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(
    !clientTom.inbox.some((e) => e.t === "VOICE_STATE_UPDATE" && e.d.states[0]?.video === "screen"),
    "compartir pantalla sin permiso no cambia el estado",
  );

  clientTom.socket.send(JSON.stringify({ t: "VOICE_VIDEO", d: { channel_id: channel.id, source: "camera" } }));
  const withCamera = await waitFor(clientTom, "VOICE_STATE_UPDATE", (d) => d.states[0]?.video === "camera");
  assert.equal(withCamera.states[0].video, "camera");

  clientTom.socket.send(JSON.stringify({ t: "VOICE_VIDEO", d: { channel_id: channel.id, source: null } }));
  const off = await waitFor(clientTom, "VOICE_STATE_UPDATE", (d) => d.states[0]?.video === null);
  assert.equal(off.states[0].video, null, "apagar la cámara también se anuncia");

  clientTom.socket.close();
});

test("la voz pasa por la instancia y solo llega a quien está en la sala", async () => {
  /* Este es el cambio que hace que la voz funcione siempre: no se negocia nada
     entre navegadores, el audio sube por el mismo socket que ya atraviesa el
     túnel y la instancia lo reparte. Aquí se comprueba lo que el servidor debe
     garantizar: que llegue a la sala, que NO llegue a quien está fuera, y que
     silenciado signifique silenciado aunque el cliente insista. */
  const ana = await call("POST", "/api/v1/auth/register", { body: { username: "anav", password: "contrasena-larga-7" } });
  const bea = await call("POST", "/api/v1/auth/register", { body: { username: "beav", password: "contrasena-larga-8" } });
  const eva = await call("POST", "/api/v1/auth/register", { body: { username: "evav", password: "contrasena-larga-a" } });

  const community = await call("POST", "/api/v1/communities", { token: ana.access_token, body: { name: "Voz" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, {
    token: ana.access_token,
    body: {},
  });
  for (const quien of [bea, eva]) await call("POST", `/api/v1/invites/${invite.code}/join`, { token: quien.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: ana.access_token });
  const channel = boot.channels.find((c: any) => c.kind === "voice");

  const abrir = async (quien: any) => {
    const client = await open(quien.access_token);
    await waitFor(client, "READY");
    client.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));
    return client;
  };
  const aSock = await abrir(ana);
  const bSock = await abrir(bea);
  const eSock = await abrir(eva);

  // Ana y Bea entran a la voz; Eva se queda fuera aunque esté en la comunidad.
  for (const client of [aSock, bSock]) client.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
  await waitFor(bSock, "VOICE_STATE_UPDATE", (d) => d.states.length === 2);

  /* El formato: del cliente sale [tipo][datos] y a los demás llega
     [tipo][16 bytes de quién][datos]. Tipo 0 es voz, 1 y 2 son imagen. */
  const datos = Buffer.from([0xfc, 0x01, 0x02, 0x03, 0x04]);
  const enviar = (kind: number) => aSock.socket.send(Buffer.concat([Buffer.of(kind), datos]), { binary: true });

  enviar(0);
  await new Promise((r) => setTimeout(r, 400));

  assert.equal(bSock.audio.length, 1, "le llega a Bea, que está en la sala");
  assert.equal(eSock.audio.length, 0, "y no a Eva, que está en la comunidad pero fuera de la llamada");
  assert.equal(aSock.audio.length, 0, "ni vuelve a quien lo mandó");

  const llegada = bSock.audio[0]!;
  assert.equal(llegada[0], 0, "conserva el tipo de paquete");
  assert.equal(
    llegada.subarray(1, 17).toString("hex"),
    ana.user.id.replaceAll("-", ""),
    "viene marcado con quién habla",
  );
  assert.deepEqual(llegada.subarray(17), datos, "y el contenido llega intacto");

  /* La imagen no se reenvía si esa persona no ha anunciado que está emitiendo.
     Igual que con el silencio: no vale con que el cliente diga que sí, porque el
     cliente lo escribe cualquiera. */
  bSock.audio.length = 0;
  enviar(1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bSock.audio.length, 0, "sin cámara anunciada, el vídeo no pasa");

  aSock.socket.send(JSON.stringify({ t: "VOICE_VIDEO", d: { channel_id: channel.id, source: "camera" } }));
  await waitFor(bSock, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === ana.user.id && s.video));
  enviar(1);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bSock.audio.length, 1, "con la cámara encendida sí");

  // Silenciada, el servidor deja de reenviar su voz aunque su cliente siga mandando.
  bSock.audio.length = 0;
  aSock.socket.send(JSON.stringify({ t: "VOICE_MUTE", d: { channel_id: channel.id, muted: true, deafened: false } }));
  await waitFor(bSock, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === ana.user.id && s.muted));

  enviar(0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bSock.audio.length, 0, "silenciada en el servidor es silenciada de verdad");

  for (const client of [aSock, bSock, eSock]) client.socket.close();
});

test("volver a entrar en la misma sala renueva la hora de entrada", async () => {
  /* Al recargar la pestaña el id de usuario no cambia, así que sin una hora de
     entrada nueva el resto de la sala no tiene forma de saber que hay que
     rehacer la conexión WebRTC: se quedan hablándole a un navegador que ya no
     existe, y esa persona ve "conectando" para siempre. */
  const nel = await call("POST", "/api/v1/auth/register", { body: { username: "nel", password: "contrasena-larga-9" } });
  const community = await call("POST", "/api/v1/communities", { token: nel.access_token, body: { name: "Recarga" } });
  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: nel.access_token });
  const channel = boot.channels.find((c: any) => c.kind === "voice");

  const client = await open(nel.access_token);
  await waitFor(client, "READY");
  client.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));

  client.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
  const first = await waitFor(client, "VOICE_STATE_UPDATE", (d) => d.states.length === 1);
  const before = first.states[0].joined_at;

  await new Promise((r) => setTimeout(r, 25));
  client.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
  const again = await waitFor(client, "VOICE_STATE_UPDATE", (d) => d.states[0]?.joined_at > before);

  assert.equal(again.states.length, 1, "no se duplica a la persona en la sala");
  assert.ok(again.states[0].joined_at > before, "la segunda entrada trae una hora nueva");

  client.socket.close();
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
