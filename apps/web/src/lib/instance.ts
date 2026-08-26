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
import { SUCCESSION_CHAIN_MAX, canonicalJson, checkSuccessionStep, compareIdentities } from "@distop/protocol";
import type { Community, InstanceIdentityRef, SuccessionCert } from "@distop/protocol";

const ACTIVE_KEY = "distop.activeInstance";
const LIST_KEY = "distop.instances";

/** Una instancia que este dispositivo ya visitó. */
export interface KnownInstance {
  url: string;
  name: string;
  last_seen: number;
  instance_id?: string;
  lineage_id?: string;
  epoch?: number;
  role?: "PRIMARY" | "STANDBY" | "SUPERSEDED";
  identity_fingerprint?: string;
  identity_public_key?: JsonWebKey;
  watch_url?: string;
  watch_enabled?: boolean;
  communities?: CachedCommunity[];
  /** Cómo llegó esta instancia a ser la que es, desde la que fijamos primero. */
  chain?: SuccessionCert[];
  /** Última generación de direcciones aceptada. Nunca se acepta una menor. */
  origin_generation?: number;
  /**
   * Dos respuestas dicen ser la misma comunidad y no pueden serlo las dos.
   * Mientras esto exista no se manda el token a ninguna: elegir mal es
   * entregarle la sesión a quien no es.
   */
  conflict?: { seen_fingerprint: string; seen_at: number; reason: string };
  /**
   * Lo que vio el vigilante de la bandeja mientras la aplicación no estaba
   * delante. No interrumpe con una ventana emergente —un conflicto de
   * identidad no se mira de reojo a mitad de otra cosa—: se guarda y se enseña
   * al abrir, que es cuando se puede hacer algo al respecto.
   */
  watch_alert?: { kind: "identity_conflict" | "protocol_incompatible"; at: number; detail: string };
}


export interface InstanceIdentityInfo {
  instance_id: string;
  lineage_id: string;
  epoch: number;
  role: "PRIMARY" | "STANDBY" | "SUPERSEDED";
  name: string;
  public_url: string;
  identity: { algorithm: "ES256"; fingerprint: string; public_key: JsonWebKey };
}
export type CachedCommunity = Pick<Community, "id" | "name" | "icon_url" | "accent_color">;

export interface PendingCommunity {
  id: string;
  name: string;
  url: string;
  previous_url: string;
}

