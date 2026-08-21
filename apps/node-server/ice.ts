/**
 * Por dónde se conectan dos navegadores (§9.4, §6).
 *
 * La voz siempre pasa por la instancia y usa la misma ruta de la aplicación.
 * Esta configuración solo decide el camino del vídeo cuando está en modo directo:
 * cámara y pantalla van de un navegador a otro, con TURN como respaldo opcional.
 *
 * Cuándo no existe, en la práctica:
 *   · Los dos en la misma casa, si el router no deja hablarse a dos aparatos
 *     suyos (aislamiento de clientes) o bloquea el descubrimiento local.
 *   · Uno con datos móviles: la operadora usa NAT simétrica y no hay agujero que
 *     perforar.
 *   · Redes de oficina o universidad que solo dejan salir por 80 y 443.
 *
 * Si esa ruta no existe, falla el vídeo directo; la voz continúa por la instancia.
 *
 * Tres cosas distintas, y solo la tercera cuesta ancho de banda a alguien:
 *   STUN  — responde "esta es tu dirección pública". Gratis e ilimitado.
 *   TURN  — reenvía los paquetes cuando no hay ruta directa. Cifrados: ve por
 *           dónde pasan, no qué llevan.
 *   SFU   — reenvía y además procesa. No lo hay aquí (fase 3).
 */
import { config } from "./config.ts";
import { meta, setMeta } from "./db.ts";
import { badRequest } from "./http.ts";

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Descubrimiento de dirección pública. Varios porque uno solo puede estar caído. */
const STUN: IceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];

export type RelayMode = "direct" | "custom" | "cloudflare" | "metered";

/**
 * Por dónde va la imagen.
 *   host   — sube a la instancia y ella la reparte. Funciona siempre, cuesta
 *            subida a quien hospeda: una copia por cada persona que mira.
 *   direct — de navegador a navegador. No cuesta nada a la instancia, pero solo
 *            llega si las dos redes dejan hablarse, que no siempre pasa.
 */
export type VideoMode = "host" | "direct";

/**
 * Techo de calidad de la imagen. No es un límite comercial (§10.3): es la subida
 * de quien hospeda, que es finita y se multiplica por cada persona que mira.
 * Quien la paga, la decide.
 */
export type Quality = "low" | "medium" | "high";
const QUALITIES: Quality[] = ["low", "medium", "high"];

interface Relay {
  mode: RelayMode;
  video: VideoMode;
  quality: Quality;
  /** TURN propio (coturn y similares). */
  url: string;
  username: string;
  credential: string;
  /** Cloudflare Realtime: la clave larga se queda aquí y nunca sale al navegador. */
  keyId: string;
  apiToken: string;
  /** Metered: el subdominio de la cuenta y su clave, igual de secreta. */
  appName: string;
  apiKey: string;
}

const DEFAULT: Relay = {
  mode: "direct",
  // Por defecto por la instancia: es lo único que funciona sin configurar nada,
  // y una comunidad casera son cuatro personas, no cuarenta.
  video: "host",
  quality: "medium",
  url: "",
  username: "",
  credential: "",
  keyId: "",
  apiToken: "",
  appName: "",
  apiKey: "",
};

function stored(): Relay {
  try {
    const saved = { ...DEFAULT, ...(JSON.parse(meta("voice_relay", () => JSON.stringify(DEFAULT))) as Partial<Relay>) };
    // Un modo que ya no existe (o escrito a mano) no puede dejar la instancia en
    // un estado que la interfaz no sepa dibujar: se cae al de siempre.
    if (!MODES.includes(saved.mode)) saved.mode = "direct";
    if (saved.video !== "direct") saved.video = "host";
    if (!QUALITIES.includes(saved.quality)) saved.quality = "medium";
    return saved;
  } catch {
    return DEFAULT;
  }
}

/** Si quien hospeda puso ICE_SERVERS a mano, manda eso: es una decisión explícita. */
function fromEnv(): boolean {
  return config.iceServers.length > 0;
}

/* ── proveedores con cuenta ───────────────────────────────────────────────
   Los dos funcionan igual de cara a la instancia: se guarda una clave larga que
   NUNCA sale al navegador, y con ella se piden credenciales cortas que sí se
   reparten. Cambian el sitio al que se pregunta y la forma de la respuesta.

   Cloudflare — 1000 GB al mes, pero exige datos de facturación en la cuenta.
   Metered   — 0,5 GB al mes sin tarjeta (20 GB si añades una), y al agotarse
               deja de retransmitir en vez de cobrar. */

const MODES: RelayMode[] = ["direct", "custom", "cloudflare", "metered"];

/** Cloudflare no acepta más de 48 h; 24 basta y sobra para cualquier llamada. */
const TTL_SECONDS = 86_400;

