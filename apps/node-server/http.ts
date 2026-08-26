/**
 * Capa HTTP: enrutado, validación, errores tipados, CORS y rate limiting (§22, §30).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ApiError } from "@distop/protocol";
import { config, MAX_UPLOAD_BYTES } from "./config.ts";
import type { AuthContext } from "./auth.ts";
import { authenticate } from "./auth.ts";
import { beginRequest, freezeReason, writesAccepted, type WriteFreeze } from "./lifecycle.ts";
import { isSuperseded } from "./identity.ts";
import { successionRecord } from "./succession.ts";
import { guestChannelOf } from "./meetings.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: Record<string, unknown>) =>
  new HttpError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Necesitas iniciar sesión.") => new HttpError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "No tienes permiso para esto.") => new HttpError(403, "FORBIDDEN", msg);
export const notFound = (msg = "No encontrado.") => new HttpError(404, "NOT_FOUND", msg);
export const conflict = (msg: string) => new HttpError(409, "CONFLICT", msg);

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  requestId: string;
  ip: string;
  auth: AuthContext | null;
}

/**
 * ¿La petición viene del mismo equipo que hospeda la instancia?
 * Se mira el socket, nunca una cabecera: las cabeceras las escribe el cliente.
 * Con un proxy delante el socket es el del proxy, así que ahí nunca es local.
 */
/* Cabeceras que solo existen cuando la peticion viene de fuera por delante: las
   pone el borde de Cloudflare y quien llega desde internet no las puede quitar.
   Sin esto no habia forma de distinguir al agente del tunel —que habla desde
   127.0.0.1— de la persona sentada delante del ordenador. */
const MARCAS_DE_REENVIO = ["cf-ray", "cf-connecting-ip", "cf-visitor", "x-forwarded-for", "x-forwarded-host"];

function llegaPorDelante(ctx: Ctx): boolean {
  return MARCAS_DE_REENVIO.some((cabecera) => ctx.req.headers[cabecera] !== undefined);
}

export function isLocalRequest(ctx: Ctx): boolean {
  if (config.trustProxy) return false;

  /* PUBLIC_URL puesta a mano: alguien colgo la instancia de internet por un
     camino que no conocemos, asi que no podemos reconocer sus reenvios. Ahi no
     hay nadie local, como antes. */
  if (config.publicUrl) return false;

  /* Con el tunel que abre la propia app si sabemos reconocerlos, y por eso
     estar sentado delante del ordenador sigue valiendo aunque este publicada:
     una peticion reenviada trae marcas, la tuya no. */
  if (llegaPorDelante(ctx)) return false;

  const address = ctx.req.socket.remoteAddress ?? "";
  return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}

/** Igual que `ctx.auth` pero garantiza sesión: los handlers privados usan esto. */
export function requireAuth(ctx: Ctx): AuthContext {
  if (!ctx.auth) throw unauthorized();
  return ctx.auth;
}

export type Handler = (ctx: Ctx) => unknown | Promise<unknown>;

/** Devuélvelo desde un handler que ya escribió la respuesta él mismo. */
export const HANDLED = Symbol("handled");

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const routes: Route[] = [];

export function route(method: string, pattern: string, handler: Handler): void {
  routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
}

