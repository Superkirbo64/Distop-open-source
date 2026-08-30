const BLOCKED_V4: Array<[number, number]> = [
  [ip4("0.0.0.0"), 8], [ip4("10.0.0.0"), 8], [ip4("100.64.0.0"), 10],
  [ip4("127.0.0.0"), 8], [ip4("169.254.0.0"), 16], [ip4("172.16.0.0"), 12],
  [ip4("192.0.0.0"), 24], [ip4("192.0.2.0"), 24], [ip4("192.168.0.0"), 16],
  [ip4("198.18.0.0"), 15], [ip4("198.51.100.0"), 24], [ip4("203.0.113.0"), 24],
  [ip4("224.0.0.0"), 4], [ip4("240.0.0.0"), 4],
];

function ip4(value: string): number {
  return value.split(".").reduce((out, part) => ((out << 8) | Number(part)) >>> 0, 0);
}

export function isPublicIp(value: string): boolean {
  if (value.includes(":")) {
    const normalized = value.toLowerCase();
    if (normalized === "::" || normalized === "::1") return false;
    if (normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
    if (normalized.startsWith("ff")) return false;
    if (normalized.startsWith("2001:db8:")) return false;
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
    return mapped ? isPublicIp(mapped[1]!) : true;
  }
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return false;
  const numeric = ip4(value);
  if (value.split(".").some((part) => Number(part) > 255)) return false;
  return !BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (numeric & mask) === (base & mask);
  });
}

export function normalizePublicOrigin(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("ORIGIN_REQUIRES_HTTPS");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("ORIGIN_MUST_BE_ORIGIN");
  return url;
}

export async function assertPublicDns(url: URL): Promise<void> {
  if (isPublicIp(url.hostname)) return;
  const addresses = [
    ...await Deno.resolveDns(url.hostname, "A").catch(() => [] as string[]),
    ...await Deno.resolveDns(url.hostname, "AAAA").catch(() => [] as string[]),
  ];
  if (addresses.length === 0) throw new Error("ORIGIN_DNS_EMPTY");
  if (addresses.some((address) => !isPublicIp(address))) throw new Error("ORIGIN_PRIVATE_ADDRESS");
}

export interface InstanceInfo {
  instance_id: string;
  lineage_id: string;
  epoch: number;
  role: string;
  public_url: string;
  identity: { fingerprint: string; public_key: JsonWebKey };
}

export async function fetchInstanceInfo(origin: string): Promise<InstanceInfo> {
  const url = normalizePublicOrigin(origin);
  await assertPublicDns(url);
  const response = await fetch(new URL("/api/v1/info", url), {
    redirect: "error",
    signal: AbortSignal.timeout(5_000),
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error("INSTANCE_UNREACHABLE");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > 64 * 1024) throw new Error("INSTANCE_RESPONSE_TOO_LARGE");
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error("INSTANCE_RESPONSE_TOO_LARGE");
  return JSON.parse(text) as InstanceInfo;
}
