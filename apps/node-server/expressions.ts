/**
 * Emojis y stickers propios de cada comunidad (§10.3).
 *
 * La regla del proyecto es que la personalización no se paga (§10), así que aquí
 * no hay un número máximo: el techo es el disco del anfitrión, que es un límite
 * físico y se puede mirar. Y a diferencia de las plataformas que cobran por
 * "usar tus emojis en otro servidor", aquí basta con ser miembro de la comunidad
 * de origen — no hay nada que desbloquear.
 */
import { EMOJI_NAME, CUSTOM_EMOJI, uuidv7 } from "@distop/protocol";
import type { CustomEmoji, EmojiKind, Snowflake } from "@distop/protocol";
import { db } from "./db.ts";
import { badRequest, conflict } from "./http.ts";

interface EmojiRow {
  id: string;
  community_id: string;
  name: string;
  kind: string;
  attachment_id: string;
  creator_id: string;
  created_at: number;
}

function toEmoji(row: EmojiRow): CustomEmoji {
  return {
    id: row.id,
    community_id: row.community_id,
    name: row.name,
    kind: row.kind === "sticker" ? "sticker" : "emoji",
    // El archivo se sirve por la ruta de siempre: un solo camino que proteger.
    url: `/api/v1/files/${row.attachment_id}`,
    creator_id: row.creator_id,
    created_at: row.created_at,
  };
}

export function emojisOf(communityId: Snowflake): CustomEmoji[] {
  const rows = db
    .prepare("SELECT * FROM emojis WHERE community_id = ? ORDER BY kind ASC, name ASC")
    .all(communityId) as EmojiRow[];
  return rows.map(toEmoji);
}

export function getEmoji(id: Snowflake): CustomEmoji | null {
  const row = db.prepare("SELECT * FROM emojis WHERE id = ?").get(id) as EmojiRow | undefined;
  return row ? toEmoji(row) : null;
}

/** Todos los de las comunidades a las que pertenece alguien, para el selector. */
export function emojisAvailableTo(userId: Snowflake): CustomEmoji[] {
  const rows = db
    .prepare(
      `SELECT e.* FROM emojis e
       JOIN members m ON m.community_id = e.community_id
       WHERE m.user_id = ? AND m.banned = 0
       ORDER BY e.community_id ASC, e.kind ASC, e.name ASC`,
    )
    .all(userId) as EmojiRow[];
  return rows.map(toEmoji);
}

export function createEmoji(opts: {
  communityId: Snowflake;
  name: string;
  kind: EmojiKind;
  attachmentId: Snowflake;
  creatorId: Snowflake;
}): CustomEmoji {
  if (!EMOJI_NAME.test(opts.name))
    throw badRequest("El nombre admite letras, números y guion bajo, entre 2 y 32 caracteres.", { field: "name" });

  const archivo = db
    .prepare("SELECT id, content_type, message_id FROM attachments WHERE id = ? AND owner_id = ?")
    .get(opts.attachmentId, opts.creatorId) as
    | { id: string; content_type: string; message_id: string | null }
    | undefined;

  // Sin esto se podría "adoptar" el adjunto de un mensaje ajeno como emoji.
  if (!archivo || archivo.message_id !== null) throw badRequest("Sube primero la imagen del emoji.");
  if (!archivo.content_type.startsWith("image/") || archivo.content_type === "image/svg+xml")
    throw badRequest("Un emoji tiene que ser una imagen (SVG no: puede llevar script).");

  if (db.prepare("SELECT 1 FROM emojis WHERE community_id = ? AND kind = ? AND name = ?").get(opts.communityId, opts.kind, opts.name))
    throw conflict(`Ya hay un ${opts.kind === "sticker" ? "sticker" : "emoji"} con ese nombre en la comunidad.`);

  const id = uuidv7();
  db.prepare(
    `INSERT INTO emojis (id, community_id, name, kind, attachment_id, creator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.communityId, opts.name, opts.kind, opts.attachmentId, opts.creatorId, Date.now());

  return getEmoji(id)!;
}

/**
 * Comprueba que quien escribe puede usar los emojis que ha puesto en el texto.
 *
 * La condición es ser miembro de la comunidad de la que salen, y ya está. Se
 * mira contra la base porque el id lo escribe el cliente, y un cliente lo
 * escribe cualquiera: sin esta comprobación se podría referenciar el emoji de
 * una comunidad privada a la que no perteneces y verlo servido igualmente.
 *
 * Devuelve los nombres que no pasan, para poder decir cuál falla y no un "no".
 */
export function unusableEmojis(content: string, userId: Snowflake): string[] {
  const referencias = [...content.matchAll(CUSTOM_EMOJI)];
  if (referencias.length === 0) return [];

  const malos: string[] = [];
  const esMiembro = db.prepare("SELECT 1 FROM members WHERE community_id = ? AND user_id = ? AND banned = 0");

  for (const [, nombre, id] of referencias) {
    const emoji = db.prepare("SELECT community_id FROM emojis WHERE id = ?").get(id!) as
      | { community_id: string }
      | undefined;
    if (!emoji || !esMiembro.get(emoji.community_id, userId)) malos.push(nombre!);
  }
  return [...new Set(malos)];
}

export function deleteEmoji(id: Snowflake): void {
  db.prepare("DELETE FROM emojis WHERE id = ?").run(id);
}
