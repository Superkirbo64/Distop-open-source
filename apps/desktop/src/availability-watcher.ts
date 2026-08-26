/**
 * El motor de la vigilancia: sondear, verificar la prueba firmada, seguir la
 * cadena de sucesión cuando la haya, decidir si hay que avisar y cuándo volver
 * a mirar.
 *
 * No importa Electron a propósito, igual que apps-policy y game-detection.
 * Recibe del exterior por dónde avisar, dónde guardar el estado, qué hora es y
 * cómo hablar por la red — y eso es justo lo que permite probar el camino
 * completo contra un servidor de verdad sin arrancar la aplicación. Las reglas
 * sueltas (qué cuenta como disponible, cuánto se calla, cómo se verifica un
 * eslabón) viven un nivel más abajo, en availability-policy.
 */
import { randomBytes, type JsonWebKey } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  DISPERSION_MS,
  applyCheck,
  healthCounts,
  pinnedRef,
  protocolMismatch,
  provenOrigin,
  stableWatchUrl,
  verifyChain,
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

/**
 * Lo que se cuenta con una ventana emergente. Solo dos cosas: que volvió, y que
 * se trasladó a una dirección demostrada. El texto lo escribe quien tiene
 * Electron delante; aquí solo se decide qué pasó.
 */
export type WatchNotice =
  | { kind: "back"; name: string; url: string }
  | { kind: "moved"; name: string; url: string; origin: string };

/**
 * Lo que NO se cuenta con una ventana emergente y aun así tiene que llegar.
 * Un conflicto de identidad no es una novedad agradable que se anuncia: es algo
 * que hay que mirar con la aplicación abierta, con contexto y sin prisa.
 */
export type WatchAlert =
  /** `fingerprint` es la clave que contestó en vez de la fijada. Enseñarla es
      lo único que permite a una persona comprobarlo por otro canal. */
  | { kind: "identity_conflict"; url: string; fingerprint: string }
  | { kind: "protocol_incompatible"; url: string; protocol: string };

/** Lo que el vigilante necesita del mundo. En producción lo pone Electron. */
export interface AvailabilitySurface {
  /** Fichero donde sobrevive el estado entre arranques. */
  statePath: string;
  /** Enseña un aviso; al pulsarlo hay que llevar a la dirección que trae. */
  notify(notice: WatchNotice): void;
  /** Se lo guarda la interfaz para enseñarlo al abrir. Nunca interrumpe. */
  alert(alert: WatchAlert): void;
  now?(): number;
  fetch?: typeof globalThis.fetch;
}

