/**
 * Migración de una sola comunidad entre instancias (C3 §3.4).
 *
 * Lo que se prueba: que los ids sobreviven —porque cada respuesta, mención y
 * overwrite guarda uno—, que importar dos veces deja lo mismo que importar una,
 * que una colisión incompatible aborta en vez de remapear en silencio, y que
 * un borrador no cambia nada hasta que alguien lo activa.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const raiz = mkdtempSync(join(tmpdir(), "distop-migracion-"));
const dirA = join(raiz, "a");
const dirB = join(raiz, "b");
mkdirSync(dirA, { recursive: true });
mkdirSync(join(dirB, "uploads"), { recursive: true });

process.env.PORT = "0";
process.env.DATABASE_PATH = join(dirA, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(dirA, "uploads");
delete process.env.AUTH_SECRET;

const { server } = await import("./server.ts");
const { db } = await import("./db.ts");
const { stopIntegrityWork } = await import("./integrity.ts");
const { MIGRATION_DIR, importMigration } = await import("./community-migration.ts");
const { MIGRATIONS } = await import("./migrations.ts");
const { uuidv7 } = await import("@distop/protocol");

const FRASE = "frase larga de mudanza 2026";
const INSTANCIA_B = uuidv7();
let base = "";
let token = "";
let comunidadId = "";
let mensajeId = "";
let certificado: any = null;
let bundle = "";

/** La instancia de destino: una base con el mismo esquema y nada dentro. */
function crearDestino(): void {
  const destino = new DatabaseSync(join(dirB, "app.db"));
  try {
    destino.exec("PRAGMA foreign_keys = ON");
    for (const paso of MIGRATIONS) destino.exec(paso);
    destino.prepare("INSERT INTO meta (key, value) VALUES ('instance_id', ?)").run(INSTANCIA_B);
    destino.prepare("INSERT INTO meta (key, value) VALUES ('lineage_id', ?)").run(uuidv7());
  } finally {
    destino.close();
  }
}

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  await stopIntegrityWork();
  crearDestino();
});

after(async () => {
  server.closeAllConnections();
  server.close();
  await stopIntegrityWork();
  try { db.close(); } catch { /* ya cerrada */ }
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

function enDestino<T>(fn: (base: DatabaseSync) => T): T {
  const destino = new DatabaseSync(join(dirB, "app.db"));
  try {
    return fn(destino);
  } finally {
    destino.close();
  }
}

test("una comunidad con mensaje y adjunto, lista para mudarse", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  token = claim.json.access_token as string;
  const comunidad = await call("POST", "/api/v1/communities", { token, body: { name: "La Plaza" } });
  comunidadId = comunidad.json.id as string;

  const boot = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  const canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!;
  const imagen = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(512, 0x33)]);
  const subida = await call("POST", "/api/v1/uploads", {
    token,
    raw: imagen,
    headers: { "content-type": "image/png", "x-filename": "plaza.png" },
  });
  const enviado = await call("POST", `/api/v1/channels/${canal.id}/messages`, {
    token,
    body: { content: "esto se muda con nosotros", attachment_ids: [subida.json.id] },
  });
  assert.equal(enviado.status, 200);
  mensajeId = enviado.json.id as string;
});

test("el borrador dice cuánto pesa y no cambia absolutamente nada", async () => {
  const estimado = await call("GET", `/api/v1/communities/${comunidadId}/migration`, { token });
  assert.equal(estimado.status, 200);
  assert.equal(estimado.json.migration, null);
  assert.equal(estimado.json.estimate.rows.messages, 1);
  assert.equal(estimado.json.estimate.attachments, 1);
  assert.ok(estimado.json.estimate.bytes > 0);

  const borrador = await call("POST", `/api/v1/communities/${comunidadId}/migration`, {
    token,
    body: { destination_origin: "https://otra-casa.example", destination_instance: INSTANCIA_B },
  });
  assert.equal(borrador.status, 200);
  assert.equal(borrador.json.migration.state, "DRAFT");

  // Nadie se ha enterado: la comunidad sigue funcionando igual.
  const sigue = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  assert.equal(sigue.status, 200);
  const log = await call("GET", `/api/v1/communities/${comunidadId}/audit`, { token });
  assert.ok(
    !(log.json as Array<{ action: string }>).some((e) => e.action === "COMMUNITY_MIGRATED"),
    "un borrador que aún puede cancelarse no se anuncia a los miembros",
  );
});

test("solo quien administra la comunidad puede mudarla", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "de paso" } });
  const invitacion = await call("POST", `/api/v1/communities/${comunidadId}/invites`, { token, body: {} });
  await call("POST", `/api/v1/invites/${invitacion.json.code}/join`, { token: visita.json.access_token });

  const ajeno = await call("POST", `/api/v1/communities/${comunidadId}/migration/export`, {
    token: visita.json.access_token as string,
    body: { passphrase: FRASE },
  });
  assert.equal(ajeno.status, 403);
});

