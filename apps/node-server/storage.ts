/**
 * Adjuntos en disco local (§16.4, §28.4).
 * El nombre que sube el usuario nunca toca el sistema de ficheros: se guarda en
 * la base y en disco vive un UUID, lo que cierra path traversal por construcción.
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uuidv7 } from "@distop/protocol";
import type { Attachment } from "@distop/protocol";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { HttpError, badRequest, notFound, rateLimit, type Ctx, HANDLED } from "./http.ts";

const ROOT = resolve(config.storagePath);
mkdirSync(ROOT, { recursive: true });

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/i;

/** Rechaza el caso común de renombrar cualquier byte como audio. La decodificación
    definitiva sigue correspondiendo al navegador, pero un MIME inventado no llega
    a convertirse en un botón roto para toda la comunidad. */
export function hasAudioSignature(contentType: string, data: Uint8Array): boolean {
  if (contentType === "audio/mpeg") {
    const id3 = data.length >= 3 && data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33;
    const frame = data.length >= 2 && data[0] === 0xff && (data[1]! & 0xe0) === 0xe0;
    return id3 || frame;
  }
  if (contentType === "audio/ogg")
    return data.length >= 4 && data[0] === 0x4f && data[1] === 0x67 && data[2] === 0x67 && data[3] === 0x53;
  if (contentType === "audio/wav" || contentType === "audio/x-wav")
    return (
      data.length >= 12 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x41 && data[10] === 0x56 && data[11] === 0x45
    );
  return true;
}

/** Nombre en disco compartido por las dos rutas de guardado: UUID + extensión
    saneada dentro de un cajón por mes, para que un directorio no acumule
    decenas de miles de entradas con los años. */
function nuevaRutaEnDisco(filename: string): { id: string; relative: string; full: string } {
  const id = uuidv7();
  const ext = extname(filename).toLowerCase();
  const bucket = new Date().toISOString().slice(0, 7); // AAAA-MM
  mkdirSync(join(ROOT, bucket), { recursive: true });
  const relative = join(bucket, `${id}${SAFE_EXT.test(ext) ? ext : ".bin"}`);
  return { id, relative, full: join(ROOT, relative) };
}

/** La fila y la forma que ve el cliente, idénticas venga el archivo de un
    Buffer o de un stream: si divergen, un adjunto se guarda y luego no se ve. */
