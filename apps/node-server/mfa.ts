/**
 * Autenticador de quien hospeda (claudexcodex/plan-acceso-admin-2026-09-14.md).
 *
 * - Solo la cuenta anfitriona, y solo cuando entra desde fuera: decidirlo es
 *   cosa de api.ts con `isLocalRequest`, igual que el código de `bootstrap`.
 * - Una vez por dispositivo: se pide al entrar; renovar la sesión no lo pide.
 * - El secreto va sellado con la clave en reposo de `push.key`, que viaja en
 *   copias y relevos. `secret.key` no sirve: rota en un relevo y el secreto
 *   quedaría ilegible, dejando fuera a quien hospeda.
 * - No protege contra quien ya tiene la carpeta de datos entera (la clave vive
 *   al lado); por eso la recuperación va por SSH: quien tiene SSH ya manda.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "./db.ts";
import { abrir, sellar } from "./push.ts";
import { matchingStep, newTotpSecret, otpauthUri } from "./totp.ts";

const RESPALDOS = 8;
const RECUPERACION_SSH_MS = 10 * 60_000;
const RETO_MS = 5 * 60_000;

interface MfaRow {
  user_id: string;
  secret_sealed: string | null;
  pending_sealed: string | null;
  last_step: number;
  recovery_hashes: string;
  ssh_code_hash: string | null;
  ssh_code_expires_at: number | null;
}

const fila = (userId: string) =>
  db.prepare("SELECT * FROM host_mfa WHERE user_id = ?").get(userId) as MfaRow | undefined;

/* Los códigos de respaldo y el de SSH son aleatorios y largos: SHA-256 basta
   (no son contraseñas elegidas por una persona). Guiones y espacios no cuentan. */
const huella = (codigo: string) =>
  createHash("sha256").update(codigo.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

const mismaHuella = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function mfaEnabled(userId: string): boolean {
  return Boolean(fila(userId)?.secret_sealed);
}

export function recoveryCodesLeft(userId: string): number {
  const actual = fila(userId);
  return actual?.secret_sealed ? (JSON.parse(actual.recovery_hashes) as string[]).length : 0;
}

/** Secreto nuevo sin confirmar. Si ya había uno confirmado, sigue valiendo hasta confirmar este. */
export function startMfaSetup(userId: string, account: string): { secret: string; otpauth_uri: string } {
  const secret = newTotpSecret();
  db.prepare(
    `INSERT INTO host_mfa (user_id, pending_sealed, created_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET pending_sealed = excluded.pending_sealed`,
  ).run(userId, sellar(secret), Date.now());
  return { secret, otpauth_uri: otpauthUri(secret, account, "Distop") };
}

function nuevosRespaldos(): { codes: string[]; hashes: string[] } {
  const codes = Array.from({ length: RESPALDOS }, () => {
    const crudo = randomBytes(5).toString("hex").toUpperCase();
    return `${crudo.slice(0, 5)}-${crudo.slice(5)}`;
  });
  return { codes, hashes: codes.map(huella) };
}

/** Confirma el QR con un código real. Devuelve los códigos de respaldo (única vez que salen) o null. */
export function confirmMfaSetup(userId: string, code: string, now = Date.now()): string[] | null {
  const actual = fila(userId);
  const pendiente = actual?.pending_sealed ? abrir<string>(actual.pending_sealed) : null;
  if (!actual || !pendiente) return null;
  const paso = matchingStep(pendiente, code.trim(), now, -1);
  if (paso === null) return null;

  const { codes, hashes } = nuevosRespaldos();
  db.prepare(
    `UPDATE host_mfa SET secret_sealed = pending_sealed, pending_sealed = NULL, last_step = ?,
       recovery_hashes = ?, ssh_code_hash = NULL, ssh_code_expires_at = NULL, confirmed_at = ?
     WHERE user_id = ?`,
  ).run(paso, JSON.stringify(hashes), now, userId);
  return codes;
}

/**
 * "ok": código de la app o de respaldo válido. "reset": código de recuperación
 * por SSH; el autenticador queda borrado y hay que configurar uno nuevo.
 */
export function verifyMfa(userId: string, input: string, now = Date.now()): "ok" | "reset" | null {
  const actual = fila(userId);
  if (!actual?.secret_sealed) return null;
  const texto = input.trim();

  if (/^\d{6}$/.test(texto)) {
    const secreto = abrir<string>(actual.secret_sealed);
    const paso = secreto ? matchingStep(secreto, texto, now, actual.last_step) : null;
    if (paso === null) return null;
    // La condición en el UPDATE cierra la carrera de dos peticiones con el mismo código.
    const cambio = db.prepare("UPDATE host_mfa SET last_step = ? WHERE user_id = ? AND last_step < ?").run(paso, userId, paso);
    return cambio.changes === 1 ? "ok" : null;
  }

  const buscada = huella(texto);
  if (actual.ssh_code_hash && (actual.ssh_code_expires_at ?? 0) > now && mismaHuella(buscada, actual.ssh_code_hash)) {
    db.prepare("DELETE FROM host_mfa WHERE user_id = ?").run(userId);
    return "reset";
  }

  const huellas = JSON.parse(actual.recovery_hashes) as string[];
  const indice = huellas.findIndex((guardada) => mismaHuella(guardada, buscada));
  if (indice < 0) return null;
  huellas.splice(indice, 1);
  db.prepare("UPDATE host_mfa SET recovery_hashes = ? WHERE user_id = ?").run(JSON.stringify(huellas), userId);
  return "ok";
}

/** Tanda nueva de códigos de respaldo; los anteriores dejan de valer. */
export function regenerateRecoveryCodes(userId: string): string[] | null {
  if (!mfaEnabled(userId)) return null;
  const { codes, hashes } = nuevosRespaldos();
  db.prepare("UPDATE host_mfa SET recovery_hashes = ? WHERE user_id = ?").run(JSON.stringify(hashes), userId);
  return codes;
}

/** Recuperación por SSH: un solo uso y 10 minutos. null si no hay autenticador que recuperar. */
export function createSshRecoveryCode(userId: string, now = Date.now()): string | null {
  if (!mfaEnabled(userId)) return null;
  const codigo = randomBytes(8).toString("hex").toUpperCase();
  db.prepare("UPDATE host_mfa SET ssh_code_hash = ?, ssh_code_expires_at = ? WHERE user_id = ?")
    .run(huella(codigo), now + RECUPERACION_SSH_MS, userId);
  return codigo;
}

/* ── el paso intermedio entre la contraseña y el código ─────────────── */

// ponytail: en memoria; si la instancia se reinicia en esos 5 minutos, se vuelve a poner la contraseña.
const retos = new Map<string, { userId: string; expires: number }>();

export function createMfaChallenge(userId: string, now = Date.now()): string {
  for (const [token, reto] of retos) if (reto.expires < now) retos.delete(token);
  const token = randomBytes(24).toString("base64url");
  retos.set(token, { userId, expires: now + RETO_MS });
  return token;
}

export function challengeUser(token: string, now = Date.now()): string | null {
  const reto = retos.get(token);
  if (!reto || reto.expires < now) {
    retos.delete(token);
    return null;
  }
  return reto.userId;
}

export function consumeChallenge(token: string): void {
  retos.delete(token);
}
