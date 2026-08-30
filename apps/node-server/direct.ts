/** Persistencia y serialización de conversaciones privadas de dos personas. */
import { uuidv7, type DirectConversation, type DirectMessage, type PublicUser, type SocialOverview } from "@distop/protocol";
import { db } from "./db.ts";
import { findUserById, toPublicUser, type UserRow } from "./auth.ts";
import { attachmentsForDirect, deleteDirectAttachmentsOf } from "./storage.ts";

interface ConversationRow {
  id: string;
  user_a_id: string;
  user_b_id: string;
  created_at: number;
  updated_at: number;
  requested_by: string | null;
  accepted_at: number | null;
}

interface FriendshipRow {
  user_a_id: string;
  user_b_id: string;
  requested_by: string;
  state: "pending" | "accepted";
  created_at: number;
  updated_at: number;
}

interface DirectMessageRow {
  id: string;
  conversation_id: string;
  author_id: string;
  content: string;
  created_at: number;
  edited_at: number | null;
  reply_to_id: string | null;
}

function hydrateMessages(rows: DirectMessageRow[]): DirectMessage[] {
  const files = attachmentsForDirect(rows.map((row) => row.id));
  return rows.map((row) => ({ ...row, attachments: files.get(row.id) ?? [] }));
}

export function getDirectMessage(id: string): DirectMessage | null {
  const row = db.prepare("SELECT * FROM direct_messages WHERE id = ?").get(id) as DirectMessageRow | undefined;
  return row ? hydrateMessages([row])[0]! : null;
}

export function directMessagesOf(
  conversationId: string,
  opts: { before?: string | undefined; limit: number },
): DirectMessage[] {
  const rows = opts.before
    ? (db
        .prepare("SELECT * FROM direct_messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?")
        .all(conversationId, opts.before, opts.limit) as DirectMessageRow[])
    : (db
        .prepare("SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
        .all(conversationId, opts.limit) as DirectMessageRow[]);
  return hydrateMessages(rows.reverse());
}

export function directParticipants(conversationId: string): [string, string] | null {
  const row = db.prepare("SELECT user_a_id, user_b_id FROM direct_conversations WHERE id = ?").get(conversationId) as
    | { user_a_id: string; user_b_id: string }
    | undefined;
  return row ? [row.user_a_id, row.user_b_id] : null;
}

export function canReadDirect(conversationId: string, userId: string): boolean {
  const participants = directParticipants(conversationId);
  return participants !== null && participants.includes(userId);
}

function conversationFromRow(row: ConversationRow, viewerId: string): DirectConversation | null {
  if (row.user_a_id !== viewerId && row.user_b_id !== viewerId) return null;
  const otherId = row.user_a_id === viewerId ? row.user_b_id : row.user_a_id;
  const other = findUserById(otherId);
  if (!other) return null;
  const lastRow = db
    .prepare("SELECT * FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
    .get(row.id) as DirectMessageRow | undefined;
  const unread = db
    .prepare(
      `SELECT COUNT(*) AS count FROM direct_messages
       WHERE conversation_id = ? AND author_id != ? AND id > COALESCE(
         (SELECT last_read_id FROM direct_read_state WHERE conversation_id = ? AND user_id = ?), ''
       )`,
    )
    .get(row.id, viewerId, row.id, viewerId) as { count: number };
  return {
    id: row.id,
    other_user: toPublicUser(other),
    created_at: row.created_at,
    updated_at: row.updated_at,
    last_message: lastRow ? hydrateMessages([lastRow])[0]! : null,
    unread_count: unread.count,
    request_state: row.accepted_at !== null
      ? "accepted"
      : row.requested_by === viewerId
        ? "outgoing"
        : "incoming",
  };
}

export function directConversationForUser(conversationId: string, userId: string): DirectConversation | null {
  const row = db.prepare("SELECT * FROM direct_conversations WHERE id = ?").get(conversationId) as
    | ConversationRow
    | undefined;
  return row ? conversationFromRow(row, userId) : null;
}

/** La lista son conversaciones, no contactos: solo aparece quien escribió o
    recibió algo. Abrir el hilo desde la lista de miembros crea la fila, pero
    hasta el primer mensaje no le sale a nadie —ni a quien lo abrió al recargar,
    ni a la otra persona, que no tiene por qué enterarse de un chat en blanco.

    ponytail: el criterio es "tiene mensajes ahora", no "los tuvo alguna vez":
    borrar el último mensaje, o purgar la instancia, también saca el hilo de la
    lista. Si eso molesta, una columna `started_at` en la conversación lo fija. */
export function directConversationsForUser(userId: string): DirectConversation[] {
  const rows = db
    .prepare(
      `SELECT * FROM direct_conversations
       WHERE (user_a_id = ? OR user_b_id = ?)
         AND EXISTS (SELECT 1 FROM direct_messages WHERE conversation_id = direct_conversations.id)
       ORDER BY updated_at DESC, id DESC`,
    )
    .all(userId, userId) as ConversationRow[];
  return rows.map((row) => conversationFromRow(row, userId)).filter((row): row is DirectConversation => row !== null);
}

/** Solo aparecen personas que comparten al menos una comunidad visible. */
export function directContactsFor(userId: string): PublicUser[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT u.* FROM users u
       JOIN members theirs ON theirs.user_id = u.id AND theirs.banned = 0
       JOIN members mine ON mine.community_id = theirs.community_id AND mine.banned = 0
       WHERE mine.user_id = ? AND u.id != ? AND u.kind != 'imported'
       ORDER BY u.display_name COLLATE NOCASE, u.username COLLATE NOCASE`,
    )
    .all(userId, userId) as UserRow[];
  return rows.map(toPublicUser);
}

function shareCommunity(userId: string, targetId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM members mine
         JOIN members theirs ON theirs.community_id = mine.community_id
         WHERE mine.user_id = ? AND theirs.user_id = ? AND mine.banned = 0 AND theirs.banned = 0
         LIMIT 1`,
      )
      .get(userId, targetId),
  );
}

