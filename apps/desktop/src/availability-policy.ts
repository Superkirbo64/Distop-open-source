/**
 * Reglas de la vigilancia de instancias: qué cuenta como "volvió", qué cuenta
 * como "se trasladó", cuándo se avisa y cuándo se vuelve a mirar. Aparte para
 * poder probarlo sin arrancar Electron, igual que apps-policy y game-detection.
 *
 * Las reglas de sucesión NO viven aquí: vienen de @distop/protocol, las mismas
 * que aplican el servidor y el navegador. Tenerlas copiadas sería peor que no
 * tenerlas: una copia que se queda atrás rechaza relevos legítimos o acepta
 * cadenas que el resto del sistema ya no acepta, y nadie se entera hasta que
 * alguien pierde su comunidad.
 */
import { createHash, createPublicKey, verify, type JsonWebKey } from "node:crypto";
import {
  PROTOCOL_VERSION,
  SUCCESSION_CHAIN_MAX,
  canonicalJson,
  checkSuccessionStep,
  compareIdentities,
  type InstanceIdentityRef,
  type SuccessionCert,
} from "@distop/protocol";

export { canonicalJson };

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
 * Los seis finales posibles de un sondeo.
 *
 * Hasta C2 solo había dos —"está" y "no está"— porque sin certificado de
 * sucesión no se podía distinguir un relevo legítimo de alguien que se puso en
 * esa dirección con un número de época más alto. Ahora la cadena firmada existe
 * y esa distinción se puede hacer con pruebas, así que se hace: mandar a
 * alguien a una dirección nueva y no mandarlo son decisiones demasiado
 * distintas como para esconderlas las dos detrás de "no disponible".
 *
 * - `available_same`        la de siempre, viva y firmando. La única que dice "volvió".
 * - `available_successor`   otra máquina continúa la línea, y lo demuestra.
 * - `unavailable`           no contesta, o contesta y no demuestra nada.
 * - `identity_conflict`     contesta algo que solo se sostiene mintiendo: fork o cadena falsa.
 * - `membership_revoked`    ya no eres miembro. Ni se sondea ni se guarda el nombre.
 * - `protocol_incompatible` habla otra versión del protocolo. No se le manda nada.
 */
export type Outcome =
  | "available_same"
  | "available_successor"
  | "unavailable"
  | "identity_conflict"
  | "membership_revoked"
  | "protocol_incompatible";

/**
 * Lo que se puede decidir mirando solo la prueba firmada, sin pedir la cadena.
 * `successor_claimed` es justo eso: una afirmación, todavía sin respaldo.
 */
export type ProofVerdict =
  | "available_same"
  | "successor_claimed"
  | "identity_conflict"
  | "protocol_incompatible"
  | "unavailable";

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
    protocol?: string;
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
  /** Destino ya anunciado. Una mudanza se cuenta una vez, no cada minuto. */
  moved_origin: string | null;
  /** Conflicto de identidad: se deja de sondear hasta que una persona decida. */
  blocked: boolean;
  /** El anterior, para avisar de un cambio y no del mismo estado repetido. */
  last_outcome: Outcome | null;
}