export interface AvailabilityWatcher {
  replace(input: AvailabilityWatchInput[]): void;
  setConnection(url: string, connected: boolean): void;
  /**
   * Deja de vigilar una dirección y borra lo que se sabía de ella, nombre
   * incluido. Lo llama la interfaz cuando la instancia deja de reconocer a esta
   * persona como miembro: seguir enseñando el nombre de una comunidad de la que
   * te echaron, en la bandeja de tu propio equipo, no le sirve a nadie.
   */
  forget(url: string): boolean;
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

/** Un sondeo terminado: qué pasó, a dónde si se mudó, y qué se vio si chirría. */
interface Probe {
  outcome: Outcome;
  origin?: string;
  /** La huella que contestó, cuando no es la fijada. */
  fingerprint?: string;
  /** La versión que dijo hablar, cuando no es la nuestra. */
  protocol?: string;
}

/** Dieciséis eslabones con su clave y su firma caben de sobra; más, no. */
const LIMITE_CADENA_BYTES = 128 * 1024;

interface ChainBody {
  lineage_id?: unknown;
  inbound_chain?: unknown;
  chain?: unknown;
  superseded?: unknown;
  successor_origin?: unknown;
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
          /* Los tres nacieron con A1 final: un fichero escrito por una versión
             anterior no los trae, y no traerlos significa "nada raro todavía". */
          moved_origin: typeof timing.moved_origin === "string" ? stableWatchUrl(timing.moved_origin) : null,
          blocked: timing.blocked === true,
          last_outcome: typeof timing.last_outcome === "string" ? (timing.last_outcome as Outcome) : null,
        });
      }
    } catch {
      watches = new Map();
    }
  }

  function save(): void {
    writeFileSync(surface.statePath, `${JSON.stringify([...watches.values()], null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Esta dirección ya no es la de siempre. O quien contesta afirma continuar la
   * línea —y acaba de firmar nuestro nonce, así que hay con qué compararlo—, o
   * la máquina de siempre solo sabe ya decir a dónde se fue.
   *
   * En los dos casos la prueba es la misma: una cadena de certificados que
   * arranca exactamente en la clave que teníamos fijada. Sin eso no se manda a
   * nadie a ninguna parte, por muy convincente que sea la respuesta.
   */
  async function follow(item: WatchState, proof: SignedProof | null): Promise<Probe> {
    const now = clock();
    let body: ChainBody;
    try {
      const response = await call(`${item.url}/api/v1/succession/chain`, {
        redirect: "manual",
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) return { outcome: "unavailable" };
      body = (await smallJson(response, LIMITE_CADENA_BYTES)) as ChainBody;
    } catch {
      return { outcome: "unavailable" };
    }

    /* Otro linaje es otra comunidad. No es un conflicto ni una mudanza: es que
       en esta dirección vive ahora el servidor de otra persona. */
    if (typeof body.lineage_id === "string" && body.lineage_id !== item.lineage_id) {
      return { outcome: "unavailable" };
    }

    const pinned = pinnedRef(item);

    if (proof) {
      const cadena = verifyChain(pinned, body.inbound_chain, now);
      /* La cadena tiene que terminar exactamente en quien acaba de firmar. Si
         termina en otra clave, alguien ha juntado una cadena real con una firma
         real de dos instancias distintas. */
      if (
        cadena &&
        cadena.final.instance_id === proof.payload.instance_id &&
        cadena.final.epoch === proof.payload.epoch &&
        cadena.final.fingerprint === proof.fingerprint
      ) {
        return { outcome: "available_successor", origin: item.url };
      }
      /* Firmó, dijo continuar la línea y no lo demuestra. Eso no es una caída
         de red: es una afirmación que no se sostiene, en la dirección de tu
         propia comunidad. */
      return { outcome: "identity_conflict", fingerprint: proof.fingerprint };
    }

    if (body.superseded === true) {
      const cadena = verifyChain(pinned, body.chain, now);
      if (!cadena) return { outcome: "identity_conflict", fingerprint: "" };
      const destino = provenOrigin(body.successor_origin, cadena);
      /* Cadena buena y destino sin firmar: no se manda a nadie a una dirección
         que no autorizó el predecesor. Se calla y se vuelve a mirar. */
      return destino ? { outcome: "available_successor", origin: destino } : { outcome: "unavailable" };
    }

    return { outcome: "unavailable" };
  }

  /** Salud primero (barato) y prueba firmada después (la que de verdad decide). */
  async function probe(item: WatchState): Promise<Probe> {
    const healthResponse = await call(`${item.url}/health`, {
      redirect: "manual",
      signal: AbortSignal.timeout(6_000),
    });
    if (!healthResponse.ok) return { outcome: "unavailable" };
    const health = (await smallJson(healthResponse)) as { status?: unknown; instance_id?: unknown; protocol?: unknown };
    /* Antes que nada: si habla otra versión, no se le pide nada más. */
    if (protocolMismatch(health.protocol)) {
      return { outcome: "protocol_incompatible", protocol: String(health.protocol) };
    }

    const nonce = randomBytes(24).toString("base64url");
    let proof: SignedProof | null = null;
    try {
      const proofResponse = await call(`${item.url}/api/v1/instance/challenge`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nonce }),
        signal: AbortSignal.timeout(6_000),
      });
      /* Una instancia retirada devuelve 410 aquí y sigue sirviendo la cadena.
         Que no firme no es el final del sondeo: es la señal de mirar a dónde
         se fue. */
      if (proofResponse.ok) proof = (await smallJson(proofResponse)) as SignedProof;
    } catch {
      proof = null;
    }

    const veredicto = proof ? verifyProof(item, proof, nonce, clock()) : "unavailable";

    if (veredicto === "available_same") {
      /* La firma dice que es ella. /health dice si además está para atender. */
      const sana = healthCounts(health.status) && health.instance_id === item.instance_id;
      return { outcome: sana ? "available_same" : "unavailable" };
    }
    if (veredicto === "identity_conflict") {
      return { outcome: "identity_conflict", fingerprint: proof?.fingerprint ?? "" };
    }
    if (veredicto === "protocol_incompatible") {
      return { outcome: "protocol_incompatible", protocol: proof?.payload.protocol ?? "" };
    }
    /* Firmó y no es nadie que reconozcamos: no hay motivo para creerle una
       cadena tampoco. Solo se sigue buscando cuando no llegó a firmar (retirada)
       o cuando afirma ser la continuación. */
    if (veredicto === "unavailable" && proof !== null) return { outcome: "unavailable" };

    return follow(item, veredicto === "successor_claimed" ? proof : null);
  }

  async function check(item: WatchState): Promise<Outcome> {
    let result: Probe = { outcome: "unavailable" };
    try {
      result = await probe(item);
    } catch {
      result = { outcome: "unavailable" };
    }

    const cambio = item.last_outcome !== result.outcome;
    const { timing, notify } = applyCheck(item, result.outcome, clock(), dispersion(), result.origin ?? null);
    Object.assign(item, timing);
    item.last_outcome = result.outcome;

    if (notify?.kind === "back") surface.notify({ kind: "back", name: item.name, url: item.url });
    if (notify?.kind === "moved") {
      surface.notify({ kind: "moved", name: item.name, url: item.url, origin: notify.origin });
    }
    /* Solo al cambiar: repetir la misma alerta cada cinco minutos la convierte
       en ruido, y el ruido se acaba ignorando justo cuando importa. */
    if (cambio && result.outcome === "identity_conflict") {
      surface.alert({ kind: "identity_conflict", url: item.url, fingerprint: result.fingerprint ?? "" });
    }
    if (cambio && result.outcome === "protocol_incompatible") {
      surface.alert({ kind: "protocol_incompatible", url: item.url, protocol: result.protocol ?? "" });
    }
    return result.outcome;
  }

  /** Ni conectadas, ni bloqueadas por un conflicto, ni antes de tiempo. */
  function pendientes(now: number): WatchState[] {
    return [...watches.values()].filter(
      (item) => item.enabled && !item.connected && !item.blocked && item.next_check <= now,
    );
  }

  async function tick(): Promise<void> {
    const toca = pendientes(clock());
    if (!toca.length) return;
    await Promise.all(toca.map(check));
    save();
  }

  function schedule(): void {
    if (!started) return;
    if (timer) clearTimeout(timer);
    const vigiladas = [...watches.values()].filter((item) => item.enabled && !item.connected && !item.blocked);
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
        /* Un conflicto se arrastra mientras la identidad fijada siga siendo la
           misma. Si la interfaz llega con otra huella, es que una persona ya
           decidió a quién cree, y volver a bloquear sería desautorizarla. */
        const mismaIdentidad = previous?.identity_fingerprint === row.identity_fingerprint;
        next.set(row.url, {
          ...row,
          failures: previous?.failures ?? 0,
          offline_since: previous?.offline_since ?? null,
          last_notification: previous?.last_notification ?? 0,
          next_check: row.connected ? clock() + 60_000 : clock(),
          moved_origin: mismaIdentidad ? previous?.moved_origin ?? null : null,
          blocked: mismaIdentidad ? previous?.blocked === true : false,
          last_outcome: mismaIdentidad ? previous?.last_outcome ?? null : null,
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
        item.connected = outcome === "available_same";
        save();
        schedule();
      });
      save();
      schedule();
    },

    forget(url: string): boolean {
      const clave = stableWatchUrl(url);
      if (!clave || !watches.delete(clave)) return false;
      save();
      schedule();
      return true;
    },

    tick,

    stop(): void {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
