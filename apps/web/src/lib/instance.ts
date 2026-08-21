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

const ACTIVE_KEY = "distop.activeInstance";
const LIST_KEY = "distop.instances";

/** Una instancia que este dispositivo ya visitó. */
export interface KnownInstance {
  url: string;
  name: string;
  last_seen: number;
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
  return instanceBase ? `distop.session::${instanceBase}` : "distop.session";
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
  const rest = knownInstances().filter((known) => known.url !== url);
  const next: KnownInstance[] = [{ url, name, last_seen: Date.now() }, ...rest].slice(0, 20);
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
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
