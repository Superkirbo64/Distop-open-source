/**
 * Migración de UNA comunidad entre instancias (C3 §3.4).
 *
 * Distinto de un relevo, y por eso vive aparte. Un relevo entrega la máquina
 * con todo lo que aloja; esto saca una comunidad de una máquina que sigue
 * funcionando y alojando otras.
 *
 * Dos decisiones que lo gobiernan todo:
 *
 * **Los IDs se conservan.** Un mensaje que responde a otro guarda su id; una
 * mención guarda el id de quien menciona; un overwrite guarda el id del rol.
 * Remapear ids al importar rompería todo eso en silencio — el mensaje seguiría
 * ahí, pero contestando a nada. Si hay colisión incompatible en el destino se
 * aborta; no se inventa un id nuevo y se cruzan los dedos.
 *
 * **La importación es idempotente.** Importar dos veces el mismo bundle deja
 * exactamente lo mismo que importarlo una. Una migración que se corta a mitad
 * es normal —una conexión doméstica, treinta gigas— y reintentar tiene que ser
 * seguro, no una ruleta.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, createPublicKey, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  COMMUNITY_MIGRATION_TYPE,
  PROTOCOL_VERSION,
  canonicalJson,
  checkMigrationCert,
  uuidv7,
  type CommunityMigrationCert,
  type CommunityMigrationPayload,
  type MigrationState,
} from "@distop/protocol";
import { audit, db } from "./db.ts";
import { instanceFingerprint, instancePublicKey, signAsInstance, LINEAGE_ID, huellaDe } from "./identity.ts";
import { currentIdentity } from "./succession.ts";
import { ROOT as STORAGE_ROOT, insideStorage } from "./storage.ts";
import { sha256File, writeBackup, readBackup, BackupError, type BackupEntry } from "./backup-format.ts";
import { config } from "./config.ts";

const DATA_DIR = dirname(resolve(config.databasePath));
export const MIGRATION_DIR = join(DATA_DIR, "migrations");
/** Un certificado no vale para siempre: si la migración no ocurre, caduca. */
const CERT_TTL_MS = 7 * 24 * 60 * 60_000;

/**
 * Las tablas que viajan y por qué columna cuelgan de la comunidad.
 *
 * `read_state` NO viaja: es de cada persona y de cada canal, y arrastrarlo
 * significaría decidir por alguien qué ha leído en una instancia en la que
 * quizá ni tiene cuenta. `invites` tampoco: un enlace repartido apunta a la
 * dirección vieja, y revivirlo en la nueva convertiría un enlace caducado en
 * una puerta que alguien creía cerrada.
 */
const TABLAS: Array<{ tabla: string; sql: string }> = [
  /* Las personas primero, y no solo las que siguen siendo miembros: quien
     escribió aquí viaja con la comunidad, porque si no su mensaje llegaría sin
     autor y la base del destino lo rechazaría. Sí, eso incluye su hash de
     contraseña — la misma advertencia que en una copia o un relevo, y por eso
     está escrita en la documentación en vez de escondida. */
  {
    tabla: "users",
    sql: `SELECT * FROM users WHERE id IN (
            SELECT user_id FROM members WHERE community_id = ?1
            UNION SELECT author_id FROM messages WHERE community_id = ?1
            UNION SELECT owner_id FROM communities WHERE id = ?1
            UNION SELECT creator_id FROM emojis WHERE community_id = ?1
            UNION SELECT r.user_id FROM reactions r
                   JOIN messages m ON m.id = r.message_id WHERE m.community_id = ?1
          )`,
  },
  { tabla: "communities", sql: "SELECT * FROM communities WHERE id = ?" },
  { tabla: "categories", sql: "SELECT * FROM categories WHERE community_id = ?" },
  { tabla: "channels", sql: "SELECT * FROM channels WHERE community_id = ?" },
  { tabla: "roles", sql: "SELECT * FROM roles WHERE community_id = ?" },
  { tabla: "members", sql: "SELECT * FROM members WHERE community_id = ?" },
  { tabla: "member_roles", sql: "SELECT * FROM member_roles WHERE community_id = ?" },
  {
    tabla: "overwrites",
    sql: "SELECT o.* FROM overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.community_id = ?",
  },
  { tabla: "messages", sql: "SELECT * FROM messages WHERE community_id = ?" },
  {
    tabla: "reactions",
    sql: "SELECT r.* FROM reactions r JOIN messages m ON m.id = r.message_id WHERE m.community_id = ?",
  },
  /* Los adjuntos van DESPUÉS de los mensajes —cuelgan de ellos— y ANTES de los
     emojis, que cuelgan de los adjuntos. El orden de esta lista es el orden de
     inserción, y equivocarlo es un fallo de clave foránea, no una sutileza. */
  {
    tabla: "attachments",
    sql: `SELECT DISTINCT a.* FROM attachments a WHERE
            a.message_id IN (SELECT id FROM messages WHERE community_id = ?1)
            OR a.id IN (SELECT attachment_id FROM emojis WHERE community_id = ?1)
            OR a.id IN (SELECT icon_attachment_id FROM emojis WHERE community_id = ?1 AND icon_attachment_id IS NOT NULL)`,
  },
  { tabla: "emojis", sql: "SELECT * FROM emojis WHERE community_id = ?" },
  { tabla: "audit_log", sql: "SELECT * FROM audit_log WHERE community_id = ?" },
];

