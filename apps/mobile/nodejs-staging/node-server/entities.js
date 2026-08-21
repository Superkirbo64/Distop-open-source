import { db } from "./db.js";
import { toPublicUser } from "./auth.js";
import { attachmentsFor } from "./storage.js";
export function toCommunity(row) {
    return { ...row, is_public: row.is_public === 1 };
}
export function getCommunity(id) {
    const row = db.prepare("SELECT * FROM communities WHERE id = ?").get(id);
    return row ? toCommunity(row) : null;
}
export function communitiesForUser(userId) {
    const rows = db
        .prepare(`SELECT c.* FROM communities c
       JOIN members m ON m.community_id = c.id
       WHERE m.user_id = ? AND m.banned = 0
       ORDER BY m.joined_at ASC`)
        .all(userId);
    return rows.map(toCommunity);
}
export function toChannel(row) {
    return { ...row, kind: row.kind };
}
export function getChannel(id) {
    const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(id);
    return row ? toChannel(row) : null;
}
export function channelsOf(communityId) {
    const rows = db
        .prepare("SELECT * FROM channels WHERE community_id = ? ORDER BY position ASC, id ASC")
        .all(communityId);
    return rows.map(toChannel);
}
export function categoriesOf(communityId) {
    return db
        .prepare("SELECT id, community_id, name, position FROM categories WHERE community_id = ? ORDER BY position ASC")
        .all(communityId);
}
export function toRole(row) {
    return { ...row, hoist: row.hoist === 1, mentionable: row.mentionable === 1, is_default: row.is_default === 1 };
}
export function getRole(id) {
    const row = db.prepare("SELECT * FROM roles WHERE id = ?").get(id);
    return row ? toRole(row) : null;
}
export function rolesOf(communityId) {
    const rows = db
        .prepare("SELECT * FROM roles WHERE community_id = ? ORDER BY position DESC, id ASC")
        .all(communityId);
    return rows.map(toRole);
}
export function getMember(communityId, userId) {
    const row = db
        .prepare(`SELECT m.nickname, m.joined_at, m.timeout_until, m.banned, u.*
       FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.user_id = ?`)
        .get(communityId, userId);
    if (!row)
        return null;
    const roleIds = db.prepare("SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ?").all(communityId, userId).map((r) => r.role_id);
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
export function membersOf(communityId, includeBanned = false) {
    const rows = db
        .prepare(`SELECT m.user_id FROM members m
       WHERE m.community_id = ? ${includeBanned ? "" : "AND m.banned = 0"}
       ORDER BY m.joined_at ASC`)
        .all(communityId);
    return rows.map((r) => getMember(communityId, r.user_id)).filter((m) => m !== null);
}
function reactionsFor(messageIds) {
    const out = new Map();
    if (messageIds.length === 0)
        return out;
    const rows = db
        .prepare(`SELECT message_id, emoji, user_id FROM reactions
       WHERE message_id IN (${messageIds.map(() => "?").join(",")})`)
        .all(...messageIds);
    for (const row of rows) {
        const list = out.get(row.message_id) ?? [];
        const existing = list.find((r) => r.emoji === row.emoji);
        if (existing) {
            existing.count++;
            existing.user_ids.push(row.user_id);
        }
        else {
            list.push({ emoji: row.emoji, count: 1, user_ids: [row.user_id] });
        }
        out.set(row.message_id, list);
    }
    return out;
}
function hydrate(rows) {
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
export function getMessage(id) {
    const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    return row ? hydrate([row])[0] : null;
}
/** Paginación por id (UUIDv7 ya ordena por tiempo), no por offset. */
export function messagesOf(channelId, opts) {
    const rows = opts.before
        ? db
            .prepare("SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
            .all(channelId, opts.before, opts.limit)
        : db
            .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?")
            .all(channelId, opts.limit);
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
export function unreadOf(userId, communityId, visibleChannelIds) {
    const out = {};
    if (visibleChannelIds.length === 0)
        return out;
    const rows = db
        .prepare(`SELECT m.channel_id,
              COUNT(*) AS count,
              SUM(CASE WHEN m.mentions_everyone = 1 OR m.content LIKE ? THEN 1 ELSE 0 END) AS mentions
       FROM messages m
       WHERE m.community_id = ?
         AND m.author_id != ?
         AND m.id > COALESCE(
           (SELECT r.last_read_id FROM read_state r WHERE r.user_id = ? AND r.channel_id = m.channel_id), '')
       GROUP BY m.channel_id`)
        .all(`%<@${userId}>%`, communityId, userId, userId);
    const visible = new Set(visibleChannelIds);
    for (const row of rows) {
        if (!visible.has(row.channel_id))
            continue;
        out[row.channel_id] = { count: row.count, mentions: row.mentions };
    }
    return out;
}
export function lastReadId(userId, channelId) {
    const row = db
        .prepare("SELECT last_read_id FROM read_state WHERE user_id = ? AND channel_id = ?")
        .get(userId, channelId);
    return row?.last_read_id ?? null;
}
