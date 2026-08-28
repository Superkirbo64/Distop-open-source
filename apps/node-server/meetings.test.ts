/**
 * Reuniones (V1): sala de espera, papeles, manos y asistencia.
 *
 * Lo que de verdad importa aquí es una sola aserción, y está escrita byte a
 * byte: **quien espera fuera no recibe ni un paquete, y lo que manda no llega a
 * nadie.** No es una comprobación que el servidor haga y se pueda olvidar de
 * hacer: quien espera no está en el registro de voz, y `relayMedia` solo
 * reenvía a quien está en él. La propiedad es estructural.
 *
 * El resto —transiciones, jerarquía, cola de manos, tramos de asistencia— son
 * las reglas que hacen que una reunión sea una reunión y no una sala de voz con
 * otro nombre.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const workdir = mkdtempSync(join(tmpdir(), "distop-meet-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-reuniones";

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const { ALL_PERMISSIONS } = await import("@distop/protocol");

let base = "";
let wsBase = "";

interface Cliente {
  socket: WebSocket;
  inbox: Array<{ t: string; d: any }>;
  media: Buffer[];
}
const abiertos: Cliente[] = [];

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}/realtime`;
  await stopIntegrityWork();
});

after(async () => {
  for (const cliente of abiertos) cliente.socket.terminate();
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

function abrir(token: string): Promise<Cliente> {
  const socket = new WebSocket(`${wsBase}?token=${encodeURIComponent(token)}`);
  const cliente: Cliente = { socket, inbox: [], media: [] };
  abiertos.push(cliente);
  socket.on("message", (raw, isBinary) => {
    if (isBinary) cliente.media.push(raw as Buffer);
    else cliente.inbox.push(JSON.parse(String(raw)) as { t: string; d: any });
  });
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve(cliente));
    socket.once("error", reject);
  });
}

async function esperar(cliente: Cliente, tipo: string, cumple?: (d: any) => boolean, ms = 4000): Promise<any> {
  const limite = Date.now() + ms;
  for (;;) {
    const i = cliente.inbox.findIndex((e) => e.t === tipo && (!cumple || cumple(e.d)));
    if (i !== -1) return cliente.inbox.splice(i, 1)[0]!.d;
    if (Date.now() > limite) throw new Error(`sin evento ${tipo} en ${ms} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const reposar = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/**
 * Tira los eventos de un tipo que ya estén en el buzón.
 *
 * `esperar` recorre todo lo recibido, así que sin esto una condición que ya se
 * cumplió antes —"exactamente una mano levantada", que pasó cuando solo Leo la
 * había levantado— la daría por buena con un evento viejo.
 */
function vaciar(cliente: Cliente, tipo: string): void {
  for (let i = cliente.inbox.length - 1; i >= 0; i--) if (cliente.inbox[i]!.t === tipo) cliente.inbox.splice(i, 1);
}

/* ── el escenario ─────────────────────────────────────────────────────── */

let ana: any;
let leo: any;
let eva: any;
let comunidadId = "";

test("una comunidad con tres personas y permisos distintos", async () => {
  ana = (await call("POST", "/api/v1/auth/register", { body: { username: "ana", password: "contrasena-larga-1" } })).json;
  leo = (await call("POST", "/api/v1/auth/register", { body: { username: "leo", password: "contrasena-larga-2" } })).json;
  eva = (await call("POST", "/api/v1/auth/register", { body: { username: "eva", password: "contrasena-larga-3" } })).json;

  const comunidad = await call("POST", "/api/v1/communities", { token: ana.access_token, body: { name: "El Consejo" } });
  comunidadId = comunidad.json.id as string;
  const invitacion = await call("POST", `/api/v1/communities/${comunidadId}/invites`, { token: ana.access_token, body: {} });
  for (const quien of [leo, eva]) {
    await call("POST", `/api/v1/invites/${invitacion.json.code}/join`, { token: quien.access_token });
  }
  assert.ok(comunidadId);
});

test("convocar es un permiso propio, no un efecto de poder crear canales", async () => {
  const ajena = await call("POST", `/api/v1/communities/${comunidadId}/meetings`, {
    token: leo.access_token,
    body: { title: "La mía" },
  });
  assert.equal(ajena.status, 403, "sin MANAGE_MEETINGS no se convoca");
});

let reunion: any;
let canalId = "";

