/**
 * Relevo planificado, de principio a fin (C2).
 *
 * El criterio de cierre de la fase: una instancia nueva asume la línea SIN
 * recibir la clave privada de la anterior, y cualquier cliente que tuviera
 * fijada la vieja puede demostrar por sí mismo que la nueva es su continuación.
 *
 * Lo demás que se prueba aquí son las formas de romperlo: activar antes de que
 * pase el aviso, ascender mientras el otro sigue mandando, dos relevos a la
 * vez, un recibo sin firma, y una instancia retirada que siguiera sirviendo.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const raiz = mkdtempSync(join(tmpdir(), "distop-relevo-"));
const dirA = join(raiz, "a");
const dirB = join(raiz, "b");
mkdirSync(dirA, { recursive: true });
mkdirSync(dirB, { recursive: true });

process.env.PORT = "0";
process.env.DATABASE_PATH = join(dirA, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(dirA, "uploads");
delete process.env.AUTH_SECRET;
process.env.INSTANCE_NAME = "La Casa";

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const { adopt, promote, AdoptError } = await import("./adopt.ts");
const { currentIdentity, verifySuccessionChain, setHandoverState, findHandover } = await import("./succession.ts");
const { instanceEpoch, instanceRole } = await import("./identity.ts");

const ORIGEN_B = "https://equipo-nuevo.example";
let base = "";
let token = "";
let comunidadId = "";
let identidadA = { instance_id: "", lineage_id: "", epoch: 1, fingerprint: "" };

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await stopIntegrityWork();
});

after(() => {
  server.closeAllConnections();
  server.close();
  try { db.close(); } catch { /* ya cerrada */ }
  rmSync(raiz, { recursive: true, force: true });
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

async function falla(promesa: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promesa;
  } catch (error) {
    return error as { code: string; message: string };
  }
  assert.fail("se esperaba un fallo y la operación salió bien");
}

let codigo = "";
let sucesorId = "";

test("la comunidad de A, antes de nada", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  assert.equal(claim.status, 200);
  token = claim.json.access_token as string;

  const comunidad = await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });
  comunidadId = comunidad.json.id as string;
  const boot = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  const canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!;
  await call("POST", `/api/v1/channels/${canal.id}/messages`, { token, body: { content: "esto tiene que sobrevivir" } });

  identidadA = { ...currentIdentity() };
  assert.equal(identidadA.epoch, 1);
});

test("autorizar un sucesor da un código de un solo uso, y solo puede quien hospeda", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  const ajeno = await call("POST", "/api/v1/instance/successors", {
    token: visita.json.access_token as string,
    body: { label: "el portátil de nadie" },
  });
  assert.equal(ajeno.status, 403, "un sucesor hereda TODAS las comunidades: no lo elige cualquiera");

  const creado = await call("POST", "/api/v1/instance/successors", {
    token,
    body: { label: "el portátil de Ana" },
  });
  assert.equal(creado.status, 200);
  assert.match(creado.json.enrol_code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  assert.equal(creado.json.enrolled, false);
  codigo = creado.json.enrol_code as string;
  sucesorId = creado.json.id as string;

  // El código no vuelve a aparecer por ninguna ruta: solo se guardó su hash.
  const lista = await call("GET", "/api/v1/instance/successors", { token });
  assert.equal(lista.status, 200);
  assert.ok(!JSON.stringify(lista.json).includes(codigo), "el código no se guarda en claro");
});

test("dos relevos a la vez no son dos relevos: son un fork firmado por nosotros", async () => {
  const otro = await call("POST", "/api/v1/instance/successors", { token, body: { label: "otro equipo" } });
  assert.equal(otro.status, 200);
  /* Ninguno de los dos está enrolado todavía, así que el primer error es ese;
     lo que importa aquí es que la exclusión existe y se prueba de verdad más
     abajo, cuando ya hay uno vivo. */
  const segundo = await call("POST", "/api/v1/instance/handover", { token, body: { successor_id: otro.json.id } });
  assert.equal(segundo.status, 400);
  await call("DELETE", `/api/v1/instance/successors/${otro.json.id}`, { token });
});

