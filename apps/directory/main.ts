import { DirectoryService } from "./domain.ts";
import { fetchInstanceInfo, normalizePublicOrigin } from "./network.ts";
import { DenoKvStorage } from "./storage.ts";
import type { DirectoryManifestPayload, SignedDirectoryManifest } from "./types.ts";

const kv = await Deno.openKv();
const storage = new DenoKvStorage(kv);
const challengeSecret = Deno.env.get("DIRECTORY_CHALLENGE_SECRET") ?? "";
if (challengeSecret.length < 32) throw new Error("DIRECTORY_CHALLENGE_SECRET must contain at least 32 characters");
const service = new DirectoryService(storage, async (payload: DirectoryManifestPayload) => {
  normalizePublicOrigin(payload.origin);
  const info = await fetchInstanceInfo(payload.origin);
  if (info.instance_id !== payload.instance_id || info.lineage_id !== payload.lineage_id) throw new Error("ORIGIN_IDENTITY_MISMATCH");
  if (info.epoch !== payload.epoch || info.identity?.fingerprint !== payload.fingerprint) throw new Error("ORIGIN_IDENTITY_MISMATCH");
  if (info.role !== "PRIMARY") throw new Error("INSTANCE_NOT_PRIMARY");
}, Date.now, challengeSecret);

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
};

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { ...cors, "cache-control": "no-store" } });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 256 * 1024) throw new Error("PAYLOAD_TOO_LARGE");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BAD_JSON");
  return value as Record<string, unknown>;
}

const rateBuckets = new Map<string, { count: number; expiresAt: number }>();

function rateLimit(scope: string, subject: string, limit: number, windowMs: number): void {
  const now = Date.now();
  const bucket = Math.floor(Date.now() / windowMs);
  const key = `${scope}:${subject.slice(0, 160)}:${bucket}`;
  const current = rateBuckets.get(key);
  if (current && current.count >= limit) throw new Error("RATE_LIMITED");
  rateBuckets.set(key, { count: (current?.count ?? 0) + 1, expiresAt: now + windowMs * 2 });
  if (rateBuckets.size > 10_000) {
    for (const [candidate, value] of rateBuckets) {
      if (value.expiresAt <= now) rateBuckets.delete(candidate);
    }
  }
}

async function handler(request: Request, clientIp: string): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(request.url);
  try {
    if (request.method === "GET" && url.pathname === "/health") return json({ status: "ok" });
    if (request.method === "POST" && url.pathname === "/v1/challenges") {
      rateLimit("challenge", clientIp, 60, 60 * 60_000);
      const input = await body(request);
      const instanceId = typeof input.instance_id === "string" ? input.instance_id : "";
      const origin = normalizePublicOrigin(String(input.origin ?? "")).origin;
      return json(await service.challenge(instanceId, origin), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/listings") {
      rateLimit("listing", clientIp, 120, 60 * 60_000);
      return json(await service.register(await body(request) as unknown as SignedDirectoryManifest));
    }
    if (request.method === "GET" && url.pathname === "/v1/explore") {
      rateLimit("explore", clientIp, 300, 60_000);
      return json(await service.explore({
        language: url.searchParams.get("language") ?? undefined,
        tag: url.searchParams.get("tag") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: Number(url.searchParams.get("limit") ?? "50"),
      }));
    }
    if (request.method === "POST" && url.pathname === "/v1/reports") {
      rateLimit("report", clientIp, 10, 60 * 60_000);
      const input = await body(request);
      return json(await service.report({
        listing_key: String(input.listing_key ?? "").slice(0, 220),
        reason: String(input.reason ?? "other") as "spam" | "abuse" | "illegal" | "impersonation" | "other",
        detail: String(input.detail ?? ""),
        reporter_hash: String(input.reporter_hash ?? "anonymous").slice(0, 100),
      }), 201);
    }
    if (request.method === "POST" && url.pathname === "/v1/moderation") {
      const expected = Deno.env.get("DIRECTORY_ADMIN_TOKEN") ?? "";
      if (!expected || request.headers.get("authorization") !== `Bearer ${expected}`) return json({ error: "UNAUTHORIZED" }, 401);
      const input = await body(request);
      return json(await service.moderate(
        String(input.listing_key ?? ""),
        input.action === "unblock" ? "unblock" : "block",
        String(input.reason ?? ""),
      ));
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (error) {
    const code = error instanceof Error ? error.message : "BAD_REQUEST";
    const status = code === "RATE_LIMITED" ? 429 : code.includes("UNREACHABLE") ? 422 : code === "PAYLOAD_TOO_LARGE" ? 413 : 400;
    return json({ error: code }, status);
  }
}

Deno.serve((request, info) => handler(request, info.remoteAddr.hostname));
