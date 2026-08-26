/**
 * Copia de recuperación de la instancia (§21, plan C1).
 *
 * Esto NO es la exportación legible de una comunidad —esa ya existe, es JSON, y
 * sirve para llevarte tus datos—. Esto reconstruye ESTA instancia: la misma
 * identidad, las mismas sesiones, las mismas invitaciones, los mismos adjuntos.
 * Por eso va cifrada obligatoriamente: dentro hay hashes de contraseñas, el
 * secreto de sesiones y la clave privada de la instancia.
 *
 * Y por eso tampoco es un relevo. Restaurar produce la MISMA instancia, con la
 * misma época y la misma clave; no una sucesora. Quien restaure una copia
 * mientras el original sigue vivo tendrá dos instancias, no un traspaso — se
 * avisa, y se dice por qué el programa no puede impedirlo solo (§11.1).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.ts";
import { db, INSTANCE_ID } from "./db.ts";
import { instanceEpoch, instanceRole, LINEAGE_ID } from "./identity.ts";
import { VERSION } from "./instance.ts";
import { freezeReason, pauseWrites, waitForWrites, type WriteFreeze } from "./lifecycle.ts";
import { SCHEMA_VERSION } from "./migrations.ts";
import { ROOT as STORAGE_ROOT } from "./storage.ts";
import {
  BACKUP_EXTENSION,
  BackupError,
  sha256File,
  writeBackup,
  type BackupCounts,
  type BackupEntry,
  type BackupManifest,
  type ManifestFile,
} from "./backup-format.ts";

const DATA_DIR = dirname(resolve(config.databasePath));
export const BACKUP_DIR = join(DATA_DIR, "backups");

/** Rutas dentro del bundle. Fijas, para que restaurar no tenga que adivinar. */
export const RUTA_DB = "database/app.db";
export const RUTA_IDENTIDAD = "identity/instance.key";
export const RUTA_SECRETO = "secrets/auth-secret";
export const PREFIJO_ADJUNTOS = "uploads/";

/**
 * Lo que se quita de la copia, dicho en el manifiesto.
 *
 * `voice_relay` guarda credenciales de un TURN de pago. Es lo único de pago que
 * hay en todo el proyecto, es opcional, y quien lo tenga contratado lo paga de
 * su bolsillo: meterlo en un fichero que acabará en un disco externo o en el
 * correo de alguien significaría que quien encuentre esa copia factura a su
 * cuenta. Se apunta que falta, para que al restaurar nadie se pregunte por qué
 * la voz dejó de encontrar caminos: hay que volver a escribirlas.
 */
const CLAVES_META_REDACTADAS = ["voice_relay", "public.fixed"];

export interface BackupJob {
  id: string;
  state: "running" | "done" | "failed";
  started_at: number;
  finished_at: number | null;
  /** Solo el nombre: la ruta del disco del anfitrión no sale por la API. */
  filename: string | null;
  bytes: number;
  files: number;
  redacted: string[];
  error_code: string | null;
}

const trabajos = new Map<string, BackupJob>();

export function backupJob(id: string): BackupJob | undefined {
  return trabajos.get(id);
}

export function recentBackupJobs(): BackupJob[] {
  return [...trabajos.values()].sort((a, b) => b.started_at - a.started_at).slice(0, 10);
}

/** Todos los ficheros de adjuntos, sin lo que está a medias. */
function ficherosDeAdjuntos(): Array<{ absolute: string; relative: string; size: number }> {
  const out: Array<{ absolute: string; relative: string; size: number }> = [];
  const recorrer = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      /* `.incoming` son subidas sin terminar: no tienen fila, no las reclama
         nadie, y meterlas engordaría la copia a cambio de basura. */
      if (entry.name === ".incoming") continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        recorrer(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({
        absolute,
        relative: relative(STORAGE_ROOT, absolute).split(sep).join("/"),
        size: statSync(absolute).size,
      });
    }
  };
  if (existsSync(STORAGE_ROOT)) recorrer(STORAGE_ROOT);
  return out;
}

/**
 * Foto coherente de la base, con las escrituras congeladas el rato justo.
 *
 * El orden importa y es demostrable: `saveUploadStream` renombra el fichero y
 * DESPUÉS inserta la fila, así que toda fila que esté en la base ya tiene su
 * fichero en el disco. Copiando primero la base y luego los ficheros, todo lo
 * que la base menciona existe. Al revés dejaría filas apuntando a la nada —un
 * adjunto roto, una pérdida visible—; un fichero de más es basura inofensiva.
 */
interface SnapshotMeta {
  generation: number;
  counts: BackupCounts;
}

