/** Identidad criptografica estable de la linea de una instancia. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { PROTOCOL_VERSION, uuidv7 } from "@distop/protocol";
import { config } from "./config.ts";
import { meta, setMeta } from "./db.ts";

export type InstanceRole = "PRIMARY" | "STANDBY" | "SUPERSEDED";

export interface InstanceProofPayload {
  t: "DISTOP_INSTANCE_PROOF";
  instance_id: string;
  lineage_id: string;
  epoch: number;
  role: InstanceRole;
  origin: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  protocol: string;
}

export interface SignedInstanceProof {
  payload: InstanceProofPayload;
  signature: string;
  public_key: JsonWebKey;
  fingerprint: string;
}

const KEY_PATH = join(dirname(resolve(config.databasePath)), "instance.key");

function loadPrivateKey(): KeyObject {
  if (existsSync(KEY_PATH)) {
    const parsed = JSON.parse(readFileSync(KEY_PATH, "utf8")) as JsonWebKey;
    return createPrivateKey({ key: parsed, format: "jwk" });
  }
  const generated = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  mkdirSync(dirname(KEY_PATH), { recursive: true });
  writeFileSync(KEY_PATH, `${JSON.stringify(generated.export({ format: "jwk" }))}\n`, { mode: 0o600, flag: "wx" });
  try { chmodSync(KEY_PATH, 0o600); } catch { /* Sin permisos POSIX. */ }
  return generated;
}

/**
 * Época, papel y clave son ESTADO, no constantes.
 *
 * Antes se leían una vez al importar el módulo, y para una instancia que nunca
 * cambia de mano da igual. Pero un relevo sube la época, cambia el papel y —en
 * el lado del sucesor— estrena clave, todo dentro del mismo proceso. Con
 * constantes, el certificado se firmaría con los datos de antes del relevo y
 * `/api/v1/info` seguiría anunciando la época vieja hasta el siguiente
 * reinicio: exactamente el desfase que la vigilancia interpreta como impostor.
 */
let privateKey = loadPrivateKey();
let publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" });
let fingerprint = huellaDe(publicKeyJwk);
let epoch = positiveInteger(meta("instance_epoch", () => "1"), 1);
let currentRole = role(meta("instance_role", () => "PRIMARY"));

export const LINEAGE_ID = meta("lineage_id", uuidv7);

export function instancePublicKey(): JsonWebKey {
  return publicKeyJwk;
}

export function instanceFingerprint(): string {
  return fingerprint;
}

export function instanceEpoch(): number {
  return epoch;
}

export function instanceRole(): InstanceRole {
  return currentRole;
}

/** ¿Esta instancia ya entregó el relevo? Entonces no manda en nada. */
export function isSuperseded(): boolean {
  return currentRole === "SUPERSEDED";
}

export function huellaDe(key: JsonWebKey): string {
  return createHash("sha256").update(canonicalJson(key)).digest("base64url");
}

/**
 * Escribe el papel y la época nuevos, en la base y en memoria.
 *
 * La época solo sube. Bajarla sería un rollback criptográfico: quien ya vio la
 * época nueva dejaría de creer a esta instancia, y quien no la vio se quedaría
 * con una versión antigua de la historia sin saberlo (§11.3).
 */
export function setInstanceStanding(next: { epoch?: number; role?: InstanceRole }): void {
  if (next.epoch !== undefined) {
    if (!Number.isSafeInteger(next.epoch) || next.epoch < epoch) throw new Error("EPOCH_CANNOT_GO_BACK");
    epoch = next.epoch;
    setMeta("instance_epoch", String(epoch));
  }
  if (next.role !== undefined) {
    /* Una instancia que ya entregó el relevo no vuelve a mandar. Reactivarla
       con la época vieja sería un rollback criptográfico: los clientes que ya
       vieron al sucesor dejarían de creerla, y los que no, seguirían
       escribiendo en una historia que nadie más va a leer (§2.6). Para volver
       a servir esta máquina hace falta un relevo NUEVO en sentido contrario,
       con su época y su certificado. */
    if (currentRole === "SUPERSEDED" && next.role !== "SUPERSEDED") {
      throw new Error("INSTANCE_ALREADY_SUPERSEDED");
    }
    currentRole = next.role;
    setMeta("instance_role", currentRole);
  }
}

/**
 * Estrena par de claves. Solo lo usa el sucesor al adoptar una línea: la clave
 * privada del anfitrión anterior NUNCA viaja, así que el sucesor genera la suya
 * y el predecesor la autoriza firmando un certificado.
 */
export function rotateInstanceKey(): { public_key: JsonWebKey; fingerprint: string } {
  const generado = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  writeFileSync(KEY_PATH, `${JSON.stringify(generado.export({ format: "jwk" }))}
`, { mode: 0o600 });
  try { chmodSync(KEY_PATH, 0o600); } catch { /* Sin permisos POSIX. */ }
  privateKey = generado;
  publicKeyJwk = createPublicKey(privateKey).export({ format: "jwk" });
  fingerprint = huellaDe(publicKeyJwk);
  return { public_key: publicKeyJwk, fingerprint };
}

/** Firma con la clave viva de esta instancia. */
export function signAsInstance(canonical: string): string {
  return sign("sha256", Buffer.from(canonical), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
}

function positiveInteger(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function role(value: string): InstanceRole {
  return value === "STANDBY" || value === "SUPERSEDED" ? value : "PRIMARY";
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

export function normalizeProofOrigin(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("INVALID_PROOF_ORIGIN");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("INVALID_PROOF_ORIGIN");
  return parsed.origin;
}

export function createInstanceProof(opts: { instanceId: string; origin: string; nonce: string; now?: number }): SignedInstanceProof {
  const now = opts.now ?? Date.now();
  const payload: InstanceProofPayload = {
    t: "DISTOP_INSTANCE_PROOF",
    instance_id: opts.instanceId,
    lineage_id: LINEAGE_ID,
    epoch,
    role: currentRole,
    origin: normalizeProofOrigin(opts.origin),
    nonce: opts.nonce,
    issued_at: now,
    expires_at: now + 60_000,
    protocol: PROTOCOL_VERSION,
  };
  return {
    payload,
    signature: signAsInstance(canonicalJson(payload)),
    public_key: publicKeyJwk,
    fingerprint,
  };
}

export function verifyInstanceProof(proof: SignedInstanceProof): boolean {
  try {
    const publicKey = createPublicKey({ key: proof.public_key, format: "jwk" });
    if (huellaDe(proof.public_key) !== proof.fingerprint) return false;
    return verify(
      "sha256",
      Buffer.from(canonicalJson(proof.payload)),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(proof.signature, "base64url"),
    );
  } catch {
    return false;
  }
}