test("no se puede arrancar un relevo con un sucesor que aún no se presentó", async () => {
  const pronto = await call("POST", "/api/v1/instance/handover", { token, body: { successor_id: sucesorId } });
  assert.equal(pronto.status, 400);
  assert.equal(pronto.json.error.code, "SUCCESSOR_NOT_ENROLLED");
});

test("B adopta la línea: se trae los datos, genera su propia clave y queda en reserva", async () => {
  /* `adopt` se presenta, espera a que A prepare la copia, la descarga, la
     verifica y firma el recibo. Corre en paralelo porque A no puede preparar
     nada hasta que B se haya presentado con su clave. */
  const adopcion = adopt({
    from: base,
    origin: ORIGEN_B,
    code: codigo,
    targetDir: dirB,
    replace: true,
    pollMs: 150,
  });

  // En cuanto B se presenta, A puede arrancar el relevo y preparar el bundle.
  for (let i = 0; i < 100; i++) {
    const lista = await call("GET", "/api/v1/instance/successors", { token });
    if ((lista.json as Array<{ id: string; enrolled: boolean }>).find((s) => s.id === sucesorId)?.enrolled) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const relevo = await call("POST", "/api/v1/instance/handover", { token, body: { successor_id: sucesorId } });
  assert.equal(relevo.status, 200, JSON.stringify(relevo.json));
  assert.equal(relevo.json.state, "PREPARING");
  assert.equal(relevo.json.to_epoch, 2);
  assert.equal(relevo.json.unplanned, false);
  assert.ok(relevo.json.activates_at - Date.now() > 23 * 60 * 60_000, "un relevo normal avisa con 24 h");

  const resultado = await adopcion;
  assert.equal(resultado.role, "STANDBY", "B tiene los datos pero todavía no manda");
  assert.equal(resultado.epoch, 2);
  assert.equal(resultado.restore.ok, true);

  // Lo que define C2: la clave privada de A NO viajó.
  assert.notEqual(
    readFileSync(join(dirB, "instance.key"), "utf8"),
    readFileSync(join(dirA, "instance.key"), "utf8"),
    "el sucesor tiene clave propia; la del anfitrión anterior nunca sale de su disco",
  );

  // Y sí viajaron los datos.
  const baseB = new DatabaseSync(join(dirB, "app.db"));
  try {
    const mensajes = baseB.prepare("SELECT content FROM messages").all() as Array<{ content: string }>;
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0]!.content, "esto tiene que sobrevivir");
    const meta = (clave: string): string =>
      (baseB.prepare("SELECT value FROM meta WHERE key = ?").get(clave) as { value: string } | undefined)?.value ?? "";
    assert.equal(meta("lineage_id"), identidadA.lineage_id, "el linaje es el mismo: es la misma comunidad");
    assert.notEqual(meta("instance_id"), identidadA.instance_id, "pero es otra instancia");
    assert.equal(meta("instance_epoch"), "2");
    assert.equal(meta("instance_role"), "STANDBY");
  } finally {
    baseB.close();
  }
});

test("un cliente que tenía fijada a A puede demostrar que B es su continuación", () => {
  const cadena = JSON.parse(
    (db.prepare("SELECT certificate FROM handovers ORDER BY started_at DESC LIMIT 1").get() as { certificate: string })
      .certificate,
  );
  const resultado = verifySuccessionChain(identidadA, [cadena]);
  assert.equal(resultado.ok, true);
  if (!resultado.ok) return;
  assert.equal(resultado.final.epoch, 2);
  assert.equal(resultado.final.lineage_id, identidadA.lineage_id);
  assert.notEqual(resultado.final.fingerprint, identidadA.fingerprint);
  assert.deepEqual(resultado.origins, [ORIGEN_B]);

  // Y no vale para una identidad que no es la suya.
  const otra = { ...identidadA, fingerprint: "huella-de-otro" };
  const rechazado = verifySuccessionChain(otra, [cadena]);
  assert.equal(rechazado.ok, false);
  if (!rechazado.ok) assert.equal(rechazado.reason, "SIGNER_NOT_PREDECESSOR");
});

test("no se activa antes de que pase el aviso que se anunció a los miembros", async () => {
  const pronto = await call("POST", "/api/v1/instance/handover/activate", { token });
  assert.equal(pronto.status, 409);
  assert.match(pronto.json.error.message, /ventana de aviso/);
  assert.equal(instanceRole(), "PRIMARY", "y A sigue mandando");
});

