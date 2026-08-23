/**
 * Qué instancia habla este cliente (§4, §18).
 *
 * En la web normal la respuesta es "la misma que me sirvió esta página": la
 * base es vacía, todo sigue siendo same-origin y este módulo no cambia nada.
 * Empaquetado (Electron, Android), el cliente viaja con la app y no lo sirvió
 * ninguna instancia: la instancia es una elección de la persona, guardada en
 * el dispositivo, y todas las rutas relativas necesitan una base explícita.
 *
 * La sesión va POR instancia: entrar en el nodo de un amigo no debe pisar la
 * sesión que ya tenías en el tuyo. La clave histórica `distop.session` se
 * conserva tal cual para same-origin, así nadie pierde su sesión al actualizar.
 */
import type { Community } from "@distop/protocol";

const ACTIVE_KEY = "distop.activeInstance";
const LIST_KEY = "distop.instances";

/** Una instancia que este dispositivo ya visitó. */
export interface KnownInstance {
  url: string;
  name: string;
  last_seen: number;
  communities?: CachedCommunity[];
}

export type CachedCommunity = Pick<Community, "id" | "name" | "icon_url" | "accent_color">;

export interface PendingCommunity {
  id: string;
  name: string;
  url: string;
  previous_url: string;
}

/** Estado de la instancia local que hospeda la app de escritorio (§5). */
export interface HostStatus {
  state: "off" | "starting" | "on" | "error";
  url: string;
  error: string;
  log: string[];
}

declare global {
  interface Window {
    /** Puente del preload de Electron (apps/desktop/src/preload.ts). Solo
        existe dentro de la app de escritorio; su forma se declara aquí porque
        el cliente web no puede importar tipos del paquete de escritorio. */
    distop?: {
      platform: string;
      host: {
        start: () => Promise<HostStatus>;
        stop: () => Promise<HostStatus>;
        status: () => Promise<HostStatus>;
        onStatus: (callback: (status: HostStatus) => void) => () => void;
      };
      games: {
        current: () => Promise<string | null>;
        onChange: (callback: (game: string | null) => void) => () => void;
        /** Qué vio la última pasada de detección. Recuentos, nunca la lista de procesos. */
        scan: () => Promise<{
          at: number;
          steam: string | null;
          processes: number;
          catalog: number;
          tasklist: boolean;
        } | null>;
      };
      overlay: {
        update: (state: {
          channelId: string | null;
          channelName: string;
          participants: Array<{
            id: string;
            name: string;
            avatarUrl: string | null;
            speaking: boolean;
            muted: boolean;
          }>;
        }) => void;
      };
    };
    /** Marca de Capacitor. Solo existe dentro de la app Android/iOS. */
    Capacitor?: { isNativePlatform?: () => boolean };
  }
}

/** ¿Corre dentro de una app empaquetada, y no servido por una instancia? */
export function isPackaged(): boolean {
  return Boolean(window.distop) || Boolean(window.Capacitor?.isNativePlatform?.());
}

/**
 * Acepta lo que la gente pega —con o sin esquema, con barra final, con ruta de
 * más— y devuelve solo el origen, o null si no es una dirección http(s) válida.
 * Lista blanca de esquemas, no lista negra (§22): `file:`, `javascript:` y
 * cualquier cosa desconocida se quedan fuera.
 */
export function normalizeInstanceUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function readActive(): string {
  // Same-origin no guarda nada: la base vacía es el comportamiento de siempre.
  try {
    const stored = localStorage.getItem(ACTIVE_KEY);
    return stored ? normalizeInstanceUrl(stored) ?? "" : "";
  } catch {
    return "";
  }
}

/** Origen de la instancia activa ("" = same-origin). Fijo durante la sesión de página. */
export const instanceBase: string = readActive();

/** Ruta de API → URL completa contra la instancia activa. */
export function apiUrl(path: string): string {
  // Una URL ya absoluta (una entidad reescrita por absolutizeUrls) pasa tal cual.
  if (!instanceBase || !path.startsWith("/")) return path;
  return instanceBase + path;
}

