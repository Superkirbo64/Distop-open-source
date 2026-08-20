/**
 * Self-check del estado de lectura y de la moderación de voz.
 * Son las dos piezas nuevas donde un fallo no se ve: un contador que no cuadra
 * se confunde con "no ha llegado el mensaje", y un silencio que el silenciado
 * puede quitarse parece que funcionó hasta que alguien vuelve a hablar.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-unread-"));
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
  server.close();
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

/** Deja montada una comunidad con dos personas dentro y devuelve lo necesario. */
async function comunidadConDos(prefijo: string) {
  const ana = await call("POST", "/api/v1/auth/register", {
    body: { username: `${prefijo}-ana`, password: "contrasena-larga-1" },
  });
  const anaToken = ana.json.access_token as string;
  const anaId = ana.json.user.id as string;

  const community = await call("POST", "/api/v1/communities", { token: anaToken, body: { name: `C ${prefijo}` } });
  const communityId = community.json.id as string;

  const boot = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: anaToken });
  const channel = boot.json.channels.find((c: any) => c.kind === "text");

  const invite = await call("POST", `/api/v1/communities/${communityId}/invites`, { token: anaToken, body: {} });
  const beto = await call("POST", "/api/v1/auth/register", {
    body: { username: `${prefijo}-beto`, password: "contrasena-larga-1" },
  });
  const betoToken = beto.json.access_token as string;
  const betoId = beto.json.user.id as string;
  await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: betoToken });

  return { anaToken, anaId, betoToken, betoId, communityId, channelId: channel.id as string };
}

test("lo que escribo no me queda sin leer, y lo que me escriben sí", async () => {
  const { anaToken, betoToken, communityId, channelId } = await comunidadConDos("lectura");

  // Ana escribe dos veces: para ella no hay nada pendiente.
  await call("POST", `/api/v1/channels/${channelId}/messages`, { token: anaToken, body: { content: "uno" } });
  await call("POST", `/api/v1/channels/${channelId}/messages`, { token: anaToken, body: { content: "dos" } });

  const paraAna = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: anaToken });
  assert.equal(paraAna.json.unread[channelId], undefined, "los mensajes propios no cuentan como sin leer");

  const paraBeto = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: betoToken });
  assert.equal(paraBeto.json.unread[channelId].count, 2);
  assert.equal(paraBeto.json.unread[channelId].mentions, 0, "sin nombrarle, no es una mención");

  // Beto lee: el contador se vacía.
  const mensajes = await call("GET", `/api/v1/channels/${channelId}/messages`, { token: betoToken });
  const ultimo = mensajes.json.at(-1).id as string;
  const leido = await call("POST", `/api/v1/channels/${channelId}/read`, {
    token: betoToken,
    body: { message_id: ultimo },
  });
  assert.equal(leido.status, 200);

  const despues = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: betoToken });
  assert.equal(despues.json.unread[channelId], undefined);
  assert.equal(despues.json.read_state[channelId], ultimo);
});

test("marcar leído nunca retrocede", async () => {
  const { anaToken, betoToken, communityId, channelId } = await comunidadConDos("retroceso");

  await call("POST", `/api/v1/channels/${channelId}/messages`, { token: anaToken, body: { content: "primero" } });
  await call("POST", `/api/v1/channels/${channelId}/messages`, { token: anaToken, body: { content: "segundo" } });

  const mensajes = await call("GET", `/api/v1/channels/${channelId}/messages`, { token: betoToken });
  const [primero, segundo] = mensajes.json as Array<{ id: string }>;

  await call("POST", `/api/v1/channels/${channelId}/read`, { token: betoToken, body: { message_id: segundo!.id } });

  /* Una pestaña lenta manda un id anterior. Si esto retrocediera, un mensaje ya
     leído volvería a aparecer como nuevo en el resto de dispositivos. */
  const tarde = await call("POST", `/api/v1/channels/${channelId}/read`, {
    token: betoToken,
    body: { message_id: primero!.id },
  });
  assert.equal(tarde.json.last_read_id, segundo!.id);
});

