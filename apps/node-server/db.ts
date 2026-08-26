/**
 * Esquema y acceso a datos de la instancia (§16.4).
 * SQLite por defecto — cero servicios que instalar; el fichero es el backup.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, seedUuidClock, uuidv7, uuidv7Time } from "@distop/protocol";
import { config } from "./config.ts";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");


const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
/* Una base más nueva que el programa no se abre y ya está: las migraciones solo
   van hacia delante, así que seguir aquí significaría servir un esquema que
   este código no conoce, escribiendo en columnas que quizá cambiaron de
   significado. Mejor no arrancar y decir por qué (§28.6). */
if (current > SCHEMA_VERSION) {
  throw new Error(
    `DATABASE_TOO_NEW: la base usa el esquema ${current} y esta versión de Distop entiende hasta el ${SCHEMA_VERSION}. Actualiza Distop.`,
  );
}
for (let i = current; i < MIGRATIONS.length; i++) {
  db.exec(MIGRATIONS[i]!);
  db.exec(`PRAGMA user_version = ${i + 1}`);
}

/* Sembrar el reloj antes de crear INSTANCE_ID o cualquier otra fila. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_TABLES = [
  "users", "sessions", "communities", "categories", "channels", "roles",
  "messages", "attachments", "audit_log", "emojis", "game_sessions",
] as const;

let persistedUuidMs = 0;
for (const table of ID_TABLES) {
  const row = db.prepare(`SELECT id FROM ${table} ORDER BY id DESC LIMIT 1`).get() as { id: string } | undefined;
  if (row && UUID_V7.test(row.id)) persistedUuidMs = Math.max(persistedUuidMs, uuidv7Time(row.id));
}
const storedInstanceId = db.prepare("SELECT value FROM meta WHERE key = 'instance_id'").get() as
  | { value: string }
  | undefined;
if (storedInstanceId && UUID_V7.test(storedInstanceId.value)) {
  persistedUuidMs = Math.max(persistedUuidMs, uuidv7Time(storedInstanceId.value));
}
seedUuidClock(persistedUuidMs);

/* ── meta ─────────────────────────────────────────────────────────────── */

export function meta(key: string, fallback: () => string): string {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  if (row) return row.value;
  const value = fallback();
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, value);
  return value;
}

export function setMeta(key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

export const INSTANCE_ID = meta("instance_id", uuidv7);

let databaseClosed = false;

/** Deja app.db autocontenido y sin WAL pendiente. Es idempotente. */
export function closeDatabase(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/* ── helpers de escritura comunes ─────────────────────────────────────── */

export function audit(
  communityId: string,
  actorId: string,
  action: string,
  targetId: string | null,
  details: Record<string, unknown> = {},
): void {
  db.prepare(
    "INSERT INTO audit_log (id, community_id, actor_id, action, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(uuidv7(), communityId, actorId, action, targetId, JSON.stringify(details), Date.now());
}

/**
 * Deja al día todos los canales de una comunidad para alguien.
 * Se llama al entrar: quien acaba de llegar no tiene mil mensajes "sin leer" de
 * conversaciones que no vivió. Lo que no ha pasado todavía sí se le avisará.
 */
export function markCommunityRead(userId: string, communityId: string): void {
  const now = Date.now();
  const rows = db
    .prepare(
      `SELECT c.id AS channel_id, (SELECT m.id FROM messages m WHERE m.channel_id = c.id ORDER BY m.id DESC LIMIT 1) AS last
       FROM channels c WHERE c.community_id = ?`,
    )
    .all(communityId) as { channel_id: string; last: string | null }[];

  const upsert = db.prepare(
    `INSERT INTO read_state (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
  );
  for (const row of rows) if (row.last) upsert.run(userId, row.channel_id, row.last, now);
}

/** Crea comunidad + rol @everyone + categoría y canales de arranque. */
export function seedCommunity(opts: {
  name: string;
  slug: string;
  ownerId: string;
  isPublic: boolean;
  accentColor?: string | undefined;
}): string {
  const now = Date.now();
  const communityId = uuidv7();

  db.prepare(
    `INSERT INTO communities (id, name, slug, accent_color, is_public, owner_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(communityId, opts.name, opts.slug, opts.accentColor ?? "#5b7cfa", opts.isPublic ? 1 : 0, opts.ownerId, now);

  db.prepare(
    `INSERT INTO roles (id, community_id, name, permissions, position, is_default) VALUES (?, ?, ?, ?, ?, 1)`,
  ).run(uuidv7(), communityId, "@everyone", DEFAULT_MEMBER_PERMISSIONS.toString(), 0);

  const adminRoleId = uuidv7();
  db.prepare(
    `INSERT INTO roles (id, community_id, name, color, permissions, position, hoist) VALUES (?, ?, ?, ?, ?, ?, 1)`,
  ).run(adminRoleId, communityId, "Administración", "#f0a35e", ALL_PERMISSIONS.toString(), 100);

  const categoryId = uuidv7();
  db.prepare("INSERT INTO categories (id, community_id, name, position) VALUES (?, ?, ?, 0)").run(
    categoryId,
    communityId,
    "General",
  );

  const channels: Array<[string, string, string]> = [
    ["general", "text", "Canal principal de la comunidad"],
    ["anuncios", "announcement", "Novedades importantes"],
    ["voz", "voice", ""],
  ];
  channels.forEach(([name, kind, topic], i) => {
    db.prepare(
      `INSERT INTO channels (id, community_id, category_id, name, topic, kind, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(uuidv7(), communityId, categoryId, name, topic || null, kind, i, now);
  });

  db.prepare("INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)").run(
    communityId,
    opts.ownerId,
    now,
  );
  db.prepare("INSERT INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)").run(
    communityId,
    opts.ownerId,
    adminRoleId,
  );

  audit(communityId, opts.ownerId, "COMMUNITY_CREATE", communityId, { name: opts.name });
  return communityId;
}

/** Slug libre a partir de un nombre; añade sufijo si choca. */
export function uniqueSlug(name: string): string {
  const base =
    name
      .normalize("NFD")
      .replace(/\p{Mn}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "comunidad";

  const taken = db.prepare("SELECT 1 FROM communities WHERE slug = ?");
  let slug = base;
  for (let n = 2; taken.get(slug); n++) slug = `${base}-${n}`;
  return slug;
}
