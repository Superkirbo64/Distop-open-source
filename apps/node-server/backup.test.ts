/**
 * Copia cifrada y restauración (plan C1).
 *
 * El criterio de cierre de la fase es una sola frase: una instancia A hace una
 * copia, A se apaga, la copia se restaura en un directorio B independiente, y B
 * arranca con la misma identidad y los mismos datos. Todo lo demás que se
 * comprueba aquí son las maneras en que eso puede salir mal en silencio — que
 * es la única forma en que un backup falla de verdad, porque nadie mira una
 * copia hasta el día que la necesita.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const raiz = mkdtempSync(join(tmpdir(), "distop-backup-"));
const dirA = join(raiz, "a");
mkdirSync(dirA, { recursive: true });

process.env.PORT = "0";
process.env.DATABASE_PATH = join(dirA, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(dirA, "uploads");
delete process.env.AUTH_SECRET;
process.env.INSTANCE_NAME = "La Casa de Prueba";

const { server, shutdown } = await import("./server.ts");
const { db } = await import("./db.ts");
const { BACKUP_DIR, createBackup } = await import("./backup.ts");
const { inspectBackup, recoverInterruptedRestore, restoreBackup } = await import("./restore.ts");
const backupFormat = await import("./backup-format.ts");
const { stopIntegrityWork } = await import("./integrity.ts");

const FRASE = "frase larga de copia 2026";
let base = "";
let token = "";
let copia = "";
const identidadA = { instance_id: "", lineage_id: "" };

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await stopIntegrityWork();
});

after(() => {
  rmSync(raiz, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.raw ? {} : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.raw ? { body: opts.raw } : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/**
 * El error que lanzó una promesa, o un fallo de la prueba si no lanzó nada.
 * `.catch((e) => e)` a secas dejaba pasar el caso peor: que la operación
 * peligrosa funcionara.
 */
async function falla(promesa: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promesa;
  } catch (error) {
    return error as { code: string; message: string };
  }
  assert.fail("se esperaba un fallo y la operación salió bien");
}

/** Una copia recién hecha, para las pruebas que la maltratan. */
function copiar(destino: string): string {
  writeFileSync(destino, readFileSync(copia));
  return destino;
}

test("una comunidad con mensajes y una imagen produce una copia verificable", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  assert.equal(claim.status, 200);
  token = claim.json.access_token as string;

  const community = await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });
  const boot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  const canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!;

  const imagen = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 0x5a)]);
  const subida = await call("POST", "/api/v1/uploads", {
    token,
    raw: imagen,
    headers: { "content-type": "image/png", "x-filename": "foto.png" },
  });
  assert.equal(subida.status, 200, JSON.stringify(subida.json));

  const enviado = await call("POST", `/api/v1/channels/${canal.id}/messages`, {
    token,
    body: { content: "esto tiene que sobrevivir", attachment_ids: [subida.json.id] },
  });
  assert.equal(enviado.status, 200);

  // Credenciales TURN de pago: existen antes de la copia y no pueden viajar.
  db.prepare("INSERT INTO meta (key, value) VALUES ('voice_relay', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ mode: "managed", provider: "metered", apiKey: "clave-secreta-de-pago" }),
  );
  db.prepare("INSERT INTO meta (key, value) VALUES ('public.fixed', 'https://equipo-viejo.ts.net') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();

  identidadA.instance_id = (db.prepare("SELECT value FROM meta WHERE key='instance_id'").get() as { value: string }).value;
  identidadA.lineage_id = (db.prepare("SELECT value FROM meta WHERE key='lineage_id'").get() as { value: string }).value;

  const job = await createBackup({ passphrase: FRASE });
  assert.equal(job.state, "done");
  assert.ok(job.bytes > 0);
  assert.deepEqual(job.redacted, ["voice_relay", "public.fixed"]);
  copia = join(BACKUP_DIR, job.filename!);
  assert.ok(existsSync(copia));
  assert.ok(!existsSync(`${copia}.partial`), "no queda ningún .partial cuando la copia termina bien");
});

