/**
 * Relevo planificado: certificados de sucesión y el estado que los rodea (C2).
 *
 * El problema que resuelve, dicho entero: quien hospeda quiere dejar de
 * hospedar, y sus miembros tienen fijada la clave pública de SU máquina. Copiar
 * esa clave privada al equipo nuevo sería lo fácil y sería lo peor — dos
 * máquinas capaces de firmar como la misma instancia, para siempre, sin forma
 * de revocar ninguna.
 *
 * En vez de eso, el sucesor genera su propia clave y el predecesor firma un
 * certificado que dice "yo, que soy quien tenías fijado, autorizo a esta otra
 * clave a continuar la línea en la época siguiente". El cliente que tenía
 * fijada la vieja puede seguir la cadena hasta la nueva sin confiar en nadie
 * más. Quien nunca vio a la vieja no puede: eso es una limitación real y está
 * escrita como tal (§11.2).
 */
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify, type JsonWebKey } from "node:crypto";
import {
  MAX_SIGNED_ORIGINS,
  ORIGIN_SET_TYPE,
  SUCCESSION_CERT_TYPE,
  SUCCESSION_CHAIN_MAX,
  canonicalJson,
  checkSuccessionStep,
  uuidv7,
  type InstanceIdentityRef,
  type OriginSetPayload,
  type SignedOrigin,
  type SignedOriginSet,
  type SuccessionCert,
  type SuccessionCertPayload,
} from "@distop/protocol";
import { audit, db, meta, setMeta } from "./db.ts";
import {
  LINEAGE_ID,
  huellaDe,
  instanceEpoch,
  instanceFingerprint,
  instancePublicKey,
  normalizeProofOrigin,
  signAsInstance,
} from "./identity.ts";

/** Cuánto vale un código de emparejamiento antes de caducar. */
export const ENROL_TTL_MS = 30 * 60_000;
/** Cuánto vale una autorización de sucesor sin usarse. */
export const SUCCESSOR_TTL_MS = 30 * 24 * 60 * 60_000;
/** Aviso por defecto antes de poder activar un relevo normal (§5.3). */
export const AVISO_NORMAL_MS = 24 * 60 * 60_000;
/** Un certificado emitido no vale eternamente: si el relevo no se activa, caduca. */
export const CERT_TTL_MS = 90 * 24 * 60 * 60_000;

export type HandoverState =
  | "PREPARING"
  | "STANDBY_SYNC"
  | "READY_TO_ACTIVATE"
  | "ACTIVATING"
  | "COMPLETED"
  | "ABORTED"
  | "FAILED";

const VIVOS: HandoverState[] = ["PREPARING", "STANDBY_SYNC", "READY_TO_ACTIVATE", "ACTIVATING"];

export interface SuccessorRow {
  id: string;
  label: string;
  created_by: string | null;
  enrol_hash: string;
  transfer_hash: string | null;
  instance_id: string | null;
  fingerprint: string | null;
  public_key: string | null;
  origin: string | null;
  max_epoch: number;
  created_at: number;
  expires_at: number;
  enrolled_at: number | null;
  last_seen: number | null;
  revoked_at: number | null;
}

export interface HandoverRow {
  id: string;
  successor_id: string;
  state: HandoverState;
  unplanned: number;
  reason: string | null;
  to_epoch: number;
  certificate: string | null;
  receipt: string | null;
  bundle_hash: string | null;
  bundle_key: string | null;
  announced_at: number | null;
  activates_at: number;
  started_at: number;
  finished_at: number | null;
  error_code: string | null;
}

export class SuccessionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/* ── códigos de emparejamiento ────────────────────────────────────────── */

/** Se guarda el hash, nunca el código: la base de una instancia acaba dentro de
    una copia de seguridad, y un código en claro ahí sería una puerta abierta. */
function hashCodigo(code: string): string {
  return createHash("sha256").update(code.trim().toUpperCase()).digest("hex");
}

function mismoHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === 32 && y.length === 32 && timingSafeEqual(x, y);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * El sucesor detrás de un testigo de transferencia.
 *
 * Se busca por hash EN LA BASE y no en un mapa en memoria: un relevo de treinta
 * gigas puede cruzar un reinicio del servidor, y obligar a volver a
 * emparejarse cada vez que la instancia se apaga haría inútil el código de un
 * solo uso — no queda ninguno para reintentar.
 */
