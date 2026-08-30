/**
 * Adjuntos en disco local (§16.4, §28.4).
 * El nombre que sube el usuario nunca toca el sistema de ficheros: se guarda en
 * la base y en disco vive un UUID, lo que cierra path traversal por construcción.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { uuidv7 } from "@distop/protocol";
import type { Attachment } from "@distop/protocol";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { HttpError, badRequest, notFound, rateLimit, type Ctx, HANDLED } from "./http.ts";

export const ROOT = resolve(config.storagePath);
mkdirSync(ROOT, { recursive: true });

/**
 * El único sitio donde vive un archivo a medias.
 *
 * Antes el temporal se escribía junto a su destino, dentro del cajón del mes.
 * Funcionaba, pero un corte de luz a mitad de una subida dejaba un `.part`
 * mezclado con los archivos buenos, y limpiarlo al arrancar habría obligado a
 * recorrer todos los cajones decidiendo qué borrar entre ficheros reales. Con
 * un directorio propio la limpieza mira un solo sitio y no puede equivocarse de
 * fichero. Sigue dentro de ROOT, así que el rename de cierre no cruza volumen y
 * continúa siendo atómico.
 */
const INCOMING = join(ROOT, ".incoming");
mkdirSync(INCOMING, { recursive: true });

/**
 * Ruta absoluta de un `path` de la base, o `null` si se sale del almacén.
 *
 * `full.startsWith(ROOT)` a secas —lo que había en media docena de sitios— deja
 * pasar `/data/uploads-de-otro/x` cuando ROOT es `/data/uploads`: comparte
 * prefijo sin estar dentro. Con `path` generado por nosotros nunca llegó a
 * importar, pero en cuanto exista restauración el contenido de la base pasa a
 * venir de un fichero que alguien nos dio, y entonces sí (§22).
 */