test("exportar produce un bundle y un certificado que lo ata a ese destino", async () => {
  const exportado = await call("POST", `/api/v1/communities/${comunidadId}/migration/export`, {
    token,
    body: { passphrase: FRASE },
  });
  assert.equal(exportado.status, 200, JSON.stringify(exportado.json));
  assert.equal(exportado.json.migration.state, "READY");
  assert.equal(exportado.json.migration.missing_files, 0);
  assert.match(exportado.json.migration.snapshot_hash, /^[0-9a-f]{64}$/);

  certificado = exportado.json.certificate;
  assert.equal(certificado.payload.community_id, comunidadId);
  assert.equal(certificado.payload.destination_instance, INSTANCIA_B);
  assert.equal(certificado.payload.snapshot_hash, exportado.json.migration.snapshot_hash);
  bundle = join(MIGRATION_DIR, `${exportado.json.migration.id}.distop-backup`);
});

test("el destino importa conservando los ids, y hacerlo dos veces no duplica", async () => {
  const primera = await importMigration({
    file: bundle,
    passphrase: FRASE,
    dataDir: dirB,
    certificate: certificado,
  });
  assert.equal(primera.ok, true, JSON.stringify(primera.collisions));
  assert.deepEqual(primera.collisions, []);
  assert.equal(primera.inserted.communities, 1);
  assert.equal(primera.inserted.messages, 1);
  assert.equal(primera.attachments, 1);

  enDestino((destino) => {
    const mensaje = destino.prepare("SELECT id, content FROM messages").get() as { id: string; content: string };
    assert.equal(mensaje.id, mensajeId, "el id del mensaje viaja: si no, cada respuesta contestaría a nada");
    assert.equal(mensaje.content, "esto se muda con nosotros");
    const comunidad = destino.prepare("SELECT id FROM communities").get() as { id: string };
    assert.equal(comunidad.id, comunidadId);
  });

  // Reintentar es normal —una conexión doméstica, treinta gigas— y tiene que ser seguro.
  const segunda = await importMigration({
    file: bundle,
    passphrase: FRASE,
    dataDir: dirB,
    certificate: certificado,
  });
  assert.equal(segunda.ok, true);
  assert.equal(segunda.inserted.messages, 0, "nada nuevo");
  assert.equal(segunda.skipped.messages, 1, "porque ya estaba");
  assert.equal(segunda.attachments, 0, "el fichero se deduplica por contenido");

  enDestino((destino) => {
    assert.equal((destino.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n, 1);
    assert.equal((destino.prepare("SELECT COUNT(*) AS n FROM communities").get() as { n: number }).n, 1);
  });
});

test("un certificado para otro destino no sirve aquí", async () => {
  const paraOtro = { ...certificado, payload: { ...certificado.payload, destination_instance: uuidv7() } };
  const fallo = await importMigration({
    file: bundle,
    passphrase: FRASE,
    dataDir: dirB,
    certificate: paraOtro,
  }).catch((e: { code: string }) => e);
  /* Cambiar el destino invalida la firma antes incluso de mirar las reglas:
     las dos comprobaciones tienen que fallar, y basta con que falle una. */
  assert.match((fallo as { code: string }).code, /^CERT_/);
});

test("una colisión incompatible aborta, en vez de remapear en silencio", async () => {
  /* Mismo id, contenido distinto: alguien ya tenía algo ahí. Remapear dejaría
     cada respuesta y cada mención señalando a nada. */
  enDestino((destino) => {
    destino.prepare("UPDATE messages SET content = 'otra cosa distinta' WHERE id = ?").run(mensajeId);
  });

  const informe = await importMigration({
    file: bundle,
    passphrase: FRASE,
    dataDir: dirB,
    certificate: certificado,
  });
  assert.equal(informe.ok, false);
  assert.ok(informe.collisions.includes(`messages:${mensajeId}`));

  enDestino((destino) => {
    const mensaje = destino.prepare("SELECT content FROM messages WHERE id = ?").get(mensajeId) as { content: string };
    assert.equal(mensaje.content, "otra cosa distinta", "y no se tocó nada de lo que había");
  });
});

test("al activar, la comunidad deja de servirse aquí y dice a dónde ir", async () => {
  const completado = await call("POST", `/api/v1/communities/${comunidadId}/migration/complete`, { token });
  assert.equal(completado.status, 200);
  assert.equal(completado.json.state, "COMPLETED");

  const leer = await call("GET", `/api/v1/communities/${comunidadId}/bootstrap`, { token });
  assert.equal(leer.status, 410);
  assert.equal(leer.json.error.code, "COMMUNITY_MIGRATED");
  assert.equal(leer.json.error.details.destination_origin, "https://otra-casa.example");

  const escribir = await call("POST", `/api/v1/communities/${comunidadId}/invites`, { token, body: {} });
  assert.equal(escribir.status, 410);

  // Pero la exportación sigue: es un derecho, no depende de quién la aloje.
  const exportacion = await call("GET", `/api/v1/communities/${comunidadId}/export`, { token });
  assert.equal(exportacion.status, 200);
  assert.equal(exportacion.json.manifest.format, "distop-community-export");
});
