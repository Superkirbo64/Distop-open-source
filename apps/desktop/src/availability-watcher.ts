/**
 * El motor de la vigilancia: sondear, verificar la prueba firmada, decidir si
 * hay que avisar y cuándo volver a mirar.
 *
 * No importa Electron a propósito, igual que apps-policy y game-detection.
 * Recibe del exterior por dónde avisar, dónde guardar el estado, qué hora es y
 * cómo hablar por la red — y eso es justo lo que permite probar el camino
 * completo contra un servidor de verdad sin arrancar la aplicación. Las reglas
 * sueltas (qué cuenta como disponible, cuánto se calla) viven un nivel más
 * abajo, en availability-policy.
 */
import { randomBytes, type JsonWebKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  DISPERSION_MS,
  applyCheck,
  healthCounts,
  stableWatchUrl,
  verifyProof,
  type Outcome,
  type SignedProof,
  type WatchTiming,
} from "./availability-policy.ts";

export interface AvailabilityWatchInput {
  url: string;
  name: string;
  instance_id: string;
  lineage_id: string;
  epoch: number;
  identity_fingerprint: string;
  identity_public_key: JsonWebKey;
  enabled: boolean;
  connected: boolean;
}

interface WatchState extends AvailabilityWatchInput, WatchTiming {}
export const MAX_AVAILABILITY_WATCHES = 20;

function validWatch(value: unknown): AvailabilityWatchInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AvailabilityWatchInput>;
  const url = typeof row.url === "string" ? stableWatchUrl(row.url) : null;
  const key = row.identity_public_key;
  const coordinate = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
  const validKey = key && typeof key === "object" && key.kty === "EC" && key.crv === "P-256"
    && coordinate(key.x) && coordinate(key.y);
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (
    !row.enabled || !url || !name || name.length > 80 ||
    typeof row.instance_id !== "string" || !row.instance_id || row.instance_id.length > 128 ||
    typeof row.lineage_id !== "string" || !row.lineage_id || row.lineage_id.length > 128 ||
    !Number.isSafeInteger(row.epoch) || (row.epoch ?? 0) < 1 ||
    typeof row.identity_fingerprint !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(row.identity_fingerprint) ||
    !validKey
  ) return null;
  return {
    url,
    name,
    instance_id: row.instance_id,
    lineage_id: row.lineage_id,
    epoch: row.epoch,
    identity_fingerprint: row.identity_fingerprint,
    identity_public_key: { kty: "EC", crv: "P-256", x: key!.x!, y: key!.y! },
    enabled: true,
    connected: row.connected === true,
  } as AvailabilityWatchInput;
}

/** Lo que el vigilante necesita del mundo. En producción lo pone Electron. */
export interface AvailabilitySurface {
  /** Fichero donde sobrevive el estado entre arranques. */
  statePath: string;
  /** Enseña un aviso; al pulsarlo hay que llevar a esa dirección. */
  notify(body: string, url: string): void;
  now?(): number;
  fetch?: typeof globalThis.fetch;
}

export interface AvailabilityWatcher {
  replace(input: AvailabilityWatchInput[]): void;
  setConnection(url: string, connected: boolean): void;
  /** Arranca el temporizador. Hasta entonces solo se avanza con `tick`. */
  start(): void;
  /** Comprueba ahora las vigilancias a las que ya les tocaba. */
  tick(): Promise<void>;
  stop(): void;
}