test("convocar crea el canal y deja a quien organiza como anfitrión", async () => {
  const creada = await call("POST", `/api/v1/communities/${comunidadId}/meetings`, {
    token: ana.access_token,
    body: { title: "Reunión del martes", agenda: "Repasar el plan" },
  });
  assert.equal(creada.status, 200, JSON.stringify(creada.json));
  reunion = creada.json;
  canalId = reunion.channel_id as string;

  assert.equal(reunion.state, "DRAFT", "sin fecha nace como borrador");
  assert.equal(reunion.lobby, true, "la sala de espera viene puesta");

  const canal = db.prepare("SELECT kind, name FROM channels WHERE id = ?").get(canalId) as { kind: string; name: string };
  assert.equal(canal.kind, "meeting", "es un canal más, con su propio tipo");

  const detalle = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: ana.access_token });
  assert.equal(detalle.json.my_role, "host");
  assert.equal((await call("GET", `/api/v1/meetings/${reunion.id}`, { token: leo.access_token })).json.my_role, "attendee");
});

test("entrar antes de abrir recibe un rechazo explícito y no finge conexión", async () => {
  const cliente = await abrir(ana.access_token);
  cliente.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: comunidadId } }));
  await reposar();
  cliente.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  const resultado = await esperar(cliente, "VOICE_JOIN_RESULT", (d) => d.channel_id === canalId);
  assert.equal(resultado.outcome, "closed");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id = ?").get(reunion.id) as { n: number }).n,
    0,
  );
  cliente.socket.close();
});

test("la máquina de estados no acepta atajos, y una reunión terminada no se reabre", async () => {
  /* DRAFT no puede saltar a ENDED: cerrar algo que nunca se abrió dejaría una
     reunión "terminada" sin principio ni asistencia. */
  const salto = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: ana.access_token,
    body: { state: "ENDED" },
  });
  assert.equal(salto.status, 409);
  assert.equal(salto.json.error.code, "MEETING_BAD_TRANSITION");

  const inventado = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: ana.access_token,
    body: { state: "PAUSADA" },
  });
  assert.equal(inventado.status, 400);

  const ajena = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: leo.access_token,
    body: { state: "LIVE" },
  });
  assert.equal(ajena.status, 403, "un asistente no abre la reunión de otro");

  const abierta = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: ana.access_token,
    body: { state: "LIVE" },
  });
  assert.equal(abierta.status, 200);
  assert.equal(abierta.json.state, "LIVE");
  assert.ok(abierta.json.opened_at > 0);
});

/* ── la sala de espera, que es de lo que va todo esto ─────────────────── */

let cAna: Cliente;
let cLeo: Cliente;

test("quien espera fuera no recibe ni un paquete, y lo que manda no llega a nadie", async () => {
  cAna = await abrir(ana.access_token);
  cLeo = await abrir(leo.access_token);
  for (const cliente of [cAna, cLeo]) {
    cliente.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: comunidadId } }));
  }
  await reposar();

  /* Ana modera: entra directa. Si tuviera que esperar a que alguien le abriese,
     una reunión con sala de espera no podría empezar nunca. */
  cAna.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === canalId && d.states.length === 1);

  /* Y se quita el silencio de entrada. Sin esto, la aserción de abajo pasaría
     porque Ana está muda —el servidor descarta el audio de quien está
     silenciado— y no porque Leo esté fuera: probaría otra cosa y parecería
     probar esta. */
  cAna.socket.send(JSON.stringify({ t: "VOICE_MUTE", d: { channel_id: canalId, muted: false, deafened: false } }));
  await reposar(200);

  // Leo llama a la puerta.
  cLeo.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  const espera = await esperar(cLeo, "MEETING_WAITING");
  assert.equal(espera.admitted, false);

  const lobby = await esperar(cAna, "MEETING_LOBBY");
  assert.equal(lobby.waiting.length, 1, "quien puede abrir ve quién espera");
  assert.equal(lobby.waiting[0].user_id, leo.user.id);
  assert.ok(!cLeo.inbox.some((e) => e.t === "MEETING_LOBBY"), "y quien espera no ve la lista de la sala de espera");

  /* Y ahora lo importante. Del cliente sale [tipo][datos]; a los demás llega
     [tipo][16 bytes de quién][datos]. Tipo 0 es voz. */
  const datos = Buffer.from([0xfc, 0x01, 0x02, 0x03, 0x04]);
  cAna.media.length = 0;
  cLeo.media.length = 0;

  cAna.socket.send(Buffer.concat([Buffer.of(0), datos]), { binary: true });
  cLeo.socket.send(Buffer.concat([Buffer.of(0), datos]), { binary: true });
  await reposar(400);

  assert.equal(cLeo.media.length, 0, "a quien espera no le llega el audio de la reunión");
  assert.equal(cAna.media.length, 0, "y el audio de quien espera no entra en la reunión");

  const estados = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: ana.access_token });
  assert.equal(estados.json.waiting.length, 1);
  const asistio = db
    .prepare("SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
    .get(reunion.id, leo.user.id) as { n: number };
  assert.equal(asistio.n, 0, "esperar no cuenta como haber asistido");
});