export function insideStorage(relative: string): string | null {
  if (!relative) return null;
  const full = resolve(ROOT, relative);
  return full.startsWith(`${ROOT}${sep}`) ? full : null;
}

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
  contentHash: string;
}): Attachment {
  const name = sanitizeName(opts.filename);
  db.prepare(
    `INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, content_hash, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(opts.id, opts.ownerId, name, opts.contentType, opts.size, opts.relative, opts.contentHash, Date.now());

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
    contentHash: `sha256:${createHash("sha256").update(opts.data).digest("hex")}`,
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
 * El cuerpo fluye a un temporal en `.incoming` (mismo volumen que el destino),
 * así el rename de cierre es atómico y nunca queda visible un archivo a medias.
 * El límite se aplica contando bytes al vuelo: superarlo destruye el stream,
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
  const temporal = join(INCOMING, `${id}.part`);

  const esAudio = opts.contentType.startsWith("audio/");
  const cabecera: Buffer[] = [];
  let cabeceraBytes = 0;
  let firmaComprobada = false;
  const firmaValida = (): boolean => hasAudioSignature(opts.contentType, Buffer.concat(cabecera, cabeceraBytes));

  const hasher = createHash("sha256");
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
      hasher.update(chunk);
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
  const contentHash = `sha256:${hasher.digest("hex")}`;

  return insertarAdjunto({
    id,
    ownerId: opts.ownerId,
    filename: opts.filename,
    contentType: opts.contentType,
    size: total,
    relative,
    contentHash,
  });
}

/** Códigos de fallo del backfill. De aquí no sale nunca una ruta ni un nombre:
    esto acaba publicado en /health, que cualquiera puede leer (§8). */
export type BackfillErrorCode = "" | "MISSING_FILE" | "OUTSIDE_STORAGE" | "READ_FAILED";

export interface AttachmentHashBackfillResult {
  scanned: number;
  updated: number;
  failed: number;
  /** Ya no quedan filas detrás del cursor: la pasada llegó al final. */
  done: boolean;
  last_error: BackfillErrorCode;
}

let backfillCursor: { created_at: number; id: string } | null = null;

/** Cuántos adjuntos con fichero propio siguen sin hash. Barato: hay índice
    parcial justo para esta condición (migración 12). */
export function pendingHashCount(): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM attachments WHERE path <> '' AND content_hash IS NULL")
    .get() as { n: number };
  return row.n;
}

/**
 * Completa gradualmente hashes de adjuntos creados antes de la migracion.
 *
 * El cursor permite avanzar aunque un fichero haya desaparecido; al reiniciar
 * se vuelve a intentar ese fichero sin bloquear todos los que venian despues.
 * Un fallo NO detiene la pasada y NO se reintenta en bucle: se cuenta, se
 * nombra con un código y la instancia queda `degraded` en vez de `complete`,
 * que es la diferencia entre "ya está" y "ya está, menos doce fotos".
 */
export async function backfillAttachmentHashes(limit = 25): Promise<AttachmentHashBackfillResult> {
  const rows = db.prepare(
    `SELECT id, path, created_at FROM attachments
      WHERE path <> '' AND content_hash IS NULL
        AND (? IS NULL OR created_at > ? OR (created_at = ? AND id > ?))
      ORDER BY created_at, id
      LIMIT ?`,
  ).all(
    backfillCursor?.id ?? null,
    backfillCursor?.created_at ?? 0,
    backfillCursor?.created_at ?? 0,
    backfillCursor?.id ?? "",
    limit,
  ) as Array<{ id: string; path: string; created_at: number }>;

  let updated = 0;
  let failed = 0;
  let lastError: BackfillErrorCode = "";

  for (const row of rows) {
    backfillCursor = { created_at: row.created_at, id: row.id };

    const full = insideStorage(row.path);
    if (full === null) {
      /* Una fila que apunta fuera del almacén no se lee: se cuenta. Con `path`
         escrito por nosotros esto no puede pasar; después de una restauración,
         sí, y entonces es justo lo que hay que ver publicado. */
      failed++;
      lastError = "OUTSIDE_STORAGE";
      continue;
    }
    if (!existsSync(full)) {
      failed++;
      lastError = "MISSING_FILE";
      continue;
    }
    try {
      const hasher = createHash("sha256");
      for await (const chunk of createReadStream(full)) hasher.update(chunk);
      const result = db.prepare(
        "UPDATE attachments SET content_hash = ? WHERE id = ? AND content_hash IS NULL",
      ).run(`sha256:${hasher.digest("hex")}`, row.id);
      updated += Number(result.changes);
    } catch {
      // Permisos, disco que devuelve error, o desaparecido a mitad de la lectura.
      failed++;
      lastError = "READ_FAILED";
    }
  }

  return { scanned: rows.length, updated, failed, done: rows.length < limit, last_error: lastError };
}

/**
 * Borra lo que quedó a medias en `.incoming`.
 *
 * Se llama UNA vez al arrancar y por eso puede vaciarlo entero: durante un
 * arranque normal no hay ninguna subida de este proceso en vuelo, así que todo
 * lo que hay dentro es de una ejecución que ya murió. Cada entrada se borra por
 * su nombre dentro del directorio conocido —nunca por una ruta reconstruida
 * desde la base— y se comprueba igualmente que no se sale de él.
 *
 * Lo que NO hace, a propósito: buscar ficheros finales sin fila y borrarlos.
 * Esa lista se calcula con una consulta, y el día que la consulta esté mal se
 * borran las fotos de alguien. Un fichero de más ocupa disco; un fichero de
 * menos es una pérdida.
 */
export function sweepIncoming(): { removed: number; kept: number } {
  let removed = 0;
  let kept = 0;
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(INCOMING, { withFileTypes: true });
  } catch {
    return { removed: 0, kept: 0 };
  }

  for (const entry of entries) {
    const full = join(INCOMING, entry.name);
    if (!full.startsWith(`${INCOMING}${sep}`)) {
      kept++;
      continue;
    }
    /* Un enlace simbólico se desata, no se sigue: unlink quita el enlace y
       jamás lo que hubiera al otro lado. Un directorio aquí no lo pone este
       código, así que no se toca. */
    if (!entry.isFile() && !entry.isSymbolicLink()) {
      kept++;
      continue;
    }
    try {
      unlinkSync(full);
      removed++;
    } catch {
      kept++;
    }
  }
  return { removed, kept };
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

export function attachmentsForDirect(messageIds: string[]): Map<string, Attachment[]> {
  const out = new Map<string, Attachment[]>();
  if (messageIds.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT id, direct_message_id, filename, content_type, size FROM attachments
       WHERE direct_message_id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .all(...messageIds) as Array<{
      id: string;
      direct_message_id: string;
      filename: string;
      content_type: string;
      size: number;
    }>;
  for (const row of rows) {
    const list = out.get(row.direct_message_id) ?? [];
    list.push({
      id: row.id,
      message_id: row.direct_message_id,
      filename: row.filename,
      content_type: row.content_type,
      size: row.size,
      url: `/api/v1/files/${row.id}`,
    });
    out.set(row.direct_message_id, list);
  }
  return out;
}

export function linkAttachments(messageId: string, ids: string[], ownerId: string): void {
  if (ids.length === 0) return;
  const claim = db.prepare(
    "UPDATE attachments SET message_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL AND direct_message_id IS NULL",
  );
  for (const id of ids) claim.run(messageId, id, ownerId);
}

export function linkDirectAttachments(messageId: string, ids: string[], ownerId: string): void {
  if (ids.length === 0) return;
  const claim = db.prepare(
    "UPDATE attachments SET direct_message_id = ? WHERE id = ? AND owner_id = ? AND message_id IS NULL AND direct_message_id IS NULL",
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

  const full = insideStorage(row.path);
  if (full === null || !existsSync(full)) throw notFound("Archivo no encontrado.");

  /* El reproductor del chat necesita que el audio se sirva como recurso, no
     como descarga. Imágenes raster y audio son seguros en línea con nosniff y
     la CSP de abajo; SVG sigue fuera porque sí puede contener código activo. */
  const inline =
    (row.content_type.startsWith("image/") && row.content_type !== "image/svg+xml") ||
    row.content_type.startsWith("audio/");

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
    const full = insideStorage(row.path);
    if (full && existsSync(full)) unlinkSync(full);
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
    const full = insideStorage(row.path);
    if (full && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE message_id = ?").run(messageId);
}

export function deleteDirectAttachmentsOf(messageId: string): void {
  const rows = db.prepare("SELECT id, path FROM attachments WHERE direct_message_id = ?").all(messageId) as Array<{
    id: string;
    path: string;
  }>;
  for (const row of rows) {
    if (!row.path) continue;
    const full = insideStorage(row.path);
    if (full && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE direct_message_id = ?").run(messageId);
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
    const full = insideStorage(row.path);
    if (full && existsSync(full)) unlinkSync(full);
  }
  db.prepare("DELETE FROM attachments WHERE owner_id = ?").run(userId);
}

/**
 * Vaciar el chat de la instancia entera (§28.4): los ficheros de los mensajes
 * —fotos, GIF, adjuntos— fuera del disco, y sus filas con ellos.
 *
 * SOLO lo que cuelga de un mensaje público o directo. Lo demás se
 * queda a propósito: emojis y sonidos de la comunidad, avatares, banners y
 * fondos también son adjuntos, pero con ambos vínculos NULL — son personalización,
 * no historial, y borrarlos rompería perfiles enteros (ver el aviso en db.ts).
 */
export function purgeChatFiles(): { files: number; mb: number } {
  const rows = db.prepare("SELECT id, path, size FROM attachments WHERE message_id IS NOT NULL OR direct_message_id IS NOT NULL").all() as {
    id: string;
    path: string;
    size: number;
  }[];
  let bytes = 0;
  for (const row of rows) {
    // Reenviado (§22): sin fichero propio, path queda vacío y no hay nada que borrar.
    if (!row.path) continue;
    const full = insideStorage(row.path);
    if (full && existsSync(full)) {
      unlinkSync(full);
      bytes += row.size;
    }
  }
  db.prepare("DELETE FROM attachments WHERE message_id IS NOT NULL OR direct_message_id IS NOT NULL").run();
  return { files: rows.length, mb: Math.round((bytes / 1024 / 1024) * 10) / 10 };
}

/**
 * Lo que queda libre en el disco donde viven los archivos, en MB, o `null` si
 * el sistema de ficheros no sabe contestar.
 *
 * La diferencia entre `null` y `0` importa: "no lo sé" y "no queda nada" llevan
 * a decisiones opuestas. Quien solo quiere pintarlo usa `storageFreeMb()`;
 * quien va a decidir con ello —pausar el trabajo de fondo, negarse a hacer una
 * copia— tiene que poder distinguirlos.
 */
export function storageFreeMbOrNull(): number | null {
  try {
    const stats = statfsSync(ROOT);
    return Math.round((stats.bavail * stats.bsize) / 1024 / 1024);
  } catch {
    return null;
  }
}

/** Lo que queda libre en el disco donde viven los archivos, en MB. */
export function storageFreeMb(): number {
  return storageFreeMbOrNull() ?? 0;
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
