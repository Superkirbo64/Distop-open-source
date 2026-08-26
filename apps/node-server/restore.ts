/**
 * Inspección y restauración de una copia `.distop-backup` (plan C1, §4.5).
 *
 * Este módulo NO importa config.ts ni db.ts, y no es un descuido: importar
 * config.ts crea `secret.key` en el directorio de datos, e importar db.ts abre
 * y migra la base. Una herramienta cuyo trabajo es reemplazar ese directorio no
 * puede empezar tocándolo. De la instancia solo se usa `migrations.ts`, que es
 * una lista de cadenas sin efectos, para saber hasta qué esquema llega este
 * programa.
 *
 * La restauración se hace con el servidor parado y no tiene ruta HTTP:
 * sustituir el directorio vivo desde una petición sería el mando a distancia
 * perfecto para el día que alguien se cuele.
 *
 *   DISTOP_BACKUP_PASSPHRASE='...' node restore.ts --inspect --file copia.distop-backup
 *   DISTOP_BACKUP_PASSPHRASE='...' node restore.ts --file copia.distop-backup --target ./data
 *
 * La frase se lee del entorno, nunca de un argumento: los argumentos de un
 * proceso los ve cualquiera que liste procesos en la máquina.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash, createPrivateKey, type JsonWebKey } from "node:crypto";
import { closeSync, createWriteStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { seedUuidClock, uuidv7, uuidv7Time } from "@distop/protocol";
import {
  BackupError,
  PARTIAL_EXTENSION,
  readBackup,
  readHeader,
  safeEntryPath,
  sameHash,
  type BackupManifest,
} from "./backup-format.ts";
import { SCHEMA_VERSION } from "./migrations.ts";

const RUTA_DB = "database/app.db";
const RUTA_IDENTIDAD = "identity/instance.key";
const RUTA_SECRETO = "secrets/auth-secret";
const RUTA_PUSH = "secrets/push";

/** Dónde acaba cada pieza dentro del directorio de datos.
    Una copia anterior a A2 no trae `secrets/push`, y eso no es un fallo: se
    restaura igual y la instancia genera un par nuevo. Lo único que se pierde
    son las suscripciones de push, que hay que volver a activar. */
const DESTINOS: Record<string, string> = {
  [RUTA_DB]: "app.db",
  [RUTA_IDENTIDAD]: "instance.key",
  [RUTA_SECRETO]: "secret.key",
  [RUTA_PUSH]: "push.key",
};

export interface RestoreReport {
  manifest: BackupManifest;
  ok: boolean;
  /** En el manifiesto pero ausentes del bundle. */
  missing: string[];
  /** Presentes pero con otro contenido del que dice el manifiesto. */
  corrupt: string[];
  /** En el bundle sin figurar en el manifiesto: nunca se escriben. */
  extra: string[];
  /** Rutas rechazadas por intentar salirse del destino. */
  rejected: string[];
  schema: { backup: number; supported: number; ok: boolean };
  database: { integrity: string; foreign_keys: number; ok: boolean };
  identity: { instance_id: string; lineage_id: string; epoch: number; ok: boolean };
  attachments: { checked: number; ok: boolean };
}

/* ── inspección ───────────────────────────────────────────────────────── */

/**
 * Lee una copia sin escribir nada.
 *
 * `deep: false` para en el manifiesto: rápido, y suficiente para "¿de quién es
 * esta copia y qué dice traer?". NO comprueba que el fichero esté entero, así
 * que devuelve `verified: false` y quien lo use no puede llamarlo verificado.
 * `deep: true` recorre todos los bytes y contrasta todos los hashes.
 */