/** La identidad fijada, en la forma que entienden las reglas compartidas. */
export function pinnedRef(known: KnownIdentity): InstanceIdentityRef {
  return {
    instance_id: known.instance_id,
    lineage_id: known.lineage_id,
    epoch: known.epoch,
    fingerprint: known.identity_fingerprint,
  };
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

/** Una versión de protocolo distinta es incompatible; ausente, no se juzga. */
export function protocolMismatch(protocol: unknown): boolean {
  return typeof protocol === "string" && protocol !== "" && protocol !== PROTOCOL_VERSION;
}

function fingerprintOf(jwk: unknown): string {
  return createHash("sha256").update(canonicalJson(jwk)).digest("base64url");
}

/**
 * Qué dice quien respondió, verificado contra su propia clave.
 *
 * El orden importa: primero se comprueba que la firma es suya de verdad y solo
 * después se mira quién dice ser. Al revés, cualquiera que escribiera la época
 * correcta en un JSON conseguiría un veredicto — y `identity_conflict` es una
 * alarma de seguridad, no algo que deba poder disparar un fichero de texto.
 */
export function verifyProof(
  known: KnownIdentity,
  proof: SignedProof | null | undefined,
  nonce: string,
  now: number,
): ProofVerdict {
  try {
    if (!proof?.payload || typeof proof.signature !== "string") return "unavailable";
    const payload = proof.payload;
    if (payload.t !== "DISTOP_INSTANCE_PROOF") return "unavailable";

    /* La huella se recalcula sobre la clave que llega: fiarse de la declarada
       dejaría a cualquiera decir que es la fijada y firmar con otra cosa. */
    const fingerprint = fingerprintOf(proof.public_key);
    if (proof.fingerprint !== fingerprint) return "unavailable";

    if (payload.origin !== known.url || payload.nonce !== nonce) return "unavailable";
    if (payload.issued_at > now + 5_000 || payload.expires_at < now) return "unavailable";

    const valid = verify(
      "sha256",
      Buffer.from(canonicalJson(payload)),
      { key: createPublicKey({ key: proof.public_key, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(proof.signature, "base64url"),
    );
    if (!valid) return "unavailable";

    /* A partir de aquí lo que dice es suyo. Ahora sí: quién dice ser.
       El protocolo se mira antes que la identidad porque una instancia que
       habla otra versión puede estar diciendo la verdad y aun así no
       entendernos: eso no es un impostor, es una que hay que actualizar. */
    if (protocolMismatch(payload.protocol)) return "protocol_incompatible";

    const veredicto = compareIdentities(pinnedRef(known), {
      instance_id: payload.instance_id,
      lineage_id: payload.lineage_id,
      epoch: payload.epoch,
      fingerprint,
    });

    if (veredicto === "same") {
      /* Misma clave y misma época pero otro identificador de máquina no tiene
         explicación buena; y en reserva o retirada no es la que sirve. */
      if (payload.instance_id !== known.instance_id) return "unavailable";
      if (canonicalJson(proof.public_key) !== canonicalJson(known.identity_public_key)) return "unavailable";
      return payload.role === "PRIMARY" ? "available_same" : "unavailable";
    }
    if (veredicto === "fork") return "identity_conflict";
    if (veredicto === "successor") return "successor_claimed";
    /* `stale` es una copia vieja sirviendo; `unrelated`, otra comunidad. */
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

export interface ChainResult {
  final: InstanceIdentityRef;
  chain: SuccessionCert[];
  /** Direcciones que el certificado autoriza. Vacío = ninguna demostrable. */
  origins: string[];
}

/** Un eslabón: reglas compartidas primero, firma después. */
function verifyStep(cert: SuccessionCert, from: InstanceIdentityRef, now: number): string | null {
  if (!cert?.payload || typeof cert.signature !== "string") return "MALFORMED";
  const fingerprint = fingerprintOf(cert.signer_public_key);
  if (fingerprint !== cert.signer_fingerprint) return "SIGNER_KEY_MISMATCH";
  /* Quien firma tiene que ser exactamente el eslabón anterior. Sin esto la
     cadena la podría empezar cualquiera con una clave cualquiera. */
  if (fingerprint !== from.fingerprint) return "SIGNER_NOT_PREDECESSOR";

  const reglas = checkSuccessionStep(from, cert.payload, now);
  if (reglas) return reglas;

  try {
    const valid = verify(
      "sha256",
      Buffer.from(canonicalJson(cert.payload)),
      {
        key: createPublicKey({ key: cert.signer_public_key as JsonWebKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(cert.signature, "base64url"),
    );
    return valid ? null : "BAD_SIGNATURE";
  } catch {
    return "BAD_SIGNATURE";
  }
}

/**
 * Recorre la cadena desde la identidad fijada. Devuelve `null` si un solo
 * eslabón no encaja: media cadena verificada no es media confianza, es ninguna.
 */
export function verifyChain(pinned: InstanceIdentityRef, chain: unknown, now: number): ChainResult | null {
  if (!Array.isArray(chain) || chain.length === 0 || chain.length > SUCCESSION_CHAIN_MAX) return null;
  let actual = pinned;
  let origins: string[] = [];
  for (const cert of chain as SuccessionCert[]) {
    if (verifyStep(cert, actual, now)) return null;
    actual = {
      instance_id: cert.payload.to_instance_id,
      lineage_id: cert.payload.lineage_id,
      epoch: cert.payload.to_epoch,
      fingerprint: cert.payload.to_fingerprint,
    };
    origins = Array.isArray(cert.payload.allowed_origins) ? cert.payload.allowed_origins : [];
  }
  return { final: actual, chain: chain as SuccessionCert[], origins };
}

/**
 * El destino de una mudanza sale del certificado, no del cuerpo de la
 * respuesta. `successor_origin` es un campo sin firmar en la base de datos de
 * una máquina que puede haber sido tocada; `allowed_origins` va dentro de lo
 * que firmó el predecesor. Solo se acepta un destino que esté en las dos.
 */
export function provenOrigin(declared: unknown, chain: ChainResult): string | null {
  if (typeof declared !== "string") return null;
  const origin = stableWatchUrl(declared);
  if (!origin) return null;
  const firmadas = chain.origins
    .map((raw) => (typeof raw === "string" ? stableWatchUrl(raw) : null))
    .filter((value): value is string => value !== null);
  return firmadas.includes(origin) ? origin : null;
}

export type Notice = { kind: "back" } | { kind: "moved"; origin: string } | null;

export interface CheckResult {
  timing: WatchTiming;
  notify: Notice;
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
  movedOrigin: string | null = null,
): CheckResult {
  const dispersion = Math.max(0, Math.min(DISPERSION_MS, Math.floor(jitterMs)));
  const espaciado = (largo: boolean): number => now + (largo ? INTERVALO_LARGO_MS : INTERVALO_NORMAL_MS) + dispersion;

  if (outcome === "identity_conflict" || outcome === "membership_revoked") {
    /* Se deja de sondear. Seguir llamando a una dirección que afirma ser tu
       comunidad sin poder demostrarlo no aporta nada, y reintentar hasta que
       "salga bien" es exactamente cómo un conflicto de identidad acaba
       aceptándose por cansancio. Lo desbloquea una persona, no un temporizador. */
    return {
      timing: { ...timing, failures: timing.failures + 1, blocked: true, next_check: espaciado(true) },
      notify: null,
    };
  }

  if (outcome === "protocol_incompatible") {
    /* Contesta y es quien dice ser, pero habla otro idioma. No es una ausencia
       —no se cuenta como caída— y no se le manda nada. Se mira de vez en cuando
       por si su anfitrión la actualiza. */
    return { timing: { ...timing, next_check: espaciado(true) }, notify: null };
  }

  if (outcome === "unavailable") {
    const offlineSince = timing.offline_since ?? now;
    return {
      timing: {
        ...timing,
        failures: timing.failures + 1,
        offline_since: offlineSince,
        next_check: espaciado(now - offlineSince >= CAIDA_LARGA_MS),
      },
      notify: null,
    };
  }

  if (outcome === "available_successor") {
    /* Una mudanza demostrada no es una vuelta y no se cuenta como tal: no gasta
       el silencio de los avisos de disponibilidad ni depende de que hubiera
       ausencia previa. Pero se anuncia UNA vez por destino — es un hecho
       permanente, no una novedad que se repite cada minuto. */
    const nueva = movedOrigin !== null && movedOrigin !== timing.moved_origin;
    return {
      timing: {
        ...timing,
        failures: 0,
        offline_since: null,
        moved_origin: movedOrigin ?? timing.moved_origin,
        next_check: espaciado(true),
      },
      notify: nueva ? { kind: "moved", origin: movedOrigin } : null,
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
      ...timing,
      failures: 0,
      offline_since: null,
      /* Volvió la de siempre: si antes se anunció una mudanza, ya no vale. */
      moved_origin: null,
      last_notification: avisar ? now : timing.last_notification,
      next_check: now + INTERVALO_NORMAL_MS + dispersion,
    },
    notify: avisar ? { kind: "back" } : null,
  };
}
