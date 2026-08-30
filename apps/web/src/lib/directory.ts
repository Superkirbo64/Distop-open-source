/**
 * De dónde salen las comunidades de "Explorar" (§19).
 *
 * Combina el descubrimiento de la instancia activa (`GET /api/v1/discovery`)
 * con el directorio global configurado. La agregación usa `Promise.allSettled`:
 * una fuente caída no puede tumbar la lista de las demás.
 */
import { api } from "./api.ts";
import type { MessageKey } from "../i18n.ts";
import { clientOrigin, connectToInstance, isPackaged, normalizeInstanceUrl, storePendingPublicJoin } from "./instance.ts";

/** Una ficha del directorio, tal como la devuelve el descubrimiento. */
export interface DirectoryCommunity {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
  accent_color: string | null;
  members: number;
  visibility?: "public";
  join_policy?: "open" | "invite" | "request";
  /** De qué nodo viene la ficha. Ausente = la instancia activa. */
  origin?: string;
  instance_id?: string;
  fingerprint?: string;
}

/** Un lugar al que preguntar por comunidades públicas. */
export interface DirectorySource {
  id: string;
  /** Clave de traducción, no texto: el nombre de la fuente se pinta en la vista. */
  labelKey: MessageKey;
  list: () => Promise<DirectoryCommunity[]>;
}

export interface DirectoryFailure {
  source: string;
  error: unknown;
}

export interface DirectoryListing {
  communities: DirectoryCommunity[];
  failures: DirectoryFailure[];
}

const instanceSource: DirectorySource = {
  id: "instance",
  labelKey: "explore.sourceInstance",
  list: () => api<DirectoryCommunity[]>("GET", "/api/v1/discovery"),
};

function globalSource(directoryUrl: string): DirectorySource {
  return {
    id: "global",
    labelKey: "explore.sourceGlobal",
    list: async () => {
      const response = await fetch(`${directoryUrl.replace(/\/+$/, "")}/v1/explore?limit=50`, {
        signal: AbortSignal.timeout(8_000),
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`DIRECTORY_${response.status}`);
      const body = await response.json() as { communities?: DirectoryCommunity[] };
      return Array.isArray(body.communities) ? body.communities : [];
    },
  };
}

/**
 * Las fuentes vigentes, en el orden en que se preguntan. Es una función para
 * depender de la configuración viva del nodo y del directorio global.
 */
export function directorySources(options: { localEnabled?: boolean; directoryUrl?: string } = {}): DirectorySource[] {
  const sources: DirectorySource[] = [];
  if (options.localEnabled ?? true) sources.push(instanceSource);
  if (options.directoryUrl) sources.push(globalSource(options.directoryUrl));
  return sources;
}

export type DirectoryEnterResult = "joined" | "requested" | "switching" | "unreachable" | "identity-mismatch" | "not-instance";

/** Comprueba la identidad anunciada antes de navegar o enviar una sesión. */
export async function verifyDirectoryTarget(community: DirectoryCommunity): Promise<DirectoryEnterResult | "verified"> {
  if (!community.origin) return "verified";
  const origin = normalizeInstanceUrl(community.origin);
  if (!origin) return "not-instance";
  try {
    const response = await fetch(`${origin}/api/v1/info`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return "not-instance";
    const info = await response.json() as { instance_id?: string; identity?: { fingerprint?: string } };
    if (community.instance_id && info.instance_id !== community.instance_id) return "identity-mismatch";
    if (community.fingerprint && info.identity?.fingerprint !== community.fingerprint) return "identity-mismatch";
    return "verified";
  } catch {
    return "unreachable";
  }
}

export async function enterDirectoryCommunity(community: DirectoryCommunity): Promise<DirectoryEnterResult> {
  const verified = await verifyDirectoryTarget(community);
  if (verified !== "verified") return verified;
  const origin = community.origin ? normalizeInstanceUrl(community.origin) : null;
  const policy = community.join_policy === "request" ? "request" : "open";
  if (!origin || origin === normalizeInstanceUrl(clientOrigin())) {
    await api("POST", `/api/v1/public-communities/${encodeURIComponent(community.id)}/${policy === "open" ? "join" : "requests"}`, {});
    return policy === "open" ? "joined" : "requested";
  }
  if (isPackaged()) {
    storePendingPublicJoin({ communityId: community.id, policy });
    const result = await connectToInstance(origin);
    return result === "ok" ? "switching" : result === "invalid" ? "not-instance" : result;
  }
  location.assign(`${origin}/?join=${encodeURIComponent(community.id)}&policy=${policy}`);
  return "switching";
}

/**
 * Pregunta a todas las fuentes y junta lo que contesten. Los fallos no se
 * tragan: vuelven con nombre para que la vista pueda decir qué fuente falló
 * en vez de enseñar una lista misteriosamente corta (§26).
 */
export async function collectDirectory(sources: DirectorySource[]): Promise<DirectoryListing> {
  const settled = await Promise.allSettled(sources.map((source) => source.list()));
  const communities: DirectoryCommunity[] = [];
  const seen = new Set<string>();
  const failures: DirectoryFailure[] = [];
  settled.forEach((result, index) => {
    const source = sources[index]!;
    if (result.status === "fulfilled") {
      for (const community of result.value) {
        const key = `${community.instance_id ?? community.origin ?? source.id}:${community.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        communities.push(community);
      }
    }
    else failures.push({ source: source.id, error: result.reason });
  });
  return { communities, failures };
}