function pair(userId: string, targetId: string): [string, string] {
  return [userId, targetId].sort() as [string, string];
}

function friendshipRow(userId: string, targetId: string): FriendshipRow | null {
  const [userA, userB] = pair(userId, targetId);
  return (db.prepare("SELECT * FROM friendships WHERE user_a_id = ? AND user_b_id = ?").get(userA, userB) as FriendshipRow | undefined) ?? null;
}

export function areFriends(userId: string, targetId: string): boolean {
  return friendshipRow(userId, targetId)?.state === "accepted";
}

export function socialOverviewFor(userId: string): SocialOverview {
  const rows = db
    .prepare("SELECT * FROM friendships WHERE user_a_id = ? OR user_b_id = ? ORDER BY updated_at DESC")
    .all(userId, userId) as FriendshipRow[];
  const friends: PublicUser[] = [];
  const incoming_friend_requests: SocialOverview["incoming_friend_requests"] = [];
  const outgoing_friend_requests: SocialOverview["outgoing_friend_requests"] = [];
  for (const row of rows) {
    const otherId = row.user_a_id === userId ? row.user_b_id : row.user_a_id;
    const other = findUserById(otherId);
    if (!other) continue;
    const publicUser = toPublicUser(other);
    if (row.state === "accepted") friends.push(publicUser);
    else if (row.requested_by === userId) outgoing_friend_requests.push({ user: publicUser, created_at: row.created_at });
    else incoming_friend_requests.push({ user: publicUser, created_at: row.created_at });
  }
  friends.sort((a, b) => a.display_name.localeCompare(b.display_name));
  return { friends, incoming_friend_requests, outgoing_friend_requests };
}

export function requestFriendship(userId: string, targetId: string): "created" | "exists" | "unavailable" {
  if (userId === targetId || !shareCommunity(userId, targetId)) return "unavailable";
  const target = findUserById(targetId);
  if (!target || target.kind === "imported") return "unavailable";
  const [userA, userB] = pair(userId, targetId);
  if (friendshipRow(userId, targetId)) return "exists";
  const now = Date.now();
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, requested_by, state, created_at, updated_at)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
  ).run(userA, userB, userId, now, now);
  return inserted.changes > 0 ? "created" : "exists";
}