export function successorByToken(token: string): SuccessorRow | undefined {
  if (!token) return undefined;
  const objetivo = hashToken(token);
  const filas = db
    .prepare("SELECT * FROM successors WHERE transfer_hash IS NOT NULL AND revoked_at IS NULL")
    .all() as SuccessorRow[];
  return filas.find((fila) => mismoHash(fila.transfer_hash!, objetivo));
}

export function setTransferToken(successorId: string, token: string): void {
  db.prepare("UPDATE successors SET transfer_hash = ? WHERE id = ?").run(hashToken(token), successorId);
}

/** Grupos legibles: alguien va a leer esto en voz alta por teléfono. */
function nuevoCodigo(): string {
  const alfabeto = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin I, O, 0, 1
  const bytes = randomBytes(16);
  let salida = "";
  for (let i = 0; i < 16; i++) {
    if (i > 0 && i % 4 === 0) salida += "-";
    salida += alfabeto[bytes[i]! % alfabeto.length];
  }
  return salida;
}

/* ── autorizaciones ───────────────────────────────────────────────────── */

export function listSuccessors(): SuccessorRow[] {
  return db.prepare("SELECT * FROM successors ORDER BY created_at DESC").all() as SuccessorRow[];
}

export function findSuccessor(id: string): SuccessorRow | undefined {
  return db.prepare("SELECT * FROM successors WHERE id = ?").get(id) as SuccessorRow | undefined;
}

/**
 * Autoriza a un futuro sucesor y devuelve su código de emparejamiento.
 *
 * El código se enseña UNA vez. Volver a mostrarlo obligaría a guardarlo en
 * claro, y entonces cualquiera con acceso a la base —o a una copia de
 * seguridad— podría enrolarse como sucesor de una instancia que no es suya.
 */
