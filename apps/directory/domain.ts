import type { DirectoryChallenge, DirectoryManifestPayload, DirectoryReport, ModerationAction, SignedDirectoryManifest, StoredListing, StoredManifest, SuccessionCertificate } from "./types.ts";
import type { DirectoryStorage } from "./storage.ts";

const CHALLENGE_TTL = 5 * 60_000;
export const LEASE_MIN = 6 * 60 * 60_000;
export const LEASE_MAX = 30 * 60 * 60_000;

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function encodeBase64Url(value: Uint8Array): string {
  let raw = "";
  for (const byte of value) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function fingerprintOf(key: JsonWebKey): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(key)));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function verifyManifestSignature(manifest: SignedDirectoryManifest): Promise<boolean> {
  try {
    if (await fingerprintOf(manifest.public_key) !== manifest.payload.fingerprint) return false;
    const key = await crypto.subtle.importKey("jwk", manifest.public_key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(manifest.signature),
      new TextEncoder().encode(canonicalJson(manifest.payload)),
    );
  } catch {
    return false;
  }
}

async function verifySignedValue(value: unknown, signature: string, publicKey: JsonWebKey): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("jwk", publicKey, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      decodeBase64Url(signature),
      new TextEncoder().encode(canonicalJson(value)),
    );
  } catch {
    return false;
  }
}

interface KnownIdentity {
  instance_id: string;
  lineage_id: string;
  epoch: number;
  fingerprint: string;
  public_key: JsonWebKey;
}

async function verifySuccession(known: KnownIdentity, target: DirectoryManifestPayload, chain: SuccessionCertificate[], now: number): Promise<void> {
  let current = known;
  const relevant = chain.filter((cert) => cert.payload.lineage_id === known.lineage_id && cert.payload.from_epoch >= known.epoch)
    .sort((a, b) => a.payload.from_epoch - b.payload.from_epoch);
  if (relevant.length === 0 || relevant.length > 16) throw new Error("SUCCESSION_CHAIN_MISSING");
  for (const cert of relevant) {
    const payload = cert.payload;
    if (payload.t !== "DISTOP_SUCCESSION_CERT" || payload.version !== 1) throw new Error("BAD_SUCCESSION_CERT");
    if (payload.from_instance_id !== current.instance_id || payload.from_epoch !== current.epoch || payload.from_fingerprint !== current.fingerprint) throw new Error("SUCCESSION_GAP");
    if (payload.to_epoch !== current.epoch + 1 || payload.to_instance_id === current.instance_id) throw new Error("BAD_SUCCESSION_STEP");
    if (now < payload.not_before || now >= payload.expires_at) throw new Error("SUCCESSION_CERT_EXPIRED");
    if (cert.signer_fingerprint !== current.fingerprint || await fingerprintOf(cert.signer_public_key) !== current.fingerprint) throw new Error("BAD_SUCCESSION_SIGNER");
    if (!await verifySignedValue(payload, cert.signature, cert.signer_public_key)) throw new Error("BAD_SUCCESSION_SIGNATURE");
    if (await fingerprintOf(payload.to_public_key) !== payload.to_fingerprint) throw new Error("BAD_SUCCESSOR_KEY");
    current = {
      instance_id: payload.to_instance_id,
      lineage_id: payload.lineage_id,
      epoch: payload.to_epoch,
      fingerprint: payload.to_fingerprint,
      public_key: payload.to_public_key,
    };
    if (current.epoch === target.epoch) break;
  }
  if (current.instance_id !== target.instance_id || current.epoch !== target.epoch || current.fingerprint !== target.fingerprint) throw new Error("SUCCESSION_TARGET_MISMATCH");
}

const challengeEncoder = new TextEncoder();

async function challengeKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", challengeEncoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signChallenge(secret: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", await challengeKey(secret), challengeEncoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

async function verifyChallenge(secret: string, nonce: string, expected: { instance_id: string; origin: string }, now: number): Promise<void> {
  const separator = nonce.lastIndexOf(".");
  if (separator < 1) throw new Error("CHALLENGE_INVALID");
  const encoded = nonce.slice(0, separator);
  const signature = nonce.slice(separator + 1);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await challengeKey(secret),
    decodeBase64Url(signature),
    challengeEncoder.encode(encoded),
  );
  if (!valid) throw new Error("CHALLENGE_INVALID");
  try {
    const value = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as DirectoryChallenge;
    if (value.expires_at <= now) throw new Error("CHALLENGE_EXPIRED");
    if (value.instance_id !== expected.instance_id || value.origin !== expected.origin) throw new Error("CHALLENGE_MISMATCH");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("CHALLENGE_")) throw error;
    throw new Error("CHALLENGE_INVALID");
  }
}

