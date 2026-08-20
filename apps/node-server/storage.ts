/**
 * Adjuntos en disco local (§16.4, §28.4).
 * El nombre que sube el usuario nunca toca el sistema de ficheros: se guarda en
 * la base y en disco vive un UUID, lo que cierra path traversal por construcción.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { uuidv7 } from "@distop/protocol";
import type { Attachment } from "@distop/protocol";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { HttpError, notFound, rateLimit, type Ctx, HANDLED } from "./http.ts";

const ROOT = resolve(config.storagePath);
mkdirSync(ROOT, { recursive: true });

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

export function saveUpload(opts: {
  ownerId: string;
  filename: string;
  contentType: string;
  data: Buffer;
}): Attachment {
  if (!config.allowedUploadTypes.includes(opts.contentType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `Tipo de archivo no permitido: ${opts.contentType}.`, {
      allowed: config.allowedUploadTypes,
    });
  }

  const id = uuidv7();
  const ext = extname(opts.filename).toLowerCase();
  const bucket = new Date().toISOString().slice(0, 7); // AAAA-MM
  mkdirSync(join(ROOT, bucket), { recursive: true });

  const relative = join(bucket, `${id}${SAFE_EXT.test(ext) ? ext : ".bin"}`);
  writeFileSync(join(ROOT, relative), opts.data);

  db.prepare(
    `INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.ownerId, sanitizeName(opts.filename), opts.contentType, opts.data.length, relative, Date.now());

  return {
    id,
    message_id: null,
    filename: sanitizeName(opts.filename),
    content_type: opts.contentType,
    size: opts.data.length,
    url: `/api/v1/files/${id}`,
  };
}

/**
 * Un GIF o sticker de la galería (§12, §22): nada en disco, solo la URL de
 * origen. Se sirve por el mismo /api/v1/files/:id de siempre, que en este caso
 * lo reenvía en cada vista en vez de leerlo de un fichero — así Giphy nunca ve
 * la IP de quien lee el mensaje, solo la del servidor, y el disco del
 * anfitrión no crece por cada sticker que alguien mande.
 *
 * A cambio, si Giphy borra ese contenido el mensaje queda roto para siempre:
 * lo contrario de un archivo subido a mano, que sigue existiendo pase lo que
 * pase con el tercero. Es la otra cara de no guardarlo (§29.3).
 */
export function saveRemoteAttachment(opts: {
  ownerId: string;
  filename: string;
  contentType: string;
  size: number;
  sourceUrl: string;
}): Attachment {
  if (!config.allowedUploadTypes.includes(opts.contentType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `Tipo de archivo no permitido: ${opts.contentType}.`, {
      allowed: config.allowedUploadTypes,
    });
  }

  const id = uuidv7();
  db.prepare(
    `INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, source_url, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, '', ?, ?)`,
  ).run(id, opts.ownerId, sanitizeName(opts.filename), opts.contentType, opts.size, opts.sourceUrl, Date.now());

  return {
    id,
    message_id: null,
    filename: sanitizeName(opts.filename),
    content_type: opts.contentType,
    size: opts.size,
    url: `/api/v1/files/${id}`,
  };
}

/** Solo para mostrar y descargar: sin barras, sin caracteres de control. */
function sanitizeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._ -]+/gu, "_").trim().slice(0, 200) || "archivo";
}

export function attachmentsFor(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT id, message_id, filename, content_type, size FROM attachments
       WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .all(...messageIds) as { id: string; message_id: string; filename: string; content_type: string; size: number }[];

  for (const row of rows) {
    const list = out.get(row.message_id) ?? [];
    list.push({
      id: row.id,
      message_id: row.message_id,
      filename: row.filename,
      content_type: row.content_type,
      size: row.size,
      url: `/api/v1/files/${row.id}`,
    });
    out.set(row.message_id, list);
  }
  return out;
}