async function fotografiarBase(destino: string): Promise<SnapshotMeta> {
  const anterior = Number.parseInt((db.prepare("SELECT value FROM meta WHERE key = 'backup.generation'").get() as { value?: string } | undefined)?.value ?? "0", 10);
  const generation = Number.isSafeInteger(anterior) && anterior >= 0 ? anterior + 1 : 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('backup.generation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(generation));
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  /* `VACUUM INTO` y no la API `backup()` de node:sqlite: existe en el runtime
     pero todavía no en los tipos que usa el repo, y aquí no aporta nada.
     `backup()` gana cuando hay que copiar con escrituras en marcha; nosotros ya
     las tenemos congeladas. A cambio, VACUUM INTO desfragmenta —la copia sale
     más pequeña— y conserva `user_version`, que es lo que después decide si
     esta versión del programa entiende el esquema. */
  db.prepare("VACUUM INTO ?").run(destino);

  const copia = new DatabaseSync(destino);
  let counts: BackupCounts;
  try {
    for (const clave of CLAVES_META_REDACTADAS) copia.prepare("DELETE FROM meta WHERE key = ?").run(clave);
    const count = (table: string): number =>
      (copia.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    counts = { users: count("users"), communities: count("communities"), channels: count("channels"), messages: count("messages"), attachments: count("attachments") };
    /* Se cierra con checkpoint para que salga un solo fichero autocontenido: un
       app.db acompañado de un -wal que no viaja es una base a la que le faltan
       las últimas escrituras. */
    copia.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    copia.close();
  }
  return { generation, counts };
}

function nuevoTrabajo(passphrase: string, congelacionPropia: WriteFreeze | null = null): { job: BackupJob; filename: string } {
  if (passphrase.length < 12) {
    throw new BackupError("WEAK_PASSPHRASE", "La frase de la copia necesita al menos 12 caracteres.");
  }
  /* Dos copias a la vez del mismo directorio no son dos copias: son una foto de
     la base tomada mientras la otra congelaba y descongelaba las escrituras.
     `congelacionPropia` es la excepción justa: la copia final de un relevo se
     hace CON las escrituras ya congeladas por ese mismo relevo, y sin esta
     salvedad el guardia se bloqueaba a sí mismo. */
  const motivo = freezeReason();
  if (motivo !== null && motivo !== congelacionPropia) {
    throw new BackupError("INSTANCE_BUSY", "La instancia ya está ocupada con otra operación de mantenimiento.");
  }

  const id = randomBytes(8).toString("hex");
  const marca = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `distop-${marca}-${randomBytes(3).toString("hex")}${BACKUP_EXTENSION}`;
  mkdirSync(BACKUP_DIR, { recursive: true });

  const job: BackupJob = {
    id,
    state: "running",
    started_at: Date.now(),
    finished_at: null,
    filename: null,
    bytes: 0,
    files: 0,
    redacted: [...CLAVES_META_REDACTADAS],
    error_code: null,
  };
  trabajos.set(id, job);
  return { job, filename };
}

/**
 * Hace la copia. Congela las escrituras solo mientras dura la foto de la base y
 * la lista de ficheros; el cifrado, que es lo lento, corre con la instancia ya
 * funcionando otra vez.
 */
/**
 * Para qué se arma el bundle. La diferencia no es cosmética.
 *
 * Una copia de recuperación reconstruye ESTA instancia, así que lleva su clave
 * privada. Un relevo entrega la línea a OTRA máquina, que genera la suya: la
 * clave privada del anfitrión anterior nunca viaja, porque dos máquinas capaces
 * de firmar como la misma instancia no se pueden separar después (§5.6).
 */
export type BundlePurpose = "backup" | "handover";

async function ejecutar(
  job: BackupJob,
  filename: string,
  passphrase: string,
  purpose: BundlePurpose = "backup",
  directorio: string = BACKUP_DIR,
): Promise<BackupJob> {
  const temporal = join(BACKUP_DIR, `snapshot-${job.id}.db`);

  try {
    /* Si ya estamos congelados por el relevo que pidió esta copia, no se vuelve
       a congelar —ni se descongela al salir, que sería peor: dejaría entrar
       escrituras justo entre la foto de la base y la copia de los ficheros. */
    const yaCongelado = freezeReason() !== null;
    const soltar = yaCongelado ? () => {} : pauseWrites("backup");
    let adjuntos: ReturnType<typeof ficherosDeAdjuntos>;
    let snapshot: SnapshotMeta;
    try {
      await waitForWrites();
      snapshot = await fotografiarBase(temporal);
      adjuntos = ficherosDeAdjuntos();
    } finally {
      soltar();
    }

    const piezas: Array<{ path: string; file: string }> = [{ path: RUTA_DB, file: temporal }];
    const identidad = join(DATA_DIR, "instance.key");
    /* En un relevo, esta línea es la que no se ejecuta. Es todo el diseño de
       C2 en una condición: el sucesor genera su clave y nosotros la firmamos. */
    if (purpose === "backup" && existsSync(identidad)) piezas.push({ path: RUTA_IDENTIDAD, file: identidad });
    const secreto = join(DATA_DIR, "secret.key");
    if (existsSync(secreto)) piezas.push({ path: RUTA_SECRETO, file: secreto });
    for (const adjunto of adjuntos) {
      piezas.push({ path: `${PREFIJO_ADJUNTOS}${adjunto.relative}`, file: adjunto.absolute });
    }

    /* Los hashes se calculan antes de escribir para que el manifiesto vaya el
       primero dentro del bundle: así inspeccionar una copia no obliga a
       descifrarla entera. Cuesta una lectura extra de los adjuntos; a cambio,
       "¿de quién es esta copia y qué trae?" se responde en un segundo. */
    const manifiesto: ManifestFile[] = [];
    const entradas: BackupEntry[] = [];
    for (const pieza of piezas) {
      const { hash, size } = await sha256File(pieza.file);
      manifiesto.push({ path: pieza.path, size, sha256: hash });
      entradas.push({ path: pieza.path, size, source: { file: pieza.file } });
    }

    const manifest: BackupManifest = {
      format: "distop-backup-manifest",
      version: 1,
      created_at: Date.now(),
      instance_id: INSTANCE_ID,
      generation: snapshot.generation,
      lineage_id: LINEAGE_ID,
      epoch: instanceEpoch(),
      role: instanceRole(),
      instance_name: config.instanceName,
      server_version: VERSION,
      database_schema: SCHEMA_VERSION,
      files: manifiesto,
      counts: snapshot.counts,
      redactions: [...CLAVES_META_REDACTADAS],
    };

    const escrito = await writeBackup({
      destination: join(directorio, filename),
      passphrase,
      manifest,
      entries: entradas,
    });

    job.state = "done";
    job.filename = filename;
    job.bytes = escrito.bytes;
    job.files = manifiesto.length;
    job.finished_at = Date.now();
    return job;
  } catch (error) {
    job.state = "failed";
    job.finished_at = Date.now();
    job.error_code = error instanceof BackupError ? error.code : "BACKUP_FAILED";
    throw error;
  } finally {
    await rm(temporal, { force: true }).catch(() => {});
  }
}

/**
 * Arranca la copia y devuelve el trabajo sin esperar a que acabe.
 *
 * Separado y en diferido a propósito, por dos razones distintas. Cifrar
 * cuarenta gigas puede tardar minutos, y una petición HTTP colgada ese rato se
 * cae por el camino sin decirle a nadie cómo fue. Y sobre todo: el handler que
 * la pide cuenta como escritura en vuelo, así que si esperase aquí,
 * `waitForWrites` estaría esperándose a sí mismo hasta agotar su tope.
 */
export function startBackup(passphrase: string): BackupJob {
  const { job, filename } = nuevoTrabajo(passphrase);
  const arranque = setTimeout(() => {
    void ejecutar(job, filename, passphrase).catch(() => {
      /* El fallo ya quedó anotado en el trabajo, que es donde alguien lo va a
         mirar; no hay a quién relanzarlo. */
    });
  }, 0);
  arranque.unref();
  return job;
}

/** La misma copia, esperando a que termine. Para la línea de órdenes y las
    pruebas, donde no hay ningún handler contando como escritura. */
export async function createBackup(opts: { passphrase: string }): Promise<BackupJob> {
  const { job, filename } = nuevoTrabajo(opts.passphrase);
  return ejecutar(job, filename, opts.passphrase);
}

/**
 * El bundle que se lleva el sucesor: lo mismo que una copia, menos la clave
 * privada. Va a un nombre fijo dentro del directorio del relevo para que la
 * descarga se pueda reanudar por rangos sin llevar la cuenta de nada más.
 */
export async function createHandoverBundle(opts: {
  passphrase: string;
  directory: string;
  filename: string;
}): Promise<BackupJob> {
  const { job } = nuevoTrabajo(opts.passphrase, "handover");
  mkdirSync(opts.directory, { recursive: true });
  return ejecutar(job, opts.filename, opts.passphrase, "handover", opts.directory);
}

/** Copias que hay ahora mismo en el disco del anfitrión, sin abrirlas. */
export function listBackupFiles(): Array<{ filename: string; size: number; created_at: number }> {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(BACKUP_EXTENSION))
    .map((entry) => {
      const stats = statSync(join(BACKUP_DIR, entry.name));
      return { filename: entry.name, size: stats.size, created_at: Math.floor(stats.mtimeMs) };
    })
    .sort((a, b) => b.created_at - a.created_at);
}
