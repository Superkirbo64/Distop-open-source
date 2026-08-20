/**
 * Lectura y serialización de entidades: la única traducción fila → protocolo.
 * Todo lo que sale hacia el cliente pasa por aquí, para que no haya dos formas
 * distintas del mismo objeto según la ruta que lo devuelva.
 */
import type { Category, Channel, Community, Member, Message, Reaction, Role, Unread } from "@distop/protocol";
import { db } from "./db.ts";
import { toPublicUser, type UserRow } from "./auth.ts";
import { attachmentsFor } from "./storage.ts";

interface CommunityRow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
  accent_color: string;
  theme: string;
  rules: string | null;
  is_public: number;
  owner_id: string;
  created_at: number;
}

export function toCommunity(row: CommunityRow): Community {
  return { ...row, is_public: row.is_public === 1 };
}

export function getCommunity(id: string): Community | null {
  const row = db.prepare("SELECT * FROM communities WHERE id = ?").get(id) as CommunityRow | undefined;
  return row ? toCommunity(row) : null;
}

export function communitiesForUser(userId: string): Community[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM communities c
       JOIN members m ON m.community_id = c.id
       WHERE m.user_id = ? AND m.banned = 0
       ORDER BY m.joined_at ASC`,
    )
    .all(userId) as CommunityRow[];
  return rows.map(toCommunity);
}

interface ChannelRow {
  id: string;
  community_id: string;
  category_id: string | null;
  name: string;
  topic: string | null;
  kind: string;
  position: number;
  slowmode_s: number;
  created_at: number;
}

export function toChannel(row: ChannelRow): Channel {
  return { ...row, kind: row.kind as Channel["kind"] };
}

export function getChannel(id: string): Channel | null {
  const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | undefined;
  return row ? toChannel(row) : null;
}

export function channelsOf(communityId: string): Channel[] {
  const rows = db
    .prepare("SELECT * FROM channels WHERE community_id = ? ORDER BY position ASC, id ASC")
    .all(communityId) as ChannelRow[];
  return rows.map(toChannel);
}

export function categoriesOf(communityId: string): Category[] {
  return db
    .prepare("SELECT id, community_id, name, position FROM categories WHERE community_id = ? ORDER BY position ASC")
    .all(communityId) as Category[];
}

interface RoleRow {
  id: string;
  community_id: string;
  name: string;
  color: string | null;
  permissions: string;
  position: number;
  hoist: number;
  mentionable: number;
  is_default: number;
}

export function toRole(row: RoleRow): Role {
  return { ...row, hoist: row.hoist === 1, mentionable: row.mentionable === 1, is_default: row.is_default === 1 };
}

export function getRole(id: string): Role | null {
  const row = db.prepare("SELECT * FROM roles WHERE id = ?").get(id) as RoleRow | undefined;
  return row ? toRole(row) : null;
}

export function rolesOf(communityId: string): Role[] {
  const rows = db
    .prepare("SELECT * FROM roles WHERE community_id = ? ORDER BY position DESC, id ASC")
    .all(communityId) as RoleRow[];
  return rows.map(toRole);
}

export function getMember(communityId: string, userId: string): Member | null {
  const row = db
    .prepare(
      `SELECT m.nickname, m.joined_at, m.timeout_until, m.banned, u.*
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.user_id = ?`,
    )
    .get(communityId, userId) as
    | (UserRow & { nickname: string | null; joined_at: number; timeout_until: number | null; banned: number })
    | undefined;
  if (!row) return null;

  const roleIds = (
    db.prepare("SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ?").all(communityId, userId) as {
      role_id: string;
    }[]
  ).map((r) => r.role_id);

  return {
    user: toPublicUser(row),
    community_id: communityId,
    nickname: row.nickname,
    role_ids: roleIds,
    joined_at: row.joined_at,
    timeout_until: row.timeout_until,
    banned: row.banned === 1,
  };
}

export function membersOf(communityId: string, includeBanned = false): Member[] {
  const rows = db
    .prepare(
      `SELECT m.user_id FROM members m
       WHERE m.community_id = ? ${includeBanned ? "" : "AND m.banned = 0"}
       ORDER BY m.joined_at ASC`,
    )
    .all(communityId) as { user_id: string }[];
  return rows.map((r) => getMember(communityId, r.user_id)).filter((m): m is Member => m !== null);
}

/* ── mensajes ──────────────────────────────────────────────────────── */

interface MessageRow {
  id: string;
  channel_id: string;
  community_id: string;
  author_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  reply_to_id: string | null;
  pinned: number;
  mentions_everyone: number;
}

function reactionsFor(messageIds: string[]): Map<string, Reaction[]> {
  const out = new Map<string, Reaction[]>();
  if (messageIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT message_id, emoji, user_id FROM reactions
       WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .all(...messageIds) as { message_id: string; emoji: string; user_id: string }[];

  for (const row of rows) {
    const list = out.get(row.message_id) ?? [];
    const existing = list.find((r) => r.emoji === row.emoji);
    if (existing) {
      existing.count++;
      existing.user_ids.push(row.user_id);
    } else {
      list.push({ emoji: row.emoji, count: 1, user_ids: [row.user_id] });
    }
    out.set(row.message_id, list);
  }
  return out;
}

function hydrate(rows: MessageRow[]): Message[] {
  const ids = rows.map((r) => r.id);
  const files = attachmentsFor(ids);
  const reactions = reactionsFor(ids);
  return rows.map((row) => ({
    ...row,
    pinned: row.pinned === 1,
    mentions_everyone: row.mentions_everyone === 1,
    attachments: files.get(row.id) ?? [],
    reactions: reactions.get(row.id) ?? [],
  }));
}

export function getMessage(id: string): Message | null {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id) as MessageRow | undefined;
  return row ? hydrate([row])[0]! : null;
}

/** Paginación por id (UUIDv7 ya ordena por tiempo), no por offset. */
export function messagesOf(channelId: string, opts: { before?: string | undefined; limit: number }): Message[] {
  const rows = opts.before
    ? (db
        .prepare("SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
        .all(channelId, opts.before, opts.limit) as MessageRow[])
    : (db
        .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?")
        .all(channelId, opts.limit) as MessageRow[]);

  return hydrate(rows.reverse());
}

/* ── estado de lectura (§9.2) ──────────────────────────────────────── */

/**
 * Qué le queda sin leer a alguien en cada canal de una comunidad.
 *
 * Una sola consulta para toda la comunidad, no una por canal: el número aparece
 * en la barra lateral y se recalcula al abrir, así que no puede costar N viajes
 * a la base. Los propios mensajes no cuentan —escribir algo no te deja algo
 * pendiente— y los canales que la persona no puede ver se descartan después,
 * porque el permiso se resuelve en TypeScript y no en SQL.
 */
export function unreadOf(userId: string, communityId: string, visibleChannelIds: string[]): Record<string, Unread> {
  const out: Record<string, Unread> = {};
  if (visibleChannelIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT m.channel_id,
              COUNT(*) AS count,
              SUM(CASE WHEN m.mentions_everyone = 1 OR m.content LIKE ? THEN 1 ELSE 0 END) AS mentions
       FROM messages m
       WHERE m.community_id = ?
         AND m.author_id != ?
         AND m.id > COALESCE(
           (SELECT r.last_read_id FROM read_state r WHERE r.user_id = ? AND r.channel_id = m.channel_id), '')
       GROUP BY m.channel_id`,
    )
    .all(`%<@${userId}>%`, communityId, userId, userId) as {
    channel_id: string;
    count: number;
    mentions: number;
  }[];

  const visible = new Set(visibleChannelIds);
  for (const row of rows) {
    if (!visible.has(row.channel_id)) continue;
    out[row.channel_id] = { count: row.count, mentions: row.mentions };
  }
  return out;
}

export function lastReadId(userId: string, channelId: string): string | null {
  const row = db
    .prepare("SELECT last_read_id FROM read_state WHERE user_id = ? AND channel_id = ?")
    .get(userId, channelId) as { last_read_id: string } | undefined;
  return row?.last_read_id ?? null;
}
