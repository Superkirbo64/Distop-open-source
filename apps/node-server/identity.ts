/** Identidad criptografica estable de la linea de una instancia. */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type JsonWebKey, type KeyObject } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { PROTOCOL_VERSION, uuidv7 } from "@distop/protocol";
import { config } from "./config.ts";
import { meta } from "./db.ts";

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

const privateKey = loadPrivateKey();
export const INSTANCE_PUBLIC_KEY = createPublicKey(privateKey).export({ format: "jwk" });
export const INSTANCE_FINGERPRINT = createHash("sha256")
  .update(canonicalJson(INSTANCE_PUBLIC_KEY))
  .digest("base64url");
export const LINEAGE_ID = meta("lineage_id", uuidv7);
export const INSTANCE_EPOCH = positiveInteger(meta("instance_epoch", () => "1"), 1);
export const INSTANCE_ROLE = role(meta("instance_role", () => "PRIMARY"));

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
    epoch: INSTANCE_EPOCH,
    role: INSTANCE_ROLE,
    origin: normalizeProofOrigin(opts.origin),
    nonce: opts.nonce,
    issued_at: now,
    expires_at: now + 60_000,
    protocol: PROTOCOL_VERSION,
  };
  const signature = sign("sha256", Buffer.from(canonicalJson(payload)), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return { payload, signature: signature.toString("base64url"), public_key: INSTANCE_PUBLIC_KEY, fingerprint: INSTANCE_FINGERPRINT };
}

export function verifyInstanceProof(proof: SignedInstanceProof): boolean {
  try {
    const publicKey = createPublicKey({ key: proof.public_key, format: "jwk" });
    const expectedFingerprint = createHash("sha256").update(canonicalJson(proof.public_key)).digest("base64url");
    if (expectedFingerprint !== proof.fingerprint) return false;
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
