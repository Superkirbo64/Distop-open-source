/**
 * Espejo tipado de `GET /api/v1/instance/backups` (§21, docs/copias-de-seguridad.md).
 *
 * El listado es requireHost-only y por eso funciona también en la nube, donde
 * nada es "local": la interfaz remota puede decir si la copia programada está
 * viva. Crear (POST) e inspeccionar siguen siendo del equipo anfitrión, y el
 * servidor lo dice con `manual_available` — el cliente no puede adivinar cómo
 * le ve la instancia a través de un proxy o un túnel.
 */

/** Un trabajo de copia, tal como lo cuenta el servidor. */
export interface BackupJob {
  id: string;
  state: "running" | "done" | "failed";
  started_at: number;
  finished_at: number | null;
  /** Solo el nombre: la ruta del disco del anfitrión no sale por la API. */
  filename: string | null;
  bytes: number;
  files: number;
  /** Meta redactada de la copia (voice_relay, public.fixed): habrá que reponerla al restaurar. */
  redacted: string[];
  error_code: string | null;
}

/** Un fichero de copia ya cifrado en el disco del servidor. */
export interface BackupFile {
  filename: string;
  size: number;
  created_at: number;
}

/** La programación interna (BACKUP_INTERVAL_HOURS / BACKUP_KEEP). */
export interface BackupSchedule {
  enabled: boolean;
  interval_hours: number;
  keep: number;
  /** Última copia programada que terminó bien, o null si nunca hubo una. */
  last: number | null;
}

export interface BackupsView {
  jobs: BackupJob[];
  files: BackupFile[];
  schedule: BackupSchedule;
  /** Calculado por el servidor: si desde donde se mira se puede pedir una copia manual. */
  manual_available: boolean;
}

/** La programación en dos estados que la interfaz sepa pintar sin pensar. */
export type ScheduleSummary =
  | { kind: "on"; hours: number; keep: number; last: number | null }
  | { kind: "off" };

/**
 * Un intervalo de 0 horas es la forma del servidor de decir "apagado", así que
 * `enabled` y el intervalo se leen juntos: nunca puede salir "cada 0 h".
 */
export function describeSchedule(schedule: BackupSchedule): ScheduleSummary {
  if (!schedule.enabled || schedule.interval_hours <= 0) return { kind: "off" };
  return { kind: "on", hours: schedule.interval_hours, keep: schedule.keep, last: schedule.last };
}

/**
 * La más nueva primero, sin fiarse del orden en que lleguen: el orden de la
 * lista es un contrato de la vista, no del transporte.
 */
export function sortBackupFiles(files: BackupFile[]): BackupFile[] {
  return [...files].sort((a, b) => b.created_at - a.created_at);
}
