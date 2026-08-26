/**
 * Reglas de la vigilancia de instancias: qué cuenta como "volvió", cuándo se
 * avisa y cuándo se vuelve a mirar. Aparte para poder probarlo sin arrancar
 * Electron, igual que apps-policy y game-detection.
 */
import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";

/** Dos fallos seguidos antes de dar una instancia por caída. */
export const FALLOS_PARA_CAIDA = 2;
/** Un reinicio rápido no es una ausencia: por debajo de esto no se avisa. */
export const CAIDA_MINIMA_MS = 90_000;
/** Si la conexión oscila, se avisa como mucho una vez cada media hora. */
export const SILENCIO_ENTRE_AVISOS_MS = 30 * 60_000;
export const INTERVALO_NORMAL_MS = 60_000;
/** Tras un buen rato caída se espacia: nadie gana con 4.000 sondeos. */
export const INTERVALO_LARGO_MS = 5 * 60_000;
export const CAIDA_LARGA_MS = 15 * 60_000;
/** Variación para que cuarenta miembros no golpeen el servidor a la vez. */
export const DISPERSION_MS = 15_000;

const ESTADOS_DISPONIBLES = new Set(["ONLINE", "DEGRADED"]);

/**
 * Dos resultados, y de momento solo dos.
 *
 * Es tentador añadir un tercero —"se mudó"— para la instancia que responde con
 * una época mayor. Todavía no: sin certificado de sucesión, esa respuesta la
 * puede dar cualquiera que se ponga en esa dirección, y mandar a alguien a un
 * sitio nuevo porque el sitio nuevo lo dice es exactamente el ataque. Hasta que
 * exista la cadena firmada (C2/C3), cualquier cosa que no sea "la misma de
 * siempre, viva" se cuenta como no disponible.
 */
export type Outcome = "available" | "unavailable";

export interface KnownIdentity {
  url: string;
  instance_id: string;
  lineage_id: string;
  epoch: number;
  identity_fingerprint: string;
  identity_public_key: JsonWebKey;
}

export interface SignedProof {
  payload: {
    t: string;
    instance_id: string;
    lineage_id: string;
    epoch: number;
    role: string;
    origin: string;
    nonce: string;
    issued_at: number;
    expires_at: number;
  };
  signature: string;
  public_key: JsonWebKey;
  fingerprint: string;
}

export interface WatchTiming {
  failures: number;
  offline_since: number | null;
  last_notification: number;
  next_check: number;
}

/** JSON con las claves ordenadas: la firma se hace sobre esto, no sobre el orden que llegue. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/**
 * Solo se vigilan direcciones que puedan volver a ser la misma. Un túnel rápido
 * estrena URL en cada arranque, así que vigilarlo sería prometer un aviso que
 * nunca llega; y aceptar una URL cualquiera convertiría esto en un escáner.
 */
export function stableWatchUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (url.hostname.endsWith(".trycloudflare.com")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Arrancando o en mantenimiento todavía no es "disponible". */
export function healthCounts(status: unknown): boolean {
  return typeof status === "string" && ESTADOS_DISPONIBLES.has(status);
}

/**
 * Verifica que quien respondió es de verdad la instancia fijada: misma clave,
 * misma huella, mismo linaje, misma época, el nonce que acabamos de mandar y la
 * dirección desde la que preguntamos. Cualquier diferencia es "no disponible":
 * no se distingue todavía la mudanza legítima del impostor, y confundirlas
 * cuesta más que esperar.
 */
export function verifyProof(
  known: KnownIdentity,
  proof: SignedProof | null | undefined,
  nonce: string,
  now: number,
): Outcome {
  try {
    if (!proof?.payload || typeof proof.signature !== "string") return "unavailable";
    const encodedKey = canonicalJson(proof.public_key);
    const fingerprint = createHash("sha256").update(encodedKey).digest("base64url");
    if (fingerprint !== known.identity_fingerprint || proof.fingerprint !== fingerprint) return "unavailable";
    if (encodedKey !== canonicalJson(known.identity_public_key)) return "unavailable";

    const payload = proof.payload;
    if (payload.t !== "DISTOP_INSTANCE_PROOF") return "unavailable";
    if (payload.instance_id !== known.instance_id || payload.lineage_id !== known.lineage_id) return "unavailable";
    if (payload.origin !== known.url || payload.nonce !== nonce) return "unavailable";
    if (payload.issued_at > now + 5_000 || payload.expires_at < now) return "unavailable";
    /* Una época menor es una copia vieja sirviendo. Una mayor puede ser un
       relevo de verdad o alguien que se puso ahí y escribió un número más alto;
       sin la cadena firmada de C2 no hay forma de saberlo, así que ninguna de
       las dos cuenta como "volvió". */
    if (payload.epoch !== known.epoch) return "unavailable";

    const valid = verify(
      "sha256",
      Buffer.from(canonicalJson(payload)),
      { key: createPublicKey({ key: proof.public_key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(proof.signature, "base64url"),
    );
    if (!valid) return "unavailable";

    if (payload.role !== "PRIMARY") return "unavailable";
    return "available";
  } catch {
    return "unavailable";
  }
}

export interface CheckResult {
  timing: WatchTiming;
  notify: "back" | null;
}

/**
 * Aplica un resultado al reloj de una vigilancia. Recibe la dispersión en vez de
 * generarla para que la prueba pueda fijarla: el azar dentro de la función haría
 * el reparto de sondeos imposible de comprobar.
 */
export function applyCheck(
  timing: WatchTiming,
  outcome: Outcome,
  now: number,
  jitterMs = 0,
): CheckResult {
  const dispersion = Math.max(0, Math.min(DISPERSION_MS, Math.floor(jitterMs)));

  if (outcome === "unavailable") {
    const offlineSince = timing.offline_since ?? now;
    const caidaLarga = now - offlineSince >= CAIDA_LARGA_MS;
    return {
      timing: {
        failures: timing.failures + 1,
        offline_since: offlineSince,
        last_notification: timing.last_notification,
        next_check: now + (caidaLarga ? INTERVALO_LARGO_MS : INTERVALO_NORMAL_MS) + dispersion,
      },
      notify: null,
    };
  }

  const caidaReal =
    timing.offline_since !== null &&
    timing.failures >= FALLOS_PARA_CAIDA &&
    now - timing.offline_since >= CAIDA_MINIMA_MS;
  const fueraDeSilencio = now - timing.last_notification >= SILENCIO_ENTRE_AVISOS_MS;
  /* Solo se avisa de una vuelta que alguien echó de menos. Sin ausencia previa
     no hay noticia que dar, y repetirla cada vez que la conexión parpadea
     convierte el aviso en algo que se desactiva. */
  const avisar = caidaReal && fueraDeSilencio;

  return {
    timing: {
      failures: 0,
      offline_since: null,
      last_notification: avisar ? now : timing.last_notification,
      next_check: now + INTERVALO_NORMAL_MS + dispersion,
    },
    notify: avisar ? "back" : null,
  };
}