export function acceptFriendship(userId: string, requesterId: string): boolean {
  const row = friendshipRow(userId, requesterId);
  if (!row || row.state !== "pending" || row.requested_by !== requesterId) return false;
  const now = Date.now();
  db.prepare("UPDATE friendships SET state = 'accepted', updated_at = ? WHERE user_a_id = ? AND user_b_id = ?")
    .run(now, row.user_a_id, row.user_b_id);
  /* Una amistad aceptada saca también el chat de la bandeja de solicitudes. */
  db.prepare(
    "UPDATE direct_conversations SET accepted_at = ? WHERE user_a_id = ? AND user_b_id = ? AND accepted_at IS NULL",
  ).run(now, row.user_a_id, row.user_b_id);
  return true;
}

export function removeFriendship(userId: string, targetId: string): boolean {
  const [userA, userB] = pair(userId, targetId);
  return db.prepare("DELETE FROM friendships WHERE user_a_id = ? AND user_b_id = ?").run(userA, userB).changes > 0;
}

export function ensureDirectConversation(userId: string, targetId: string): DirectConversation | null {
  if (userId === targetId) return null;
  const target = findUserById(targetId);
  if (!target || target.kind === "imported") return null;
  const [userA, userB] = pair(userId, targetId);
  let row = db
    .prepare("SELECT * FROM direct_conversations WHERE user_a_id = ? AND user_b_id = ?")
    .get(userA, userB) as ConversationRow | undefined;
  if (!row) {
    if (!shareCommunity(userId, targetId)) return null;
    const now = Date.now();
    const id = uuidv7();
    db.prepare(
      `INSERT OR IGNORE INTO direct_conversations
       (id, user_a_id, user_b_id, created_at, updated_at, requested_by, accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, userA, userB, now, now, userId, areFriends(userId, targetId) ? now : null);
    /* Dos pestañas pueden abrir a la misma persona a la vez. La restricción
       única decide cuál ganó y esta lectura devuelve siempre el hilo real. */
    row = db
      .prepare("SELECT * FROM direct_conversations WHERE user_a_id = ? AND user_b_id = ?")
      .get(userA, userB) as ConversationRow;
  }
  return conversationFromRow(row, userId);
}

export function canSendDirect(conversationId: string, userId: string): boolean {
  const row = db
    .prepare("SELECT user_a_id, user_b_id, requested_by, accepted_at FROM direct_conversations WHERE id = ?")
    .get(conversationId) as Pick<ConversationRow, "user_a_id" | "user_b_id" | "requested_by" | "accepted_at"> | undefined;
  if (!row || (row.user_a_id !== userId && row.user_b_id !== userId)) return false;
  return row.accepted_at !== null || row.requested_by === userId;
}

export function acceptDirectRequest(conversationId: string, userId: string): boolean {
  const row = db.prepare("SELECT * FROM direct_conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
  if (!row || row.accepted_at !== null || row.requested_by === userId) return false;
  if (row.user_a_id !== userId && row.user_b_id !== userId) return false;
  const now = Date.now();
  db.prepare("UPDATE direct_conversations SET accepted_at = ?, updated_at = ? WHERE id = ?").run(now, now, conversationId);
  return true;
}

export function removeDirectRequest(conversationId: string, userId: string): [string, string] | null {
  const row = db.prepare("SELECT * FROM direct_conversations WHERE id = ?").get(conversationId) as ConversationRow | undefined;
  if (!row || row.accepted_at !== null || (row.user_a_id !== userId && row.user_b_id !== userId)) return null;
  const messages = db.prepare("SELECT id FROM direct_messages WHERE conversation_id = ?").all(conversationId) as { id: string }[];
  for (const message of messages) deleteDirectAttachmentsOf(message.id);
  db.prepare("DELETE FROM direct_conversations WHERE id = ?").run(conversationId);
  return [row.user_a_id, row.user_b_id];
}

export function touchDirectConversation(conversationId: string, at = Date.now()): void {
  db.prepare("UPDATE direct_conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
}

export function refreshDirectConversationTimestamp(conversationId: string): void {
  const row = db
    .prepare("SELECT created_at FROM direct_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1")
    .get(conversationId) as { created_at: number } | undefined;
  const conversation = db.prepare("SELECT created_at FROM direct_conversations WHERE id = ?").get(conversationId) as
    | { created_at: number }
    | undefined;
  if (conversation) touchDirectConversation(conversationId, row?.created_at ?? conversation.created_at);
}