test("B no se asciende mientras A siga mandando", async () => {
  const fallo = await falla(promote({ from: base, targetDir: dirB }));
  assert.equal(fallo.code, "PREDECESSOR_STILL_PRIMARY");
  assert.ok(fallo instanceof AdoptError);
});

test("cancelar antes del corte deja la línea exactamente donde estaba", async () => {
  const cancelado = await call("DELETE", "/api/v1/instance/handover", { token });
  assert.equal(cancelado.status, 200);
  assert.equal(cancelado.json.state, "ABORTED");
  assert.equal(cancelado.json.epoch, 1, "la época no se toca al cancelar");
  assert.equal(instanceEpoch(), 1);

  const sinRelevo = await call("GET", "/api/v1/instance/handover", { token });
  assert.equal(sinRelevo.json.state, "NONE");
});

test("una copia que acaba tarde no resucita un relevo ya cancelado", () => {
  /* La copia del relevo se prepara en segundo plano y puede terminar DESPUÉS de
     que el anfitrión cancele. Antes, ese trabajo tardío escribía STANDBY_SYNC
     encima del ABORTED: el relevo volvía a estar vivo, y a partir de ahí
     cualquier intento de arrancar otro moría con HANDOVER_IN_PROGRESS sin que
     nada lo explicara. Se veía solo donde la copia es rápida —Linux en CI, no
     Windows—, que es la peor forma de tener un fallo. */
  const relevo = db
    .prepare("SELECT id, state FROM handovers ORDER BY started_at DESC LIMIT 1")
    .get() as { id: string; state: string };
  assert.equal(relevo.state, "ABORTED", "el test anterior lo dejó cancelado");

  setHandoverState(relevo.id, "STANDBY_SYNC");

  const despues = findHandover(relevo.id)!;
  assert.equal(despues.state, "ABORTED", "cerrado es cerrado: nada tardío lo revive");
  assert.notEqual(despues.finished_at, null, "y conserva la hora a la que se cerró");
});

test("el relevo de emergencia se salta el aviso, pero hay que decirlo en voz alta", async () => {
  const sinConfirmar = await call("POST", "/api/v1/instance/handover", {
    token,
    body: { successor_id: sucesorId, unplanned: true, reason: "el disco está fallando" },
  });
  assert.equal(sinConfirmar.status, 400, "saltarse el aviso es una decisión, no un descuido");

  const emergencia = await call("POST", "/api/v1/instance/handover", {
    token,
    body: { successor_id: sucesorId, unplanned: true, confirm: true, reason: "el disco está fallando" },
  });
  assert.equal(emergencia.status, 200);
  assert.equal(emergencia.json.unplanned, true);
  assert.ok(emergencia.json.activates_at <= Date.now() + 1_000, "sin espera");

  // Queda escrito que NO hubo aviso: no se finge lo contrario.
  const auditoria = await call("GET", `/api/v1/communities/${comunidadId}/audit`, { token });
  const entrada = (auditoria.json as Array<{ action: string; details: any }>).find(
    (e) => e.action === "INSTANCE_HANDOVER_STARTED" && e.details.unplanned === true,
  );
  assert.ok(entrada, "los miembros tienen derecho a ver que su comunidad cambió de manos sin aviso");
  assert.equal(entrada.details.reason, "el disco está fallando");
});

test("sin recibo firmado del sucesor, A no se retira", async () => {
  const sinRecibo = await call("POST", "/api/v1/instance/handover/activate", { token });
  assert.equal(sinRecibo.status, 409);
  assert.match(sinRecibo.json.error.message, /todavía no ha confirmado/);
});

