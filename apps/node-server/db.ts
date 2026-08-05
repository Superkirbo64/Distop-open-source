/**
 * Esquema y acceso a datos de la instancia (§16.4).
 * SQLite por defecto — cero servicios que instalar; el fichero es el backup.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ALL_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, uuidv7 } from "@distop/protocol";
import { config } from "./config.ts";

mkdirSync(dirname(config.databasePath), { recursive: true });

export const db = new DatabaseSync(config.databasePath);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

/* Migraciones: cada entrada corre una vez, en orden, y sube user_version (§28.6). */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,
    kind          TEXT NOT NULL DEFAULT 'local',
    avatar_url    TEXT,
    banner_url    TEXT,
    bio           TEXT,
    pronouns      TEXT,
    accent_color  TEXT,
    locale        TEXT NOT NULL DEFAULT 'es',
    theme         TEXT NOT NULL DEFAULT 'system',
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE communities (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description  TEXT,
    icon_url     TEXT,
    banner_url   TEXT,
    accent_color TEXT NOT NULL DEFAULT '#5b7cfa',
    theme        TEXT NOT NULL DEFAULT 'system',
    rules        TEXT,
    is_public    INTEGER NOT NULL DEFAULT 0,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE categories (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_categories_community ON categories(community_id);

  CREATE TABLE channels (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    topic        TEXT,
    kind         TEXT NOT NULL DEFAULT 'text',
    position     INTEGER NOT NULL DEFAULT 0,
    slowmode_s   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_channels_community ON channels(community_id);

  CREATE TABLE roles (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT,
    permissions  TEXT NOT NULL DEFAULT '0',
    position     INTEGER NOT NULL DEFAULT 0,
    hoist        INTEGER NOT NULL DEFAULT 0,
    mentionable  INTEGER NOT NULL DEFAULT 1,
    is_default   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_roles_community ON roles(community_id);

  CREATE TABLE members (
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname      TEXT,
    joined_at     INTEGER NOT NULL,
    timeout_until INTEGER,
    banned        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE INDEX idx_members_user ON members(user_id);

  CREATE TABLE member_roles (
    community_id TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, user_id, role_id),
    FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE overwrites (
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL,
    target_type TEXT NOT NULL,
    allow       TEXT NOT NULL DEFAULT '0',
    deny        TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (channel_id, target_id)
  );

  CREATE TABLE messages (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    community_id TEXT NOT NULL,
    author_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    reply_to_id  TEXT,
    pinned       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id DESC);

  CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
    owner_id     TEXT NOT NULL,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    path         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments(message_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE invites (
    code         TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id   TEXT REFERENCES channels(id) ON DELETE SET NULL,
    creator_id   TEXT NOT NULL,
    uses         INTEGER NOT NULL DEFAULT 0,
    max_uses     INTEGER,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_invites_community ON invites(community_id);

  CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_id    TEXT,
    details      TEXT NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_community ON audit_log(community_id, id DESC);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
for (let i = current; i < MIGRATIONS.length; i++) {
  db.exec(MIGRATIONS[i]!);
  db.exec(`PRAGMA user_version = ${i + 1}`);
}

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
