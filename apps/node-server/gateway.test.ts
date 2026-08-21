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
  /* Los cierres de socket se procesan en el tick siguiente y todavía tocan la
     base: cerrarla aquí mismo hace saltar "database is not open" desde fuera de
     cualquier prueba, y eso tumba la suite entera con todo en verde. */
  await new Promise((r) => setTimeout(r, 150));
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

/** Cabecera ID3 suficiente para que el servidor lo reconozca como MP3 en esta
    prueba de protocolo; la decodificación real se comprueba en el navegador. */
const testMp3 = (label: string): Buffer => Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0]), Buffer.from(label)]);

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

/** Canal dedicado de vídeo: no recibe READY ni eventos JSON, solo imagen binaria. */
function openVideo(token: string): Promise<Client> {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}&media=video`);
  const client: Client = { socket, inbox: [], audio: [] };
  clients.push(client);
  socket.on("message", (raw, isBinary) => {
    if (isBinary) client.audio.push(raw as Buffer);
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

  // La versión optimizada lleva vídeo por otro TCP y conserva el timestamp real.
  // La voz y los controles no quedan detrás de un keyframe grande.
  const aVideo = await openVideo(ana.access_token);
  const bVideo = await openVideo(bea.access_token);
  bSock.audio.length = 0;
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(16_666n);
  aVideo.socket.send(Buffer.concat([Buffer.of(3), timestamp, datos]), { binary: true });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bVideo.audio.length, 1, "el vídeo nuevo llega por su conexión dedicada");
  assert.equal(bSock.audio.length, 0, "y no bloquea la conexión de voz y controles");
  assert.equal(bVideo.audio[0]![0], 3, "conserva el tipo con timestamp");
  assert.deepEqual(bVideo.audio[0]!.subarray(17), Buffer.concat([timestamp, datos]), "conserva tiempo y contenido");

  // Silenciada, el servidor deja de reenviar su voz aunque su cliente siga mandando.
  bSock.audio.length = 0;
  aSock.socket.send(JSON.stringify({ t: "VOICE_MUTE", d: { channel_id: channel.id, muted: true, deafened: false } }));
  await waitFor(bSock, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === ana.user.id && s.muted));

  enviar(0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(bSock.audio.length, 0, "silenciada en el servidor es silenciada de verdad");

  for (const client of [aSock, bSock, eSock, aVideo, bVideo]) client.socket.close();
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

test("un sonido de la tabla llega a la sala, y solo a la sala", async () => {
  /* Por el socket viaja el id, no el audio: cada cliente pide el archivo a la
     instancia y lo suena a calidad original. Lo que el servidor tiene que
     garantizar es a quién se lo reenvía, porque el id lo escribe el cliente y
     un cliente lo escribe cualquiera. */
  const zoe = await call("POST", "/api/v1/auth/register", { body: { username: "zoes", password: "contrasena-larga-s1" } });
  const ian = await call("POST", "/api/v1/auth/register", { body: { username: "ians", password: "contrasena-larga-s2" } });
  const noa = await call("POST", "/api/v1/auth/register", { body: { username: "noas", password: "contrasena-larga-s3" } });

  const community = await call("POST", "/api/v1/communities", { token: zoe.access_token, body: { name: "Tabla" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, { token: zoe.access_token, body: {} });
  for (const quien of [ian, noa]) await call("POST", `/api/v1/invites/${invite.code}/join`, { token: quien.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: zoe.access_token });
  const channel = boot.channels.find((c: any) => c.kind === "voice");

  // Un sonido de la comunidad, por el mismo camino que uno subido a mano.
  const subida = await fetch(`${base}/api/v1/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${zoe.access_token}`,
      "content-type": "audio/mpeg",
      "x-filename": "bocina.mp3",
    },
    body: testMp3("bocina"),
  }).then((r) => r.json() as Promise<any>);
  const subidaIcono = await fetch(`${base}/api/v1/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${zoe.access_token}`,
      "content-type": "image/png",
      "x-filename": "bocina.png",
    },
    body: Buffer.from("89504e470d0a1a0a", "hex"),
  }).then((r) => r.json() as Promise<any>);
  const sonido = await call("POST", `/api/v1/communities/${community.id}/emojis`, {
    token: zoe.access_token,
    body: { name: "bocina", kind: "sound", attachment_id: subida.id, icon_attachment_id: subidaIcono.id },
  });
  assert.equal(sonido.kind, "sound");
  assert.equal(sonido.icon_emoji, null);
  assert.equal(sonido.icon_url, `/api/v1/files/${subidaIcono.id}`);

  // Un sonido de OTRA comunidad, para comprobar que no se puede colar.
  const otra = await call("POST", "/api/v1/communities", { token: zoe.access_token, body: { name: "Ajena" } });
  const subidaAjena = await fetch(`${base}/api/v1/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${zoe.access_token}`, "content-type": "audio/mpeg", "x-filename": "otra.mp3" },
    body: testMp3("otra comunidad"),
  }).then((r) => r.json() as Promise<any>);
  const sonidoAjeno = await call("POST", `/api/v1/communities/${otra.id}/emojis`, {
    token: zoe.access_token,
    body: { name: "ajeno", kind: "sound", attachment_id: subidaAjena.id, icon_emoji: "🐸" },
  });
  assert.equal(sonidoAjeno.icon_emoji, "🐸");
  assert.equal(sonidoAjeno.icon_url, null);

  const catalogoPropio = await call("GET", `/api/v1/communities/${community.id}/emojis`, { token: zoe.access_token });
  const catalogoAjeno = await call("GET", `/api/v1/communities/${otra.id}/emojis`, { token: zoe.access_token });
  assert.deepEqual(catalogoPropio.map((item: any) => item.id), [sonido.id], "cada comunidad lista únicamente sus sonidos");
  assert.deepEqual(catalogoAjeno.map((item: any) => item.id), [sonidoAjeno.id], "el segundo catálogo permanece separado");

  const entrar = async (quien: any, dentro: boolean) => {
    const client = await open(quien.access_token);
    await waitFor(client, "READY");
    client.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));
    if (dentro) {
      client.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
      await waitFor(client, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === quien.user.id));
    }
    return client;
  };

  const clientZoe = await entrar(zoe, true);
  const clientIan = await entrar(ian, true);
  const clientNoa = await entrar(noa, false); // en la comunidad, fuera de la sala

  clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: sonido.id } }));

  // Le llega a la sala entera, incluida quien lo dispara: así todos lo oyen a la vez.
  const paraIan = await waitFor(clientIan, "VOICE_SOUND");
  assert.equal(paraIan.sound_id, sonido.id);
  assert.equal(paraIan.user_id, zoe.user.id);
  assert.equal((await waitFor(clientZoe, "VOICE_SOUND")).sound_id, sonido.id);

  await new Promise((r) => setTimeout(r, 300));
  assert.ok(!clientNoa.inbox.some((e) => e.t === "VOICE_SOUND"), "quien no está en la sala no lo recibe");

  // Un sonido de otra comunidad no suena aquí aunque el cliente mande su id.
  clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: sonidoAjeno.id } }));
  assert.equal((await waitFor(clientZoe, "VOICE_SOUND_ERROR")).reason, "not_available");
  // Y un id que no es de ningún sonido, tampoco.
  clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: channel.id } }));
  assert.equal((await waitFor(clientZoe, "VOICE_SOUND_ERROR")).reason, "not_available");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(
    !clientIan.inbox.some((e) => e.t === "VOICE_SOUND"),
    "ni el sonido de otra comunidad ni un id inventado se reenvían",
  );

  // Silenciado es silenciado: tampoco se puede hacer ruido con la tabla.
  clientZoe.socket.send(
    JSON.stringify({ t: "VOICE_MUTE", d: { channel_id: channel.id, muted: true, deafened: false } }),
  );
  await waitFor(clientZoe, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === zoe.user.id && s.muted));
  clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: sonido.id } }));
  assert.equal((await waitFor(clientZoe, "VOICE_SOUND_ERROR")).reason, "muted");
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!clientIan.inbox.some((e) => e.t === "VOICE_SOUND"), "silenciado no dispara sonidos");

  clientZoe.socket.send(
    JSON.stringify({ t: "VOICE_MUTE", d: { channel_id: channel.id, muted: false, deafened: false } }),
  );
  await waitFor(clientZoe, "VOICE_STATE_UPDATE", (d) => d.states.some((s: any) => s.user_id === zoe.user.id && !s.muted));
  // El primero ya gastó una de las cinco acciones de esta ventana.
  for (let i = 0; i < 4; i++) {
    clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: sonido.id } }));
    await waitFor(clientZoe, "VOICE_SOUND");
  }
  clientZoe.socket.send(JSON.stringify({ t: "VOICE_SOUND", d: { channel_id: channel.id, sound_id: sonido.id } }));
  assert.equal((await waitFor(clientZoe, "VOICE_SOUND_ERROR")).reason, "rate_limited");

  await call("DELETE", `/api/v1/emojis/${sonido.id}`, { token: zoe.access_token });
  assert.equal((await fetch(`${base}${sonido.url}`)).status, 404, "borrar el sonido borra también su archivo");
  assert.equal((await fetch(`${base}${sonido.icon_url}`)).status, 404, "y borra también la imagen propia del sonido");

  /* Se sale de la sala ANTES de cerrar. Un socket que se cae estando dentro
     dispara el anuncio de salida, que toca la base; si eso ocurre mientras el
     `after` ya la ha cerrado, la suite muere en el desmontaje y no por lo que
     se estaba probando. */
  for (const client of [clientZoe, clientIan]) {
    client.socket.send(JSON.stringify({ t: "VOICE_LEAVE", d: { channel_id: channel.id } }));
  }
  await waitFor(clientIan, "VOICE_STATE_UPDATE", (d) => d.states.length === 0);
  for (const client of [clientZoe, clientIan, clientNoa]) client.socket.close();
  await new Promise((r) => setTimeout(r, 200));
});

test("salirse de la carrera no cierra la que está corriendo", async () => {
  /* Salir y volver a entrar montaba OTRA partida: si quien la abrió se iba, la
     sala se borraba entera y el siguiente que pulsaba abría una carrera nueva
     con otra semilla. Se puede salir, pero la carrera de los demás sigue y al
     volver se entra en ESA, no en una distinta. */
  const leo = await call("POST", "/api/v1/auth/register", { body: { username: "leor", password: "contrasena-larga-r1" } });
  const mia = await call("POST", "/api/v1/auth/register", { body: { username: "miar", password: "contrasena-larga-r2" } });

  const community = await call("POST", "/api/v1/communities", { token: leo.access_token, body: { name: "Carreras" } });
  const invite = await call("POST", `/api/v1/communities/${community.id}/invites`, { token: leo.access_token, body: {} });
  await call("POST", `/api/v1/invites/${invite.code}/join`, { token: mia.access_token });

  const boot = await call("GET", `/api/v1/communities/${community.id}/bootstrap`, { token: leo.access_token });
  const channel = boot.channels.find((c: any) => c.kind === "voice");

  const abrir = async (quien: any) => {
    const client = await open(quien.access_token);
    await waitFor(client, "READY");
    client.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: community.id } }));
    client.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: channel.id } }));
    return client;
  };
  const lSock = await abrir(leo);
  const mSock = await abrir(mia);
  await waitFor(mSock, "VOICE_STATE_UPDATE", (d) => d.states.length === 2);

  lSock.socket.send(JSON.stringify({ t: "RACE_OPEN", d: { channel_id: channel.id } }));
  await waitFor(mSock, "RACE_UPDATE", (d) => d.lobby?.host_id === leo.user.id);
  mSock.socket.send(JSON.stringify({ t: "RACE_OPEN", d: { channel_id: channel.id } }));
  await waitFor(mSock, "RACE_UPDATE", (d) => d.lobby?.members.length === 2);

  lSock.socket.send(JSON.stringify({ t: "RACE_START", d: { channel_id: channel.id } }));
  const corriendo = await waitFor(mSock, "RACE_UPDATE", (d) => d.lobby?.seed !== null);

  // Se va quien la abrió: la carrera sigue, con el testigo en la otra persona.
  lSock.socket.send(JSON.stringify({ t: "RACE_LEAVE", d: { channel_id: channel.id } }));
  const sinLeo = await waitFor(mSock, "RACE_UPDATE", (d) => d.lobby?.members.length === 1);
  assert.equal(sinLeo.lobby.host_id, mia.user.id, "el testigo pasa a quien queda");
  assert.equal(sinLeo.lobby.seed, corriendo.lobby.seed, "sigue siendo la misma carrera");

  // Y al volver, se entra en esa misma carrera: ni semilla ni salida nuevas.
  lSock.socket.send(JSON.stringify({ t: "RACE_OPEN", d: { channel_id: channel.id } }));
  const vuelta = await waitFor(mSock, "RACE_UPDATE", (d) => d.lobby?.members.length === 2);
  assert.equal(vuelta.lobby.seed, corriendo.lobby.seed, "no se abre otra partida al volver");
  assert.equal(vuelta.lobby.started_at, corriendo.lobby.started_at, "la salida es la misma");
  assert.equal(vuelta.lobby.host_id, mia.user.id, "volver no devuelve el testigo");

  for (const client of [lSock, mSock]) client.socket.close();
});