function assertManifestShape(payload: DirectoryManifestPayload, now: number): void {
  if (payload?.t !== "DISTOP_DIRECTORY_MANIFEST" || payload.version !== 1) throw new Error("BAD_MANIFEST");
  if (!payload.instance_id || !payload.lineage_id || !payload.fingerprint) throw new Error("BAD_IDENTITY");
  if (!Number.isSafeInteger(payload.epoch) || payload.epoch < 1) throw new Error("BAD_EPOCH");
  if (!Number.isSafeInteger(payload.issued_at) || Math.abs(now - payload.issued_at) > 10 * 60_000) throw new Error("BAD_CLOCK");
  const lease = payload.expires_at - payload.issued_at;
  if (lease < LEASE_MIN || lease > LEASE_MAX) throw new Error("BAD_LEASE");
  if (!Array.isArray(payload.communities) || payload.communities.length > 100) throw new Error("TOO_MANY_COMMUNITIES");
  if (!Array.isArray(payload.succession_chain) || payload.succession_chain.length > 16) throw new Error("BAD_SUCCESSION_CHAIN");
  const ids = new Set<string>();
  const profileOrigin = new URL(payload.origin).origin;
  for (const community of payload.communities) {
    if (!community.id || ids.has(community.id)) throw new Error("BAD_COMMUNITY_ID");
    ids.add(community.id);
    if (community.visibility !== "public") throw new Error("NOT_PUBLIC");
    if (!(["open", "invite", "request"] as const).includes(community.join_policy)) throw new Error("BAD_JOIN_POLICY");
    if (!community.name || community.name.length > 64 || (community.description?.length ?? 0) > 500) throw new Error("BAD_PROFILE");
    if (!Number.isSafeInteger(community.members) || community.members < 0) throw new Error("BAD_MEMBER_COUNT");
    if (!Array.isArray(community.tags) || community.tags.length > 8 || community.tags.some((tag) => tag.length > 24)) throw new Error("BAD_TAGS");
    for (const asset of [community.icon_url, community.banner_url]) {
      if (asset === null) continue;
      try {
        const url = new URL(asset, profileOrigin);
        if (url.protocol !== "https:" || url.origin !== profileOrigin || url.username || url.password) throw new Error();
      } catch {
        throw new Error("BAD_ASSET_URL");
      }
    }
  }
}

export class DirectoryService {
  constructor(
    private readonly storage: DirectoryStorage,
    private readonly verifyOrigin: (payload: DirectoryManifestPayload, publicKey: JsonWebKey) => Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly challengeSecret = "distop-directory-development-secret",
  ) {}

  async challenge(instanceId: string, origin: string): Promise<DirectoryChallenge> {
    if (!instanceId || instanceId.length > 100) throw new Error("BAD_INSTANCE_ID");
    const value = {
      nonce: "",
      instance_id: instanceId,
      origin,
      expires_at: this.now() + CHALLENGE_TTL,
      salt: encodeBase64Url(crypto.getRandomValues(new Uint8Array(18))),
    };
    const encoded = encodeBase64Url(challengeEncoder.encode(JSON.stringify(value)));
    return { ...value, nonce: `${encoded}.${await signChallenge(this.challengeSecret, encoded)}` };
  }