export class MigrationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface MigrationRow {
  id: string;
  community_id: string;
  state: MigrationState;
  destination_origin: string;
  destination_instance: string;
  snapshot_hash: string | null;
  certificate: string | null;
  bundle_key: string | null;
  files: number;
  bytes: number;
  missing_files: number;
  created_at: number;
  updated_at: number;
  error_code: string | null;
}

/* ── el borrador ──────────────────────────────────────────────────────── */

export function findMigration(id: string): MigrationRow | undefined {
  return db.prepare("SELECT * FROM community_migrations WHERE id = ?").get(id) as MigrationRow | undefined;
}

export function activeMigration(communityId: string): MigrationRow | undefined {
  return db
    .prepare(
      `SELECT * FROM community_migrations
        WHERE community_id = ? AND state NOT IN ('COMPLETED','FAILED')
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(communityId) as MigrationRow | undefined;
}

/** Lo que se puede saber ANTES de mover nada: cuánto pesa y qué falta. */
export function estimateMigration(communityId: string): {
  rows: Record<string, number>;
  attachments: number;
  bytes: number;
  missing: number;
} {
  const rows: Record<string, number> = {};
  for (const { tabla, sql } of TABLAS) {
    rows[tabla] = (db.prepare(sql.replace("SELECT *", "SELECT COUNT(*) AS n").replace("SELECT o.*", "SELECT COUNT(*) AS n").replace("SELECT r.*", "SELECT COUNT(*) AS n")).get(communityId) as { n: number }).n;
  }
  const adjuntos = adjuntosDe(communityId);
  let bytes = 0;
  let missing = 0;
  for (const adjunto of adjuntos) {
    const full = insideStorage(adjunto.path);
    if (full && existsSync(full)) bytes += adjunto.size;
    else missing++;
  }
  return { rows, attachments: adjuntos.length, bytes, missing };
}

function adjuntosDe(communityId: string): Array<{ id: string; path: string; size: number; content_hash: string | null }> {
  return db
    .prepare(
      `SELECT DISTINCT a.id, a.path, a.size, a.content_hash FROM attachments a
        WHERE a.path <> '' AND (
          a.message_id IN (SELECT id FROM messages WHERE community_id = ?)
          OR a.id IN (SELECT attachment_id FROM emojis WHERE community_id = ?)
          OR a.id IN (SELECT icon_attachment_id FROM emojis WHERE community_id = ? AND icon_attachment_id IS NOT NULL)
        )`,
    )
    .all(communityId, communityId, communityId) as Array<{
    id: string;
    path: string;
    size: number;
    content_hash: string | null;
  }>;
}

/**
 * Empieza un borrador. Mientras esté en `DRAFT` no cambia nada visible y no se
 * notifica a nadie: es una previsualización, y anunciar una mudanza que todavía
 * puede cancelarse haría que la gente se fuera a un sitio que quizá nunca existe.
 */
export function draftMigration(opts: {
  communityId: string;
  destinationOrigin: string;
  destinationInstance: string;
  actorId: string;
}): MigrationRow {
  if (activeMigration(opts.communityId)) {
    throw new MigrationError("MIGRATION_IN_PROGRESS", "Esa comunidad ya tiene una migración en marcha.");
  }
  const comunidad = db.prepare("SELECT id, migrated_to FROM communities WHERE id = ?").get(opts.communityId) as
    | { id: string; migrated_to: string | null }
    | undefined;
  if (!comunidad) throw new MigrationError("COMMUNITY_UNKNOWN", "Esa comunidad no existe aquí.");
  if (comunidad.migrated_to) throw new MigrationError("ALREADY_MIGRATED", "Esa comunidad ya se mudó.");
  if (opts.destinationInstance === currentIdentity().instance_id) {
    throw new MigrationError("SAME_INSTANCE", "El destino tiene que ser otra instancia.");
  }

  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO community_migrations
       (id, community_id, state, destination_origin, destination_instance, files, bytes, missing_files, created_at, updated_at)
     VALUES (?, ?, 'DRAFT', ?, ?, 0, 0, 0, ?, ?)`,
  ).run(id, opts.communityId, opts.destinationOrigin, opts.destinationInstance, now, now);
  return findMigration(id)!;
}