test("una copia no cuenta de quién es a quien no tenga la frase", () => {
  const bytes = readFileSync(copia);
  const cabecera = JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString("utf8")) as Record<string, unknown>;
  assert.deepEqual(Object.keys(cabecera).sort(), ["cipher", "format", "kdf", "version"]);

  /* Lo que importa: nada del contenido asoma en claro. Ni el nombre de la
     instancia, ni su identificador, ni un solo nombre de fichero. */
  const texto = bytes.toString("latin1");
  for (const secreto of ["La Casa", identidadA.instance_id, identidadA.lineage_id, "foto.png", "app.db", "uploads"]) {
    assert.ok(!texto.includes(secreto), `"${secreto}" no puede aparecer en claro en la copia`);
  }
});

test("la frase equivocada y el archivo manipulado dan el mismo error", async () => {
  const conFraseMala = await falla(inspectBackup(copia, "frase completamente otra"));
  assert.equal(conFraseMala.code, "BACKUP_UNREADABLE");

  const manipulada = copiar(join(raiz, "manipulada.distop-backup"));
  const bytes = readFileSync(manipulada);
  // Un byte del primer bloque cifrado, justo detrás del encabezado.
  const inicio = bytes.indexOf(0x0a) + 8;
  bytes[inicio] = bytes[inicio]! ^ 0xff;
  writeFileSync(manipulada, bytes);

  const conArchivoRoto = await falla(inspectBackup(manipulada, FRASE));
  assert.equal(conArchivoRoto.code, "BACKUP_UNREADABLE");
  assert.equal(
    conArchivoRoto.message,
    conFraseMala.message,
    "distinguirlos convertiría la copia en un oráculo de frases",
  );
});

test("una copia cortada por la mitad no se acepta como buena", async () => {
  const cortada = join(raiz, "cortada.distop-backup");
  const bytes = readFileSync(copia);
  writeFileSync(cortada, bytes.subarray(0, Math.floor(bytes.length * 0.6)));

  const fallo = await falla(inspectBackup(cortada, FRASE, { deep: true }));
  assert.ok(
    ["TRUNCATED", "BACKUP_UNREADABLE"].includes(fallo.code),
    `cortar el archivo tiene que notarse, y dio ${fallo.code}`,
  );
});

test("un .partial nunca se restaura, aunque esté entero", async () => {
  const parcial = copiar(join(raiz, "aunque-este-bien.distop-backup.partial"));
  const fallo = await falla(inspectBackup(parcial, FRASE));
  assert.equal(fallo.code, "PARTIAL_BACKUP");
});

test("inspeccionar dice de quién es la copia sin escribir nada", async () => {
  const rapida = await inspectBackup(copia, FRASE);
  assert.equal(rapida.verified, false, "la inspección rápida no puede llamarse verificación");
  assert.equal(rapida.manifest.instance_id, identidadA.instance_id);
  assert.equal(rapida.manifest.instance_name, "La Casa de Prueba");
  assert.ok(rapida.manifest.generation >= 1);
  assert.deepEqual(rapida.manifest.redactions, ["voice_relay", "public.fixed"]);
  assert.equal(rapida.manifest.counts.communities, 1);
  assert.equal(rapida.manifest.counts.attachments, 1);
  assert.ok(rapida.manifest.files.some((f) => f.path === "database/app.db"));
  assert.ok(rapida.manifest.files.some((f) => f.path.startsWith("uploads/")));
  assert.ok(rapida.manifest.files.some((f) => f.path === "secrets/auth-secret"));
  assert.ok(rapida.manifest.files.some((f) => f.path === "identity/instance.key"));

  const profunda = await inspectBackup(copia, FRASE, { deep: true });
  assert.equal(profunda.verified, true);
  assert.deepEqual(profunda.missing, []);
  assert.deepEqual(profunda.corrupt, []);
  assert.deepEqual(profunda.extra, []);
});

test("una ruta que se sale del destino se rechaza, no se sanea", () => {
  const { safeEntryPath } = backupFormat;
  for (const mala of [
    "../fuera.txt",
    "uploads/../../fuera.txt",
    "/etc/passwd",
    "C:/Windows/system32/x",
    "uploads\\..\\fuera",
    "",
    "uploads//doble",
    "./relativa",
  ]) {
    assert.equal(safeEntryPath(mala), false, `"${mala}" no puede pasar`);
  }
  assert.equal(safeEntryPath("uploads/2026-08/foto.png"), true);
  assert.equal(safeEntryPath("database/app.db"), true);
});

