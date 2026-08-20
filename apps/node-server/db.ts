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

  /* Estado de lectura y menciones.
     `last_read_id` es un id de mensaje, no una fecha: los UUIDv7 ya ordenan por
     tiempo, así que "lo que no he leído" es una comparación de texto contra el
     índice que ya existe, sin columna de fecha ni reloj de por medio. */
  `
  CREATE TABLE read_state (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );

  ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0;
  `,

  /* Estado de presencia elegido a mano. Va en users y no en una tabla aparte
     porque acompaña a la persona entre dispositivos, igual que el idioma. */
  `
  ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
  ALTER TABLE users ADD COLUMN custom_status TEXT;
  `,

  /* Emojis y stickers propios de cada comunidad (§10.3).
     El archivo se reutiliza de `attachments` con message_id NULL, así que se
     sirve por /api/v1/files/:id como cualquier otro y no hay un segundo camino
     que proteger. OJO: cuando exista la limpieza de adjuntos huérfanos tendrá
     que respetar los que estén referenciados aquí. */
  `
  CREATE TABLE emojis (
    id            TEXT PRIMARY KEY,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'emoji',
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    creator_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_emojis_name ON emojis(community_id, kind, name);
  CREATE INDEX idx_emojis_community ON emojis(community_id);
  `,

  /* Un GIF o sticker elegido de la galería ya no se descarga (§22): se reenvía
     desde la instancia cada vez que alguien lo ve, como la galería de avatares,
     para no ocupar disco del anfitrión con algo que Giphy ya aloja. `path` se
     deja vacío en ese caso — no se puede quitarle NOT NULL a una columna ya
     creada sin reconstruir la tabla, así que source_url es la que manda. */
  `
  ALTER TABLE attachments ADD COLUMN source_url TEXT;
  `,

  /* Personalización del perfil (§10.1): marco del avatar, placa del nombre,
     fuente, efectos y tema de la tarjeta.

     Una columna JSON y no ocho columnas: son ocho ajustes del MISMO adorno, se
     leen y se escriben siempre juntos, y añadir el noveno no debería costar una
     migración. Lo que impide que aquí entre basura no es el tipo de la columna
     sino toProfileStyle() del protocolo, que corre al guardar y al leer. */
  `
  ALTER TABLE users ADD COLUMN profile_style TEXT NOT NULL DEFAULT '{}';
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