function setState(id: string, state: MigrationState, errorCode: string | null = null): void {
  db.prepare("UPDATE community_migrations SET state = ?, error_code = ?, updated_at = ? WHERE id = ?").run(
    state,
    errorCode,
    Date.now(),
    id,
  );
}

/* ── exportar ─────────────────────────────────────────────────────────── */

interface Snapshot {
  format: "distop-community-migration";
  version: 1;
  community_id: string;
  source_instance: string;
  source_lineage: string;
  protocol: string;
  created_at: number;
  tables: Record<string, unknown[]>;
  attachments: Array<{ id: string; path: string; size: number; sha256: string }>;
}

/**
 * Saca la comunidad a un bundle cifrado, con los ids tal cual están.
 *
 * Se reutiliza el formato de las copias: ya está probado, va cifrado por
 * bloques y detecta el truncamiento. Lo que cambia es el contenido — aquí no va
 * la instancia, va una comunidad.
 */
export async function exportMigration(id: string, passphrase: string): Promise<MigrationRow> {
  const fila = findMigration(id);
  if (!fila) throw new MigrationError("MIGRATION_UNKNOWN", "Esa migración no existe.");
  setState(id, "EXPORTING");

  try {
    const snapshot: Snapshot = {
      format: "distop-community-migration",
      version: 1,
      community_id: fila.community_id,
      source_instance: currentIdentity().instance_id,
      source_lineage: LINEAGE_ID,
      protocol: PROTOCOL_VERSION,
      created_at: Date.now(),
      tables: {},
      attachments: [],
    };
    for (const { tabla, sql } of TABLAS) {
      snapshot.tables[tabla] = db.prepare(sql).all(fila.community_id) as unknown[];
    }

    const entradas: BackupEntry[] = [];
    /* El manifiesto lleva el hash real de cada pieza, no un hueco: es la lista
       contra la que el destino comprueba lo que llega, y un hash vacío la
       convertiría en decoración. */
    const manifiesto: Array<{ path: string; size: number; sha256: string }> = [];
    let bytes = 0;
    let faltan = 0;
    for (const adjunto of adjuntosDe(fila.community_id)) {
      const full = insideStorage(adjunto.path);
      if (!full || !existsSync(full)) {
        /* Se cuenta y se dice. Una comunidad que llega al destino con fotos
           rotas es un resultado legítimo si su origen ya las había perdido; lo
           que no vale es que nadie se entere. */
        faltan++;
        continue;
      }
      const { hash, size } = await sha256File(full);
      const ruta = `uploads/${adjunto.path.split(sep).join("/")}`;
      snapshot.attachments.push({ id: adjunto.id, path: adjunto.path, size, sha256: hash });
      entradas.push({ path: ruta, size, source: { file: full } });
      manifiesto.push({ path: ruta, size, sha256: hash });
      bytes += size;
    }

    const cuerpo = Buffer.from(JSON.stringify(snapshot), "utf8");
    entradas.unshift({ path: "community.json", size: cuerpo.length, source: { data: cuerpo } });
    manifiesto.unshift({
      path: "community.json",
      size: cuerpo.length,
      sha256: createHash("sha256").update(cuerpo).digest("hex"),
    });

    mkdirSync(MIGRATION_DIR, { recursive: true });
    const destino = join(MIGRATION_DIR, `${id}.distop-backup`);
    await writeBackup({
      destination: destino,
      passphrase,
      manifest: {
        format: "distop-backup-manifest",
        version: 1,
        created_at: Date.now(),
        generation: 1,
        instance_id: snapshot.source_instance,
        lineage_id: LINEAGE_ID,
        epoch: currentIdentity().epoch,
        role: "PRIMARY",
        instance_name: config.instanceName,
        server_version: PROTOCOL_VERSION,
        /* Cero a propósito: este bundle no lleva una base, lleva las filas de
           una comunidad. Restaurarlo como si fuera una copia de instancia sería
           un error, y un esquema 0 no lo aprueba ninguna restauración. */
        database_schema: 0,
        counts: {
          users: 0,
          communities: 1,
          channels: (snapshot.tables.channels ?? []).length,
          messages: (snapshot.tables.messages ?? []).length,
          attachments: snapshot.attachments.length,
        },
        redactions: ["invites", "read_state", "sessions"],
        files: manifiesto,
      },
      entries: entradas,
    });

    const { hash } = await sha256File(destino);
    db.prepare(
      "UPDATE community_migrations SET snapshot_hash = ?, files = ?, bytes = ?, missing_files = ?, bundle_key = ?, updated_at = ? WHERE id = ?",
    ).run(hash, entradas.length, bytes, faltan, passphrase, Date.now(), id);
    setState(id, "READY");
    return findMigration(id)!;
  } catch (error) {
    setState(id, "FAILED", error instanceof MigrationError ? error.code : "EXPORT_FAILED");
    throw error;
  }
}