test("no se restaura encima de un directorio que ya tiene datos", async () => {
  const ocupado = join(raiz, "ocupado");
  mkdirSync(ocupado, { recursive: true });
  writeFileSync(join(ocupado, "app.db"), "datos de alguien");

  const fallo = await falla(restoreBackup({ file: copia, passphrase: FRASE, targetDir: ocupado }));
  assert.equal(fallo.code, "TARGET_NOT_EMPTY");
  assert.equal(readFileSync(join(ocupado, "app.db"), "utf8"), "datos de alguien", "y no se tocó nada");
});

test("una copia de un esquema más nuevo no se restaura a ciegas", async () => {
  const { SCHEMA_VERSION } = await import("./migrations.ts");
  const futura = join(raiz, "futura.distop-backup");
  await backupFormat.writeBackup({
    destination: futura,
    passphrase: FRASE,
    manifest: {
      format: "distop-backup-manifest",
      version: 1,
      created_at: Date.now(),
      generation: 1,
      instance_id: identidadA.instance_id,
      lineage_id: identidadA.lineage_id,
      epoch: 1,
      role: "PRIMARY",
      instance_name: "Del futuro",
      server_version: "9.9.9",
      database_schema: SCHEMA_VERSION + 5,
      counts: { users: 0, communities: 0, channels: 0, messages: 0, attachments: 0 },
      redactions: [],

      files: [],
    },
    entries: [],
  });

  const destino = join(raiz, "futuro");
  mkdirSync(destino, { recursive: true });
  const report = await restoreBackup({ file: futura, passphrase: FRASE, targetDir: destino });
  assert.equal(report.ok, false);
  assert.equal(report.schema.ok, false);
  assert.equal(report.schema.backup, SCHEMA_VERSION + 5);
  assert.deepEqual(readdirSync(destino), [], "nada llegó al directorio");
});

test("una entrada vacía se cierra y su hash se comprueba", async () => {
  const file = join(raiz, "vacia.distop-backup");
  const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  await backupFormat.writeBackup({
    destination: file,
    passphrase: FRASE,
    manifest: {
      format: "distop-backup-manifest",
      version: 1,
      created_at: Date.now(),
      generation: 1,
      instance_id: identidadA.instance_id,
      lineage_id: identidadA.lineage_id,
      epoch: 1,
      role: "PRIMARY",
      instance_name: "Vacía",
      server_version: "0.1.0",
      database_schema: 0,
      counts: { users: 0, communities: 0, channels: 0, messages: 0, attachments: 0 },
      redactions: [],
      files: [{ path: "uploads/vacio.bin", size: 0, sha256: emptyHash }],
    },
    entries: [{ path: "uploads/vacio.bin", size: 0, source: { data: Buffer.alloc(0) } }],
  });
  const report = await inspectBackup(file, FRASE, { deep: true });
  assert.equal(report.verified, true);
  assert.deepEqual(report.corrupt, []);
});

test("un manifiesto de otra versión se rechaza antes de entregar entradas", async () => {
  const file = join(raiz, "manifest-v2.distop-backup");
  await backupFormat.writeBackup({
    destination: file,
    passphrase: FRASE,
    manifest: {
      format: "distop-backup-manifest",
      version: 2,
      created_at: Date.now(),
      generation: 1,
      instance_id: identidadA.instance_id,
      lineage_id: identidadA.lineage_id,
      epoch: 1,
      role: "PRIMARY",
      instance_name: "Futura",
      server_version: "0.1.0",
      database_schema: 0,
      counts: { users: 0, communities: 0, channels: 0, messages: 0, attachments: 0 },
      redactions: [],
      files: [],
    },
    entries: [],
  });
  const error = await falla(inspectBackup(file, FRASE));
  assert.equal(error.code, "UNSUPPORTED_MANIFEST");
});

test("la restauración detecta un adjunto que la base reclama pero el bundle no trae", async () => {
  const attachment = db.prepare("SELECT path FROM attachments LIMIT 1").get() as { path: string };
  const original = join(dirA, "uploads", ...attachment.path.split("/"));
  const parked = join(raiz, "adjunto-apartado");
  renameSync(original, parked);
  let brokenFile = "";
  try {
    const job = await createBackup({ passphrase: FRASE });
    brokenFile = join(BACKUP_DIR, job.filename!);
  } finally {
    renameSync(parked, original);
  }
  const target = join(raiz, "adjunto-faltante");
  const report = await restoreBackup({ file: brokenFile, passphrase: FRASE, targetDir: target });
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, [`uploads/${attachment.path.replaceAll("\\", "/")}`]);
  assert.equal(report.attachments.ok, false);
});