test("quien entra por invitación no hereda el historial como pendiente", async () => {
  const ana = await call("POST", "/api/v1/auth/register", {
    body: { username: "nueva-ana", password: "contrasena-larga-1" },
  });
  const anaToken = ana.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token: anaToken, body: { name: "Con historial" } });
  const communityId = community.json.id as string;
  const boot = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: anaToken });
  const channelId = boot.json.channels.find((c: any) => c.kind === "text").id as string;

  for (const texto of ["a", "b", "c"])
    await call("POST", `/api/v1/channels/${channelId}/messages`, { token: anaToken, body: { content: texto } });

  const invite = await call("POST", `/api/v1/communities/${communityId}/invites`, { token: anaToken, body: {} });
  const nuevo = await call("POST", "/api/v1/auth/register", {
    body: { username: "recien-llegado", password: "contrasena-larga-1" },
  });
  const nuevoToken = nuevo.json.access_token as string;
  await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: nuevoToken });

  const paraNuevo = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: nuevoToken });
  assert.equal(
    paraNuevo.json.unread[channelId],
    undefined,
    "llegar a una comunidad viva no debe encender todos los canales a la vez",
  );
});

test("mencionar cuenta aparte, y @everyone necesita permiso", async () => {
  const { anaToken, betoToken, betoId, communityId, channelId } = await comunidadConDos("mencion");

  await call("POST", `/api/v1/channels/${channelId}/messages`, {
    token: anaToken,
    body: { content: `hola <@${betoId}>, mira esto` },
  });

  const paraBeto = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token: betoToken });
  assert.equal(paraBeto.json.unread[channelId].count, 1);
  assert.equal(paraBeto.json.unread[channelId].mentions, 1, "nombrarle sí es una mención");

  /* Beto no tiene MENTION_EVERYONE: escribir las palabras no debe convertirse en
     un aviso para toda la comunidad. El mensaje se guarda igual. */
  const suyo = await call("POST", `/api/v1/channels/${channelId}/messages`, {
    token: betoToken,
    body: { content: "@everyone atención" },
  });
  assert.equal(suyo.status, 200);
  assert.equal(suyo.json.mentions_everyone, false, "sin el permiso, @everyone es texto normal");

  // Ana es la dueña, así que sí puede.
  const deAna = await call("POST", `/api/v1/channels/${channelId}/messages`, {
    token: anaToken,
    body: { content: "@everyone reunión" },
  });
  assert.equal(deAna.json.mentions_everyone, true);
});

test("un silencio de moderación no se lo quita el silenciado", async () => {
  const voice = await import("./voice.ts");
  const { db, seedCommunity } = await import("./db.ts");
  const { uuidv7 } = await import("@distop/protocol");

  const jefaId = uuidv7();
  const ruidosoId = uuidv7();
  const ahora = Date.now();
  for (const [id, nombre] of [
    [jefaId, "jefa"],
    [ruidosoId, "ruidoso"],
  ] as const)
    db.prepare(
      "INSERT INTO users (id, username, display_name, kind, created_at) VALUES (?, ?, ?, 'local', ?)",
    ).run(id, nombre, nombre, ahora);

  const communityId = seedCommunity({ name: "Sala", slug: `sala-${ahora}`, ownerId: jefaId, isPublic: false });
  db.prepare("INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)").run(
    communityId,
    ruidosoId,
    ahora,
  );

  const canalVoz = db
    .prepare("SELECT id FROM channels WHERE community_id = ? AND kind = 'voice'")
    .get(communityId) as { id: string };

  assert.ok(voice.join(canalVoz.id, jefaId), "la dueña entra en la sala");
  assert.ok(voice.join(canalVoz.id, ruidosoId), "el otro miembro también");
  assert.equal(voice.participantOf(canalVoz.id, ruidosoId)?.muted, false);

  // La dueña tiene todos los permisos y está por encima en la jerarquía.
  assert.equal(voice.moderate(canalVoz.id, jefaId, ruidosoId, "mute"), true);
  assert.equal(voice.participantOf(canalVoz.id, ruidosoId)?.forceMuted, true);

  /* Y aquí está lo que importa: el propio silenciado pide dejar de estar
     silenciado, que es lo que hace su botón de micrófono, y no lo consigue. */
  voice.setMute(canalVoz.id, ruidosoId, false, false);
  assert.equal(
    voice.participantOf(canalVoz.id, ruidosoId)?.muted,
    true,
    "un silencio que el silenciado puede quitarse no es moderación",
  );

  // Al revés no funciona: sin permisos no se silencia a la dueña.
  assert.equal(voice.moderate(canalVoz.id, ruidosoId, jefaId, "mute"), false);
  assert.equal(voice.participantOf(canalVoz.id, jefaId)?.muted, false);

  // Y quitarlo devuelve la palabra, porque su rol por defecto sí puede hablar.
  assert.equal(voice.moderate(canalVoz.id, jefaId, ruidosoId, "unmute"), true);
  assert.equal(voice.participantOf(canalVoz.id, ruidosoId)?.muted, false);

  voice.leaveAll(jefaId);
  voice.leaveAll(ruidosoId);
});
