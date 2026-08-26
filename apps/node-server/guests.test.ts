/**
 * Invitados de reunión (V2).
 *
 * Lo que importa aquí no es que un invitado pueda entrar —eso es la parte
 * fácil— sino que **no pueda hacer nada más**. Una sesión de invitado es una
 * llave que alguien reparte por un enlace; si esa llave abriera la comunidad,
 * repartir el enlace de una reunión de media hora sería regalar el servidor.
 *
 * Por eso la mayoría de estas pruebas son negativas, y por eso la puerta que
 * las hace ciertas es una lista blanca: una lista negra dejaría permitida por
 * omisión cualquier ruta que se añada mañana.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const workdir = mkdtempSync(join(tmpdir(), "distop-guest-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-invitados";

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const meetings = await import("./meetings.ts");

let base = "";
let wsBase = "";
const sockets: WebSocket[] = [];

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/realtime`;
  await stopIntegrityWork();
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  server.closeAllConnections();
  server.close();
  await stopIntegrityWork();
  await new Promise((r) => setTimeout(r, 150));
  try { db.close(); } catch { /* ya cerrada */ }
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
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/* ── el escenario ─────────────────────────────────────────────────────── */

let ana: any;
let comunidadId = "";
let canalPrivado = "";
let reunion: any;
let enlace = "";

test("una comunidad con una reunión y un canal que el invitado no debe ver", async () => {
  ana = (await call("POST", "/api/v1/auth/register", { body: { username: "ana", password: "contrasena-larga-1" } })).json;
  const comunidad = await call("POST", "/api/v1/communities", { token: ana.access_token, body: { name: "La Cooperativa" } });
  comunidadId = comunidad.json.id as string;

  const boot = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token: ana.access_token });
  canalPrivado = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!.id;

  const creada = await call("POST", `/api/v1/communities/${comunidadId}/meetings`, {
    token: ana.access_token,
    body: { title: "Junta abierta" },
  });
  reunion = creada.json;
  assert.equal(reunion.guests_allowed, false, "los invitados no vienen puestos: hay que pedirlo");
});

test("sin invitación no se entra, y no se dice si el enlace existía", async () => {
  const inventado = await call("POST", "/api/v1/meetings/guest", {
    body: { token: "un-enlace-que-nadie-repartio", display_name: "Alguien" },
  });
  assert.equal(inventado.status, 404);
  assert.equal(inventado.json.error.code, "INVITE_INVALID", "un solo código: distinguirlos sería un oráculo de enlaces");
});

test("crear el enlace enciende los invitados y lo enseña una sola vez", async () => {
  const creado = await call("POST", `/api/v1/meetings/${reunion.id}/invites`, {
    token: ana.access_token,
    body: { label: "Para la asesora", max_uses: 2 },
  });
  assert.equal(creado.status, 200, JSON.stringify(creado.json));
  enlace = creado.json.token as string;
  assert.ok(enlace.length >= 20);

  const listadas = await call("GET", `/api/v1/meetings/${reunion.id}/invites`, { token: ana.access_token });
  assert.equal(listadas.json.guests_allowed, true, "crear un enlace sin poder usarlo no le sirve a nadie");
  assert.equal(listadas.json.invites.length, 1);
  assert.ok(!JSON.stringify(listadas.json).includes(enlace), "el token no se vuelve a enseñar: solo existe su hash");

  const enBase = db.prepare("SELECT token_hash FROM meeting_invites").get() as { token_hash: string };
  assert.notEqual(enBase.token_hash, enlace, "ni se guarda en claro");
});

test("con la reunión cerrada el enlace no abre nada, aunque sea válido", async () => {
  const pronto = await call("POST", "/api/v1/meetings/guest", {
    body: { token: enlace, display_name: "La asesora" },
  });
  assert.equal(pronto.status, 409);
  assert.equal(pronto.json.error.code, "MEETING_CLOSED", "quien llega pronto merece saber que llegó pronto");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'guest'").get() as { n: number }).n,
    0,
    "y no se creó ninguna cuenta: primero se comprueba, después se crea",
  );
});

let invitada: any;