export async function inspectBackup(
  file: string,
  passphrase: string,
  opts: { deep?: boolean } = {},
): Promise<{ manifest: BackupManifest; verified: boolean; missing: string[]; corrupt: string[]; extra: string[] }> {
  if (file.endsWith(PARTIAL_EXTENSION)) {
    throw new BackupError("PARTIAL_BACKUP", "Esa copia se quedó a medias al escribirse; no sirve para restaurar.");
  }
  await readHeader(file);

  if (!opts.deep) {
    const manifest = await readBackup(file, passphrase, async () => async () => {}, { stopAfterManifest: true });
    return { manifest, verified: false, missing: [], corrupt: [], extra: [] };
  }

  const vistos = new Set<string>();
  const corrupt: string[] = [];
  const extra: string[] = [];

  const manifest = await readBackup(file, passphrase, async (path, size, manifiesto) => {
    vistos.add(path);
    const declarado = manifiesto.files.find((f) => f.path === path);
    if (!declarado) {
      extra.push(path);
      return async () => {};
    }
    const hasher = createHash("sha256");
    let leidos = 0;
    return async (chunk) => {
      hasher.update(chunk);
      leidos += chunk.length;
      if (leidos === size && !sameHash(hasher.digest("hex"), declarado.sha256)) corrupt.push(path);
    };
  });

  const missing = manifest.files.map((f) => f.path).filter((path) => !vistos.has(path));
  return { manifest, verified: true, missing, corrupt, extra };
}

/* ── restauración ─────────────────────────────────────────────────────── */

interface DiarioMovimiento {
  from: string;
  to: string;
  backup: string | null;
}

const NOMBRE_DIARIO = "restore.journal";
const STAGING = ".restore-incoming";

/** ¿Queda algo del directorio anterior, aparte de lo que dejamos nosotros? */
function contenidoReal(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name !== STAGING && name !== NOMBRE_DIARIO);
}
interface RestoreJournal {
  format: "distop-restore-journal";
  started_at: number;
  source: string;
  moves: DiarioMovimiento[];
}

function movimientosEsperados(destino: string, staging: string): DiarioMovimiento[] {
  const out: DiarioMovimiento[] = [];
  for (const [dentro, fuera] of Object.entries(DESTINOS)) {
    const from = join(staging, ...dentro.split("/"));
    if (existsSync(from)) out.push({ from, to: join(destino, fuera), backup: null });
  }
  const uploads = join(staging, "uploads");
  if (existsSync(uploads)) out.push({ from: uploads, to: join(destino, "uploads"), backup: null });
  return out;
}

function leerDiario(destino: string, diarioPath: string): RestoreJournal {
  let journal: RestoreJournal;
  try {
    journal = JSON.parse(readFileSync(diarioPath, "utf8")) as RestoreJournal;
  } catch {
    throw new BackupError("RESTORE_JOURNAL_INVALID", "El diario de restauración está dañado; no se tocaron los datos.");
  }
  if (journal?.format !== "distop-restore-journal" || !Array.isArray(journal.moves)) {
    throw new BackupError("RESTORE_JOURNAL_INVALID", "El diario de restauración no tiene un formato reconocido.");
  }
  const staging = join(destino, STAGING);
  const permitidos = new Map<string, string>([
    ...Object.entries(DESTINOS).map(([inside, outside]) => [join(staging, ...inside.split("/")), join(destino, outside)] as const),
    [join(staging, "uploads"), join(destino, "uploads")] as const,
  ]);
  const vistos = new Set<string>();
  for (const move of journal.moves) {
    const expected = permitidos.get(move.from);
    if (!expected || expected !== move.to || vistos.has(move.from) || (move.backup !== null && move.backup !== `${move.to}.bak`)) {
      throw new BackupError("RESTORE_JOURNAL_INVALID", "El diario contiene destinos que no pertenecen a esta restauración.");
    }
    vistos.add(move.from);
  }
  return journal;
}