/** Estado de la instancia local que hospeda la app de escritorio (§5). */
interface HostStatus {
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
      availability: {
        replace: (items: unknown[]) => Promise<boolean>;
        status: (url: string, connected: boolean) => void;
        forget: (url: string) => Promise<boolean>;
        onOpen: (callback: (url: string) => void) => () => void;
        onAlert: (
          callback: (
            alert:
              | { kind: "identity_conflict"; url: string; fingerprint: string }
              | { kind: "protocol_incompatible"; url: string; protocol: string },
          ) => void,
        ) => () => void;
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
        /** Opcionales: cascarones anteriores no los exponen. Gobiernan el
            sondeo local entero (tasklist + registro), no solo el reporte. */
        watch?: () => Promise<boolean>;
        setWatch?: (enabled: boolean) => Promise<boolean>;
      };
      /** Aplicaciones integradas (WhatsApp/Telegram). Opcional: cascarones
          anteriores no lo exponen. Apagada = pestaña y proceso fuera. */
      apps?: {
        prefs: () => Promise<{ whatsapp: boolean; telegram: boolean }>;
        set: (
          id: "whatsapp" | "telegram",
          enabled: boolean,
        ) => Promise<{ whatsapp: boolean; telegram: boolean } | null>;
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

function storePendingInvite(code: string): void {
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

function rememberInstance(url: string, name: string): void {
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

  /**
   * Tenías comunidades aquí y ahora no tienes ninguna: te fuiste o te echaron.
   *
   * Es la única forma fiable que tiene el cliente de saberlo. El servidor no lo
   * dice —`requireMembership` devuelve "no encontrada" a propósito, porque
   * distinguir "te echaron" de "no existe" filtraría quién está dentro— y el
   * vigilante sondea sin credenciales, así que tampoco puede preguntarlo.
   *
   * Se compara contra lo que había justamente para no confundirlo con una
   * cuenta recién creada, que también tiene la lista vacía y no ha perdido nada.
   */
  if (communities.length === 0 && (previous?.communities?.length ?? 0) > 0) {
    forgetInstance(url);
    return;
  }

  const cached = communities.map(({ id, name, icon_url, accent_color }) => ({ id, name, icon_url, accent_color }));
  const entry: KnownInstance = {
    ...previous,
    url,
    name: previous?.name ?? communities[0]?.name ?? url,
    last_seen: Date.now(),
    communities: cached,
  };
  localStorage.setItem(LIST_KEY, JSON.stringify([entry, ...list.filter((known) => known.url !== url)].slice(0, 20)));
  syncDesktopAvailability();
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

/**
 * Fuera del todo: nombre, comunidades en caché, identidad fijada y vigilancia.
 *
 * `syncDesktopAvailability` ya dejaría de vigilarla por omisión, pero se pide
 * además el olvido explícito: la lista solo llega si esta pestaña alcanza a
 * enviarla, y una comunidad de la que te fuiste no debería seguir apareciendo
 * en tu bandeja —ni recibiendo un sondeo tuyo cada minuto— porque un `replace`
 * se quedó por el camino.
 */
export function forgetInstance(url: string): void {
  localStorage.setItem(LIST_KEY, JSON.stringify(knownInstances().filter((known) => known.url !== url)));
  void window.distop?.availability.forget(url);
  syncDesktopAvailability();
}

let availabilityConnected = false;


function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function stableWatchUrl(raw: string): string | null {
  const normalized = normalizeInstanceUrl(raw);
  if (!normalized) return null;
  const parsed = new URL(normalized);
  if (parsed.protocol !== "https:" || parsed.hostname.endsWith(".trycloudflare.com")) return null;
  return parsed.origin;
}

/** Ningún origen nuevo puede obligar al cliente a reservar memoria sin límite. */
async function smallJson(response: Response, limit = 32 * 1024): Promise<unknown> {
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > limit || !response.body) throw new Error("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("INVALID_RESPONSE");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Verifica una prueba fresca y aplica TOFU: una clave fijada nunca cambia sola. */
/**
 * Verifica un eslabón de la cadena con WebCrypto.
 *
 * Las reglas —época siguiente, mismo linaje, ventana de validez— son las mismas
 * que aplica el servidor, porque viven en el paquete compartido. Lo único que
 * cambia aquí es la primitiva de firma.
 */
async function verifyCertInBrowser(cert: SuccessionCert, from: InstanceIdentityRef, now: number): Promise<string | null> {
  if (!cert?.payload || typeof cert.signature !== "string") return "MALFORMED";
  const encodedKey = new TextEncoder().encode(canonicalJson(cert.signer_public_key));
  const fingerprint = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encodedKey)));
  /* La huella se recalcula sobre la clave que llega: fiarse de la declarada
     dejaría a cualquiera decir que es el predecesor y firmar con otra cosa. */
  if (fingerprint !== cert.signer_fingerprint) return "SIGNER_KEY_MISMATCH";
  if (fingerprint !== from.fingerprint) return "SIGNER_NOT_PREDECESSOR";

  const reglas = checkSuccessionStep(from, cert.payload, now);
  if (reglas) return reglas;

  try {
    const key = await crypto.subtle.importKey(
      "jwk", cert.signer_public_key as JsonWebKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"],
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key,
      fromBase64Url(cert.signature), new TextEncoder().encode(canonicalJson(cert.payload)),
    );
    return valid ? null : "BAD_SIGNATURE";
  } catch { return "BAD_SIGNATURE"; }
}

/** Sigue la cadena entera desde lo que teníamos fijado hasta donde acabe. */
export async function followSuccessionChain(
  pinned: InstanceIdentityRef, chain: SuccessionCert[], now = Date.now(),
): Promise<{ final: InstanceIdentityRef; chain: SuccessionCert[]; origins: string[] } | null> {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > SUCCESSION_CHAIN_MAX) return null;
  let actual = pinned;
  let origins: string[] = [];
  for (const cert of chain) {
    if (await verifyCertInBrowser(cert, actual, now)) return null;
    actual = {
      instance_id: cert.payload.to_instance_id, lineage_id: cert.payload.lineage_id,
      epoch: cert.payload.to_epoch, fingerprint: cert.payload.to_fingerprint,
    };
    origins = cert.payload.allowed_origins;
  }
  return { final: actual, chain, origins };
}

async function fetchAndFollowChain(
  origin: string, pinned: InstanceIdentityRef, now: number,
): Promise<{ final: InstanceIdentityRef; chain: SuccessionCert[]; origins: string[] } | null> {
  try {
    const response = await fetch(`${origin}/api/v1/succession/chain`, {
      redirect: "manual", signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const cuerpo = await smallJson(response) as { inbound_chain?: SuccessionCert[] };
    return await followSuccessionChain(pinned, cuerpo.inbound_chain ?? [], now);
  } catch { return null; }
}

/**
 * Deja constancia de que dos cosas distintas dicen ser la misma comunidad.
 *
 * No se resuelve solo y no debe intentarlo: se guarda para que la interfaz
 * pueda enseñar las dos huellas y que decida una persona, que es quien puede
 * llamar por teléfono y preguntar.
 */
function recordContinuityConflict(url: string, seenFingerprint: string, reason: string): void {
  const next = knownInstances().map((known) =>
    known.url === url ? { ...known, conflict: { seen_fingerprint: seenFingerprint, seen_at: Date.now(), reason } } : known,
  );
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
}

/** El conflicto de continuidad de una dirección, si lo hay. */
export function continuityConflict(url = instanceBase): KnownInstance["conflict"] {
  return knownInstances().find((known) => known.url === url)?.conflict;
}

export function clearContinuityConflict(url = instanceBase): void {
  localStorage.setItem(
    LIST_KEY,
    JSON.stringify(
      knownInstances().map((known) => {
        if (known.url !== url) return known;
        const { conflict: _descartado, ...resto } = known;
        return resto;
      }),
    ),
  );
}

export async function trustInstanceIdentity(info: InstanceIdentityInfo, connectedUrl = instanceBase): Promise<boolean> {
  const watchUrl = stableWatchUrl(info.public_url) ?? stableWatchUrl(connectedUrl);
  if (!watchUrl || info.identity?.algorithm !== "ES256") return false;
  const nonce = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  try {
    const response = await fetch(`${watchUrl}/api/v1/instance/challenge`, {
      method: "POST", redirect: "manual", headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }), signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return false;
    const proof = await smallJson(response) as {
      payload: { t: string; instance_id: string; lineage_id: string; epoch: number; role: string; origin: string; nonce: string; issued_at: number; expires_at: number };
      signature: string; public_key: JsonWebKey; fingerprint: string;
    };
    const encodedKey = new TextEncoder().encode(canonicalJson(proof.public_key));
    const fingerprint = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encodedKey)));
    const now = Date.now();
    if (fingerprint !== info.identity.fingerprint || proof.fingerprint !== fingerprint) return false;
    if (canonicalJson(proof.public_key) !== canonicalJson(info.identity.public_key)) return false;
    if (proof.payload.t !== "DISTOP_INSTANCE_PROOF" || proof.payload.instance_id !== info.instance_id) return false;
    if (proof.payload.lineage_id !== info.lineage_id || proof.payload.epoch !== info.epoch || proof.payload.role !== info.role) return false;
    if (proof.payload.origin !== watchUrl || proof.payload.nonce !== nonce || proof.payload.issued_at > now + 5_000 || proof.payload.expires_at < now) return false;
    const key = await crypto.subtle.importKey("jwk", proof.public_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, fromBase64Url(proof.signature), new TextEncoder().encode(canonicalJson(proof.payload)),
    );
    if (!valid) return false;

    const list = knownInstances();
    const previous = list.find((known) => known.url === connectedUrl);
    let cadena = previous?.chain;

    /* Ya habíamos fijado una identidad en esta dirección. Antes, cualquier
       diferencia se trataba igual: "no me fío". Pero "cambió de manos con un
       certificado que lo demuestra" y "alguien distinto responde aquí" son
       cosas opuestas, y tratarlas igual dejaba a la gente fuera de su propia
       comunidad después de un relevo legítimo. */
    if (previous?.identity_fingerprint && previous.lineage_id && previous.instance_id && previous.epoch !== undefined) {
      const fijada: InstanceIdentityRef = {
        instance_id: previous.instance_id, lineage_id: previous.lineage_id,
        epoch: previous.epoch, fingerprint: previous.identity_fingerprint,
      };
      const vista: InstanceIdentityRef = {
        instance_id: info.instance_id, lineage_id: info.lineage_id, epoch: info.epoch, fingerprint,
      };
      const veredicto = compareIdentities(fijada, vista);

      if (veredicto === "fork") {
        /* Misma línea, misma época, otra clave. Alguien restauró una copia o
           alguien miente, y desde fuera las dos parecen legítimas. No se elige:
           se anota y se para, porque elegir mal es entregar la sesión. */
        recordContinuityConflict(connectedUrl, fingerprint, "SAME_EPOCH_DIFFERENT_KEY");
        return false;
      }
      if (veredicto === "stale" || veredicto === "unrelated") return false;

      if (veredicto === "successor") {
        const seguida = await fetchAndFollowChain(watchUrl, fijada, now);
        if (!seguida || seguida.final.fingerprint !== fingerprint || seguida.final.instance_id !== info.instance_id) {
          recordContinuityConflict(connectedUrl, fingerprint, "UNPROVEN_SUCCESSOR");
          return false;
        }
        cadena = seguida.chain;
      }
    }

    /* El conflicto se quita QUITANDO la clave, no poniéndola a undefined: con
       `exactOptionalPropertyTypes` no es lo mismo, y además una clave presente
       con valor undefined sobrevive a JSON.stringify como ausencia silenciosa
       en unos sitios y como ruido en otros. */
    const { conflict: _resuelto, ...anterior } = previous ?? ({} as KnownInstance);
    const entry: KnownInstance = {
      ...anterior, url: connectedUrl, name: info.name, last_seen: Date.now(),
      instance_id: info.instance_id, lineage_id: info.lineage_id, epoch: info.epoch, role: info.role,
      identity_fingerprint: fingerprint, identity_public_key: proof.public_key, watch_url: watchUrl,
      ...(cadena ? { chain: cadena } : {}),
    };
    localStorage.setItem(LIST_KEY, JSON.stringify([entry, ...list.filter((known) => known.url !== connectedUrl)].slice(0, 20)));
    syncDesktopAvailability();
    return true;
  } catch { return false; }
}