test("con la reunión abierta se entra, sin cuenta y sin instalar nada", async () => {
  await call("POST", `/api/v1/meetings/${reunion.id}/state`, { token: ana.access_token, body: { state: "LOBBY" } });

  const entrada = await call("POST", "/api/v1/meetings/guest", {
    body: { token: enlace, display_name: "La asesora" },
  });
  assert.equal(entrada.status, 200, JSON.stringify(entrada.json));
  invitada = entrada.json;
  assert.equal(invitada.meeting.id, reunion.id);
  assert.ok(invitada.access_token);

  const atada = db.prepare("SELECT meeting_id FROM meeting_guests WHERE user_id = ?").get(invitada.user.id) as
    | { meeting_id: string }
    | undefined;
  assert.equal(atada?.meeting_id, reunion.id);

  const sesion = db.prepare("SELECT meeting_id FROM sessions WHERE user_id = ?").get(invitada.user.id) as
    | { meeting_id: string | null }
    | undefined;
  assert.equal(sesion?.meeting_id, reunion.id, "la sesión nace acotada, no se acota después");
});

/* ── y aquí empieza lo que de verdad hay que probar ───────────────────── */

test("un invitado no es miembro de la comunidad y no aparece en su lista", async () => {
  const miembros = db
    .prepare("SELECT COUNT(*) AS n FROM members WHERE community_id = ? AND user_id = ?")
    .get(comunidadId, invitada.user.id) as { n: number };
  assert.equal(miembros.n, 0, "meterlo en members le daría todo lo demás");

  const lista = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token: ana.access_token });
  assert.ok(
    !(lista.json.members as Array<{ user_id: string }>).some((m) => m.user_id === invitada.user.id),
    "y no sale en la lista de miembros de nadie",
  );
});

test("su sesión no sirve para nada fuera de su reunión", async () => {
  const prohibidas: Array<[string, string]> = [
    ["GET", `/api/v1/communities/${comunidadId}/bootstrap`],
    ["GET", `/api/v1/channels/${canalPrivado}/messages`],
    ["POST", `/api/v1/channels/${canalPrivado}/messages`],
    ["GET", `/api/v1/communities/${comunidadId}/audit`],
    ["GET", `/api/v1/communities/${comunidadId}/export`],
    ["POST", "/api/v1/communities"],
    ["GET", `/api/v1/meetings/${reunion.id}/attendance`],
    ["GET", `/api/v1/meetings/${reunion.id}/invites`],
  ];
  for (const [metodo, ruta] of prohibidas) {
    const salida = await call(metodo, ruta, {
      token: invitada.access_token,
      /* Un GET con cuerpo no es una peticion: fetch lo rechaza antes de salir. */
      ...(metodo === "GET" ? {} : { body: { content: "hola", name: "x" } }),
    });
    assert.equal(salida.status, 403, `${metodo} ${ruta} debería estar cerrado`);
    assert.equal(salida.json.error.code, "GUEST_SCOPED");
  }
});

test("y tampoco para OTRA reunión de la misma comunidad", async () => {
  const otra = await call("POST", `/api/v1/communities/${comunidadId}/meetings`, {
    token: ana.access_token,
    body: { title: "La privada" },
  });
  const ajena = await call("GET", `/api/v1/meetings/${otra.json.id}`, { token: invitada.access_token });
  assert.equal(ajena.status, 403, "que la FORMA de la ruta encaje no basta: el id tiene que ser el suyo");
  assert.equal(ajena.json.error.code, "GUEST_SCOPED");
});

test("sí puede ver su reunión y escribir en su chat", async () => {
  const suya = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: invitada.access_token });
  assert.equal(suya.status, 200);
  assert.equal(suya.json.my_role, "attendee");
  assert.deepEqual(suya.json.waiting, [], "y no ve la sala de espera: eso es de quien modera");

  const escrito = await call("POST", `/api/v1/channels/${reunion.channel_id}/messages`, {
    token: invitada.access_token,
    body: { content: "buenas, ya estoy" },
  });
  assert.equal(escrito.status, 200);
});