export function linkAttachments(messageId: string, ids: string[], ownerId: string): void {
  if (ids.length === 0) return;
  const claim = db.prepare(
    "UPDATE attachments SET message_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL",
  );
  for (const id of ids) claim.run(messageId, id, ownerId);
}

/**
 * Los unicos CDN de los que esta instancia reenvia algo.
 *
 * Exportada porque /api/v1/gifs/save valida contra esta MISMA lista: tenerla
 * duplicada era pedir que un dia una aceptara un dominio que la otra rechaza, y
 * entonces el adjunto se guarda y despues no se puede ver. Sin lista esto seria
 * un SSRF de manual (§22).
 */
export const CDN_REENVIABLE = /^(media[0-9]?\.giphy\.com|i\.giphy\.com|static[0-9]?\.klipy\.com)$/;

export async function serveFile(ctx: Ctx, id: string): Promise<typeof HANDLED> {
  const row = db
    .prepare("SELECT filename, content_type, size, path, source_url FROM attachments WHERE id = ?")
    .get(id) as
    | { filename: string; content_type: string; size: number; path: string; source_url: string | null }
    | undefined;
  if (!row) throw notFound("Archivo no encontrado.");

  if (row.source_url) {
    /* Sin sesión, igual que /avatars/image: un <img src> no manda Authorization,
       así que el límite que protege el ancho de banda del anfitrión es por IP. */
    rateLimit(`file:${ctx.ip}`, 120, 60_000);

    let origen: URL;
    try {
      origen = new URL(row.source_url);
    } catch {
      throw notFound("Archivo no encontrado.");
    }
    if (origen.protocol !== "https:" || !CDN_REENVIABLE.test(origen.hostname)) throw notFound("Archivo no encontrado.");

    const res = await fetch(origen, { signal: AbortSignal.timeout(8000) }).catch(() => null);
    if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "El archivo no se pudo traer.");

    ctx.res.writeHead(200, {
      "content-type": row.content_type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    });
    ctx.res.end(Buffer.from(await res.arrayBuffer()));
    return HANDLED;
  }

  const full = resolve(ROOT, row.path);
  if (!full.startsWith(ROOT) || !existsSync(full)) throw notFound("Archivo no encontrado.");

  // inline solo para tipos que el navegador no puede usar para ejecutar script.
  const inline = row.content_type.startsWith("image/") && row.content_type !== "image/svg+xml";

  ctx.res.writeHead(200, {
    "content-type": row.content_type,
    "content-length": String(row.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    "cache-control": "private, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  createReadStream(full).pipe(ctx.res);
  return HANDLED;
}

export function deleteAttachmentsOf(messageId: string): void {
  const rows = db.prepare("SELECT id, path FROM attachments WHERE message_id = ?").all(messageId) as {
    id: string;
    path: string;
  }[];
  for (const row of rows) {
    // Reenviado (§22): sin fichero propio, path queda vacío y no hay nada que borrar.
    if (!row.path) continue;
    const full = resolve(ROOT, row.path);
    if (full.startsWith(ROOT) && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
}

/**
 * Todo lo que subió una persona, borrado del disco además de la base.
 * Sin esto, "eliminar mi cuenta" dejaría sus fotos en el disco del anfitrión: la
 * fila desaparece y el fichero se queda, servido por su URL para quien la tenga.
 */
export function deleteAttachmentsOwnedBy(userId: string): void {
  const rows = db.prepare("SELECT id, path FROM attachments WHERE owner_id = ?").all(userId) as {
    id: string;
    path: string;
  }[];
  for (const row of rows) {
    if (!row.path) continue;
    const full = resolve(ROOT, row.path);
    if (full.startsWith(ROOT) && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE owner_id = ?").run(userId);
}

export function storageUsedMb(): number {
  let bytes = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else bytes += statSync(full).size;
    }
  };
  try {
    walk(ROOT);
  } catch {
    return 0;
  }
  return Math.round((bytes / 1024 / 1024) * 10) / 10;
}