function match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
  const parts = pathname.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < r.segments.length; i++) {
      const seg = r.segments[i]!;
      if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(parts[i]!);
      else if (seg !== parts[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* ── cuerpo de la petición ─────────────────────────────────────────── */

const MAX_JSON_BYTES = 1024 * 1024;

/** Solo para cuerpos pequeños (JSON y similares): acumula TODO en memoria.
    Las subidas de archivos van por storage.ts:saveUploadStream, que fluye a
    disco justamente para no pagar aquí un pico de RAM del tamaño del archivo. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "PAYLOAD_TOO_LARGE", `El cuerpo supera ${limit} bytes.`);
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJson(ctx: Ctx): Promise<Record<string, unknown>> {
  const raw = await readBody(ctx.req, MAX_JSON_BYTES);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("no es objeto");
    return parsed as Record<string, unknown>;
  } catch {
    throw badRequest("El cuerpo debe ser un objeto JSON válido.");
  }
}

/* ── validación (§30) ──────────────────────────────────────────────── */

export const v = {
  string(
    body: Record<string, unknown>,
    key: string,
    opts: { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {},
  ): string {
    const raw = body[key];
    if (typeof raw !== "string") throw badRequest(`El campo "${key}" debe ser texto.`, { field: key });
    const value = opts.trim === false ? raw : raw.trim();
    const min = opts.min ?? 1;
    if (value.length < min) throw badRequest(`"${key}" necesita al menos ${min} caracteres.`, { field: key });
    if (opts.max !== undefined && value.length > opts.max)
      throw badRequest(`"${key}" admite como máximo ${opts.max} caracteres.`, { field: key });
    if (opts.pattern && !opts.pattern.test(value))
      throw badRequest(`"${key}" tiene un formato no admitido.`, { field: key });
    return value;
  },

  optionalString(
    body: Record<string, unknown>,
    key: string,
    opts: { max?: number; pattern?: RegExp } = {},
  ): string | null | undefined {
    if (!(key in body)) return undefined;
    if (body[key] === null) return null;
    return v.string(body, key, { ...opts, min: 0 });
  },

  bool(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const raw = body[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== "boolean") throw badRequest(`"${key}" debe ser true o false.`, { field: key });
    return raw;
  },

  int(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; fallback?: number } = {}): number {
    const raw = body[key];
    if (raw === undefined && opts.fallback !== undefined) return opts.fallback;
    if (typeof raw !== "number" || !Number.isInteger(raw))
      throw badRequest(`"${key}" debe ser un número entero.`, { field: key });
    if (opts.min !== undefined && raw < opts.min) throw badRequest(`"${key}" mínimo ${opts.min}.`, { field: key });
    if (opts.max !== undefined && raw > opts.max) throw badRequest(`"${key}" máximo ${opts.max}.`, { field: key });
    return raw;
  },

  color(body: Record<string, unknown>, key: string): string | null | undefined {
    const value = v.optionalString(body, key, { max: 7, pattern: /^#[0-9a-fA-F]{6}$/ });
    return value === "" ? null : value;
  },

  oneOf<T extends string>(body: Record<string, unknown>, key: string, allowed: readonly T[], fallback?: T): T {
    const raw = body[key];
    if (raw === undefined && fallback !== undefined) return fallback;
    if (typeof raw !== "string" || !allowed.includes(raw as T))
      throw badRequest(`"${key}" debe ser uno de: ${allowed.join(", ")}.`, { field: key });
    return raw as T;
  },
};

/* ── rate limiting ─────────────────────────────────────────────────────
   Ventana fija en memoria. ponytail: por proceso; si algún día hay varias
   instancias detrás de un balanceador, esto se muda a Redis. */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  bucket.count++;
  if (bucket.count > limit) {
    throw new HttpError(429, "RATE_LIMITED", "Demasiadas peticiones, espera un momento.", {
      retry_after_s: Math.ceil((bucket.resetAt - now) / 1000),
    });
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt < now) buckets.delete(key);
}, 60_000).unref();

/* ── respuesta ─────────────────────────────────────────────────────── */

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allowed = config.corsOrigins.includes("*")
    ? origin ?? "*"
    : origin && config.corsOrigins.includes(origin)
      ? origin
      : "";
  if (!allowed) return {};
  return {
    "access-control-allow-origin": allowed,
    "access-control-allow-credentials": "true",
    "access-control-allow-headers": "authorization, content-type, x-filename",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "86400",
    vary: "origin",
  };
}

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "cross-origin",
};

export function send(ctx: Ctx, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? "" : JSON.stringify(body, (_k, value) => (typeof value === "bigint" ? value.toString() : value));
  ctx.res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "x-request-id": ctx.requestId,
    ...SECURITY_HEADERS,
    ...corsHeaders(ctx.req.headers.origin),
    ...headers,
  });
  ctx.res.end(payload);
}