test("un diario interrumpido revierte la base nueva y recupera la anterior", () => {
  const target = join(raiz, "restore-interrumpido");
  const staging = join(target, ".restore-incoming");
  const stagedDb = join(staging, "database", "app.db");
  const targetDb = join(target, "app.db");
  mkdirSync(join(staging, "database"), { recursive: true });
  writeFileSync(targetDb, "base anterior");
  writeFileSync(stagedDb, "base nueva");
  const backupDb = `${targetDb}.bak`;
  writeFileSync(
    join(target, "restore.journal"),
    `${JSON.stringify({
      format: "distop-restore-journal",
      started_at: Date.now(),
      source: "prueba.distop-backup",
      moves: [{ from: stagedDb, to: targetDb, backup: backupDb }],
    })}\n`,
  );
  renameSync(targetDb, backupDb);
  renameSync(stagedDb, targetDb);

  assert.equal(recoverInterruptedRestore(target), true);
  assert.equal(readFileSync(targetDb, "utf8"), "base anterior");
  assert.ok(!existsSync(backupDb));
  assert.ok(!existsSync(staging));
  assert.ok(!existsSync(join(target, "restore.journal")));
});

test("las rutas de copia son del anfitrión, y el nombre de fichero no es una ruta", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  const ajeno = await call("POST", "/api/v1/instance/backups", {
    token: visita.json.access_token as string,
    body: { passphrase: "frase larga de copia 2026" },
  });
  assert.equal(ajeno.status, 403, "una copia se lleva los mensajes de todos: no la pide cualquiera");

  const floja = await call("POST", "/api/v1/instance/backups", { token, body: { passphrase: "corta" } });
  assert.equal(floja.status, 400);

  const pedida = await call("POST", "/api/v1/instance/backups", { token, body: { passphrase: FRASE } });
  assert.equal(pedida.status, 200);
  assert.equal(pedida.json.state, "running", "responde en cuanto arranca, no cuando termina");

  /* El trabajo corre en diferido justamente porque el handler cuenta como
     escritura en vuelo; se espera a que acabe como haría la interfaz. */
  let job = pedida.json;
  for (let i = 0; i < 100 && job.state === "running"; i++) {
    await new Promise((r) => setTimeout(r, 50));
    job = (await call("GET", `/api/v1/instance/backups/${pedida.json.id}`, { token })).json;
  }
  assert.equal(job.state, "done", JSON.stringify(job));
  assert.ok(job.filename.endsWith(".distop-backup"));

  const listado = await call("GET", "/api/v1/instance/backups", { token });
  assert.equal(listado.status, 200);
  assert.ok((listado.json.files as Array<{ filename: string }>).some((f) => f.filename === job.filename));

  // El nombre se busca en la lista real: una ruta no es un nombre que exista.
  const travesia = await call("POST", "/api/v1/instance/restore/inspect", {
    token,
    body: { filename: "../../secret.key", passphrase: FRASE },
  });
  assert.equal(travesia.status, 404);

  const abierta = await call("POST", "/api/v1/instance/restore/inspect", {
    token,
    body: { filename: job.filename, passphrase: FRASE },
  });
  assert.equal(abierta.status, 200);
  assert.equal(abierta.json.manifest.instance_id, identidadA.instance_id);
  assert.equal(abierta.json.verified, false);

  const conFraseMala = await call("POST", "/api/v1/instance/restore/inspect", {
    token,
    body: { filename: job.filename, passphrase: "otra frase distinta" },
  });
  assert.equal(conFraseMala.status, 422);
  assert.equal(conFraseMala.json.error.code, "BACKUP_UNREADABLE");
});

