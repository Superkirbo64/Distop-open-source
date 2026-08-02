/**
 * Identidad local y sesiones (§7.2, §22).
 * Tokens opacos y revocables: en la base solo vive su HMAC, así que un volcado
 * de la base no entrega sesiones utilizables.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { uuidv7 } from "@distop/protocol";
import type { PublicUser, SelfUser } from "@distop/protocol";
import { db } from "./db.ts";
import { config } from "./config.ts";

/* ── contraseñas ───────────────────────────────────────────────────────
   scrypt de node:crypto: memory-hard y sin dependencias nativas que compilar,
   lo que importa cuando la instancia corre en una Raspberry o un NAS.
   ponytail: §22 pide Argon2id; migrar aquí y solo aquí cuando haya binarios
   precompilados en todas las plataformas objetivo. El prefijo del hash ya
   versiona el algoritmo, así que conviven los dos durante la transición. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, n, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !n || !r || !p || !salt || !hash) return false;

  const expected = Buffer.from(hash, "base64");
  const N = Number(n);
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: 128 * N * Number(r) * 2,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ── tokens ────────────────────────────────────────────────────────── */

function fingerprint(token: string): string {
  return createHmac("sha256", config.authSecret).update(token).digest("hex");
}

function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function createSession(userId: string): IssuedSession {
  const now = Date.now();
  const sessionId = uuidv7();
  const accessToken = newToken();
  const refreshToken = newToken();

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, refresh_hash, created_at, expires_at, refresh_expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    userId,
    fingerprint(accessToken),
    fingerprint(refreshToken),
    now,
    now + config.accessTokenTtlS * 1000,
    now + config.refreshTokenTtlS * 1000,
    now,
  );

  return { sessionId, accessToken, refreshToken, expiresIn: config.accessTokenTtlS };
}

/** Rotación estricta: el refresh usado se destruye aunque el cliente no lo confirme. */
export function rotateSession(refreshToken: string): IssuedSession | null {
  const row = db
    .prepare("SELECT id, user_id, refresh_expires_at FROM sessions WHERE refresh_hash = ?")
    .get(fingerprint(refreshToken)) as { id: string; user_id: string; refresh_expires_at: number } | undefined;

  if (!row) return null;
  db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
  if (row.refresh_expires_at < Date.now()) return null;

  return createSession(row.user_id);
}

export function revokeSession(accessToken: string): void {
  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(fingerprint(accessToken));
}

export function revokeAllSessions(userId: string): void {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

export interface AuthContext {
  user: SelfUser;
  sessionId: string;
}

export function authenticate(token: string | null): AuthContext | null {
  if (!token) return null;

  const row = db
    .prepare(
      `SELECT s.id AS session_id, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
    )
    .get(fingerprint(token)) as (UserRow & { session_id: string; expires_at: number }) | undefined;

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }

  db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(Date.now(), row.session_id);
  return { user: toSelfUser(row), sessionId: row.session_id };
}

/** Limpia sesiones caducadas; se llama periódicamente desde server.ts. */
export function pruneSessions(): void {
  db.prepare("DELETE FROM sessions WHERE refresh_expires_at < ?").run(Date.now());
}

/* ── usuarios ──────────────────────────────────────────────────────── */

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string | null;
  kind: string;
  avatar_url: string | null;
  banner_url: string | null;
  bio: string | null;
  pronouns: string | null;
  accent_color: string | null;
  locale: string;
  theme: string;
  settings: string;
  created_at: number;
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    banner_url: row.banner_url,
    bio: row.bio,
    pronouns: row.pronouns,
    accent_color: row.accent_color,
    kind: row.kind === "guest" ? "guest" : "local",
    created_at: row.created_at,
  };
}

export function toSelfUser(row: UserRow): SelfUser {
  return {
    ...toPublicUser(row),
    locale: row.locale,
    theme: row.theme,
    settings: safeJson(row.settings),
  };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Cuentas capaces de ser dueñas de la instancia.
 * Los invitados NO cuentan: son visitantes de paso, sin contraseña y atados a un
 * navegador. Si contaran, bastaría con que alguien entrase como invitado antes
 * que tú para dejar la instancia "reclamada" y a nadie con acceso de
 * administración — un cerrojo sin llave.
 */
export function countOwners(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").get() as { n: number }).n;
}

export function findUserById(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username) as UserRow | undefined;
}

export function createUser(opts: {
  username: string;
  displayName?: string;
  password?: string;
  kind?: "local" | "guest";
}): UserRow {
  const id = uuidv7();
  db.prepare(
    `INSERT INTO users (id, username, display_name, password_hash, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.username,
    opts.displayName ?? opts.username,
    opts.password ? hashPassword(opts.password) : null,
    opts.kind ?? "local",
    Date.now(),
  );
  return findUserById(id)!;
}

/**
 * Invitado (§7.1): usuario real en la base pero sin contraseña, con nombre
 * único generado. Se puede convertir en cuenta local más adelante sin perder
 * mensajes ni membresías, porque el id no cambia.
 */
export function createGuest(displayName: string): UserRow {
  const base = displayName.trim().slice(0, 24) || "invitado";
  let username = `${base}-${randomBytes(2).toString("hex")}`;
  while (findUserByUsername(username)) username = `${base}-${randomBytes(3).toString("hex")}`;
  return createUser({ username, displayName: base, kind: "guest" });
}
