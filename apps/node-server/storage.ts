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
import { HttpError, notFound, type Ctx, HANDLED } from "./http.ts";

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

export function serveFile(ctx: Ctx, id: string): typeof HANDLED {
  const row = db.prepare("SELECT filename, content_type, size, path FROM attachments WHERE id = ?").get(id) as
    | { filename: string; content_type: string; size: number; path: string }
    | undefined;
  if (!row) throw notFound("Archivo no encontrado.");

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
