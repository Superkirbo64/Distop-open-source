/**
 * Identidad local y sesiones (§7.2, §22).
 * Tokens opacos y revocables: en la base solo vive su HMAC, así que un volcado
 * de la base no entrega sesiones utilizables.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_STATUSES, toProfileStyle, uuidv7 } from "@distop/protocol";
import type { PublicUser, SelfUser, UserStatus } from "@distop/protocol";
import { db } from "./db.ts";
import { config } from "./config.ts";
import { writesAccepted } from "./lifecycle.ts";

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
    if (writesAccepted()) db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
    return null;
  }

  if (writesAccepted()) db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(Date.now(), row.session_id);
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
  status: string;
  custom_status: string | null;
  profile_style: string;
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
    // Un valor viejo o corrupto en la base no debe pintar un estado inventado.
    status: (USER_STATUSES as readonly string[]).includes(row.status) ? (row.status as UserStatus) : "online",
    custom_status: row.custom_status,
    // Normalizado aqui tambien, no solo al guardar: una fila vieja o tocada a
    // mano en el fichero SQLite no puede colarse hasta el CSS del cliente.
    profile_style: toProfileStyle(safeJson(row.profile_style)),
    created_at: row.created_at,
  };
}

export function toSelfUser(row: UserRow): SelfUser {
  return {
    ...toPublicUser(row),
    locale: row.locale,
    theme: row.theme,
    settings: safeJson(row.settings),
    has_password: row.password_hash !== null,
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

/**
 * Quien puso en marcha la instancia: la cuenta local más antigua.
 * Es la única a la que se le permite tocar cosas del anfitrión (abrir un túnel,
 * por ejemplo). Ser administrador de una comunidad no basta: administrar una
 * comunidad no da derecho a manejar el ordenador de otra persona (§28.5).
 */
export function isInstanceOwner(userId: string): boolean {
  return hostUserId() === userId;
}

/** Autoridad explícita del equipo. `null` exige una reclamación local. */
export function hostUserId(): string | null {
  const row = db.prepare("SELECT user_id FROM host_authority WHERE id = 1").get() as
    | { user_id: string | null }
    | undefined;
  return row?.user_id ?? null;
}

/* Estar sentado delante del ordenador vale lo mismo que arrancarlo: por eso
   `local-claim` no exige contraseña, igual que `bootstrap`. Una transferencia
   sí la exige, porque el destino tiene que poder volver a entrar sin estar
   físicamente en la máquina. */
const RECLAMOS_PRESENCIALES = new Set(["bootstrap", "local-claim"]);

export function setHostUser(userId: string | null, reason: string, grantedBy: string | null): void {
  if (userId) {
    const target = findUserById(userId);
    if (!target || target.kind !== "local") throw new Error("HOST_AUTHORITY_TARGET_INVALID");
    if (!RECLAMOS_PRESENCIALES.has(reason) && !target.password_hash) {
      throw new Error("HOST_AUTHORITY_RECOVERY_REQUIRED");
    }
  }
  db.prepare(
    `INSERT INTO host_authority (id, user_id, since, granted_by, reason)
     VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       since = excluded.since,
       granted_by = excluded.granted_by,
       reason = excluded.reason`,
  ).run(userId, Date.now(), grantedBy, reason);
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
  kind?: "local" | "guest" | "portable";
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
  /* Instancia recién nacida —sin fila de autoridad todavía—: la primera cuenta
     local se queda con el equipo. Si la fila existe pero está vacía porque el
     anfitrión borró su cuenta, NO se hereda sola: registrarse por el túnel no
     puede dar el mando del ordenador de otra persona. Se recupera a mano desde
     el propio equipo con /instance/host/claim. */
  if ((opts.kind ?? "local") === "local" && !db.prepare("SELECT 1 FROM host_authority WHERE id = 1").get()) {
    setHostUser(id, "bootstrap", null);
  }
  return findUserById(id)!;
}

/**
 * Vincula la cuenta de esta instancia con la identidad secreta que guarda la
 * aplicación. Quien ya está autenticado puede crear o rotar su propio vínculo;
 * un mismo identificador nunca puede saltar a otra cuenta.
 */
export function linkPortableIdentity(userId: string, identityId: string, secret: string): void {
  const existing = db
    .prepare("SELECT user_id FROM portable_identities WHERE identity_id = ?")
    .get(identityId) as { user_id: string } | undefined;
  if (existing && existing.user_id !== userId) throw new Error("PORTABLE_IDENTITY_CONFLICT");

  db.prepare("DELETE FROM portable_identities WHERE user_id = ? AND identity_id <> ?").run(userId, identityId);
  db.prepare(
    `INSERT INTO portable_identities (identity_id, user_id, secret_hash, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET secret_hash = excluded.secret_hash`,
  ).run(identityId, userId, hashPassword(secret), Date.now());
}

/** La identidad existe solo si también demuestra conocer su secreto. */
export function portableUser(identityId: string, secret: string): UserRow | null {
  const row = db
    .prepare(
      `SELECT p.secret_hash, u.*
         FROM portable_identities p JOIN users u ON u.id = p.user_id
        WHERE p.identity_id = ?`,
    )
    .get(identityId) as (UserRow & { secret_hash: string }) | undefined;
  if (!row || !verifyPassword(secret, row.secret_hash)) return null;
  return row;
}

export function hasPortableIdentity(identityId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM portable_identities WHERE identity_id = ?").get(identityId));
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