/** Firma el permiso para que el destino importe ESTE bundle y ningún otro. */
export function mintMigrationCert(id: string, now = Date.now()): CommunityMigrationCert {
  const fila = findMigration(id);
  if (!fila?.snapshot_hash) throw new MigrationError("NOT_EXPORTED", "Esa migración todavía no tiene bundle.");

  const payload: CommunityMigrationPayload = {
    t: COMMUNITY_MIGRATION_TYPE,
    version: 1,
    community_id: fila.community_id,
    source_instance: currentIdentity().instance_id,
    source_lineage: LINEAGE_ID,
    destination_instance: fila.destination_instance,
    destination_origin: fila.destination_origin,
    snapshot_hash: fila.snapshot_hash,
    protocol: PROTOCOL_VERSION,
    issued_at: now,
    expires_at: now + CERT_TTL_MS,
  };
  const cert: CommunityMigrationCert = {
    payload,
    signature: signAsInstance(canonicalJson(payload)),
    signer_public_key: instancePublicKey() as Record<string, unknown>,
    signer_fingerprint: instanceFingerprint(),
  };
  db.prepare("UPDATE community_migrations SET certificate = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(cert),
    Date.now(),
    id,
  );
  return cert;
}

/**
 * El corte: la comunidad deja de servirse aquí y apunta a su destino.
 *
 * No se borra. Borrarla sería irreversible en el peor momento posible —justo
 * cuando alguien acaba de descubrir que el destino no funciona— y la
 * exportación del §21 tiene que seguir existiendo.
 */
export function completeMigration(id: string, actorId: string): MigrationRow {
  const fila = findMigration(id);
  if (!fila) throw new MigrationError("MIGRATION_UNKNOWN", "Esa migración no existe.");
  if (fila.state !== "READY") throw new MigrationError("NOT_READY", `La migración está en ${fila.state}.`);

  db.prepare("UPDATE communities SET migrated_to = ? WHERE id = ?").run(fila.destination_origin, fila.community_id);
  audit(fila.community_id, actorId, "COMMUNITY_MIGRATED", fila.community_id, {
    destination: fila.destination_origin,
    files: fila.files,
    missing_files: fila.missing_files,
  });
  setState(id, "COMPLETED");
  return findMigration(id)!;
}