/** Revierte una colocación interrumpida usando el estado real del disco. */
export function recoverInterruptedRestore(targetDir: string): boolean {
  const destino = resolve(targetDir);
  const diarioPath = join(destino, NOMBRE_DIARIO);
  if (!existsSync(diarioPath)) return false;
  const journal = leerDiario(destino, diarioPath);
  for (const move of [...journal.moves].reverse()) {
    if (move.backup && existsSync(move.backup)) {
      rmSync(move.to, { recursive: true, force: true });
      mkdirSync(dirname(move.to), { recursive: true });
      renameSync(move.backup, move.to);
      continue;
    }
    if (move.backup && !existsSync(move.from)) {
      throw new BackupError("RESTORE_RECOVERY_FAILED", "Falta tanto el origen como la copia anterior de un movimiento interrumpido.");
    }
    if (!move.backup && !existsSync(move.from) && existsSync(move.to)) {
      mkdirSync(dirname(move.from), { recursive: true });
      renameSync(move.to, move.from);
    }
  }
  rmSync(join(destino, STAGING), { recursive: true, force: true });
  rmSync(diarioPath, { force: true });
  return true;
}

/**
 * Extrae, verifica y —solo si todo cuadró— coloca.
 *
 * El orden no es negociable: nada toca el directorio final hasta que la copia
 * entera está en disco, con todos sus hashes comprobados, la base abierta, su
 * integridad verificada y su esquema reconocido. Restaurar a medias sobre los
 * datos de alguien es peor que no restaurar.
 */