/** Una instancia sana responde poco: nadie tiene que aceptar un cuerpo enorme. */
async function smallJson(response: Response, limit = 32 * 1024): Promise<unknown> {
  const announced = Number(response.headers.get("content-length") ?? "0");
  if (announced > limit || !response.body) throw new Error("INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new Error("INVALID_RESPONSE");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function createAvailabilityWatcher(surface: AvailabilitySurface): AvailabilityWatcher {
  const clock = surface.now ?? Date.now;
  const call = surface.fetch ?? globalThis.fetch;
  let watches = new Map<string, WatchState>();
  let timer: NodeJS.Timeout | null = null;
  let started = false;

  /** Dispersión real, sin depender del azar barato. */
  const dispersion = (): number => randomBytes(2).readUInt16BE(0) % (DISPERSION_MS + 1);

  function load(): void {
    try {
      if (!existsSync(surface.statePath)) return;
      const rows = JSON.parse(readFileSync(surface.statePath, "utf8")) as unknown[];
      if (!Array.isArray(rows)) return;
      for (const value of rows) {
        if (watches.size >= MAX_AVAILABILITY_WATCHES) break;
        const row = validWatch(value);
        if (!row || watches.has(row.url)) continue;
        const timing = value as Partial<WatchTiming>;
        watches.set(row.url, {
          ...row,
          connected: false,
          failures: Number.isSafeInteger(timing.failures) ? Math.max(0, Math.min(1_000, timing.failures!)) : 0,
          offline_since: typeof timing.offline_since === "number" ? timing.offline_since : null,
          last_notification: typeof timing.last_notification === "number" ? timing.last_notification : 0,
          next_check: typeof timing.next_check === "number" ? timing.next_check : clock(),
        });
      }
    } catch {
      watches = new Map();
    }
  }

  function save(): void {
    writeFileSync(surface.statePath, `${JSON.stringify([...watches.values()], null, 2)}\n`, { mode: 0o600 });
  }

  /** Salud primero (barato) y prueba firmada después (la que de verdad decide). */
  async function probe(item: WatchState): Promise<Outcome> {
    const healthResponse = await call(`${item.url}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(6_000),
    });
    if (!healthResponse.ok) return "unavailable";
    const health = (await smallJson(healthResponse)) as { status?: unknown; instance_id?: unknown };
    if (!healthCounts(health.status) || health.instance_id !== item.instance_id) return "unavailable";

    const nonce = randomBytes(24).toString("base64url");
    const proofResponse = await call(`${item.url}/api/v1/instance/challenge`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce }),
      signal: AbortSignal.timeout(6_000),
    });
    if (!proofResponse.ok) return "unavailable";
    return verifyProof(item, (await smallJson(proofResponse)) as SignedProof, nonce, clock());
  }

  async function check(item: WatchState): Promise<Outcome> {
    let outcome: Outcome = "unavailable";
    try {
      outcome = await probe(item);
    } catch {
      outcome = "unavailable";
    }
    const { timing, notify } = applyCheck(item, outcome, clock(), dispersion());
    Object.assign(item, timing);
    if (notify) surface.notify(`${item.name} volvió a estar disponible.`, item.url);
    return outcome;
  }

  async function tick(): Promise<void> {
    const now = clock();
    const toca = [...watches.values()].filter(
      (item) => item.enabled && !item.connected && item.next_check <= now,
    );
    if (!toca.length) return;
    await Promise.all(toca.map(check));
    save();
  }

  function schedule(): void {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const vigiladas = [...watches.values()].filter((item) => item.enabled && !item.connected);
    if (!vigiladas.length) return;
    const wait = Math.max(250, Math.min(...vigiladas.map((item) => item.next_check)) - clock());
    timer = setTimeout(() => {
      timer = null;
      void tick().finally(schedule);
    }, wait);
    timer.unref();
  }

  return {
    start(): void {
      started = true;
      load();
      schedule();
    },

    replace(input: AvailabilityWatchInput[]): void {
      const next = new Map<string, WatchState>();
      for (const value of input) {
        if (next.size >= MAX_AVAILABILITY_WATCHES) break;
        const row = validWatch(value);
        if (!row || next.has(row.url)) continue;
        const previous = watches.get(row.url);
        next.set(row.url, {
          ...row,
          failures: previous?.failures ?? 0,
          offline_since: previous?.offline_since ?? null,
          last_notification: previous?.last_notification ?? 0,
          next_check: row.connected ? clock() + 60_000 : clock(),
        });
      }
      watches = next;
      save();
      schedule();
    },

    setConnection(url: string, connected: boolean): void {
      const item = watches.get(url);
      if (!item) return;
      if (!connected) {
        item.connected = false;
        item.next_check = clock();
        save();
        schedule();
        return;
      }
      /* Que el gateway conecte es una pista, no una prueba: cualquiera puede
         abrir un WebSocket. Antes de dar por buena la vuelta se pide igual la
         prueba firmada, así que un socket falso no llega a producir un aviso. */
      item.connected = false;
      item.next_check = clock();
      void check(item).then((outcome) => {
        item.connected = outcome === "available";
        save();
        schedule();
      });
      save();
      schedule();
    },

    tick,

    stop(): void {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