export function authorizeSuccessor(opts: { label: string; createdBy: string }): { row: SuccessorRow; code: string } {
  const code = nuevoCodigo();
  const id = uuidv7();
  const now = Date.now();
  db.prepare(
    `INSERT INTO successors (id, label, created_by, enrol_hash, max_epoch, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.label.slice(0, 80), opts.createdBy, hashCodigo(code), instanceEpoch() + 1, now, now + SUCCESSOR_TTL_MS);
  return { row: findSuccessor(id)!, code };
}

export function revokeSuccessor(id: string): void {
  db.prepare("UPDATE successors SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), id);
  /* Un relevo en marcha con ese sucesor deja de tener sentido: revocarlo es
     decir "esa máquina ya no", y dejar el relevo vivo sería contradecirlo. */
  db.prepare(
    `UPDATE handovers SET state = 'ABORTED', finished_at = ?, error_code = 'SUCCESSOR_REVOKED'
      WHERE successor_id = ? AND state IN (${VIVOS.map(() => "?").join(",")})`,
  ).run(Date.now(), id, ...VIVOS);
}

/** El sucesor se presenta con su código, su identidad nueva y su dirección. */
export function enrolSuccessor(opts: {
  code: string;
  instanceId: string;
  publicKey: JsonWebKey;
  origin: string;
}): SuccessorRow {
  const objetivo = hashCodigo(opts.code);
  const now = Date.now();
  const candidatas = db
    .prepare("SELECT * FROM successors WHERE revoked_at IS NULL AND expires_at > ?")
    .all(now) as SuccessorRow[];
  const fila = candidatas.find((row) => mismoHash(row.enrol_hash, objetivo));
  if (!fila) throw new SuccessionError("ENROL_CODE_INVALID", "Ese código no vale, o ya caducó.");
  if (fila.enrolled_at !== null) throw new SuccessionError("ENROL_CODE_USED", "Ese código ya se usó una vez.");

  const huella = huellaDe(opts.publicKey);
  if (huella === instanceFingerprint()) {
    throw new SuccessionError("SAME_KEY", "El sucesor tiene que traer una clave propia, no la de esta instancia.");
  }
  if (!opts.instanceId || opts.instanceId === (db.prepare("SELECT value FROM meta WHERE key='instance_id'").get() as { value: string }).value) {
    throw new SuccessionError("SAME_INSTANCE", "El sucesor tiene que ser otra instancia.");
  }
  /* La clave tiene que ser una P-256 de verdad: si no, el certificado que
     firmemos autorizaría a algo que nadie puede verificar. */
  try {
    const key = createPublicKey({ key: opts.publicKey, format: "jwk" });
    if (key.asymmetricKeyType !== "ec") throw new Error("no-ec");
  } catch {
    throw new SuccessionError("BAD_KEY", "La clave del sucesor no es una clave P-256 válida.");
  }
  const origen = normalizeProofOrigin(opts.origin);

  db.prepare(
    `UPDATE successors SET instance_id = ?, fingerprint = ?, public_key = ?, origin = ?, enrolled_at = ?, last_seen = ?
      WHERE id = ?`,
  ).run(opts.instanceId, huella, JSON.stringify(opts.publicKey), origen, now, now, fila.id);
  return findSuccessor(fila.id)!;
}

/* ── certificado ──────────────────────────────────────────────────────── */

export function currentIdentity(): InstanceIdentityRef {
  const instanceId = (db.prepare("SELECT value FROM meta WHERE key='instance_id'").get() as { value: string }).value;
  return { instance_id: instanceId, lineage_id: LINEAGE_ID, epoch: instanceEpoch(), fingerprint: instanceFingerprint() };
}

/**
 * Emite el certificado que autoriza al sucesor.
 *
 * Se firma al ENROLAR, no al terminar la transferencia. Si se emitiera al
 * final y el equipo de origen muriera entre el recibo y la entrega, el sucesor
 * se quedaría con la copia completa y sin forma de activarla: la comunidad
 * muerta con los datos vivos delante. Prefirmar mueve el riesgo al lado
 * correcto, que es el de la máquina que se asume que va a desaparecer.
 */
export function mintSuccessionCert(opts: {
  successor: SuccessorRow;
  handoverId: string;
  notBefore: number;
  now?: number;
}): SuccessionCert {
  const now = opts.now ?? Date.now();
  const desde = currentIdentity();
  if (!opts.successor.instance_id || !opts.successor.fingerprint || !opts.successor.public_key) {
    throw new SuccessionError("SUCCESSOR_NOT_ENROLLED", "Ese sucesor todavía no se ha presentado con su clave.");
  }

  const payload: SuccessionCertPayload = {
    t: SUCCESSION_CERT_TYPE,
    version: 1,
    lineage_id: desde.lineage_id,
    from_instance_id: desde.instance_id,
    from_epoch: desde.epoch,
    from_fingerprint: desde.fingerprint,
    to_instance_id: opts.successor.instance_id,
    to_epoch: desde.epoch + 1,
    to_fingerprint: opts.successor.fingerprint,
    to_public_key: JSON.parse(opts.successor.public_key) as Record<string, unknown>,
    allowed_origins: opts.successor.origin ? [opts.successor.origin] : [],
    issued_at: now,
    not_before: opts.notBefore,
    expires_at: now + CERT_TTL_MS,
    handover_id: opts.handoverId,
  };

  return {
    payload,
    signature: signAsInstance(canonicalJson(payload)),
    signer_public_key: instancePublicKey() as Record<string, unknown>,
    signer_fingerprint: instanceFingerprint(),
  };
}

/**
 * Comprueba un certificado suelto: que lo firmó quien dice, y que dice algo
 * coherente respecto a la identidad desde la que se parte.
 */
export function verifySuccessionCert(cert: SuccessionCert, from: InstanceIdentityRef, now = Date.now()): string | null {
  if (!cert?.payload || typeof cert.signature !== "string") return "MALFORMED";
  /* La huella se recalcula sobre la clave que llega. Fiarse de la que viene
     escrita permitiría a cualquiera declarar la huella buena y firmar con otra. */
  if (huellaDe(cert.signer_public_key as JsonWebKey) !== cert.signer_fingerprint) return "SIGNER_KEY_MISMATCH";
  /* Y el firmante tiene que ser exactamente la instancia de la que partimos:
     un certificado firmado por un tercero no autoriza nada. */
  if (cert.signer_fingerprint !== from.fingerprint) return "SIGNER_NOT_PREDECESSOR";

  const reglas = checkSuccessionStep(from, cert.payload, now);
  if (reglas) return reglas;

  try {
    const ok = verify(
      "sha256",
      Buffer.from(canonicalJson(cert.payload)),
      { key: createPublicKey({ key: cert.signer_public_key as JsonWebKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
      Buffer.from(cert.signature, "base64url"),
    );
    return ok ? null : "BAD_SIGNATURE";
  } catch {
    return "BAD_SIGNATURE";
  }
}

/**
 * Sigue una cadena entera desde la identidad fijada hasta el final.
 *
 * Devuelve dónde acaba la línea, o el motivo del rechazo. Cada eslabón se
 * verifica contra el anterior: nadie puede insertar un certificado en medio sin
 * la clave privada del eslabón que lo precede.
 */
export function verifySuccessionChain(
  pinned: InstanceIdentityRef,
  chain: SuccessionCert[],
  now = Date.now(),
): { ok: true; final: InstanceIdentityRef; origins: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(chain)) return { ok: false, reason: "MALFORMED" };
  if (chain.length > SUCCESSION_CHAIN_MAX) return { ok: false, reason: "CHAIN_TOO_LONG" };

  let actual = pinned;
  let origins: string[] = [];
  for (const cert of chain) {
    const fallo = verifySuccessionCert(cert, actual, now);
    if (fallo) return { ok: false, reason: fallo };
    actual = {
      instance_id: cert.payload.to_instance_id,
      lineage_id: cert.payload.lineage_id,
      epoch: cert.payload.to_epoch,
      fingerprint: cert.payload.to_fingerprint,
    };
    origins = cert.payload.allowed_origins;
  }
  return { ok: true, final: actual, origins };
}

/* ── relevos ──────────────────────────────────────────────────────────── */

export function activeHandover(): HandoverRow | undefined {
  return db
    .prepare(`SELECT * FROM handovers WHERE state IN (${VIVOS.map(() => "?").join(",")}) ORDER BY started_at DESC LIMIT 1`)
    .get(...VIVOS) as HandoverRow | undefined;
}

export function findHandover(id: string): HandoverRow | undefined {
  return db.prepare("SELECT * FROM handovers WHERE id = ?").get(id) as HandoverRow | undefined;
}

export function setHandoverState(id: string, state: HandoverState, errorCode: string | null = null): void {
  const cerrado = state === "COMPLETED" || state === "ABORTED" || state === "FAILED";
  /* Solo se mueve un relevo que siga VIVO. Cerrado es cerrado: la copia se
     prepara en segundo plano y puede terminar DESPUÉS de que el anfitrión
     cancelara. Sin este filtro, ese trabajo tardío reescribía el ABORTED con
     STANDBY_SYNC y resucitaba un relevo que ya nadie quería; a partir de ahí
     todo intento de arrancar otro moría con HANDOVER_IN_PROGRESS y la única
     salida era reiniciar la instancia. */
  db.prepare(
    `UPDATE handovers SET state = ?, error_code = ?, finished_at = ?
      WHERE id = ? AND state IN (${VIVOS.map(() => "?").join(",")})`,
  ).run(state, errorCode, cerrado ? Date.now() : null, id, ...VIVOS);
}

/**
 * Arranca un relevo y prefirma su certificado.
 *
 * `unplanned` existe porque prohibir todo relevo antes de 24 h haría imposible
 * salvar una instancia cuando el disco está fallando o el equipo se apaga esta
 * tarde. Lo que NO se hace es fingir que hubo aviso: queda marcado, se audita, y
 * la interfaz tiene que decirlo (§5.3).
 */
export function startHandover(opts: {
  successorId: string;
  actorId: string;
  unplanned: boolean;
  reason: string | null;
  noticeMs?: number;
}): { handover: HandoverRow; cert: SuccessionCert } {
  if (activeHandover()) throw new SuccessionError("HANDOVER_IN_PROGRESS", "Ya hay un relevo en marcha.");

  const sucesor = findSuccessor(opts.successorId);
  if (!sucesor || sucesor.revoked_at !== null) throw new SuccessionError("SUCCESSOR_UNKNOWN", "Ese sucesor no existe.");
  if (sucesor.enrolled_at === null) {
    throw new SuccessionError("SUCCESSOR_NOT_ENROLLED", "Ese sucesor todavía no se ha presentado con su clave.");
  }

  const now = Date.now();
  const espera = opts.unplanned ? 0 : (opts.noticeMs ?? AVISO_NORMAL_MS);
  const id = uuidv7();
  const toEpoch = instanceEpoch() + 1;

  db.prepare(
    `INSERT INTO handovers (id, successor_id, state, unplanned, reason, to_epoch, announced_at, activates_at, started_at)
     VALUES (?, ?, 'PREPARING', ?, ?, ?, ?, ?, ?)`,
  ).run(id, sucesor.id, opts.unplanned ? 1 : 0, opts.reason, toEpoch, now, now + espera, now);

  const cert = mintSuccessionCert({ successor: sucesor, handoverId: id, notBefore: now, now });
  db.prepare("UPDATE handovers SET certificate = ? WHERE id = ?").run(JSON.stringify(cert), id);

  /* Los miembros tienen derecho a saber que su comunidad va a cambiar de manos
     y cuándo, no a enterarse el día que la dirección deja de responder. */
  for (const row of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
    audit(row.id, opts.actorId, "INSTANCE_HANDOVER_STARTED", id, {
      successor: sucesor.label,
      unplanned: opts.unplanned,
      activates_at: now + espera,
      reason: opts.reason,
    });
  }
  return { handover: findHandover(id)!, cert };
}

/**
 * Deja constancia de a quién pasó la línea, para poder contestar `410` con la
 * cadena aunque esta instancia vuelva a arrancar dentro de un año.
 */
export function recordSuccession(cert: SuccessionCert, origin: string | null): void {
  setMeta(
    "succeeded_by",
    JSON.stringify({ origin, certificate: cert, recorded_at: Date.now() }),
  );
}

/* ── direcciones alternativas firmadas (C3 §3.1) ──────────────────────── */

/** Cuánto vale un conjunto de orígenes antes de tener que refrescarse. */
const ORIGENES_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * Firma la lista de direcciones por las que se puede encontrar esta instancia.
 *
 * `generation` sube en cada cambio y el cliente nunca acepta una menor. Sin eso,
 * reponer una lista vieja sería un ataque gratis: bastaría con guardar la
 * respuesta de hace un mes —cuando la instancia estaba en una dirección que
 * ahora controla otro— y devolverla firmada y todo.
 */
export function mintOriginSet(origins: SignedOrigin[], now = Date.now()): SignedOriginSet {
  if (origins.length > MAX_SIGNED_ORIGINS) {
    throw new SuccessionError("TOO_MANY_ORIGINS", `Como máximo ${MAX_SIGNED_ORIGINS} direcciones alternativas.`);
  }
  const generacion = Number.parseInt(meta("origin_generation", () => "0"), 10) + 1;
  setMeta("origin_generation", String(generacion));

  const desde = currentIdentity();
  const payload: OriginSetPayload = {
    t: ORIGIN_SET_TYPE,
    version: 1,
    lineage_id: desde.lineage_id,
    instance_id: desde.instance_id,
    epoch: desde.epoch,
    generation: generacion,
    origins: origins.map((origen) => ({
      url: normalizeProofOrigin(origen.url),
      priority: Math.max(0, Math.min(100, Math.trunc(origen.priority))),
      kind: origen.kind,
      /* La etiqueta la escribe quien hospeda. Nunca el hostname ni el nombre de
         usuario del sistema: "el-portatil-de-ana" en una lista que ven los
         miembros dice más de Ana de lo que Ana decidió contar. */
      label: origen.label.slice(0, 60),
    })),
    issued_at: now,
    expires_at: now + ORIGENES_TTL_MS,
  };

  const firmado: SignedOriginSet = {
    payload,
    signature: signAsInstance(canonicalJson(payload)),
    signer_public_key: instancePublicKey() as Record<string, unknown>,
    signer_fingerprint: instanceFingerprint(),
  };
  setMeta("origin_set", JSON.stringify(firmado));
  return firmado;
}

export function currentOriginSet(): SignedOriginSet | null {
  const fila = db.prepare("SELECT value FROM meta WHERE key = 'origin_set'").get() as { value: string } | undefined;
  if (!fila) return null;
  try {
    const guardado = JSON.parse(fila.value) as SignedOriginSet;
    /* Un conjunto firmado en una época anterior ya no vale: la firma es de una
       clave que puede haber cambiado en un relevo. */
    return guardado.payload.epoch === instanceEpoch() ? guardado : null;
  } catch {
    return null;
  }
}

export function successionRecord(): { origin: string | null; certificate: SuccessionCert } | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'succeeded_by'").get() as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as { origin: string | null; certificate: SuccessionCert };
  } catch {
    return null;
  }
}