export function cancelMigration(id: string): MigrationRow {
  const fila = findMigration(id);
  if (!fila) throw new MigrationError("MIGRATION_UNKNOWN", "Esa migración no existe.");
  if (fila.state === "COMPLETED") throw new MigrationError("ALREADY_COMPLETED", "Esa migración ya terminó.");
  setState(id, "FAILED", "CANCELLED");
  return findMigration(id)!;
}

/* ── importar (lado del destino) ──────────────────────────────────────── */

export interface ImportReport {
  community_id: string;
  inserted: Record<string, number>;
  skipped: Record<string, number>;
  attachments: number;
  collisions: string[];
  ok: boolean;
}

/**
 * Importa un bundle de migración en el directorio de datos indicado.
 *
 * Idempotente por construcción: cada fila se inserta con `INSERT OR IGNORE` y
 * se cuenta lo que entró y lo que ya estaba. Importar dos veces deja lo mismo
 * que importar una.
 *
 * Antes de escribir nada se comprueba que ningún id chocaría con algo que ya
 * existe Y ES DISTINTO. Coincidir consigo mismo es reintentar; coincidir con
 * otra cosa es una colisión real, y ahí se aborta en vez de remapear: remapear
 * dejaría cada respuesta contestando a nada y cada mención señalando a nadie.
 */