function insertarAdjunto(opts: {
  id: string;
  ownerId: string;
  filename: string;
  contentType: string;
  size: number;
  relative: string;
}): Attachment {
  const name = sanitizeName(opts.filename);
  db.prepare(
    `INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.ownerId, name, opts.contentType, opts.size, opts.relative, Date.now());

  return {
    id: opts.id,
    message_id: null,
    filename: name,
    content_type: opts.contentType,
    size: opts.size,
    url: `/api/v1/files/${opts.id}`,
  };
}

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
  if (opts.contentType.startsWith("audio/") && !hasAudioSignature(opts.contentType, opts.data)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "El contenido no coincide con el formato de audio indicado.");
  }

  const { id, relative, full } = nuevaRutaEnDisco(opts.filename);
  writeFileSync(full, opts.data);
  return insertarAdjunto({
    id,
    ownerId: opts.ownerId,
    filename: opts.filename,
    contentType: opts.contentType,
    size: opts.data.length,
    relative,
  });
}

/* La firma más larga que mira hasAudioSignature es la de WAV: 12 bytes. Con
   retener eso de cada subida de audio ya se puede validar sin tener el cuerpo. */
const FIRMA_BYTES = 12;

/**
 * La subida de archivos (§28.3), del socket directo a disco: bufferizar el
 * cuerpo entero en RAM (http.ts:readBody) significaba que un vídeo al límite
 * de MAX_UPLOAD_SIZE_MB era un pico de cientos de MB en el proceso — letal en
 * el escritorio, donde la instancia vive en un utilityProcess, y en una
 * Raspberry Pi con varias subidas a la vez.
 *
 * El cuerpo fluye a un temporal JUNTO al destino final (mismo volumen), así el
 * rename de cierre es atómico y nunca queda visible un archivo a medias. El
 * límite se aplica contando bytes al vuelo: superarlo destruye el stream,
 * borra el temporal y responde el mismo 413 de siempre — el cap no se relaja,
 * es un invariante de seguridad (§22).
 */
export async function saveUploadStream(opts: {
  ownerId: string;
  filename: string;
  contentType: string;
  body: Readable;
  limit: number;
}): Promise<Attachment> {
  // Antes de tocar el disco: un tipo prohibido no debe costar ni un byte escrito.
  if (!config.allowedUploadTypes.includes(opts.contentType)) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", `Tipo de archivo no permitido: ${opts.contentType}.`, {
      allowed: config.allowedUploadTypes,
    });
  }

  const { id, relative, full } = nuevaRutaEnDisco(opts.filename);
  const temporal = `${full}.part`;

  const esAudio = opts.contentType.startsWith("audio/");
  const cabecera: Buffer[] = [];
  let cabeceraBytes = 0;
  let firmaComprobada = false;
  const firmaValida = (): boolean => hasAudioSignature(opts.contentType, Buffer.concat(cabecera, cabeceraBytes));

  let total = 0;
  const contador = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > opts.limit) {
        // Mismo error que readBody: para el cliente nada cambia, solo deja de costar RAM.
        done(new HttpError(413, "PAYLOAD_TOO_LARGE", `El cuerpo supera ${opts.limit} bytes.`));
        return;
      }
      if (esAudio && !firmaComprobada) {
        if (cabeceraBytes < FIRMA_BYTES) {
          const trozo = chunk.subarray(0, FIRMA_BYTES - cabeceraBytes);
          cabecera.push(trozo);
          cabeceraBytes += trozo.length;
        }
        // En cuanto hay cabecera completa se decide: abortar aquí evita escribir
        // cientos de MB de un fichero renombrado que igual iba a rechazarse.
        if (cabeceraBytes >= FIRMA_BYTES) {
          firmaComprobada = true;
          if (!firmaValida()) {
            done(new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "El contenido no coincide con el formato de audio indicado."));
            return;
          }
        }
      }
      done(null, chunk);
    },
  });

  try {
    // pipeline y no .pipe: propaga errores en ambos sentidos, respeta backpressure
    // y destruye el resto de la cadena si el cliente corta a mitad de subida.
    await pipeline(opts.body, contador, createWriteStream(temporal, { flags: "wx" }));
    if (total === 0) throw badRequest("El archivo está vacío.");
    // Audio más corto que la firma completa: se juzga con lo que llegó, como antes.
    if (esAudio && !firmaComprobada && !firmaValida())
      throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "El contenido no coincide con el formato de audio indicado.");
    renameSync(temporal, full);
  } catch (err) {
    // Cliente que aborta, límite superado o firma falsa: el temporal no sobrevive.
    // El borrado nunca pisa al error original, que es lo que hay que contar.
    await rm(temporal, { force: true }).catch(() => {});
    throw err;
  }

  return insertarAdjunto({
    id,
    ownerId: opts.ownerId,
    filename: opts.filename,
    contentType: opts.contentType,
    size: total,
    relative,
  });
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

/** Borra una pieza de almacenamiento y su fila. Las referencias con ON DELETE
    CASCADE desaparecen en la misma operación; el fichero nunca queda huérfano. */
export function deleteStoredAttachment(id: string): void {
  const row = db.prepare("SELECT path FROM attachments WHERE id = ?").get(id) as { path: string } | undefined;
  if (!row) return;
  if (row.path) {
    const full = resolve(ROOT, row.path);
    if (full.startsWith(ROOT) && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE id = ?").run(id);
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

/**
 * Vaciar el chat de la instancia entera (§28.4): los ficheros de los mensajes
 * —fotos, GIF, adjuntos— fuera del disco, y sus filas con ellos.
 *
 * SOLO lo que cuelga de un mensaje (`message_id IS NOT NULL`). Lo demás se
 * queda a propósito: emojis y sonidos de la comunidad, avatares, banners y
 * fondos también son adjuntos, pero con message_id NULL — son personalización,
 * no historial, y borrarlos rompería perfiles enteros (ver el aviso en db.ts).
 */
export function purgeChatFiles(): { files: number; mb: number } {
  const rows = db.prepare("SELECT id, path, size FROM attachments WHERE message_id IS NOT NULL").all() as {
    id: string;
    path: string;
    size: number;
  }[];
  let bytes = 0;
  for (const row of rows) {
    // Reenviado (§22): sin fichero propio, path queda vacío y no hay nada que borrar.
    if (!row.path) continue;
    const full = resolve(ROOT, row.path);
    if (full.startsWith(ROOT) && existsSync(full)) {
      unlinkSync(full);
      bytes += row.size;
    }
  }
  db.prepare("DELETE FROM attachments WHERE message_id IS NOT NULL").run();
  return { files: rows.length, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

/** Lo que queda libre en el disco donde viven los archivos, en MB. */
export function storageFreeMb(): number {
  try {
    const stats = statfsSync(ROOT);
    return Math.round((stats.bavail * stats.bsize) / 1024 / 1024);
  } catch {
    // Sistema de ficheros que no sabe contestar: mejor 0 que inventar un número.
    return 0;
  }
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