test("no puede adjuntar ficheros al disco de quien hospeda", async () => {
  const subida = await fetch(`${base}/api/v1/uploads`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${invitada.access_token}`,
      "content-type": "image/png",
      "x-filename": "cosa.png",
    },
    body: Buffer.alloc(64),
  });
  assert.equal(subida.status, 403, "invitar a una reunión no es dar espacio en disco");
});

test("por el gateway tampoco: no puede suscribirse a la comunidad", async () => {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(invitada.access_token)}`);
  sockets.push(socket);
  const recibidos: Array<{ t: string; d: any }> = [];
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) recibidos.push(JSON.parse(String(raw)) as { t: string; d: any });
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: comunidadId } }));
  await new Promise((r) => setTimeout(r, 300));

  /* Ana escribe en el canal privado. Si la suscripción hubiera colado, esto
     llegaría al invitado. */
  await call("POST", `/api/v1/channels/${canalPrivado}/messages`, {
    token: ana.access_token,
    body: { content: "esto es de la comunidad, no de la reunión" },
  });
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(
    !recibidos.some((e) => e.t === "MESSAGE_CREATE"),
    "no es miembro: SUBSCRIBE no le da nada, y sin eso no recibe mensajes de la comunidad",
  );
});

test("pero sí recibe lo de su propia reunión, aunque no esté suscrito a nada", async () => {
  const socket = sockets.at(-1)!;
  const recibidos: Array<{ t: string; d: any }> = [];
  socket.on("message", (raw, isBinary) => {
    if (!isBinary) recibidos.push(JSON.parse(String(raw)) as { t: string; d: any });
  });

  await call("POST", `/api/v1/channels/${reunion.channel_id}/messages`, {
    token: ana.access_token,
    body: { content: "hola a quien esté esperando" },
  });
  await new Promise((r) => setTimeout(r, 400));

  assert.ok(
    recibidos.some((e) => e.t === "MESSAGE_CREATE" && e.d.channel_id === reunion.channel_id),
    "sin esto un invitado no vería ni la reunión a la que le invitaron",
  );
});

/* ── el enlace tiene límites, y se pueden quitar ──────────────────────── */

test("el enlace se gasta: dos usos son dos usos", async () => {
  const segunda = await call("POST", "/api/v1/meetings/guest", { body: { token: enlace, display_name: "Otro" } });
  assert.equal(segunda.status, 200, "el segundo uso todavía vale");

  const tercera = await call("POST", "/api/v1/meetings/guest", { body: { token: enlace, display_name: "Un tercero" } });
  assert.equal(tercera.status, 404, "el tercero ya no");
});

test("revocar un enlace lo mata en el acto", async () => {
  const creado = await call("POST", `/api/v1/meetings/${reunion.id}/invites`, {
    token: ana.access_token,
    body: { label: "temporal" },
  });
  const vivo = creado.json.token as string;
  assert.equal((await call("POST", "/api/v1/meetings/guest", { body: { token: vivo, display_name: "Antes" } })).status, 200);

  await call("DELETE", `/api/v1/meetings/${reunion.id}/invites/${creado.json.invite.id}`, { token: ana.access_token });
  const despues = await call("POST", "/api/v1/meetings/guest", { body: { token: vivo, display_name: "Después" } });
  assert.equal(despues.status, 404);
});

test("las invitaciones las reparte quien organiza, no cualquiera que entre", async () => {
  const ajena = await call("POST", `/api/v1/meetings/${reunion.id}/invites`, {
    token: invitada.access_token,
    body: {},
  });
  assert.equal(ajena.status, 403);
});

/* ── limpieza ─────────────────────────────────────────────────────────── */

test("los invitados que nunca entraron se limpian; los que sí, se quedan", async () => {
  /* Se admite a una de ellas: entrar de verdad la saca de la limpieza. */
  meetings.joinMeeting(reunion.channel_id, invitada.user.id);
  meetings.admit(reunion.channel_id, ana.user.id, invitada.user.id);

  const antes = (db.prepare("SELECT COUNT(*) AS n FROM meeting_guests").get() as { n: number }).n;
  assert.ok(antes >= 3, "hay varias personas que solo abrieron el enlace");

  /* Con la ventana a cero, todo lo no admitido es viejo. */
  const borrados = meetings.sweepGuests(0);
  assert.ok(borrados >= 2, "las que nunca entraron dejan de ocupar disco");

  const quedan = db.prepare("SELECT user_id FROM meeting_guests").all() as Array<{ user_id: string }>;
  assert.deepEqual(
    quedan.map((q) => q.user_id),
    [invitada.user.id],
    "y quien sí estuvo en la reunión se queda: su asistencia es un registro real",
  );
  assert.ok(
    db.prepare("SELECT id FROM users WHERE id = ?").get(invitada.user.id),
    "su cuenta tampoco se borra",
  );
});
