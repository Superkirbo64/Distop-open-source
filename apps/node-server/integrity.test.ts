/**
 * Integridad de adjuntos: qué se ve desde fuera y cuándo se aparta (§26, §28.4).
 *
 * Lo que se prueba aquí no es que el hash sea correcto —eso lo garantiza
 * sha256— sino que el progreso publicado dice la verdad: que "completo" no se
 * dice cuando faltan doce fotos, que el motivo de una pausa se nombra, y que
 * en /health, que lee cualquiera, no aparece ni una ruta.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-integrity-"));
const uploads = join(workdir, "uploads");
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = uploads;
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { attachmentHashProgress, backfillPause, runIntegrityBatch, stopIntegrityWork } = await import("./integrity.ts");
const { insideStorage, pendingHashCount } = await import("./storage.ts");
const { pauseWrites } = await import("./lifecycle.ts");
const voice = await import("./voice.ts");
const { uuidv7 } = await import("@distop/protocol");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  /* El arranque deja un temporizador de fondo corriendo. Estas pruebas mandan
     las tandas a mano para poder mirar el estado entre una y otra; con el
     temporizador vivo estarían compitiendo con él y el resultado dependería de
     quién llegue antes. Se para: lo que se prueba es la máquina de estados, y
     que el temporizador la mueve ya lo prueba el arranque real. */
  await stopIntegrityWork();
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await stopIntegrityWork();
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

/** Una fila de adjunto puesta a mano, como la dejaría una base restaurada de
    una versión anterior a la migración de hashes. */
function filaSinHash(path: string): string {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, created_at)
     VALUES (?, NULL, 'alguien', 'foto.png', 'image/png', 4, ?, ?)`,
  ).run(id, path, Date.now());
  return id;
}

let token = "";
let userId = "";
let communityId = "";

test("una instancia sin nada pendiente publica integridad completa", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  token = claim.json.access_token as string;
  userId = claim.json.user.id as string;
  const community = await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });
  communityId = community.json.id as string;

  await runIntegrityBatch();
  const salud = await call("GET", "/health");
  assert.equal(salud.status, 200);

  const integridad = salud.json.integrity.attachment_hashes;
  assert.equal(integridad.remaining, 0);
  assert.equal(integridad.failed, 0);
  assert.equal(integridad.last_error, "");
  assert.equal(integridad.state, "complete");
});

test("un adjunto viejo sin hash se completa, y se cuenta", async () => {
  const relativa = "1999-01/vieja.png";
  assert.ok(insideStorage(relativa), "la ruta de prueba cae dentro del almacén");
  mkdirSync(join(uploads, "1999-01"), { recursive: true });
  writeFileSync(join(uploads, "1999-01", "vieja.png"), Buffer.from("hola"));
  const id = filaSinHash(relativa);

  assert.equal(pendingHashCount(), 1);
  const resultado = await runIntegrityBatch();
  assert.equal(resultado.updated, 1);
  assert.equal(resultado.failed, 0);
  assert.equal(resultado.done, true);

  const fila = db.prepare("SELECT content_hash FROM attachments WHERE id = ?").get(id) as { content_hash: string };
  assert.equal(fila.content_hash, "sha256:b221d9dbb083a7f33428d7c2a3c3198ae925614d70210e28716ccaa7cd4ddb79");
  assert.equal(pendingHashCount(), 0);
});

test("un adjunto que ya no está en el disco no bloquea a los demás, y se dice", async () => {
  filaSinHash("1999-01/borrada-a-mano.png");
  const resultado = await runIntegrityBatch();

  assert.equal(resultado.failed, 1);
  assert.equal(resultado.updated, 0);
  assert.equal(resultado.last_error, "MISSING_FILE");

  const progreso = attachmentHashProgress();
  assert.equal(progreso.remaining, 1, "la fila sigue sin hash: no se inventa uno");
  assert.equal(progreso.state, "degraded", "queda trabajo imposible: eso es degradado, no completo");
  assert.equal(progreso.last_error, "MISSING_FILE");
});

test("una fila que apunta fuera del almacén no se lee: se marca", async () => {
  db.prepare("DELETE FROM attachments WHERE content_hash IS NULL").run();
  filaSinHash(join("..", "..", "secreto.txt"));

  const resultado = await runIntegrityBatch();
  assert.equal(resultado.failed, 1);
  assert.equal(resultado.last_error, "OUTSIDE_STORAGE");

  assert.equal(insideStorage("../../secreto.txt"), null, "el guardia rechaza la ruta por su cuenta");
  assert.equal(insideStorage("../uploads-de-otro/x.png"), null, "compartir prefijo no es estar dentro");
  assert.ok(insideStorage("2026-08/foto.png"), "una ruta normal sí pasa");
});

test("lo que se publica no lleva rutas ni nombres de fichero", async () => {
  const salud = await call("GET", "/health");
  const texto = JSON.stringify(salud.json.integrity);

  assert.ok(!texto.includes("secreto"), "el nombre del fichero que falló no sale a /health");
  assert.ok(!texto.includes("uploads"), "la ruta del almacén tampoco");
  assert.match(
    salud.json.integrity.attachment_hashes.last_error,
    /^[A-Z_]*$/,
    "last_error es un código estable, no un mensaje",
  );
});

test("el trabajo de fondo se aparta mientras hay una llamada", async () => {
  const boot = await call("GET", `/api/v1/communities/${communityId}/bootstrap`, { token });
  const voz = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "voice");
  assert.ok(voz, "la comunidad nace con un canal de voz");

  assert.equal(backfillPause(), null, "sin nadie hablando, el trabajo puede correr");

  // Con la cuenta real: `join` exige CONNECT_VOICE, como en una llamada de verdad.
  assert.ok(voice.join(voz.id, userId), "entrar en la sala de voz");
  assert.equal(backfillPause(), "paused_call");
  assert.equal(attachmentHashProgress().state, "paused_call");

  voice.leave(voz.id, userId);
  assert.equal(backfillPause(), null, "al colgar, vuelve a poder correr");
});

test("una copia en curso también detiene el trabajo de fondo", () => {
  const soltar = pauseWrites("backup");
  try {
    assert.equal(backfillPause(), "paused_maintenance");
  } finally {
    soltar();
  }
  assert.equal(backfillPause(), null, "al soltar la copia, se reanuda");

  const primera = pauseWrites("backup");
  try {
    assert.throws(
      () => pauseWrites("restore"),
      /WRITES_ALREADY_FROZEN/,
      "dos operaciones exclusivas a la vez no son dos copias, son una corrupta",
    );
  } finally {
    primera();
  }
});