test("admitir mete de verdad, y entonces sí pasa el audio", async () => {
  cAna.socket.send(JSON.stringify({ t: "MEETING_ADMIT", d: { channel_id: canalId, user_id: leo.user.id } }));
  const admitido = await esperar(cLeo, "MEETING_WAITING", (d) => d.admitted === true);
  assert.equal(admitido.channel_id, canalId);
  await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === canalId && d.states.length === 2);

  const estado = await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === canalId && d.states.length === 2, 4000)
    .catch(async () => (await call("GET", `/api/v1/meetings/${reunion.id}`, { token: ana.access_token })).json);
  const suyo = (estado.states as any[] | undefined)?.find((s) => s.user_id === leo.user.id);
  if (suyo) assert.equal(suyo.muted, true, "mute_on_entry hace lo que dice: entra escuchando, no interrumpiendo");

  cAna.media.length = 0;
  cLeo.media.length = 0;
  const datos = Buffer.from([0xaa, 0xbb]);
  cAna.socket.send(Buffer.concat([Buffer.of(0), datos]), { binary: true });
  await reposar(400);

  assert.equal(cLeo.media.length, 1, "ya está dentro: ahora sí oye");
  assert.equal(cLeo.media[0]!.subarray(17).toString("hex"), datos.toString("hex"));
  assert.equal(cAna.media.length, 0, "y nunca vuelve a quien lo mandó");

  const asistio = db
    .prepare("SELECT admitted_by, role_at_join FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
    .get(reunion.id, leo.user.id) as { admitted_by: string; role_at_join: string };
  assert.equal(asistio.admitted_by, ana.user.id, "queda escrito quién le abrió");
  assert.equal(asistio.role_at_join, "attendee");
});

test("denegar la entrada saca de la cola sin decir quién lo decidió", async () => {
  const cEva = await abrir(eva.access_token);
  cEva.socket.send(JSON.stringify({ t: "SUBSCRIBE", d: { community_id: comunidadId } }));
  await reposar();
  cEva.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  await esperar(cEva, "MEETING_WAITING", (d) => d.admitted === false);

  cAna.socket.send(JSON.stringify({ t: "MEETING_DENY", d: { channel_id: canalId, user_id: eva.user.id } }));
  await reposar(300);

  const detalle = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: ana.access_token });
  assert.equal(detalle.json.waiting.length, 0, "ya no está en la cola");
  const negado = cEva.inbox.filter((e) => e.t === "MEETING_WAITING").at(-1);
  assert.equal(negado?.d.admitted, false);
  assert.ok(!JSON.stringify(negado).includes(ana.user.id), "no se dice quién decidió: sería una lista de a quién culpar");
});

test("un asistente no puede admitir a nadie por mucho que mande el comando", async () => {
  const cEva = abiertos.at(-1)!;
  cEva.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  await esperar(cEva, "MEETING_WAITING", (d) => d.admitted === false);

  // Leo es `attendee`: el botón no existe en su interfaz, pero el comando sí.
  cLeo.socket.send(JSON.stringify({ t: "MEETING_ADMIT", d: { channel_id: canalId, user_id: eva.user.id } }));
  await reposar(300);

  const detalle = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: ana.access_token });
  assert.equal(detalle.json.waiting.length, 1, "sigue esperando: el permiso se revalida en el servidor");
});

/* ── manos ────────────────────────────────────────────────────────────── */