test("A se apaga, la copia se restaura en B, y B es la misma instancia", async () => {
  await shutdown("prueba-de-copia");

  const dirB = join(raiz, "b");
  mkdirSync(dirB, { recursive: true });
  const report = await restoreBackup({ file: copia, passphrase: FRASE, targetDir: dirB });

  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.corrupt, []);
  assert.deepEqual(report.extra, []);
  assert.deepEqual(report.rejected, []);
  assert.equal(report.database.integrity, "ok");
  assert.equal(report.database.foreign_keys, 0);
  assert.equal(report.identity.instance_id, identidadA.instance_id);
  assert.equal(report.identity.lineage_id, identidadA.lineage_id);

  // El directorio queda listo para arrancar: base, identidad, secreto y archivos.
  for (const pieza of ["app.db", "instance.key", "secret.key", "uploads"]) {
    assert.ok(existsSync(join(dirB, pieza)), `falta ${pieza} en el destino`);
  }
  assert.ok(!existsSync(join(dirB, ".restore-incoming")), "el directorio de trabajo se limpia");
  assert.ok(!existsSync(join(dirB, "restore.journal")), "el diario se cierra al terminar");

  const restaurada = new DatabaseSync(join(dirB, "app.db"));
  try {
    const mensajes = restaurada.prepare("SELECT content FROM messages").all() as Array<{ content: string }>;
    assert.equal(mensajes.length, 1);
    assert.equal(mensajes[0]!.content, "esto tiene que sobrevivir");

    // La sesión de A sigue existiendo en B: es la misma instancia, no una nueva.
    const sesiones = (restaurada.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
    assert.ok(sesiones > 0, "las sesiones viajan: restaurar no echa a nadie");

    // Y las credenciales de pago NO viajaron.
    assert.equal(
      restaurada.prepare("SELECT value FROM meta WHERE key = 'voice_relay'").get(),
      undefined,
      "el TURN de pago se queda fuera de la copia (§5.6)",
    );
    assert.equal(
      restaurada.prepare("SELECT value FROM meta WHERE key = 'public.fixed'").get(),
      undefined,
      "la dirección del equipo anterior no se publica desde la máquina restaurada",
    );
    assert.ok((restaurada.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'INSTANCE_RESTORE_COMPLETED'").get() as { n: number }).n > 0);

    const adjunto = restaurada.prepare("SELECT path, size FROM attachments").get() as { path: string; size: number };
    const fichero = join(dirB, "uploads", ...adjunto.path.split(/[\\/]/));
    assert.ok(existsSync(fichero), "el adjunto llegó al destino");
    assert.equal(statSync(fichero).size, adjunto.size);
  } finally {
    restaurada.close();
  }

  // La identidad privada es la misma clave, no una nueva.
  assert.equal(
    readFileSync(join(dirB, "instance.key"), "utf8"),
    readFileSync(join(dirA, "instance.key"), "utf8"),
    "restaurar conserva la identidad: por eso es la misma instancia y no una sucesora",
  );
});

test("B arranca de verdad sobre lo restaurado y se presenta como la misma instancia", async () => {
  const dirB = join(raiz, "b");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);

  /* En un proceso aparte, como el arranque real: si el directorio hubiera
     quedado a medias, es aquí donde se vería. */
  const guion = `
    const { db, closeDatabase } = await import('./db.ts');
    const { instanceFingerprint, LINEAGE_ID } = await import('./identity.ts');
    const fila = db.prepare("SELECT value FROM meta WHERE key='instance_id'").get();
    const mensajes = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    console.log(JSON.stringify({ instance_id: fila.value, lineage: LINEAGE_ID, huella: instanceFingerprint(), mensajes: mensajes.n }));
    closeDatabase();
  `;
  const { AUTH_SECRET: _sinSecreto, INSTANCE_NAME: _sinNombre, ...entorno } = process.env;
  const salida = await run(process.execPath, ["--input-type=module", "--eval", guion], {
    cwd: import.meta.dirname,
    env: {
      ...entorno,
      DATABASE_PATH: join(dirB, "app.db"),
      DEFAULT_STORAGE_PATH: join(dirB, "uploads"),
      PORT: "0",
    },
  });
  const visto = JSON.parse(salida.stdout.trim().split(/\r?\n/).at(-1)!) as {
    instance_id: string;
    lineage: string;
    huella: string;
    mensajes: number;
  };

  assert.equal(visto.instance_id, identidadA.instance_id, "B se presenta como la misma instancia");
  assert.equal(visto.lineage, identidadA.lineage_id);
  assert.equal(visto.mensajes, 1, "y con los mensajes de A");
  assert.ok(visto.huella.length > 20, "la huella se recalcula desde la clave restaurada");
});
