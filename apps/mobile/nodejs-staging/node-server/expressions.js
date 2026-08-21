/**
 * Emojis y stickers propios de cada comunidad (§10.3).
 *
 * La regla del proyecto es que la personalización no se paga (§10), así que aquí
 * no hay un número máximo: el techo es el disco del anfitrión, que es un límite
 * físico y se puede mirar. Y a diferencia de las plataformas que cobran por
 * "usar tus emojis en otro servidor", aquí basta con ser miembro de la comunidad
 * de origen — no hay nada que desbloquear.
 */
import { EMOJI_KINDS, EMOJI_NAME, CUSTOM_EMOJI, uuidv7 } from "@distop/protocol";
import { db } from "./db.js";
import { badRequest, conflict } from "./http.js";
import { deleteStoredAttachment } from "./storage.js";
/** Cómo se llama cada tipo cuando hay que decírselo a alguien. */
const ETIQUETA = { emoji: "emoji", sticker: "sticker", sound: "sonido" };
/** Un efecto se decodifica entero en cada navegador; no debe heredar el límite de adjuntos grandes. */
export const MAX_SOUND_BYTES = 5 * 1024 * 1024;
const SOUND_CONTENT_TYPES = new Set(["audio/mpeg", "audio/ogg", "audio/wav", "audio/x-wav"]);
export function validateSoundIcon(opts) {
    const iconEmoji = opts.iconEmoji?.trim() || null;
    const iconAttachmentId = opts.iconAttachmentId || null;
    if (iconEmoji && iconAttachmentId)
        throw badRequest("Elige un emoji o una imagen para el sonido, no ambos.");
    if (iconEmoji) {
        const graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(iconEmoji)];
        const hasEmoji = /(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]\uFE0F?\u20E3)/u.test(iconEmoji);
        if (iconEmoji.length > 16 || graphemes.length !== 1 || !hasEmoji)
            throw badRequest("El icono del sonido debe ser un solo emoji.", { field: "icon_emoji" });
    }
    if (iconAttachmentId) {
        if (iconAttachmentId === opts.audioAttachmentId)
            throw badRequest("La imagen del sonido debe ser un archivo distinto del audio.");
        const icono = db
            .prepare("SELECT content_type, message_id FROM attachments WHERE id = ? AND owner_id = ?")
            .get(iconAttachmentId, opts.creatorId);
        if (!icono || icono.message_id !== null)
            throw badRequest("Sube primero la imagen del sonido.");
        if (!icono.content_type.startsWith("image/") || icono.content_type === "image/svg+xml")
            throw badRequest("El icono del sonido debe ser PNG, JPG, GIF o WEBP.");
    }
    return { iconEmoji, iconAttachmentId };
}
function toEmoji(row) {
    return {
        id: row.id,
        community_id: row.community_id,
        name: row.name,
        // La columna es TEXT: se contrasta con la lista en vez de confiar en ella.
        kind: EMOJI_KINDS.includes(row.kind) ? row.kind : "emoji",
        // El archivo se sirve por la ruta de siempre: un solo camino que proteger.
        url: `/api/v1/files/${row.attachment_id}`,
        icon_emoji: row.icon_emoji ?? null,
        icon_url: row.icon_attachment_id ? `/api/v1/files/${row.icon_attachment_id}` : null,
        creator_id: row.creator_id,
        created_at: row.created_at,
    };
}
export function emojisOf(communityId) {
    const rows = db
        .prepare("SELECT * FROM emojis WHERE community_id = ? ORDER BY kind ASC, name ASC")
        .all(communityId);
    return rows.map(toEmoji);
}
export function getEmoji(id) {
    const row = db.prepare("SELECT * FROM emojis WHERE id = ?").get(id);
    return row ? toEmoji(row) : null;
}
/** Todos los de las comunidades a las que pertenece alguien, para el selector. */
export function emojisAvailableTo(userId) {
    const rows = db
        .prepare(`SELECT e.* FROM emojis e
       JOIN members m ON m.community_id = e.community_id
       WHERE m.user_id = ? AND m.banned = 0
       ORDER BY e.community_id ASC, e.kind ASC, e.name ASC`)
        .all(userId);
    return rows.map(toEmoji);
}
export function createEmoji(opts) {
    if (!EMOJI_NAME.test(opts.name))
        throw badRequest("El nombre admite letras, números y guion bajo, entre 2 y 32 caracteres.", { field: "name" });
    const archivo = db
        .prepare("SELECT id, content_type, size, message_id FROM attachments WHERE id = ? AND owner_id = ?")
        .get(opts.attachmentId, opts.creatorId);
    // Sin esto se podría "adoptar" el adjunto de un mensaje ajeno como emoji.
    if (!archivo || archivo.message_id !== null)
        throw badRequest("Sube primero el archivo.");
    if (opts.kind === "sound") {
        if (!SOUND_CONTENT_TYPES.has(archivo.content_type))
            throw badRequest("Un sonido tiene que ser MP3, OGG o WAV.");
        if (archivo.size > MAX_SOUND_BYTES)
            throw badRequest("Un sonido puede ocupar como máximo 5 MB.");
    }
    else if (!archivo.content_type.startsWith("image/") || archivo.content_type === "image/svg+xml") {
        throw badRequest("Un emoji tiene que ser una imagen (SVG no: puede llevar script).");
    }
    if (opts.kind !== "sound" && (opts.iconEmoji || opts.iconAttachmentId))
        throw badRequest("Solo los sonidos pueden llevar un icono separado.");
    const { iconEmoji, iconAttachmentId } = opts.kind === "sound"
        ? validateSoundIcon({
            iconEmoji: opts.iconEmoji,
            iconAttachmentId: opts.iconAttachmentId,
            creatorId: opts.creatorId,
            audioAttachmentId: opts.attachmentId,
        })
        : { iconEmoji: null, iconAttachmentId: null };
    if (db.prepare("SELECT 1 FROM emojis WHERE community_id = ? AND kind = ? AND name = ?").get(opts.communityId, opts.kind, opts.name))
        throw conflict(`Ya hay un ${ETIQUETA[opts.kind]} con ese nombre en la comunidad.`);
    const id = uuidv7();
    db.prepare(`INSERT INTO emojis (id, community_id, name, kind, attachment_id, icon_emoji, icon_attachment_id, creator_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, opts.communityId, opts.name, opts.kind, opts.attachmentId, iconEmoji, iconAttachmentId, opts.creatorId, Date.now());
    return getEmoji(id);
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
export function unusableEmojis(content, userId) {
    const referencias = [...content.matchAll(CUSTOM_EMOJI)];
    if (referencias.length === 0)
        return [];
    const malos = [];
    const esMiembro = db.prepare("SELECT 1 FROM members WHERE community_id = ? AND user_id = ? AND banned = 0");
    for (const [, nombre, id] of referencias) {
        const emoji = db.prepare("SELECT community_id FROM emojis WHERE id = ?").get(id);
        if (!emoji || !esMiembro.get(emoji.community_id, userId))
            malos.push(nombre);
    }
    return [...new Set(malos)];
}
export function deleteEmoji(id) {
    const row = db.prepare("SELECT attachment_id, icon_attachment_id FROM emojis WHERE id = ?").get(id);
    if (!row)
        return;
    deleteStoredAttachment(row.attachment_id);
    if (row.icon_attachment_id)
        deleteStoredAttachment(row.icon_attachment_id);
}
/** Limpieza previa a borrar una comunidad: los adjuntos pueden pertenecer a
    cualquier administrador, así que no basta con limpiar los del dueño. */
export function deleteExpressionAttachmentsOfCommunity(communityId) {
    const rows = db.prepare("SELECT attachment_id, icon_attachment_id FROM emojis WHERE community_id = ?").all(communityId);
    for (const row of rows) {
        deleteStoredAttachment(row.attachment_id);
        if (row.icon_attachment_id)
            deleteStoredAttachment(row.icon_attachment_id);
    }
}