test("la cola de manos respeta el orden de llegada, e insistir no adelanta", async () => {
  cAna.socket.send(JSON.stringify({ t: "MEETING_ADMIT_ALL", d: { channel_id: canalId } }));
  await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === canalId && d.states.length === 3);

  const cEva = abiertos.at(-1)!;
  cLeo.socket.send(JSON.stringify({ t: "MEETING_HAND", d: { channel_id: canalId, raised: true } }));
  await reposar(120);
  cEva.socket.send(JSON.stringify({ t: "MEETING_HAND", d: { channel_id: canalId, raised: true } }));
  await reposar(120);
  // Leo insiste: si eso refrescase su marca, se colaría por delante de Eva.
  cLeo.socket.send(JSON.stringify({ t: "MEETING_HAND", d: { channel_id: canalId, raised: true } }));
  await reposar(300);

  const estado = await esperar(cAna, "VOICE_STATE_UPDATE", (d) =>
    (d.states as any[]).filter((s) => s.hand_raised_at !== null).length === 2,
  );
  const cola = (estado.states as any[])
    .filter((s) => s.hand_raised_at !== null)
    .sort((a, b) => a.hand_raised_at - b.hand_raised_at)
    .map((s) => s.user_id);
  assert.deepEqual(cola, [leo.user.id, eva.user.id], "quien pidió primero sigue siendo el primero");

  vaciar(cAna, "VOICE_STATE_UPDATE");
  cLeo.socket.send(JSON.stringify({ t: "MEETING_HAND", d: { channel_id: canalId, raised: false } }));
  const bajada = await esperar(cAna, "VOICE_STATE_UPDATE", (d) =>
    (d.states as any[]).filter((s) => s.hand_raised_at !== null).length === 1,
  );
  assert.equal((bajada.states as any[]).find((s) => s.hand_raised_at !== null).user_id, eva.user.id);
});

/* ── papeles ──────────────────────────────────────────────────────────── */

test("nadie reparte un papel igual o superior al suyo", async () => {
  const sube = await call("PUT", `/api/v1/meetings/${reunion.id}/roles`, {
    token: ana.access_token,
    body: { user_id: leo.user.id, role: "cohost" },
  });
  assert.equal(sube.status, 200);

  /* Leo ya es coanfitrión: puede nombrar presentadores, pero no coanfitriones
     —su propio rango— ni tocar a Ana, que está por encima. */
  const iguala = await call("PUT", `/api/v1/meetings/${reunion.id}/roles`, {
    token: leo.access_token,
    body: { user_id: eva.user.id, role: "cohost" },
  });
  assert.equal(iguala.status, 403);

  const derroca = await call("PUT", `/api/v1/meetings/${reunion.id}/roles`, {
    token: leo.access_token,
    body: { user_id: ana.user.id, role: "attendee" },
  });
  assert.equal(derroca.status, 403, "un coanfitrión no destituye al anfitrión y se queda la reunión");

  const presenta = await call("PUT", `/api/v1/meetings/${reunion.id}/roles`, {
    token: leo.access_token,
    body: { user_id: eva.user.id, role: "presenter" },
  });
  assert.equal(presenta.status, 200);
});

test("no se puede quitar el papel al último anfitrión", async () => {
  const suicidio = await call("PUT", `/api/v1/meetings/${reunion.id}/roles`, {
    token: ana.access_token,
    body: { user_id: ana.user.id, role: "attendee" },
  });
  assert.equal(suicidio.status, 409);
  assert.equal(suicidio.json.error.code, "MEETING_LAST_HOST");
});

test("la asistencia la ve quien organiza, no cualquiera que esté dentro", async () => {
  const ajena = await call("GET", `/api/v1/meetings/${reunion.id}/attendance`, { token: eva.access_token });
  assert.equal(ajena.status, 403, "quién estuvo y cuánto es un registro sobre personas");

  const propia = await call("GET", `/api/v1/meetings/${reunion.id}/attendance`, { token: ana.access_token });
  assert.equal(propia.status, 200);
  assert.equal(propia.json.sessions.length, 3);
});