function toApiError(err: unknown, requestId: string, clientGone = false): ApiError {
  const known = err instanceof HttpError;
  /* Un cliente que se va a mitad de una subida —o al que corta el apagado— no
     es un fallo de la instancia. Se registra el hecho en una línea, sin traza:
     apagar con diez subidas en curso escupía diez pilas de ECONNRESET, y eso es
     exactamente lo que hace que nadie mire los logs cuando pasa algo de verdad. */
  if (!known) {
    if (clientGone) console.warn(`[${requestId}] petición abandonada por el cliente`);
    else console.error(`[${requestId}]`, err);
  }
  return {
    code: known ? err.code : "INTERNAL",
    // Fuera de HttpError el mensaje real no sale: puede contener rutas o SQL (§30).
    message: known ? err.message : "Error interno de la instancia.",
    status: known ? err.status : 500,
    ...(known && err.details ? { details: err.details } : {}),
    requestId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Por qué la instancia no acepta cambios ahora mismo, dicho tal cual (§26).
 * "Vuelve más tarde" a secas mete una pausa de treinta segundos y un apagado
 * definitivo en el mismo mensaje, y no son lo mismo para quien está escribiendo.
 */
const MOTIVO_CONGELADO: Record<WriteFreeze, { message: string; retry_after_s: number | null }> = {
  shutdown: { message: "La instancia se está apagando; no acepta cambios nuevos.", retry_after_s: null },
  backup: { message: "La instancia está copiando sus datos; en unos segundos vuelve.", retry_after_s: 15 },
  restore: { message: "La instancia está restaurando una copia; no acepta cambios.", retry_after_s: 60 },
  handover: { message: "La instancia está entregando el relevo; no acepta cambios.", retry_after_s: 60 },
};

/**
 * Lo único que sigue contestando una instancia que ya entregó el relevo.
 *
 * Retirado significa retirado: servir datos como si mandara sería la forma más
 * fácil de partir una comunidad en dos, con la mitad escribiendo en la máquina
 * vieja. Se dejan abiertos la salud, la ficha con la dirección nueva, la cadena
 * de sucesión —para que un cliente pueda comprobar a dónde ir— y la
 * exportación, que es un derecho y no depende de quién mande (§21). Entrar
 * sigue permitido porque sin sesión no hay exportación que valga.
 */
function abiertoTrasElRelevo(pathname: string, method: string): boolean {
  if (pathname === "/health" || pathname === "/api/v1/health" || pathname === "/api/v1/info") return true;
  if (pathname === "/api/v1/succession/chain") return true;
  if (pathname === "/api/v1/auth/login" || pathname === "/api/v1/auth/refresh") return true;
  return method === "GET" && /^\/api\/v1\/communities\/[^/]+\/export$/.test(pathname);
}

/**
 * Lo que sí pasa mientras las escrituras están congeladas.
 *
 * Congelar durante un relevo sirve para que la comunidad no siga escribiendo
 * mientras se saca la copia final. Pero el propio relevo tiene que poder
 * avanzar: el recibo del sucesor y la cancelación del anfitrión son
 * exactamente las dos cosas que sacan a la instancia de ese estado. Sin esta
 * salvedad, la congelación bloqueaba lo único capaz de levantarla, y una
 * comunidad se quedaba en mantenimiento hasta que alguien reiniciara.
 */
function permitidoDuranteCongelacion(pathname: string, motivo: WriteFreeze): boolean {
  if (motivo !== "handover") return false;
  return pathname.startsWith("/api/v1/succession/") || pathname === "/api/v1/instance/handover";
}

/**
 * Por dónde puede pasar una sesión acotada a una reunión (V2).
 *
 * Lista blanca, no lista negra. Una lista negra envejece mal: cada ruta nueva
 * queda permitida por omisión, y basta con que alguien añada un endpoint sin
 * acordarse de esto para que un invitado de una reunión de media hora pueda
 * leer la comunidad entera.
 *
 * El id que lleve la ruta tiene que ser el suyo: no basta con que la FORMA
 * encaje. `/api/v1/meetings/<otra>` encaja igual de bien y no es su reunión.
 */
function permitidoParaInvitado(pathname: string, meetingId: string, userId: string): boolean {
  if (pathname === "/health" || pathname === "/api/v1/health" || pathname === "/api/v1/info") return true;
  if (pathname === "/api/v1/auth/me" || pathname === "/api/v1/auth/logout" || pathname === "/api/v1/auth/refresh") {
    return true;
  }
  if (pathname === `/api/v1/meetings/${meetingId}`) return true;

  /* Su canal, y solo el suyo: mensajes y lectura del chat de la reunión. */
  const canal = guestChannelOf(userId);
  if (canal) {
    if (pathname === `/api/v1/channels/${canal}/messages`) return true;
    if (pathname === `/api/v1/channels/${canal}/read`) return true;
  }
  return false;
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  /* OPTIONS no muta: si contara, un preflight durante una copia mantendría
     ocupado el contador que la copia está esperando a que llegue a cero. */
  const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const finishRequest = beginRequest(mutating);
  const requestId = randomUUID();
  const host = req.headers.host ?? `localhost:${config.port}`;
  const url = new URL(req.url ?? "/", `http://${host}`);
  // Sin TRUST_PROXY, la cabecera se ignora: es texto que escribe el cliente.
  const forwarded = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
  const ip = forwarded || req.socket.remoteAddress || "?";

  const ctx: Ctx = { req, res, url, params: {}, requestId, ip, auth: null };

  try {
    if (req.method === "OPTIONS") return send(ctx, 204, undefined);

    if (isSuperseded() && !abiertoTrasElRelevo(url.pathname, method)) {
      const registro = successionRecord();
      throw new HttpError(410, "INSTANCE_SUPERSEDED", "Esta comunidad se sirve ahora desde otro equipo.", {
        successor: {
          origin: registro?.origin ?? null,
          /* La cadena viaja con el error: quien tenía fijada esta instancia
             puede comprobar por sí mismo que la nueva es su continuación, sin
             fiarse de que se lo digamos. */
          certificate_chain: registro ? [registro.certificate] : [],
        },
      });
    }

    const congelado = freezeReason();
    if (mutating && congelado !== null && !permitidoDuranteCongelacion(url.pathname, congelado)) {
      const motivo = MOTIVO_CONGELADO[congelado];
      throw new HttpError(503, "INSTANCE_MAINTENANCE", motivo.message, {
        reason: congelado,
        ...(motivo.retry_after_s === null ? {} : { retry_after_s: motivo.retry_after_s }),
      });
    }

    rateLimit(`ip:${ip}`, 600, 60_000);

    const header = req.headers.authorization;
    ctx.auth = authenticate(header?.startsWith("Bearer ") ? header.slice(7) : null);

    /* Una sesión de invitado de reunión no vale para nada más que esa reunión,
       y eso se comprueba AQUÍ: una sola puerta, en vez de confiar en que cada
       ruta futura se acuerde de mirarlo. Lo que no está en la lista, no pasa. */
    if (ctx.auth?.meetingId && !permitidoParaInvitado(url.pathname, ctx.auth.meetingId, ctx.auth.user.id)) {
      throw new HttpError(403, "GUEST_SCOPED", "Esta sesión solo sirve para la reunión a la que te invitaron.");
    }

    const found = match(req.method ?? "GET", url.pathname);
    if (!found) throw notFound(`Ruta desconocida: ${req.method} ${url.pathname}`);

    ctx.params = found.params;
    const result = await found.handler(ctx);
    if (result === HANDLED) return;
    send(ctx, result === undefined ? 204 : 200, result);
  } catch (err) {
    const apiError = toApiError(err, requestId, req.destroyed || res.destroyed);
    /* Un apagado corta las subidas a medias destruyendo el socket: para cuando
       el handler propaga el error ya no hay a quién contestar, y escribir en
       una respuesta destruida convierte un cierre limpio en una excepción sin
       dueño. El error igualmente se registró arriba si no era un HttpError. */
    if (res.destroyed || res.writableEnded) return;
    if (!res.headersSent) send(ctx, apiError.status, { error: apiError });
    else res.end();
  } finally {
    finishRequest();
  }
}

export { MAX_UPLOAD_BYTES };
