/**
 * Copias programadas dentro del servidor (§21, plan N1).
 *
 * Existe por una razón concreta: detrás de un proxy con TRUST_PROXY y
 * PUBLIC_URL ninguna petición es "local" (http.ts:isLocalRequest), y la ruta
 * HTTP de crear copias es local a propósito. En el despliegue en nube
 * (`docs/nube-oracle.md`) eso significaba cero copias — el peor fallo
 * silencioso posible. Aquí no hay HTTP: el propio proceso se hace su copia.
 *
 * Calcado de integrity.ts a conciencia: cadena de setTimeout —nunca
 * setInterval, para que una copia lenta no se solape con la siguiente—, se
 * aparta mientras hay gente en una llamada o mantenimiento en curso, y el
 * apagado espera a la tanda en vuelo. Una copia que llega minutos tarde no la
 * nota nadie; una voz entrecortada, sí.
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.ts";
import { audit, db, meta, setMeta } from "./db.ts";
import { hostUserId } from "./auth.ts";
import { BACKUP_DIR, createBackup, listBackupFiles } from "./backup.ts";
import { BackupError } from "./backup-format.ts";
import { freezeReason } from "./lifecycle.ts";
import { callParticipants } from "./voice.ts";

/** El arranque ya barre subidas, integridad y push: la primera copia espera. */
const PRIMER_RETRASO_MS = 10 * 60_000;
/** Cuánto se espera antes de volver a mirar si la razón de la pausa sigue ahí. */
const REVISION_PAUSA_MS = 5 * 60_000;
/** Tras un fallo no se insiste en caliente: el disco lleno sigue lleno en 5 s. */
const RETRASO_FALLO_MS = 60 * 60_000;

const CLAVE_ULTIMA = "backup.scheduled.last_at";

let started = false;
let stopped = false;
let timer: NodeJS.Timeout | null = null;
let task: Promise<unknown> | null = null;

function intervalMs(): number {
  return config.backupIntervalHours * 3_600_000;
}

/** Cuándo terminó la última copia programada, o 0 si nunca. */
function lastAt(): number {
  const n = Number.parseInt(meta(CLAVE_ULTIMA, () => "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function schedulerEnabled(): boolean {
  return config.backupIntervalHours > 0;
}

/** Por qué la copia programada está esperando, o `null` si puede correr. */
export function schedulerPause(): "paused_maintenance" | "paused_call" | null {
  /* Con otra operación exclusiva en marcha, createBackup lanzaría
     INSTANCE_BUSY igualmente: mejor esperar que fallar. */
  if (freezeReason() !== null) return "paused_maintenance";
  if (callParticipants() > 0) return "paused_call";
  return null;
}

/**
 * Borra las copias más viejas dejando las `keep` más recientes. Devuelve los
 * nombres borrados. Aplica a TODO el directorio de copias, también a las
 * hechas a mano desde el botón local: un directorio, una política, dicho en
 * voz alta — la red de seguridad de verdad es la copia que sale de la máquina
 * (`docs/nube-oracle.md`). Los `.partial` ni aparecen: listBackupFiles solo
 * devuelve ficheros con la extensión completa.
 */
export function pruneBackups(keep: number): string[] {
  const borrados: string[] = [];
  for (const file of listBackupFiles().slice(keep)) {
    try {
      rmSync(join(BACKUP_DIR, file.filename));
      borrados.push(file.filename);
    } catch {
      // Un fichero que no se deja borrar no puede parar la poda de los demás.
    }
  }
  return borrados;
}

/**
 * Un intento de copia con su contabilidad. Jamás lanza: el resultado se lee,
 * no se atrapa. Exportada para las pruebas, igual que runIntegrityBatch.
 */
export async function runScheduledBackup(): Promise<{
  outcome: "done" | "deferred" | "failed";
  filename?: string;
  pruned: string[];
}> {
  const pausa = schedulerPause();
  if (pausa !== null) {
    console.log(`[copias] aplazada (${pausa}); se reintenta en ${REVISION_PAUSA_MS / 60_000} min.`);
    return { outcome: "deferred", pruned: [] };
  }

  try {
    const inicio = Date.now();
    const job = await createBackup({ passphrase: config.backupPassphrase });
    if (job.state !== "done" || job.filename === null) {
      console.log(`[copias] falló (${job.error_code ?? "desconocido"}).`);
      return { outcome: "failed", pruned: [] };
    }
    setMeta(CLAVE_ULTIMA, String(Date.now()));

    /* Que quede escrito en cada comunidad que existe un fichero con sus
       mensajes, igual que cuando la copia la pide una persona. En una
       instancia sin reclamar aún no hay actor válido para el registro. */
    const host = hostUserId();
    if (host !== null) {
      for (const row of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
        audit(row.id, host, "INSTANCE_BACKUP_SCHEDULED", job.id, { redacted: job.redacted });
      }
    }

    const pruned = pruneBackups(config.backupKeep);
    console.log(
      `[copias] hecha ${job.filename} (${job.bytes} bytes, ${job.files} ficheros, ${Date.now() - inicio} ms)` +
        (pruned.length > 0 ? `; podadas: ${pruned.join(", ")}` : ""),
    );
    return { outcome: "done", filename: job.filename, pruned };
  } catch (error) {
    const code = error instanceof BackupError ? error.code : "desconocido";
    console.log(`[copias] falló (${code}).`);
    return { outcome: "failed", pruned: [] };
  }
}

function schedule(delayMs: number): void {
  if (stopped || timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    task = step().finally(() => {
      task = null;
    });
  }, delayMs);
  timer.unref();
}

async function step(): Promise<void> {
  if (stopped) return;
  const result = await runScheduledBackup();
  if (result.outcome === "deferred") schedule(REVISION_PAUSA_MS);
  else if (result.outcome === "failed") schedule(RETRASO_FALLO_MS);
  else schedule(intervalMs());
}

/** Lo que la interfaz necesita para decir si la copia diaria está viva. */
export function backupSchedule(): {
  enabled: boolean;
  interval_hours: number;
  keep: number;
  last: number | null;
} {
  const ultima = lastAt();
  return {
    enabled: schedulerEnabled(),
    interval_hours: config.backupIntervalHours,
    keep: config.backupKeep,
    last: ultima > 0 ? ultima : null,
  };
}

export function startBackupScheduler(): void {
  if (started) return;
  started = true;
  stopped = false;
  if (!schedulerEnabled()) {
    console.log("[copias] programación apagada (BACKUP_INTERVAL_HOURS=0).");
    return;
  }
  /* Reinicios frecuentes no pueden ni saltarse copias para siempre ni martillear
     cada arranque: la siguiente sale de la última hecha, con un suelo de diez
     minutos desde el arranque. */
  const siguiente = Math.max(lastAt() + intervalMs() - Date.now(), PRIMER_RETRASO_MS);
  console.log(`[copias] programadas cada ${config.backupIntervalHours} h; próxima en ${Math.round(siguiente / 60_000)} min.`);
  schedule(siguiente);
}

/** Quieto y esperando a la copia en vuelo: nadie lee ficheros cuando la base se cierra. */
export async function stopBackupScheduler(): Promise<void> {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (task) await task.catch(() => {});
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