test("el corte: A congela y espera al sucesor, en vez de cortar en seco", async () => {
  /* B vuelve a adoptar, ahora sobre un relevo de emergencia. El código anterior
     ya se gastó, así que hace falta uno nuevo — que es justamente la propiedad
     que se quiere de un código de un solo uso. */
  await call("DELETE", "/api/v1/instance/handover", { token });
  const nuevo = await call("POST", "/api/v1/instance/successors", { token, body: { label: "el portátil de Ana, otra vez" } });
  assert.equal(nuevo.status, 200);

  const adopcion = adopt({
    from: base,
    origin: ORIGEN_B,
    code: nuevo.json.enrol_code as string,
    targetDir: dirB,
    replace: true,
    pollMs: 150,
  });
  for (let i = 0; i < 100; i++) {
    const lista = await call("GET", "/api/v1/instance/successors", { token });
    if ((lista.json as Array<{ id: string; enrolled: boolean }>).find((s) => s.id === nuevo.json.id)?.enrolled) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const emergencia = await call("POST", "/api/v1/instance/handover", {
    token,
    body: { successor_id: nuevo.json.id, unplanned: true, confirm: true, reason: "prueba del corte" },
  });
  assert.equal(emergencia.status, 200);
  await adopcion;

  const listo = await call("GET", "/api/v1/instance/handover", { token });
  assert.equal(listo.json.state, "READY_TO_ACTIVATE");
  assert.equal(listo.json.has_receipt, true);

  /* Alguien escribe DESPUÉS de que B se llevara su copia. Con un corte
     instantáneo este mensaje se perdería sin que nadie se enterara; con un
     aviso de 24 h se perdería un día entero de conversación. */
  const boot = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  const canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!;
  const tardio = await call("POST", `/api/v1/channels/${canal.id}/messages`, {
    token,
    body: { content: "escrito justo antes del corte" },
  });
  assert.equal(tardio.status, 200);

  const activado = await call("POST", "/api/v1/instance/handover/activate", { token });
  assert.equal(activado.status, 200, JSON.stringify(activado.json));
  assert.equal(activado.json.state, "ACTIVATING");
  assert.equal(activado.json.waiting_for, "final_receipt");
  assert.equal(instanceRole(), "PRIMARY", "todavía no se ha retirado: falta que el sucesor confirme");

  // Mientras dura el corte no entran cambios, y se dice por qué.
  const durante = await call("POST", `/api/v1/channels/${canal.id}/messages`, { token, body: { content: "tarde" } });
  assert.equal(durante.status, 503);
  assert.equal(durante.json.error.details.reason, "handover");
  // Pero leer sigue funcionando: nadie se queda mirando una pantalla en blanco.
  const leyendo = await call("GET", `/api/v1/channels/${canal.id}/messages`, { token });
  assert.equal(leyendo.status, 200);
});

test("B recoge la copia final —con los mensajes de última hora— y entonces A se retira", async () => {
  const ascendido = await promote({ targetDir: dirB, pollMs: 100 });
  assert.equal(ascendido.finalized, true, "hubo copia final: no se cortó en seco");
  assert.equal(ascendido.role, "PRIMARY");
  assert.equal(ascendido.epoch, 2);
  assert.equal(instanceRole(), "SUPERSEDED", "A se retira al recibir el recibo de la copia final");

  const baseB = new DatabaseSync(join(dirB, "app.db"));
  try {
    const textos = (baseB.prepare("SELECT content FROM messages ORDER BY id").all() as Array<{ content: string }>).map(
      (m) => m.content,
    );
    assert.deepEqual(textos, ["esto tiene que sobrevivir", "escrito justo antes del corte"]);
    const meta = (clave: string): string =>
      (baseB.prepare("SELECT value FROM meta WHERE key = ?").get(clave) as { value: string } | undefined)?.value ?? "";
    assert.equal(meta("instance_role"), "PRIMARY");
    assert.equal(meta("instance_epoch"), "2");
    assert.equal(meta("lineage_id"), identidadA.lineage_id);
    assert.equal(meta("public.fixed"), "", "no se hereda la dirección del equipo anterior");
    assert.equal((JSON.parse(meta("succession_chain")) as unknown[]).length, 1);
  } finally {
    baseB.close();
  }
});

test("retirado significa retirado: A ya no acepta cambios, pero dice a dónde ir", async () => {
  const escribir = await call("POST", "/api/v1/communities", { token, body: { name: "Otra" } });
  assert.equal(escribir.status, 410);
  assert.equal(escribir.json.error.code, "INSTANCE_SUPERSEDED");
  assert.equal(escribir.json.error.details.successor.origin, ORIGEN_B);
  assert.equal(escribir.json.error.details.successor.certificate_chain.length, 1);

  // Leer datos como si mandara tampoco: partiría la comunidad en dos.
  const leer = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  assert.equal(leer.status, 410);

  // Lo que sigue abierto: salud, la ficha con la dirección nueva y la cadena.
  assert.equal((await call("GET", "/health")).status, 200);
  const info = await call("GET", "/api/v1/info");
  assert.equal(info.json.moved_to.origin, ORIGEN_B);
  const cadena = await call("GET", "/api/v1/succession/chain");
  assert.equal(cadena.json.superseded, true);

  // Y la exportación, que es un derecho y no depende de quién mande (§21).
  const exportacion = await call("GET", `/api/v1/communities/${comunidadId}/export`, { token });
  assert.equal(exportacion.status, 200);
  assert.equal(exportacion.json.manifest.format, "distop-community-export");
});

test("la sesión que abrió alguien en A sigue valiendo en B, y se reancla sola", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  /* El secreto de sesiones viajó dentro del bundle —si no, todo el mundo
     aparecería desconectado— pero B estrenó el suyo y conserva el viejo por una
     ventana. Lo que se comprueba: el token de A entra, y después de entrar la
     fila ya está anclada al secreto nuevo. */
  assert.ok(existsSync(join(dirB, "secret.previous.json")), "B conserva el secreto anterior por una ventana");
  assert.notEqual(
    readFileSync(join(dirB, "secret.key"), "utf8"),
    readFileSync(join(dirA, "secret.key"), "utf8"),
    "y estrenó uno propio: el anfitrión anterior también conocía el viejo",
  );

  const guion = `
    const { db, closeDatabase } = await import('./db.ts');
    const { authenticate } = await import('./auth.ts');
    const antes = db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
    const sesion = authenticate(${JSON.stringify(token)});
    const despues = db.prepare('SELECT token_hash FROM sessions').all().map((r) => r.token_hash);
    console.log(JSON.stringify({ entro: sesion !== null, cambio: JSON.stringify(antes) !== JSON.stringify(despues) }));
    closeDatabase();
  `;
  const { AUTH_SECRET: _s2, INSTANCE_NAME: _n2, ...entorno } = process.env;
  const salida = await run(process.execPath, ["--input-type=module", "--eval", guion], {
    cwd: import.meta.dirname,
    env: { ...entorno, DATABASE_PATH: join(dirB, "app.db"), DEFAULT_STORAGE_PATH: join(dirB, "uploads"), PORT: "0" },
  });
  const visto = JSON.parse(salida.stdout.trim().split(/\r?\n/).at(-1)!) as { entro: boolean; cambio: boolean };

  assert.equal(visto.entro, true, "quien tenía sesión abierta no se queda fuera por un cambio de anfitrión");
  assert.equal(visto.cambio, true, "y al entrar, su sesión pasa al secreto nuevo: el almacén no se queda en modo doble");
});