  async register(manifest: SignedDirectoryManifest): Promise<{ published: number; expires_at: number }> {
    const now = this.now();
    assertManifestShape(manifest.payload, now);
    await verifyChallenge(this.challengeSecret, manifest.payload.nonce, manifest.payload, now);
    if (!await verifyManifestSignature(manifest)) throw new Error("BAD_SIGNATURE");
    await this.verifyOrigin(manifest.payload, manifest.public_key);

    const manifestKey = ["manifest", manifest.payload.lineage_id] as const;
    const known = await this.storage.get<StoredManifest>(manifestKey);
    if (known.value) {
      /* El desafío es un token HMAC sin estado: guardar cada nonce usado costaría
         una escritura de KV por publicación. Sale más barato exigir que la misma
         instancia solo avance en el tiempo, que es lo que impide reenviar un
         manifiesto interceptado para revivir una ficha recién retirada. Solo
         dentro de la misma época: en un relevo manda la cadena de sucesión, no
         el reloj de la máquina nueva. */
      if (manifest.payload.epoch === known.value.identity.epoch
        && manifest.payload.instance_id === known.value.identity.instance_id
        && manifest.payload.issued_at <= known.value.issued_at) throw new Error("STALE_MANIFEST");
      if (manifest.payload.epoch < known.value.identity.epoch) throw new Error("STALE_EPOCH");
      if (manifest.payload.epoch === known.value.identity.epoch && known.value.identity.fingerprint !== manifest.payload.fingerprint) throw new Error("IDENTITY_FORK");
      if (manifest.payload.epoch === known.value.identity.epoch && known.value.identity.instance_id !== manifest.payload.instance_id) throw new Error("IDENTITY_FORK");
      if (manifest.payload.epoch > known.value.identity.epoch) await verifySuccession(known.value.identity, manifest.payload, manifest.payload.succession_chain, now);
    }

    const bundle: StoredManifest = {
      identity: {
        instance_id: manifest.payload.instance_id,
        lineage_id: manifest.payload.lineage_id,
        epoch: manifest.payload.epoch,
        fingerprint: manifest.payload.fingerprint,
        public_key: manifest.public_key,
      },
      communities: manifest.payload.communities.map((community): StoredListing => ({
        ...community,
        instance_id: manifest.payload.instance_id,
        lineage_id: manifest.payload.lineage_id,
        epoch: manifest.payload.epoch,
        fingerprint: manifest.payload.fingerprint,
        origin: manifest.payload.origin,
        issued_at: manifest.payload.issued_at,
        expires_at: manifest.payload.expires_at,
      })),
      issued_at: manifest.payload.issued_at,
      expires_at: manifest.payload.expires_at,
    };
    const saved = await this.storage.setIfVersion(manifestKey, known.version, bundle, {
      expireIn: Math.max(1, manifest.payload.expires_at - now),
    });
    if (!saved) throw new Error("CONCURRENT_RENEWAL");
    return { published: manifest.payload.communities.length, expires_at: manifest.payload.expires_at };
  }

  async explore(options: { language?: string; tag?: string; cursor?: string; limit?: number } = {}): Promise<{ communities: StoredListing[]; cursor: string }> {
    const page = await this.storage.list<StoredManifest>(["manifest"], { cursor: options.cursor, limit: Math.min(options.limit ?? 50, 50) });
    const now = this.now();
    const communities: StoredListing[] = [];
    for (const bundle of page.values) {
      if (bundle.expires_at <= now) continue;
      for (const listing of bundle.communities) {
        if (options.language && listing.language !== options.language) continue;
        if (options.tag && !listing.tags.includes(options.tag)) continue;
        const blocked = await this.storage.get<boolean>(["blocked", `${listing.lineage_id}:${listing.id}`]);
        if (!blocked.value) communities.push(listing);
      }
    }
    communities.sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));
    return { communities, cursor: page.cursor };
  }

  async report(input: Omit<DirectoryReport, "id" | "created_at">): Promise<DirectoryReport> {
    if (!(["spam", "abuse", "illegal", "impersonation", "other"] as const).includes(input.reason)) throw new Error("BAD_REPORT_REASON");
    if (input.detail.length > 1000) throw new Error("REPORT_TOO_LONG");
    const report = { ...input, id: crypto.randomUUID(), created_at: this.now() };
    await this.storage.set(["report", report.id], report);
    return report;
  }

  async moderate(listingKeyValue: string, action: "block" | "unblock", reason: string): Promise<ModerationAction> {
    const record = { id: crypto.randomUUID(), listing_key: listingKeyValue, action, reason: reason.slice(0, 500), created_at: this.now() };
    if (action === "block") await this.storage.set(["blocked", listingKeyValue], true);
    else await this.storage.delete(["blocked", listingKeyValue]);
    await this.storage.set(["moderation", record.created_at, record.id], record);
    return record;
  }
}