export function activeAvailabilityWatch(): { eligible: boolean; enabled: boolean } {
  const known = knownInstances().find((item) => item.url === instanceBase);
  const eligible = Boolean(window.distop?.availability && known?.watch_url && known.instance_id && known.lineage_id
    && known.identity_fingerprint && known.identity_public_key && known.communities?.length);
  return { eligible, enabled: eligible && known?.watch_enabled === true };
}

export function setActiveAvailabilityWatch(enabled: boolean): boolean {
  const current = activeAvailabilityWatch();
  if (!current.eligible) return false;
  const next = knownInstances().map((known) => known.url === instanceBase ? { ...known, watch_enabled: enabled } : known);
  localStorage.setItem(LIST_KEY, JSON.stringify(next));
  syncDesktopAvailability();
  return enabled;
}

export async function syncDesktopAvailability(): Promise<void> {
  if (!window.distop?.availability) return;
  const items = knownInstances().filter((known) => known.watch_enabled && known.watch_url && known.instance_id
    && known.lineage_id && known.epoch && known.identity_fingerprint && known.identity_public_key && known.communities?.length)
    .map((known) => ({
      url: known.watch_url!, name: known.name, instance_id: known.instance_id!, lineage_id: known.lineage_id!,
      epoch: known.epoch!, identity_fingerprint: known.identity_fingerprint!, identity_public_key: known.identity_public_key!,
      enabled: true, connected: known.url === instanceBase && availabilityConnected,
    }));
  await window.distop.availability.replace(items);
}

