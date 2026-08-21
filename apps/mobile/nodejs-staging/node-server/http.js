import { randomUUID } from "node:crypto";
import { config, MAX_UPLOAD_BYTES } from "./config.js";
import { authenticate } from "./auth.js";
import { publicUrl } from "./tunnel.js";
export class HttpError extends Error {
    status;
    code;
    details;
    constructor(status, code, message, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
export const badRequest = (msg, details) => new HttpError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Necesitas iniciar sesión.") => new HttpError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "No tienes permiso para esto.") => new HttpError(403, "FORBIDDEN", msg);
export const notFound = (msg = "No encontrado.") => new HttpError(404, "NOT_FOUND", msg);
export const conflict = (msg) => new HttpError(409, "CONFLICT", msg);
/**
 * ¿La petición viene del mismo equipo que hospeda la instancia?
 * Se mira el socket, nunca una cabecera: las cabeceras las escribe el cliente.
 * Con un proxy delante el socket es el del proxy, así que ahí nunca es local.
 */
export function isLocalRequest(ctx) {
    if (config.trustProxy)
        return false;
    /* Con la instancia publicada —un túnel abierto o PUBLIC_URL puesta— el socket
       SIGUE siendo 127.0.0.1, porque quien se conecta de verdad es el agente del
       túnel corriendo en esta misma máquina. Sin esta comprobación, "estoy sentado
       delante del ordenador" pasaba a significar "tengo la URL", y con eso
       /auth/recover entregaba una sesión de quien hospeda a cualquiera que la
       pidiera. Publicada la instancia, nadie es local. */
    if (publicUrl())
        return false;
    const address = ctx.req.socket.remoteAddress ?? "";
    return address === "::1" || address === "127.0.0.1" || address.startsWith("::ffff:127.");
}
/** Igual que `ctx.auth` pero garantiza sesión: los handlers privados usan esto. */
export function requireAuth(ctx) {
    if (!ctx.auth)
        throw unauthorized();
    return ctx.auth;
}
/** Devuélvelo desde un handler que ya escribió la respuesta él mismo. */
export const HANDLED = Symbol("handled");
const routes = [];
export function route(method, pattern, handler) {
    routes.push({ method, segments: pattern.split("/").filter(Boolean), handler });
}
function match(method, pathname) {
    const parts = pathname.split("/").filter(Boolean);
    for (const r of routes) {
        if (r.method !== method || r.segments.length !== parts.length)
            continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < r.segments.length; i++) {
            const seg = r.segments[i];
            if (seg.startsWith(":"))
                params[seg.slice(1)] = decodeURIComponent(parts[i]);
            else if (seg !== parts[i]) {
                ok = false;
                break;
            }
        }
        if (ok)
            return { handler: r.handler, params };
    }
    return null;
}
/* ── cuerpo de la petición ─────────────────────────────────────────── */
const MAX_JSON_BYTES = 1024 * 1024;
export async function readBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buf = chunk;
        size += buf.length;
        if (size > limit)
            throw new HttpError(413, "PAYLOAD_TOO_LARGE", `El cuerpo supera ${limit} bytes.`);
        chunks.push(buf);
    }
    return Buffer.concat(chunks);
}
export async function readJson(ctx) {
    const raw = await readBody(ctx.req, MAX_JSON_BYTES);
    if (raw.length === 0)
        return {};
    try {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            throw new Error("no es objeto");
        return parsed;
    }
    catch {
        throw badRequest("El cuerpo debe ser un objeto JSON válido.");
    }
}
/* ── validación (§30) ──────────────────────────────────────────────── */
export const v = {
    string(body, key, opts = {}) {
        const raw = body[key];
        if (typeof raw !== "string")
            throw badRequest(`El campo "${key}" debe ser texto.`, { field: key });
        const value = opts.trim === false ? raw : raw.trim();
        const min = opts.min ?? 1;
        if (value.length < min)
            throw badRequest(`"${key}" necesita al menos ${min} caracteres.`, { field: key });
        if (opts.max !== undefined && value.length > opts.max)
            throw badRequest(`"${key}" admite como máximo ${opts.max} caracteres.`, { field: key });
        if (opts.pattern && !opts.pattern.test(value))
            throw badRequest(`"${key}" tiene un formato no admitido.`, { field: key });
        return value;
    },
    optionalString(body, key, opts = {}) {
        if (!(key in body))
            return undefined;
        if (body[key] === null)
            return null;
        return v.string(body, key, { ...opts, min: 0 });
    },
    bool(body, key, fallback) {
        const raw = body[key];
        if (raw === undefined)
            return fallback;
        if (typeof raw !== "boolean")
            throw badRequest(`"${key}" debe ser true o false.`, { field: key });
        return raw;
    },
    int(body, key, opts = {}) {
        const raw = body[key];
        if (raw === undefined && opts.fallback !== undefined)
            return opts.fallback;
        if (typeof raw !== "number" || !Number.isInteger(raw))
            throw badRequest(`"${key}" debe ser un número entero.`, { field: key });
        if (opts.min !== undefined && raw < opts.min)
            throw badRequest(`"${key}" mínimo ${opts.min}.`, { field: key });
        if (opts.max !== undefined && raw > opts.max)
            throw badRequest(`"${key}" máximo ${opts.max}.`, { field: key });
        return raw;
    },
    color(body, key) {
        const value = v.optionalString(body, key, { max: 7, pattern: /^#[0-9a-fA-F]{6}$/ });
        return value === "" ? null : value;
    },
    oneOf(body, key, allowed, fallback) {
        const raw = body[key];
        if (raw === undefined && fallback !== undefined)
            return fallback;
        if (typeof raw !== "string" || !allowed.includes(raw))
            throw badRequest(`"${key}" debe ser uno de: ${allowed.join(", ")}.`, { field: key });
        return raw;
    },
};
/* ── rate limiting ─────────────────────────────────────────────────────
   Ventana fija en memoria. ponytail: por proceso; si algún día hay varias
   instancias detrás de un balanceador, esto se muda a Redis. */
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
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
    for (const [key, bucket] of buckets)
        if (bucket.resetAt < now)
            buckets.delete(key);
}, 60_000).unref();
/* ── respuesta ─────────────────────────────────────────────────────── */
function corsHeaders(origin) {
    const allowed = config.corsOrigins.includes("*")
        ? origin ?? "*"
        : origin && config.corsOrigins.includes(origin)
            ? origin
            : "";
    if (!allowed)
        return {};
    return {
        "access-control-allow-origin": allowed,
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "authorization, content-type, x-filename",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-max-age": "86400",
        vary: "origin",
    };
}
const SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-resource-policy": "cross-origin",
};
export function send(ctx, status, body, headers = {}) {
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
function toApiError(err, requestId) {
    const known = err instanceof HttpError;
    if (!known)
        console.error(`[${requestId}]`, err);
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
export async function handleRequest(req, res) {
    const requestId = randomUUID();
    const host = req.headers.host ?? `localhost:${config.port}`;
    const url = new URL(req.url ?? "/", `http://${host}`);
    // Sin TRUST_PROXY, la cabecera se ignora: es texto que escribe el cliente.
    const forwarded = config.trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim() : "";
    const ip = forwarded || req.socket.remoteAddress || "?";
    const ctx = { req, res, url, params: {}, requestId, ip, auth: null };
    try {
        if (req.method === "OPTIONS")
            return send(ctx, 204, undefined);
        rateLimit(`ip:${ip}`, 600, 60_000);
        const header = req.headers.authorization;
        ctx.auth = authenticate(header?.startsWith("Bearer ") ? header.slice(7) : null);
        const found = match(req.method ?? "GET", url.pathname);
        if (!found)
            throw notFound(`Ruta desconocida: ${req.method} ${url.pathname}`);
        ctx.params = found.params;
        const result = await found.handler(ctx);
        if (result === HANDLED)
            return;
        send(ctx, result === undefined ? 204 : 200, result);
    }
    catch (err) {
        const apiError = toApiError(err, requestId);
        if (!res.headersSent)
            send(ctx, apiError.status, { error: apiError });
        else
            res.end();
    }
}
export { MAX_UPLOAD_BYTES };
