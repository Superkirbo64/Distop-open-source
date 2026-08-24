/**
 * Identidad local y sesiones (§7.2, §22).
 * Tokens opacos y revocables: en la base solo vive su HMAC, así que un volcado
 * de la base no entrega sesiones utilizables.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_STATUSES, toProfileStyle, uuidv7 } from "@distop/protocol";
import { db } from "./db.js";
import { config } from "./config.js";
/* ── contraseñas ───────────────────────────────────────────────────────
   scrypt de node:crypto: memory-hard y sin dependencias nativas que compilar,
   lo que importa cuando la instancia corre en una Raspberry o un NAS.
   ponytail: §22 pide Argon2id; migrar aquí y solo aquí cuando haya binarios
   precompilados en todas las plataformas objetivo. El prefijo del hash ya
   versiona el algoritmo, así que conviven los dos durante la transición. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keylen: 64 };
export function hashPassword(password) {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2 });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}
export function verifyPassword(password, stored) {
    const [algo, n, r, p, salt, hash] = stored.split("$");
    if (algo !== "scrypt" || !n || !r || !p || !salt || !hash)
        return false;
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
function fingerprint(token) {
    return createHmac("sha256", config.authSecret).update(token).digest("hex");
}
function newToken() {
    return randomBytes(32).toString("base64url");
}
export function createSession(userId) {
    const now = Date.now();
    const sessionId = uuidv7();
    const accessToken = newToken();
    const refreshToken = newToken();
    db.prepare(`INSERT INTO sessions (id, user_id, token_hash, refresh_hash, created_at, expires_at, refresh_expires_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(sessionId, userId, fingerprint(accessToken), fingerprint(refreshToken), now, now + config.accessTokenTtlS * 1000, now + config.refreshTokenTtlS * 1000, now);
    return { sessionId, accessToken, refreshToken, expiresIn: config.accessTokenTtlS };
}
/** Rotación estricta: el refresh usado se destruye aunque el cliente no lo confirme. */
export function rotateSession(refreshToken) {
    const row = db
        .prepare("SELECT id, user_id, refresh_expires_at FROM sessions WHERE refresh_hash = ?")
        .get(fingerprint(refreshToken));
    if (!row)
        return null;
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    if (row.refresh_expires_at < Date.now())
        return null;
    return createSession(row.user_id);
}
export function revokeSession(accessToken) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(fingerprint(accessToken));
}
export function revokeAllSessions(userId) {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
export function authenticate(token) {
    if (!token)
        return null;
    const row = db
        .prepare(`SELECT s.id AS session_id, s.expires_at, u.*
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`)
        .get(fingerprint(token));
    if (!row)
        return null;
    if (row.expires_at < Date.now()) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(row.session_id);
        return null;
    }
    db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?").run(Date.now(), row.session_id);
    return { user: toSelfUser(row), sessionId: row.session_id };
}
/** Limpia sesiones caducadas; se llama periódicamente desde server.ts. */
export function pruneSessions() {
    db.prepare("DELETE FROM sessions WHERE refresh_expires_at < ?").run(Date.now());
}
export function toPublicUser(row) {
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
        status: USER_STATUSES.includes(row.status) ? row.status : "online",
        custom_status: row.custom_status,
        // Normalizado aqui tambien, no solo al guardar: una fila vieja o tocada a
        // mano en el fichero SQLite no puede colarse hasta el CSS del cliente.
        profile_style: toProfileStyle(safeJson(row.profile_style)),
        created_at: row.created_at,
    };
}
export function toSelfUser(row) {
    return {
        ...toPublicUser(row),
        locale: row.locale,
        theme: row.theme,
        settings: safeJson(row.settings),
        has_password: row.password_hash !== null,
    };
}
function safeJson(raw) {
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
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
export function countOwners() {
    return db.prepare("SELECT COUNT(*) AS n FROM users WHERE kind = 'local'").get().n;
}
/**
 * Quien puso en marcha la instancia: la cuenta local más antigua.
 * Es la única a la que se le permite tocar cosas del anfitrión (abrir un túnel,
 * por ejemplo). Ser administrador de una comunidad no basta: administrar una
 * comunidad no da derecho a manejar el ordenador de otra persona (§28.5).
 */
export function isInstanceOwner(userId) {
    const row = db.prepare("SELECT id FROM users WHERE kind = 'local' ORDER BY created_at LIMIT 1").get();
    return Boolean(row) && row.id === userId;
}
export function findUserById(id) {
    return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
export function findUserByUsername(username) {
    return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}
export function createUser(opts) {
    const id = uuidv7();
    db.prepare(`INSERT INTO users (id, username, display_name, password_hash, kind, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`).run(id, opts.username, opts.displayName ?? opts.username, opts.password ? hashPassword(opts.password) : null, opts.kind ?? "local", Date.now());
    return findUserById(id);
}
/**
 * Vincula la cuenta de esta instancia con la identidad secreta que guarda la
 * aplicación. Quien ya está autenticado puede crear o rotar su propio vínculo;
 * un mismo identificador nunca puede saltar a otra cuenta.
 */
export function linkPortableIdentity(userId, identityId, secret) {
    const existing = db
        .prepare("SELECT user_id FROM portable_identities WHERE identity_id = ?")
        .get(identityId);
    if (existing && existing.user_id !== userId)
        throw new Error("PORTABLE_IDENTITY_CONFLICT");
    db.prepare("DELETE FROM portable_identities WHERE user_id = ? AND identity_id <> ?").run(userId, identityId);
    db.prepare(`INSERT INTO portable_identities (identity_id, user_id, secret_hash, created_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET secret_hash = excluded.secret_hash`).run(identityId, userId, hashPassword(secret), Date.now());
}
/** La identidad existe solo si también demuestra conocer su secreto. */
export function portableUser(identityId, secret) {
    const row = db
        .prepare(`SELECT p.secret_hash, u.*
         FROM portable_identities p JOIN users u ON u.id = p.user_id
        WHERE p.identity_id = ?`)
        .get(identityId);
    if (!row || !verifyPassword(secret, row.secret_hash))
        return null;
    return row;
}
export function hasPortableIdentity(identityId) {
    return Boolean(db.prepare("SELECT 1 FROM portable_identities WHERE identity_id = ?").get(identityId));
}
/**
 * Invitado (§7.1): usuario real en la base pero sin contraseña, con nombre
 * único generado. Se puede convertir en cuenta local más adelante sin perder
 * mensajes ni membresías, porque el id no cambia.
 */
export function createGuest(displayName) {
    const base = displayName.trim().slice(0, 24) || "invitado";
    let username = `${base}-${randomBytes(2).toString("hex")}`;
    while (findUserByUsername(username))
        username = `${base}-${randomBytes(3).toString("hex")}`;
    return createUser({ username, displayName: base, kind: "guest" });
}