export async function importMigration(opts: {
  file: string;
  passphrase: string;
  dataDir: string;
  certificate: CommunityMigrationCert;
  expectedInstanceId?: string;
}): Promise<ImportReport> {
  const dataDir = resolve(opts.dataDir);
  const base = new DatabaseSync(join(dataDir, "app.db"));
  try {
    const meta = (clave: string): string =>
      (base.prepare("SELECT value FROM meta WHERE key = ?").get(clave) as { value: string } | undefined)?.value ?? "";
    const destino = { instance_id: opts.expectedInstanceId ?? meta("instance_id"), protocol: PROTOCOL_VERSION };

    const reglas = checkMigrationCert(destino, opts.certificate.payload, Date.now());
    if (reglas) throw new MigrationError(`CERT_${reglas}`, `El certificado de migración no cuadra: ${reglas}.`);
    if (huellaDe(opts.certificate.signer_public_key as never) !== opts.certificate.signer_fingerprint) {
      throw new MigrationError("CERT_SIGNER_KEY_MISMATCH", "La huella declarada no es la de la clave que firma.");
    }
    const firmaValida = verify(
      "sha256",
      Buffer.from(canonicalJson(opts.certificate.payload)),
      {
        key: createPublicKey({ key: opts.certificate.signer_public_key as never, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(opts.certificate.signature, "base64url"),
    );
    if (!firmaValida) throw new MigrationError("CERT_BAD_SIGNATURE", "El certificado de migración no está bien firmado.");

    const { hash } = await sha256File(opts.file);
    if (hash !== opts.certificate.payload.snapshot_hash) {
      throw new MigrationError("SNAPSHOT_MISMATCH", "Ese bundle no es el que autoriza el certificado.");
    }

    /* Se lee entero antes de tocar la base: una importación a medias sobre los
       datos de otra comunidad es peor que no importar. */
    let snapshot: Snapshot | null = null;
    const ficheros: Array<{ path: string; datos: Buffer }> = [];
    await readBackup(opts.file, opts.passphrase, async (path, size) => {
      const trozos: Buffer[] = [];
      let leidos = 0;
      return async (chunk) => {
        trozos.push(chunk);
        leidos += chunk.length;
        if (leidos !== size) return;
        const completo = Buffer.concat(trozos);
        if (path === "community.json") snapshot = JSON.parse(completo.toString("utf8")) as Snapshot;
        else if (path.startsWith("uploads/")) ficheros.push({ path: path.slice("uploads/".length), datos: completo });
      };
    });
    if (!snapshot) throw new MigrationError("NO_SNAPSHOT", "El bundle no trae la comunidad.");
    const contenido: Snapshot = snapshot;
    if (contenido.community_id !== opts.certificate.payload.community_id) {
      throw new MigrationError("COMMUNITY_MISMATCH", "El bundle no es de la comunidad que autoriza el certificado.");
    }

    const informe: ImportReport = {
      community_id: contenido.community_id,
      inserted: {},
      skipped: {},
      attachments: 0,
      collisions: [],
      ok: false,
    };

    /* Primera pasada: colisiones. Nada se escribe todavía.
       Coincidir consigo mismo es reintentar; coincidir con OTRA cosa es una
       colisión real, y ahí se aborta en vez de remapear. */
    const CON_ID = new Set([
      "users", "communities", "categories", "channels", "roles", "messages", "attachments", "emojis", "audit_log",
    ]);
    for (const [tabla, filas] of Object.entries(contenido.tables)) {
      if (!CON_ID.has(tabla)) continue;
      for (const cruda of filas as Array<Record<string, unknown>>) {
        const existente = base.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(cruda.id as string) as
          | Record<string, unknown>
          | undefined;
        if (existente && canonicalJson(existente) !== canonicalJson(cruda)) {
          informe.collisions.push(`${tabla}:${String(cruda.id)}`);
        }
      }
    }

    /* El nombre de usuario es único en cada instancia, y dos personas distintas
       pueden llamarse igual en dos sitios. Renombrar a una de ellas en silencio
       sería cambiarle el nombre a alguien sin decírselo: se aborta y se nombra. */
    for (const cruda of (contenido.tables.users ?? []) as Array<Record<string, unknown>>) {
      const choque = base.prepare("SELECT id FROM users WHERE username = ? AND id <> ?").get(
        cruda.username as string,
        cruda.id as string,
      ) as { id: string } | undefined;
      if (choque) informe.collisions.push(`username:${String(cruda.username)}`);
    }

    if (informe.collisions.length > 0) return informe;

    base.exec("BEGIN IMMEDIATE");
    try {
      for (const { tabla } of TABLAS) {
        const filas = (contenido.tables[tabla] ?? []) as Array<Record<string, unknown>>;
        let metidas = 0;
        for (const cruda of filas) {
          const columnas = Object.keys(cruda);
          const sentencia = base.prepare(
            `INSERT OR IGNORE INTO ${tabla} (${columnas.join(",")}) VALUES (${columnas.map(() => "?").join(",")})`,
          );
          const resultado = sentencia.run(...columnas.map((c) => cruda[c] as never));
          metidas += Number(resultado.changes);
        }
        informe.inserted[tabla] = metidas;
        informe.skipped[tabla] = filas.length - metidas;
      }
      base.exec("COMMIT");
    } catch (error) {
      base.exec("ROLLBACK");
      throw error;
    }

    /* Los ficheros, después de las filas: una fila sin fichero es un adjunto
       roto y se ve; un fichero sin fila es basura inofensiva. Y se deduplican
       por contenido — si ya está el mismo byte a byte, no se reescribe. */
    for (const fichero of ficheros) {
      const salida = join(dataDir, "uploads", ...fichero.path.split("/"));
      if (!resolve(salida).startsWith(`${resolve(join(dataDir, "uploads"))}${sep}`)) continue;
      const digest = createHash("sha256").update(fichero.datos).digest("hex");
      if (existsSync(salida)) {
        const actual = createHash("sha256").update(readFileSync(salida)).digest("hex");
        if (actual === digest) continue;
      }
      mkdirSync(dirname(salida), { recursive: true });
      writeFileSync(salida, fichero.datos);
      informe.attachments++;
    }

    informe.ok = true;
    return informe;
  } catch (error) {
    if (error instanceof BackupError) throw new MigrationError(error.code, error.message);
    throw error;
  } finally {
    base.close();
  }
}

/** Dónde se fue una comunidad que ya no se sirve aquí. */
export function migratedTo(communityId: string): string | null {
  const fila = db.prepare("SELECT migrated_to FROM communities WHERE id = ?").get(communityId) as
    | { migrated_to: string | null }
    | undefined;
  return fila?.migrated_to ?? null;
}

export { STORAGE_ROOT };