/** Ruta de WebSocket → URL ws(s):// contra la instancia activa. */
export function wsUrl(pathWithQuery: string): string {
  if (!instanceBase) {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${location.host}${pathWithQuery}`;
  }
  return instanceBase.replace(/^http/, "ws") + pathWithQuery;
}

/** Clave de la sesión de ESTA instancia. Same-origin conserva la clave histórica. */
export function sessionKey(): string {
  if (!instanceBase) return "distop.session";
  /* La instancia que hospeda la propia app es un caso aparte: su puerto puede
     cambiar de un arranque a otro —si el preferido esta ocupado, el sistema da
     otro—, y con la URL dentro de la clave eso equivalia a cerrar la sesion sola.
     Para la app su servidor es uno solo aunque cambie de puerto. Fuera de la app
     empaquetada nada cambia: alli si puede haber dos instancias locales a la vez. */
  if (window.distop && isLocalInstance(instanceBase)) return "distop.session::app-host";
  return `distop.session::${instanceBase}`;
}

/** ¿La instancia activa corre en este mismo equipo? (la que hospeda la app) */
export function isLocalInstance(base: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|localhost)(:|$)/.test(base);
}

/**
 * Origen que se puede ENSEÑAR y compartir: la instancia activa o, en la web,
 * el propio origen de la página. Nunca location.origin a secas en la app
 * empaquetada — eso es app://distop, una dirección interna que a nadie sirve.
 */
export function clientOrigin(): string {
  return instanceBase || location.origin;
}

/* Una invitación pegada antes de conectar sobrevive a la recarga: se apunta
   aquí y App.tsx la abre en cuanto la aplicación vuelve a estar en pie. */
const PENDING_INVITE = "distop.pendingInvite";

export function storePendingInvite(code: string): void {
  localStorage.setItem(PENDING_INVITE, code);
}

export function peekPendingInvite(): string | null {
  return localStorage.getItem(PENDING_INVITE);
}

export function takePendingInvite(): string | null {
  const code = localStorage.getItem(PENDING_INVITE);
  if (code) localStorage.removeItem(PENDING_INVITE);
  return code;
}

const PENDING_COMMUNITY = "distop.pendingCommunity";

export function storePendingCommunity(target: PendingCommunity): void {
  sessionStorage.setItem(PENDING_COMMUNITY, JSON.stringify(target));
}

export function peekPendingCommunity(): PendingCommunity | null {
  try {
    const raw = sessionStorage.getItem(PENDING_COMMUNITY);
    return raw ? (JSON.parse(raw) as PendingCommunity) : null;
  } catch {
    return null;
  }
}

export function clearPendingCommunity(): void {
  sessionStorage.removeItem(PENDING_COMMUNITY);
}

/* "Cambiar de instancia" pone esta marca antes de recargar: sin ella, la app
   de escritorio volvería a hospedar y conectar sola, y sería una trampa. */
const MANUAL_FLAG = "distop.chooseInstance";

export function requestManualConnect(): void {
  sessionStorage.setItem(MANUAL_FLAG, "1");
}

export function takeManualConnect(): boolean {
  const flagged = sessionStorage.getItem(MANUAL_FLAG) === "1";
  if (flagged) sessionStorage.removeItem(MANUAL_FLAG);
  return flagged;
}

/**
 * Un enlace pegado puede ser una invitación (…/invite/abc) o una dirección a
 * secas. Se separa aquí para que la pantalla de conexión acepte los dos sin
 * pedirle a nadie que sepa la diferencia.
 */
export function parseInvite(raw: string): { origin: string; code: string | null } | null {
  const origin = normalizeInstanceUrl(raw);
  if (!origin) return null;
  const match = /\/invite\/([A-Za-z0-9_-]+)/.exec(raw);
  return { origin, code: match?.[1] ?? null };
}

export type ConnectResult = "invalid" | "unreachable" | "not-instance" | "ok";

/**
 * Valida que en esa dirección vive un servidor de Distop y, si es así, lo hace
 * el activo (con recarga). Si lo pegado era una invitación, el código queda
 * apuntado y App la abre al volver a estar en pie.
 */
export async function connectToInstance(raw: string): Promise<ConnectResult> {
  const parsed = parseInvite(raw);
  if (!parsed) return "invalid";
  try {
    const res = await fetch(`${parsed.origin}/api/v1/info`, { signal: AbortSignal.timeout(8000) });
    const info = (await res.json()) as { name?: string; version?: string };
    // Una web cualquiera también responde 200: lo que identifica a un servidor
    // de Distop es que /api/v1/info devuelva su carné con nombre y versión.
    if (!res.ok || typeof info.name !== "string" || typeof info.version !== "string") return "not-instance";
    rememberInstance(parsed.origin, info.name);
    if (parsed.code) storePendingInvite(parsed.code);
    setActiveInstance(parsed.origin);
    return "ok";
  } catch {
    return "unreachable";
  }
}

/**
 * Cambia la instancia activa y recarga. La recarga no es pereza: el store, el
 * gateway y la voz están construidos alrededor de UNA instancia; arrancar de
 * cero es el único estado limpio garantizado al cambiar de nodo.
 */
export function setActiveInstance(url: string | null): void {
  if (url) localStorage.setItem(ACTIVE_KEY, url);
  else localStorage.removeItem(ACTIVE_KEY);
  location.reload();
}

export function knownInstances(): KnownInstance[] {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const list = raw ? (JSON.parse(raw) as KnownInstance[]) : [];
    return Array.isArray(list) ? list.filter((i) => typeof i?.url === "string") : [];
  } catch {
    return [];
  }
}

export function rememberInstance(url: string, name: string): void {
  const list = knownInstances();
  const previous = list.find((known) => known.url === url);
  const rest = list.filter((known) => known.url !== url);
  const next: KnownInstance[] = [{ ...previous, url, name, last_seen: Date.now() }, ...rest].slice(0, 20);
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
}

/** Guarda solo la ficha visual necesaria para pintar una barra unificada. */
export function rememberCommunities(url: string, communities: Community[]): void {
  if (!url) return;
  const list = knownInstances();
  const previous = list.find((known) => known.url === url);
  const cached = communities.map(({ id, name, icon_url, accent_color }) => ({ id, name, icon_url, accent_color }));
  const entry: KnownInstance = {
    url,
    name: previous?.name ?? communities[0]?.name ?? url,
    last_seen: Date.now(),
    communities: cached,
  };
  localStorage.setItem(LIST_KEY, JSON.stringify([entry, ...list.filter((known) => known.url !== url)].slice(0, 20)));
}

export function forgetKnownCommunity(url: string, communityId: string): void {
  localStorage.setItem(
    LIST_KEY,
    JSON.stringify(
      knownInstances().map((known) =>
        known.url === url
          ? { ...known, communities: (known.communities ?? []).filter((community) => community.id !== communityId) }
          : known,
      ),
    ),
  );
}

export function forgetInstance(url: string): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(knownInstances().filter((known) => known.url !== url)));
}

/* ── URLs de media en la frontera ──────────────────────────────────────
   La API devuelve rutas relativas ("/api/v1/uploads/…") porque para un
   navegador servido por la instancia eso ES la dirección completa. Para el
   cliente empaquetado no apuntan a nada. En lugar de perseguir cada <img>
   del árbol, se reescriben AQUÍ, en la única puerta por la que entran los
   datos — y al escribir se deshace, para no guardar en la instancia URLs
   absolutas que caducan con el túnel. */

const URL_KEY = /(^url$|_url$)/;

function rewriteUrls(payload: unknown, rewrite: (value: string) => string): void {
  if (!payload || typeof payload !== "object") return;
  if (Array.isArray(payload)) {
    for (const item of payload) rewriteUrls(item, rewrite);
    return;
  }
  const record = payload as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === "string" && URL_KEY.test(key)) record[key] = rewrite(value);
    else rewriteUrls(value, rewrite);
  }
}

/** Respuestas y eventos: rutas de la instancia → URLs absolutas. Muta el objeto. */
export function absolutizeUrls<T>(payload: T): T {
  if (instanceBase) rewriteUrls(payload, (value) => (value.startsWith("/") ? instanceBase + value : value));
  return payload;
}

/** Cuerpos que se envían: URLs absolutas de esta instancia → rutas otra vez. */
export function relativizeUrls<T>(payload: T): T {
  if (instanceBase) rewriteUrls(payload, (value) => (value.startsWith(`${instanceBase}/`) ? value.slice(instanceBase.length) : value));
  return payload;
}
