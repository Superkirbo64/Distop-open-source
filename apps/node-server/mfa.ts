/**
 * Autenticador de quien hospeda (claudexcodex/plan-acceso-admin-2026-09-14.md).
 *
 * - Solo en VPS y solo cuando se entra desde fuera: decidirlo es cosa de
 *   api.ts (`deploymentProfile`, `isLocalRequest`), igual que `bootstrap`.
 * - Una vez por dispositivo: se pide al entrar; renovar la sesión no lo pide.
 * - Si se pierde el teléfono, la salida es el código de recuperación por SSH.
 *   Sin códigos de respaldo (Kirbo, 14-09): quien administra una VPS tiene SSH.
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

const RECUPERACION_SSH_MS = 10 * 60_000;
const RETO_MS = 5 * 60_000;

interface MfaRow {
  user_id: string;
  secret_sealed: string | null;
  pending_sealed: string | null;
  last_step: number;
  ssh_code_hash: string | null;
  ssh_code_expires_at: number | null;
}

const fila = (userId: string) =>
  db.prepare("SELECT * FROM host_mfa WHERE user_id = ?").get(userId) as MfaRow | undefined;

/* El código de SSH es aleatorio y largo: SHA-256 basta (no es una contraseña
   elegida por una persona). Guiones y espacios no cuentan. */
const huella = (codigo: string) =>
  createHash("sha256").update(codigo.replace(/[\s-]/g, "").toUpperCase()).digest("hex");

const mismaHuella = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function mfaEnabled(userId: string): boolean {
  return Boolean(fila(userId)?.secret_sealed);
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

/** Confirma el QR con un código real de la app. */
export function confirmMfaSetup(userId: string, code: string, now = Date.now()): boolean {
  const actual = fila(userId);
  const pendiente = actual?.pending_sealed ? abrir<string>(actual.pending_sealed) : null;
  if (!actual || !pendiente) return false;
  const paso = matchingStep(pendiente, code.trim(), now, -1);
  if (paso === null) return false;

  db.prepare(
    `UPDATE host_mfa SET secret_sealed = pending_sealed, pending_sealed = NULL, last_step = ?,
       ssh_code_hash = NULL, ssh_code_expires_at = NULL, confirmed_at = ?
     WHERE user_id = ?`,
  ).run(paso, now, userId);
  return true;
}

/**
 * "ok": código de la app válido. "reset": código de recuperación por SSH; el
 * autenticador queda borrado y hay que configurar uno nuevo.
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

  if (actual.ssh_code_hash && (actual.ssh_code_expires_at ?? 0) > now && mismaHuella(huella(texto), actual.ssh_code_hash)) {
    db.prepare("DELETE FROM host_mfa WHERE user_id = ?").run(userId);
    return "reset";
  }
  return null;
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