export async function setDesktopAvailabilityStatus(connected: boolean): Promise<void> {
  availabilityConnected = connected;
  await syncDesktopAvailability();
  const current = knownInstances().find((known) => known.url === instanceBase);
  if (current?.watch_url) window.distop?.availability.status(current.watch_url, connected);
}

/** Lo que el vigilante vio con la aplicación cerrada, si vio algo. */
export function watchAlert(url = instanceBase): KnownInstance["watch_alert"] {
  return knownInstances().find((known) => known.url === url)?.watch_alert;
}

export function clearWatchAlert(url = instanceBase): void {
  localStorage.setItem(
    LIST_KEY,
    JSON.stringify(
      knownInstances().map((known) => {
        if (known.url !== url) return known;
        const { watch_alert: _descartado, ...resto } = known;
        return resto;
      }),
    ),
  );
}

if (typeof window !== "undefined") {
  window.distop?.availability.onOpen((url) => { localStorage.setItem(ACTIVE_KEY, url); location.reload(); });

  /* El vigilante llega por `watch_url`, que puede no ser la misma cadena que la
     dirección con la que se guardó la instancia (una acaba en barra, la otra
     no). Se casa por las dos. */
  window.distop?.availability.onAlert((alert) => {
    const ahora = Date.now();
    localStorage.setItem(
      LIST_KEY,
      JSON.stringify(
        knownInstances().map((known) => {
          if (known.url !== alert.url && known.watch_url !== alert.url) return known;
          const detalle = alert.kind === "identity_conflict" ? alert.fingerprint : alert.protocol;
          const marcada = { ...known, watch_alert: { kind: alert.kind, at: ahora, detail: detalle } };
          /* Un conflicto visto por el vigilante es el mismo conflicto que
             detecta el cliente al conectar: se anota donde ya lo lee la
             interfaz, para que no haya dos verdades sobre lo mismo. */
          return alert.kind === "identity_conflict"
            ? { ...marcada, conflict: { seen_fingerprint: alert.fingerprint, seen_at: ahora, reason: "WATCH_IDENTITY_CONFLICT" } }
            : marcada;
        }),
      ),
    );
  });
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
