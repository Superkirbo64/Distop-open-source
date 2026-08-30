/** Publicación voluntaria y firmada en el directorio global. */
import { canonicalJson } from "@distop/protocol";
import { config } from "./config.ts";
import { db, meta, setMeta, INSTANCE_ID } from "./db.ts";
import { LINEAGE_ID, instanceEpoch, instanceFingerprint, instancePublicKey, instanceRole, signAsInstance } from "./identity.ts";
import { fixedPublicUrl } from "./tunnel.ts";

const DAY = 24 * 60 * 60_000;

/**
 * Si esta instancia se anuncia en el índice público.
 *
 * Vive en la base de datos y no solo en el entorno porque quien hospeda desde
 * la aplicación de escritorio no tiene ningún fichero que editar: dejarlo solo
 * en PUBLIC_DISCOVERY_ENABLED convertía «marcar la comunidad como pública» en
 * un botón que no hacía nada y no explicaba por qué.
 *
 * La variable de entorno sigue mandando la primera vez, para quien despliega
 * con una configuración preparada; a partir de ahí manda el interruptor.
 */
const CLAVE_DESCUBRIMIENTO = "public_discovery";

export function discoveryEnabled(): boolean {
  return meta(CLAVE_DESCUBRIMIENTO, () => (config.publicDiscoveryEnabled ? "1" : "0")) === "1";
}

/** Apagarlo publica una ficha vacía: la comunidad desaparece del índice, no se queda. */
export function setDiscoveryEnabled(on: boolean): void {
  setMeta(CLAVE_DESCUBRIMIENTO, on ? "1" : "0");
}
const RETRY = 60 * 60_000;

interface Challenge {
  nonce: string;
  expires_at: number;
}

function stableOrigin(): string {
  const raw = fixedPublicUrl() || config.publicUrl;
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname.endsWith(".trycloudflare.com")) return "";
    return url.origin;
  } catch {
    return "";
  }
}

function safeAssetUrl(value: unknown, origin: string): string | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value, origin);
    return url.protocol === "https:" && url.origin === origin && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function publicCommunities(origin: string): unknown[] {
  if (!discoveryEnabled()) return [];
  return db.prepare(
    `SELECT c.id, c.name, c.slug, c.description, c.icon_url, c.banner_url,
            c.accent_color, c.visibility, c.join_policy, c.category,
            (SELECT COUNT(*) FROM members m WHERE m.community_id = c.id AND m.banned = 0) AS members
       FROM communities c
      WHERE c.visibility = 'public'
      ORDER BY c.created_at ASC
      LIMIT 100`,
  ).all().map((raw) => {
    const row = raw as Record<string, unknown>;
    return {
      ...row,
      icon_url: safeAssetUrl(row.icon_url, origin),
      banner_url: safeAssetUrl(row.banner_url, origin),
      tags: [],
      language: null,
    };
  });
}

function successionChain(): unknown[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'succession_chain'").get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function publishDirectoryNow(): Promise<{ published: number; expires_at: number } | null> {
  const origin = stableOrigin();
  if (!config.directoryUrl || !origin || instanceRole() !== "PRIMARY") return null;
  const challengeResponse = await fetch(`${config.directoryUrl}/v1/challenges`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instance_id: INSTANCE_ID, origin }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!challengeResponse.ok) throw new Error(`DIRECTORY_CHALLENGE_${challengeResponse.status}`);
  const challenge = await challengeResponse.json() as Challenge;
  const issuedAt = Date.now();
  const payload = {
    t: "DISTOP_DIRECTORY_MANIFEST",
    version: 1,
    nonce: challenge.nonce,
    instance_id: INSTANCE_ID,
    lineage_id: LINEAGE_ID,
    epoch: instanceEpoch(),
    fingerprint: instanceFingerprint(),
    origin,
    communities: publicCommunities(origin),
    succession_chain: successionChain(),
    issued_at: issuedAt,
    expires_at: issuedAt + DAY,
  };
  const response = await fetch(`${config.directoryUrl}/v1/listings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payload, signature: signAsInstance(canonicalJson(payload)), public_key: instancePublicKey() }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`DIRECTORY_REGISTER_${response.status}:${detail.slice(0, 200)}`);
  }
  return await response.json() as { published: number; expires_at: number };
}

let timer: NodeJS.Timeout | null = null;
let queued: NodeJS.Timeout | null = null;

async function cycle(): Promise<void> {
  let next = DAY;
  try {
    const result = await publishDirectoryNow();
    if (result) console.log(`[directorio] ${result.published} comunidad(es) publicadas hasta ${new Date(result.expires_at).toISOString()}.`);
    else if (config.directoryUrl && discoveryEnabled()) next = RETRY;
  } catch (error) {
    next = RETRY;
    console.warn(`[directorio] no se pudo renovar: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void cycle(), next);
  timer.unref();
}

export function startDirectoryPublisher(): void {
  if (!config.directoryUrl) return;
  void cycle();
}

export function queueDirectorySync(): void {
  if (!config.directoryUrl) return;
  if (queued) clearTimeout(queued);
  queued = setTimeout(() => {
    queued = null;
    void cycle();
  }, 2_000);
  queued.unref();
}

export function stopDirectoryPublisher(): void {
  if (timer) clearTimeout(timer);
  if (queued) clearTimeout(queued);
  timer = null;
  queued = null;
}