export async function restoreBackup(opts: {
  file: string;
  passphrase: string;
  targetDir: string;
  /** Reemplazar un directorio con datos. Sin esto, se exige que esté vacío. */
  replace?: boolean;
  /**
   * Si el bundle debe traer la clave privada de la instancia.
   *
   * Una copia de recuperación sí: reconstruye la MISMA instancia. Un relevo no,
   * y no por descuido — el sucesor genera su clave y el predecesor la autoriza
   * firmando un certificado, precisamente para que no queden dos máquinas
   * capaces de firmar como la misma (§5.6). Exigirla aquí haría imposible el
   * relevo; darla por opcional siempre haría que una copia mutilada pasara por
   * buena. Por eso lo decide quien llama, y por defecto se exige.
   */
  expectIdentityKey?: boolean;
}): Promise<RestoreReport> {
  if (opts.file.endsWith(PARTIAL_EXTENSION)) {
    throw new BackupError("PARTIAL_BACKUP", "Esa copia se quedó a medias al escribirse; no sirve para restaurar.");
  }

  const destino = resolve(opts.targetDir);
  const staging = join(destino, STAGING);
  const diarioPath = join(destino, NOMBRE_DIARIO);

  recoverInterruptedRestore(destino);
  if (contenidoReal(destino).length > 0 && !opts.replace) {
    throw new BackupError(
      "TARGET_NOT_EMPTY",
      `El directorio ${destino} ya tiene datos. Restaura en uno vacío, o pide el reemplazo explícitamente.`,
    );
  }

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const corrupt: string[] = [];
  const extra: string[] = [];
  const rejected: string[] = [];
  const vistos = new Set<string>();

  try {
    const manifest = await readBackup(opts.file, opts.passphrase, async (path, size, manifiesto) => {
      vistos.add(path);
      const declarado = manifiesto.files.find((f) => f.path === path);
      /* Un fichero que no figura en el manifiesto no se escribe: el manifiesto
         va firmado por el mismo cifrado que el resto, así que es la única lista
         de la que fiarse dentro del bundle. */
      if (!declarado) {
        extra.push(path);
        return async () => {};
      }
      if (!safeEntryPath(path)) {
        rejected.push(path);
        return async () => {};
      }
      const salida = join(staging, ...path.split("/"));
      /* Doble cinturón: la ruta ya pasó safeEntryPath y aun así se comprueba
         que el resultado cae dentro de staging. Un `..` que se colara por un
         caso no previsto no llegaría a escribir fuera. */
      if (!resolve(salida).startsWith(`${resolve(staging)}${sep}`)) {
        rejected.push(path);
        return async () => {};
      }
      if (size !== declarado.size) {
        corrupt.push(path);
        return async () => {};
      }

      mkdirSync(dirname(salida), { recursive: true });
      const flujo = createWriteStream(salida, { flags: "wx" });
      const hasher = createHash("sha256");
      let leidos = 0;
      return async (chunk) => {
        hasher.update(chunk);
        leidos += chunk.length;
        await new Promise<void>((ok, fail) => flujo.write(chunk, (e) => (e ? fail(e) : ok())));
        if (leidos === size) {
          await new Promise<void>((ok, fail) => flujo.end((e?: Error | null) => (e ? fail(e) : ok())));
          if (!sameHash(hasher.digest("hex"), declarado.sha256)) corrupt.push(path);
        }
      };
    });

    const missing = manifest.files.map((f) => f.path).filter((path) => !vistos.has(path));
    const report = verificar({
      manifest,
      staging,
      missing,
      corrupt,
      extra,
      rejected,
      expectIdentityKey: opts.expectIdentityKey !== false,
    });
    if (!report.ok) {
      rmSync(staging, { recursive: true, force: true });
      return report;
    }

    registrarAuditoriaRestauracion(staging, report, opts.file);
    colocar({ destino, staging, diarioPath, source: opts.file });
    return report;
  } catch (error) {
    if (!existsSync(diarioPath)) rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

/** Todo lo que hay que poder responder ANTES de tocar el directorio final. */
function verificar(input: {
  manifest: BackupManifest;
  staging: string;
  missing: string[];
  corrupt: string[];
  extra: string[];
  rejected: string[];
  expectIdentityKey: boolean;
}): RestoreReport {
  const { manifest, staging } = input;

  const schema = {
    backup: manifest.database_schema,
    supported: SCHEMA_VERSION,
    /* Una copia de una versión más nueva no se restaura: sus tablas pueden
       tener columnas que este código no conoce, y migrar hacia atrás no
       existe (§28.6). */
    ok: Number.isInteger(manifest.database_schema) && manifest.database_schema <= SCHEMA_VERSION,
  };

  const database = { integrity: "no comprobada", foreign_keys: -1, ok: false };
  const identity = { instance_id: "", lineage_id: "", epoch: 0, ok: false };
  const attachments = { checked: 0, ok: false };

  const baseRestaurada = join(staging, ...RUTA_DB.split("/"));
  const integraHastaAqui = input.corrupt.length === 0 && input.missing.length === 0 && input.rejected.length === 0;

  if (existsSync(baseRestaurada) && integraHastaAqui) {
    const copia = new DatabaseSync(baseRestaurada);
    try {
      database.integrity = (copia.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
      database.foreign_keys = (copia.prepare("PRAGMA foreign_key_check").all() as unknown[]).length;
      const version = (copia.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      database.ok = database.integrity === "ok" && database.foreign_keys === 0 && version === manifest.database_schema;

      const leerMeta = copia.prepare("SELECT value FROM meta WHERE key = ?");
      const meta = (clave: string): string => (leerMeta.get(clave) as { value: string } | undefined)?.value ?? "";
      identity.instance_id = meta("instance_id");
      identity.lineage_id = meta("lineage_id");
      identity.epoch = Number.parseInt(meta("instance_epoch") || "1", 10);
      /* La base y el manifiesto tienen que contar la misma historia. Si no
         coinciden, alguien recompuso el bundle a mano y esto no es la copia de
         la instancia que dice ser. */
      identity.ok =
        identity.instance_id === manifest.instance_id &&
        identity.lineage_id === manifest.lineage_id &&
        identity.epoch === manifest.epoch &&
        (input.expectIdentityKey
          ? clavePrivadaValida(join(staging, ...RUTA_IDENTIDAD.split("/")))
          : !existsSync(join(staging, ...RUTA_IDENTIDAD.split("/"))));
      const declared = new Map(manifest.files.map((file) => [file.path, file]));
      const columns = copia.prepare("PRAGMA table_info(attachments)").all() as Array<{ name: string }>;
      const hasContentHash = columns.some((column) => column.name === "content_hash");
      const rows = copia.prepare(
        hasContentHash
          ? "SELECT path, size, content_hash FROM attachments WHERE path <> ''"
          : "SELECT path, size, NULL AS content_hash FROM attachments WHERE path <> ''",
      ).all() as Array<{ path: string; size: number; content_hash: string | null }>;
      attachments.ok = true;
      for (const row of rows) {
        attachments.checked++;
        // SQLite conserva la ruta relativa con el separador de la plataforma
        // donde se creó. El contenedor, en cambio, siempre usa "/".
        const normalizedPath = row.path.replaceAll("\\", "/");
        const bundlePath = `uploads/${normalizedPath}`;
        const absoluteOrDrive =
          row.path.startsWith("/") ||
          row.path.startsWith("\\") ||
          /^[A-Za-z]:[\\/]/.test(row.path);
        if (!row.path || absoluteOrDrive || !safeEntryPath(bundlePath)) {
          if (!input.rejected.includes(bundlePath)) input.rejected.push(bundlePath);
          attachments.ok = false;
          continue;
        }
        const file = declared.get(bundlePath);
        const diskPath = join(staging, ...bundlePath.split("/"));
        if (!file || !existsSync(diskPath) || !statSync(diskPath).isFile()) {
          if (!input.missing.includes(bundlePath)) input.missing.push(bundlePath);
          attachments.ok = false;
          continue;
        }
        const expectedHash = row.content_hash?.match(/^sha256:([0-9a-f]{64})$/i)?.[1];
        if (file.size !== row.size || statSync(diskPath).size !== row.size || (row.content_hash && (!expectedHash || !sameHash(file.sha256, expectedHash)))) {
          if (!input.corrupt.includes(bundlePath)) input.corrupt.push(bundlePath);
          attachments.ok = false;
        }
      }
      const count = (table: string): number =>
        (copia.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      for (const table of ["users", "communities", "channels", "messages", "attachments"] as const) {
        if (count(table) !== manifest.counts[table]) database.ok = false;
      }
    } catch {
      database.ok = false;
    } finally {
      copia.close();
    }
  }

  const ok = input.corrupt.length === 0 && input.missing.length === 0 && input.rejected.length === 0 && input.extra.length === 0 && schema.ok && database.ok && identity.ok && attachments.ok;
  return { manifest, ok, missing: input.missing, corrupt: input.corrupt, extra: input.extra, rejected: input.rejected, schema, database, identity, attachments };
}

/** La identidad de la instancia tiene que ser una P-256 de verdad, no un texto. */
function clavePrivadaValida(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const key = createPrivateKey({ key: JSON.parse(readFileSync(file, "utf8")) as JsonWebKey, format: "jwk" });
    return key.asymmetricKeyType === "ec";
  } catch {
    return false;
  }
}
/** Deja en cada comunidad el resultado que arrancará junto a la base restaurada. */
function registrarAuditoriaRestauracion(staging: string, report: RestoreReport, source: string): void {
  const file = join(staging, ...RUTA_DB.split("/"));
  const copia = new DatabaseSync(file);
  try {
    const latest = copia.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get() as { id?: string } | undefined;
    if (latest?.id && /^[0-9a-f]{8}-[0-9a-f]{4}-7/i.test(latest.id)) seedUuidClock(uuidv7Time(latest.id));
    const communities = copia.prepare("SELECT id FROM communities").all() as Array<{ id: string }>;
    const insert = copia.prepare(
      "INSERT INTO audit_log (id, community_id, actor_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const details = JSON.stringify({
      source: basename(source),
      generation: report.manifest.generation,
      missing: report.missing,
      corrupt: report.corrupt,
      extra: report.extra,
      rejected: report.rejected,
      attachments_checked: report.attachments.checked,
    });
    copia.exec("BEGIN IMMEDIATE");
    try {
      for (const community of communities) {
        insert.run(uuidv7(), community.id, "system", "INSTANCE_RESTORE_COMPLETED", report.manifest.instance_id, details, Date.now());
      }
      copia.exec("COMMIT");
    } catch (error) {
      copia.exec("ROLLBACK");
      throw error;
    }
  } finally {
    // El intercambio mueve app.db, no un WAL temporal: consolida la auditoría
    // antes de colocar la base verificada en su destino definitivo.
    copia.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copia.close();
  }
}

/**
 * Mueve lo verificado a su sitio, dejando escrito qué se está moviendo.
 *
 * Lo anterior no se borra: se aparta a `.bak`. Restaurar la copia equivocada es
 * un error que alguien va a cometer, y el momento de descubrirlo es siempre
 * después. El diario se borra al terminar; si sigue ahí, la restauración se
 * cortó a mitad y el siguiente intento revierte el intercambio antes de seguir.
 */
function colocar(input: { destino: string; staging: string; diarioPath: string; source: string }): void {
  const movimientos = movimientosEsperados(input.destino, input.staging);
  for (const movimiento of movimientos) {
    if (existsSync(movimiento.to)) movimiento.backup = `${movimiento.to}.bak`;
  }

  const journal: RestoreJournal = {
    format: "distop-restore-journal",
    started_at: Date.now(),
    source: basename(input.source),
    moves: movimientos,
  };
  writeFileSync(input.diarioPath, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
  const journalFd = openSync(input.diarioPath, "r+");
  try {
    fsyncSync(journalFd);
  } finally {
    closeSync(journalFd);
  }

  try {
    for (const movimiento of movimientos) {
      if (movimiento.backup) {
        rmSync(movimiento.backup, { recursive: true, force: true });
        renameSync(movimiento.to, movimiento.backup);
      }
      mkdirSync(dirname(movimiento.to), { recursive: true });
      renameSync(movimiento.from, movimiento.to);
    }

    /* Los ficheros WAL del destino anterior no pueden sobrevivir a un cambio de
       base: describirían escrituras de una historia que ya no existe. */
    for (const sufijo of ["-wal", "-shm"]) rmSync(join(input.destino, `app.db${sufijo}`), { force: true });
    rmSync(input.staging, { recursive: true, force: true });
    rmSync(input.diarioPath, { force: true });
  } catch (error) {
    try {
      recoverInterruptedRestore(input.destino);
    } catch (recoveryError) {
      throw new BackupError(
        "RESTORE_RECOVERY_FAILED",
        `Falló la colocación y tampoco se pudo revertir: ${(recoveryError as Error).message}`,
      );
    }
    throw error;
  }
}

/* ── línea de órdenes ─────────────────────────────────────────────────── */

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function principal(): Promise<void> {
  const file = argumento("file");
  const passphrase = process.env.DISTOP_BACKUP_PASSPHRASE ?? "";
  if (!file || !passphrase) {
    console.error(
      [
        "Uso:",
        "  DISTOP_BACKUP_PASSPHRASE='...' node restore.ts --inspect [--deep] --file copia.distop-backup",
        "  DISTOP_BACKUP_PASSPHRASE='...' node restore.ts --file copia.distop-backup --target ./data [--replace]",
        "",
        "La frase va en la variable de entorno y no en un argumento: los argumentos",
        "de un proceso los puede leer cualquiera que liste procesos en el equipo.",
        "",
        "La instancia tiene que estar PARADA antes de restaurar sobre su directorio.",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  try {
    if (process.argv.includes("--inspect")) {
      const deep = process.argv.includes("--deep");
      console.log(JSON.stringify(await inspectBackup(file, passphrase, { deep }), null, 2));
      if (!deep) {
        console.error("\nAviso: sin --deep esto NO comprueba que la copia esté entera ni que sus hashes cuadren.");
      }
      return;
    }

    const target = argumento("target");
    if (!target) {
      console.error("Falta --target: el directorio de datos donde restaurar.");
      process.exitCode = 2;
      return;
    }
    const report = await restoreBackup({
      file,
      passphrase,
      targetDir: target,
      replace: process.argv.includes("--replace"),
    });
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) {
      console.error("\nNo se restauró nada: la copia no pasó la verificación.");
      process.exitCode = 1;
    }
  } catch (error) {
    const codigo = error instanceof BackupError ? error.code : "RESTORE_FAILED";
    console.error(`${codigo}: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/* Solo cuando se ejecuta a mano; importarlo desde una prueba no arranca nada. */
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await principal();
}