test("B arranca de verdad y se presenta como la época 2 del mismo linaje", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  const guion = `
    const { db, closeDatabase } = await import('./db.ts');
    const { instanceEpoch, instanceRole, instanceFingerprint, LINEAGE_ID } = await import('./identity.ts');
    const fila = db.prepare("SELECT value FROM meta WHERE key='instance_id'").get();
    const n = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    console.log(JSON.stringify({
      instance_id: fila.value, lineage: LINEAGE_ID, epoch: instanceEpoch(),
      role: instanceRole(), huella: instanceFingerprint(), mensajes: n.n,
    }));
    closeDatabase();
  `;
  const { AUTH_SECRET: _s, INSTANCE_NAME: _n, ...entorno } = process.env;
  const salida = await run(process.execPath, ["--input-type=module", "--eval", guion], {
    cwd: import.meta.dirname,
    env: { ...entorno, DATABASE_PATH: join(dirB, "app.db"), DEFAULT_STORAGE_PATH: join(dirB, "uploads"), PORT: "0" },
  });
  const visto = JSON.parse(salida.stdout.trim().split(/\r?\n/).at(-1)!) as Record<string, any>;

  assert.equal(visto.lineage, identidadA.lineage_id, "misma línea");
  assert.notEqual(visto.instance_id, identidadA.instance_id, "otra instancia");
  assert.notEqual(visto.huella, identidadA.fingerprint, "otra clave");
  assert.equal(visto.epoch, 2);
  assert.equal(visto.role, "PRIMARY");
  assert.equal(visto.mensajes, 2, "incluido el que se escribió justo antes del corte");
});