let minted: { servers: IceServer[]; until: number; key: string } | null = null;

async function cloudflareServers(relay: Relay): Promise<IceServer[]> {
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(relay.keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${relay.apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare respondió ${response.status}`);

  const body = (await response.json()) as { iceServers?: IceServer | IceServer[] };
  // Devuelve un objeto cuando solo hay un servidor y un array cuando hay varios.
  return body.iceServers ? (Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]) : [];
}

async function meteredServers(relay: Relay): Promise<IceServer[]> {
  const host = `${encodeURIComponent(relay.appName)}.metered.live`;
  const response = await fetch(`https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(relay.apiKey)}`);
  if (!response.ok) throw new Error(`Metered respondió ${response.status}`);

  const body = (await response.json()) as IceServer[] | { error?: string };
  if (!Array.isArray(body)) throw new Error("Metered no devolvió ningún servidor");
  return body;
}

/** Credenciales del proveedor configurado, reaprovechadas mientras valgan. */
async function fromProvider(relay: Relay): Promise<IceServer[]> {
  const key = `${relay.mode}:${relay.keyId}${relay.appName}`;
  // Sin caché, cada carga de la página sería una llamada a la API del proveedor.
  if (minted && minted.key === key && minted.until > Date.now()) return minted.servers;

  const servers = relay.mode === "cloudflare" ? await cloudflareServers(relay) : await meteredServers(relay);
  if (servers.length === 0) throw new Error("no devolvió ningún servidor");

  // Se renueva una hora antes de caducar: una llamada en curso no se queda sin relevo.
  minted = { servers, until: Date.now() + (TTL_SECONDS - 3600) * 1000, key };
  return servers;
}

function configured(relay: Relay): boolean {
  if (relay.mode === "cloudflare") return Boolean(relay.keyId && relay.apiToken);
  if (relay.mode === "metered") return Boolean(relay.appName && relay.apiKey);
  return false;
}

export async function iceServers(): Promise<IceServer[]> {
  if (fromEnv()) return config.iceServers;
  const relay = stored();

  if (configured(relay)) {
    try {
      return await fromProvider(relay);
    } catch {
      // Proveedor caído, clave revocada o cuota agotada: mejor seguir con STUN,
      // que arregla la mayoría de los casos, que dejar la aplicación sin arrancar.
      return STUN;
    }
  }
  if (relay.mode === "custom" && relay.url) {
    return [...STUN, { urls: relay.url, username: relay.username, credential: relay.credential }];
  }
  return STUN;
}

/** Nunca devuelve secretos: ni la contraseña del TURN ni las claves de los proveedores. */
export function relayState(): {
  mode: RelayMode;
  video: VideoMode;
  quality: Quality;
  url: string;
  username: string;
  keyId: string;
  appName: string;
  locked: boolean;
} {
  const relay = stored();
  return {
    mode: relay.mode,
    video: relay.video,
    quality: relay.quality,
    url: relay.url,
    username: relay.username,
    keyId: relay.keyId,
    appName: relay.appName,
    locked: fromEnv(),
  };
}

/** Lo necesita cualquiera que entre, no solo quien hospeda: va en /info. */
export function videoMode(): { mode: VideoMode; quality: Quality } {
  const relay = stored();
  return { mode: relay.video, quality: relay.quality };
}

export async function setRelay(next: Partial<Relay>): Promise<ReturnType<typeof relayState>> {
  const relay = { ...stored(), ...next };
  if (relay.video !== "direct") relay.video = "host";
  if (!QUALITIES.includes(relay.quality)) relay.quality = "medium";

  // Con el vídeo pasando por la instancia no hay conexión directa que arreglar,
  // así que un relevo TURN no pintaría nada: se guarda igual por si se cambia.
  if (relay.mode === "cloudflare" || relay.mode === "metered") {
    if (!configured(relay)) throw badRequest("Faltan las credenciales del proveedor.");
    minted = null;
    // Se comprueba AHORA, no en la primera llamada: guardar unas credenciales que
    // no funcionan deja la sala rota y con aspecto de configurada.
    try {
      await fromProvider(relay);
    } catch (err) {
      throw badRequest(`No aceptó esas credenciales: ${err instanceof Error ? err.message : "error"}`);
    }
  } else if (relay.mode === "custom") {
    // Un "stun:" donde va un TURN no relevaría nada: quedaría con aspecto de
    // configurado y fallando igual. Mejor rechazarlo que fingir.
    if (!/^turns?:/.test(relay.url)) throw badRequest("La dirección tiene que empezar por turn: o turns:");
  } else {
    relay.mode = "direct";
    minted = null;
  }

  setMeta("voice_relay", JSON.stringify(relay));
  return relayState();
}