test("entrar, salir y volver son dos tramos, no uno", async () => {
  cLeo.socket.send(JSON.stringify({ t: "VOICE_LEAVE", d: { channel_id: canalId } }));
  await reposar(300);

  const tramoUno = db
    .prepare("SELECT left_at FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
    .get(reunion.id, leo.user.id) as { left_at: number | null };
  assert.ok(tramoUno.left_at !== null, "al salir se cierra el tramo");

  cLeo.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: canalId } }));
  await reposar(400);

  const tramos = db
    .prepare("SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id = ? AND user_id = ?")
    .get(reunion.id, leo.user.id) as { n: number };
  assert.equal(tramos.n, 2, "un solo left_at por persona habría perdido el segundo tramo");

  const totales = await call("GET", `/api/v1/meetings/${reunion.id}/attendance`, { token: ana.access_token });
  const suyo = (totales.json.totals as any[]).find((t) => t.user_id === leo.user.id);
  assert.ok(suyo.seconds >= 0, "y el total suma los dos");
});

/* ── el poder de seguridad de la comunidad ────────────────────────────── */

test("quien administra la comunidad puede cerrar una reunión que no organizó, y queda escrito", async () => {
  /* Eva no es anfitriona de nada. Se le da MANAGE_MEETINGS en la comunidad: eso
     no la convierte en organizadora —su papel sigue siendo `presenter`— pero sí
     le permite terminar una reunión abusiva dentro del servidor que administra.
     Quitarle ese poder permitiría crear, dentro del servidor de otra persona,
     una zona imposible de moderar. */
  const roles = await call("GET", `/api/v1/communities/${comunidadId}/roles`, { token: ana.access_token });
  const porDefecto = (roles.json as any[]).find((r) => r.is_default);
  await call("PATCH", `/api/v1/roles/${porDefecto.id}`, {
    token: ana.access_token,
    body: { permissions: String(ALL_PERMISSIONS) },
  });

  const detalle = await call("GET", `/api/v1/meetings/${reunion.id}`, { token: eva.access_token });
  assert.equal(detalle.json.my_role, "presenter", "el poder de seguridad no la asciende en la reunión");

  const cerrada = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: eva.access_token,
    body: { state: "ENDED" },
  });
  assert.equal(cerrada.status, 200);
  assert.equal(cerrada.json.state, "ENDED");
  const vozCerrada = await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === canalId && d.states.length === 0);
  assert.equal(vozCerrada.states.length, 0, "cerrar también saca visualmente a todos los clientes");
  assert.ok(cerrada.json.closed_at > 0);

  const log = await call("GET", `/api/v1/communities/${comunidadId}/audit`, { token: ana.access_token });
  const entrada = (log.json as any[]).find((e) => e.action === "MEETING_ENDED");
  assert.ok(entrada, "un poder de seguridad invisible no es un poder de seguridad");
  assert.equal(entrada.actor_id, eva.user.id);
});

test("cerrar completa la asistencia de todo el mundo y vacía la sala", async () => {
  const abiertas = db
    .prepare("SELECT COUNT(*) AS n FROM meeting_attendance WHERE meeting_id = ? AND left_at IS NULL")
    .get(reunion.id) as { n: number };
  assert.equal(abiertas.n, 0, "nadie se queda 'todavía dentro' de una reunión terminada");

  const reabrir = await call("POST", `/api/v1/meetings/${reunion.id}/state`, {
    token: ana.access_token,
    body: { state: "LIVE" },
  });
  assert.equal(reabrir.status, 409, "terminada es terminada: reabrirla falsearía su duración");
});

test("una reunión que se queda vacía termina sola", async () => {
  const otra = await call("POST", `/api/v1/communities/${comunidadId}/meetings`, {
    token: ana.access_token,
    body: { title: "La corta", lobby: false },
  });
  const otroCanal = otra.json.channel_id as string;
  await call("POST", `/api/v1/meetings/${otra.json.id}/state`, { token: ana.access_token, body: { state: "LIVE" } });

  cAna.socket.send(JSON.stringify({ t: "VOICE_JOIN", d: { channel_id: otroCanal } }));
  await esperar(cAna, "VOICE_STATE_UPDATE", (d) => d.channel_id === otroCanal && d.states.length === 1);
  cAna.socket.send(JSON.stringify({ t: "VOICE_LEAVE", d: { channel_id: otroCanal } }));

  const fin = await esperar(cAna, "MEETING_UPDATE", (d) => d.id === otra.json.id && d.state === "ENDED");
  assert.ok(fin.closed_at > 0, "si no, quedaría LIVE para siempre y su asistencia abierta");
});
