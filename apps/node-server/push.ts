/**
 * Web Push, escrito a mano (§2.4 del plan de continuidad, A2).
 *
 * Sirve para una sola cosa que ninguna otra pieza puede dar: avisar con la
 * aplicación **cerrada**. El vigilante de la bandeja necesita que Distop esté
 * abierto en algún sitio; esto no.
 *
 * Se implementa aquí en vez de traer una dependencia porque todo lo que hace
 * falta está en `node:crypto` y porque el proyecto solo depende de `ws`. El
 * coste es real y conviene decirlo: son dos RFC de criptografía que tienen que
 * estar exactamente bien, no un envoltorio.
 *
 *   RFC 8291 — cifrado del mensaje: ECDH P-256 + HKDF-SHA256 + AES-128-GCM.
 *   RFC 8292 — autenticación del emisor: JWT ES256 (VAPID).
 *   RFC 8188 — el sobre `aes128gcm` que las dos usan.
 *
 * Lo que NO hace, y no puede hacer:
 *
 * - **No funciona en la aplicación de escritorio empaquetada.** Electron no
 *   trae servicio de push y el origen es `app://distop`. El escritorio usa el
 *   vigilante de la bandeja; el navegador usa esto.
 * - **El proveedor de push del navegador ve el momento, la frecuencia y el
 *   tamaño**, aunque el contenido vaya cifrado de extremo a extremo. Por eso
 *   los avisos van rellenados a un tamaño fijo: que todos pesen igual quita la
 *   única señal que quedaba a la vista.
 * - **El contenido no viaja.** Ni nombre de comunidad, ni texto, ni quién
 *   escribió, ni direcciones. Solo un código de tipo y, como mucho, un número.
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
  timingSafeEqual,
  type JsonWebKey,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { uuidv7 } from "@distop/protocol";
import { config } from "./config.ts";
import { db, setMeta } from "./db.ts";
import { writesAccepted } from "./lifecycle.ts";
import { publicUrl } from "./tunnel.ts";

const DATA_DIR = dirname(resolve(config.databasePath));
export const RUTA_PUSH_SECRETO = "secrets/push";
const FICHERO = join(DATA_DIR, "push.key");

const b64u = (buffer: Buffer): string => buffer.toString("base64url");
const deB64u = (value: string): Buffer => Buffer.from(value, "base64url");

/* ── material de la instancia ──────────────────────────────────────────
 *
 * Las claves VAPID son de la instancia, no de un servicio. Viajan dentro de
 * una copia cifrada y de un relevo (§5.6) porque si no viajaran, cada
 * suscripción del navegador de cada miembro quedaría muerta al restaurar o al
 * cambiar de anfitrión, y habría que pedirle a todo el mundo que volviera a
 * activarlo.
 *
 * Y por eso mismo: **quien restaura una copia puede mandar notificaciones a
 * los navegadores de tus miembros.** Va escrito en la documentación junto a
 * los mensajes y los hashes de contraseña, no escondido aquí.
 */
interface PushSecrets {
  version: 1;
  /** El par VAPID completo, en JWK: firmar el JWT necesita la privada. */
  vapid: JsonWebKey;
  /** Clave AES-256 para lo que se guarda en la base. Ver `sellar`. */
  at_rest: string;
}

let secretos: PushSecrets | null = null;

function nuevoPar(): PushSecrets {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const publica = ecdh.getPublicKey();
  return {
    version: 1,
    vapid: {
      kty: "EC",
      crv: "P-256",
      d: b64u(ecdh.getPrivateKey()),
      x: b64u(publica.subarray(1, 33)),
      y: b64u(publica.subarray(33, 65)),
    },
    at_rest: b64u(randomBytes(32)),
  };
}

function cargar(): PushSecrets {
  if (secretos) return secretos;
  if (existsSync(FICHERO)) {
    try {
      const leido = JSON.parse(readFileSync(FICHERO, "utf8")) as PushSecrets;
      if (leido?.version === 1 && leido.vapid?.d && leido.vapid.x && leido.vapid.y && leido.at_rest) {
        secretos = leido;
        return secretos;
      }
    } catch {
      /* Ilegible: se regenera. Perder las suscripciones es molesto; arrancar
         sin poder avisar a nadie y sin decirlo, peor. */
    }
  }
  secretos = nuevoPar();
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FICHERO, `${JSON.stringify(secretos, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(FICHERO, 0o600);
  } catch {
    /* Windows no siempre lo respeta; en Linux sí, que es donde importa. */
  }
  return secretos;
}

/** El punto sin comprimir, que es lo que el navegador espera en `applicationServerKey`. */
export function vapidPublicKey(): string {
  const { vapid } = cargar();
  return b64u(Buffer.concat([Buffer.from([0x04]), deB64u(vapid.x!), deB64u(vapid.y!)]));
}

/** La ruta del fichero de secretos, para que la copia de seguridad lo incluya. */
export function pushSecretFile(): string {
  return FICHERO;
}

/* ── cifrado en reposo de las suscripciones ────────────────────────────
 *
 * Un `endpoint` es una URL capaz de despertar el navegador de una persona, y
 * `auth`+`p256dh` son las claves que cifran lo que se le manda. En claro, un
 * `app.db` compartido o una copia suelta de la base entrega las tres cosas.
 *
 * Lo que esto protege es exactamente eso: la base por su cuenta. **No protege
 * contra quien tiene el directorio de datos entero**, porque la clave vive
 * ahí al lado — decir otra cosa sería mentir. Que la clave esté aparte del
 * `secret.key` de sesiones tiene su motivo: ese rota en un relevo (§5.5), y
 * las suscripciones tienen que sobrevivirlo.
 */
function sellar(valor: unknown): string {
  const clave = deB64u(cargar().at_rest);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", clave, iv);
  const cuerpo = Buffer.concat([cipher.update(JSON.stringify(valor), "utf8"), cipher.final()]);
  return b64u(Buffer.concat([iv, cipher.getAuthTag(), cuerpo]));
}

function abrir<T>(sellado: string): T | null {
  try {
    const bruto = deB64u(sellado);
    const clave = deB64u(cargar().at_rest);
    const decipher = createDecipheriv("aes-256-gcm", clave, bruto.subarray(0, 12));
    decipher.setAuthTag(bruto.subarray(12, 28));
    const texto = Buffer.concat([decipher.update(bruto.subarray(28)), decipher.final()]).toString("utf8");
    return JSON.parse(texto) as T;
  } catch {
    return null;
  }
}

/* ── RFC 8291: cifrar el mensaje ───────────────────────────────────────── */

const hmac = (clave: Buffer, datos: Buffer): Buffer => createHmac("sha256", clave).update(datos).digest();

/** HKDF-Expand con un solo bloque: nada de lo que se deriva aquí pasa de 32 B. */
function expandir(prk: Buffer, info: Buffer, longitud: number): Buffer {
  return hmac(prk, Buffer.concat([info, Buffer.from([0x01])])).subarray(0, longitud);
}

export interface PushKeys {
  /** Clave pública del navegador, punto sin comprimir de 65 bytes. */
  p256dh: string;
  /** Secreto de autenticación de 16 bytes que genera el navegador. */
  auth: string;
}

/**
 * El sobre `aes128gcm` completo, listo para el cuerpo de la petición.
 *
 * `salt` y `senderPrivate` son inyectables **solo** para poder reproducir el
 * ejemplo del RFC 8291 §5 byte a byte en la prueba. En producción los dos
 * salen de `randomBytes`, y reutilizar cualquiera de los dos entre mensajes
 * rompería el cifrado: es la razón de que no haya forma de fijarlos desde
 * fuera de este módulo.
 */
export function encryptPush(opts: {
  plaintext: Buffer;
  keys: PushKeys;
  salt?: Buffer;
  senderPrivate?: Buffer;
  /** Relleno RFC 8188 tras el delimitador, para que todos pesen igual. */
  padTo?: number;
}): Buffer {
  const uaPublic = deB64u(opts.keys.p256dh);
  const authSecret = deB64u(opts.keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("PUSH_BAD_CLIENT_KEY");
  if (authSecret.length !== 16) throw new Error("PUSH_BAD_AUTH_SECRET");

  const ecdh = createECDH("prime256v1");
  if (opts.senderPrivate) ecdh.setPrivateKey(opts.senderPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);

  /* Los cinco pasos del §3.4, en orden. El orden de ua_public y as_public
     dentro de key_info no es simétrico y equivocarlo produce una clave
     perfectamente válida que el navegador no puede deshacer. */
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), uaPublic, asPublic]);
  const ikm = expandir(prkKey, keyInfo, 32);
  const prk = hmac(salt, ikm);
  const cek = expandir(prk, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
  const nonce = expandir(prk, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

  /* Un solo registro, así que el delimitador es 0x02. Detrás van ceros hasta
     el tamaño pedido: el proveedor de push ve el tamaño aunque no vea el
     contenido, y un aviso de 12 bytes y otro de 90 no dicen lo mismo. */
  const relleno = Math.max(0, (opts.padTo ?? 0) - opts.plaintext.length - 1);
  const registro = Buffer.concat([opts.plaintext, Buffer.from([0x02]), Buffer.alloc(relleno)]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const cifrado = Buffer.concat([cipher.update(registro), cipher.final(), cipher.getAuthTag()]);

  const cabecera = Buffer.alloc(21);
  salt.copy(cabecera, 0);
  cabecera.writeUInt32BE(4096, 16);
  cabecera.writeUInt8(asPublic.length, 20);
  return Buffer.concat([cabecera, asPublic, cifrado]);
}

/* ── RFC 8292: decir quién manda ───────────────────────────────────────── */

/**
 * `sub` tiene que ser una forma de contactar con quien envía, por si el
 * servicio de push necesita quejarse. La dirección pública de la instancia lo
 * es, y no filtra nada que quien se suscribió no supiera ya. Sin dirección
 * pública no hay push posible de todas formas: el navegador tampoco podría
 * llegar aquí.
 */
function contacto(): string {
  const configurado = config.pushContact?.trim();
  if (configurado) return configurado;
  const publica = publicUrl();
  if (!publica) throw new Error("PUSH_NO_PUBLIC_URL");
  return publica;
}

export function vapidAuthHeader(endpoint: string, now = Date.now()): string {
  const { vapid } = cargar();
  const aud = new URL(endpoint).origin;
  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  /* Doce horas: el RFC permite hasta veinticuatro y no hay ninguna razón para
     acercarse al techo cuando el token se emite en cada envío. */
  const payload = b64u(
    Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: contacto() })),
  );
  const firma = sign(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key: createPrivateKey({ key: vapid, format: "jwk" }), dsaEncoding: "ieee-p1363" },
  );
  return `vapid t=${header}.${payload}.${b64u(firma)}, k=${vapidPublicKey()}`;
}

/* ── suscripciones ─────────────────────────────────────────────────────── */

/** Lo mínimo que se enseña de una suscripción sin abrirla. */
export interface StoredSubscription {
  id: string;
  user_id: string;
  created_at: number;
  failures: number;
}

interface SubscriptionSecrets {
  endpoint: string;
  keys: PushKeys;
}

interface FilaPush {
  id: string;
  user_id: string;
  endpoint_hash: string;
  sealed: string;
  created_at: number;
  last_success: number | null;
  failures: number;
  next_attempt: number;
}

/** El endpoint no se guarda en claro ni siquiera para deduplicar. */
const huellaEndpoint = (endpoint: string): string => createHash("sha256").update(endpoint).digest("base64url");

export class PushError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function registerSubscription(opts: {
  userId: string;
  endpoint: string;
  keys: PushKeys;
  now?: number;
}): StoredSubscription {
  let url: URL;
  try {
    url = new URL(opts.endpoint);
  } catch {
    throw new PushError("PUSH_BAD_ENDPOINT", "La dirección de la suscripción no es válida.");
  }
  /* Solo https, y nada de credenciales en la URL. Un endpoint es algo a lo que
     esta instancia hará peticiones salientes: aceptar http o una dirección
     arbitraria lo convertiría en un ariete contra la red del anfitrión (SSRF,
     §22). El servicio de push del navegador siempre es https. */
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new PushError("PUSH_BAD_ENDPOINT", "Solo se aceptan suscripciones https.");
  }
  if (opts.endpoint.length > 1000) throw new PushError("PUSH_BAD_ENDPOINT", "Suscripción demasiado larga.");
  if (deB64u(opts.keys.p256dh).length !== 65) throw new PushError("PUSH_BAD_KEYS", "Clave de cliente inválida.");
  if (deB64u(opts.keys.auth).length !== 16) throw new PushError("PUSH_BAD_KEYS", "Secreto de autenticación inválido.");

  const now = opts.now ?? Date.now();
  const hash = huellaEndpoint(opts.endpoint);
  const sellado = sellar({ endpoint: opts.endpoint, keys: opts.keys } satisfies SubscriptionSecrets);

  /* Reactivar la misma suscripción es lo normal —el navegador la renueva sola—
     y tiene que ser idempotente: se actualiza y se reinician los fallos. */
  const existente = db.prepare("SELECT id FROM push_subscriptions WHERE endpoint_hash = ?").get(hash) as
    | { id: string }
    | undefined;
  if (existente) {
    db.prepare(
      "UPDATE push_subscriptions SET user_id = ?, sealed = ?, failures = 0, next_attempt = 0 WHERE id = ?",
    ).run(opts.userId, sellado, existente.id);
    return { id: existente.id, user_id: opts.userId, created_at: now, failures: 0 };
  }

  /* Tope por persona: un navegador por dispositivo es lo esperable, y una
     lista sin fondo es sitio gratis en la base de quien hospeda. */
  const suyas = (
    db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(opts.userId) as { n: number }
  ).n;
  if (suyas >= MAX_SUSCRIPCIONES) {
    db.prepare(
      "DELETE FROM push_subscriptions WHERE id IN (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at LIMIT ?)",
    ).run(opts.userId, suyas - MAX_SUSCRIPCIONES + 1);
  }

  const id = uuidv7();
  db.prepare(
    "INSERT INTO push_subscriptions (id, user_id, endpoint_hash, sealed, created_at, failures, next_attempt) VALUES (?, ?, ?, ?, ?, 0, 0)",
  ).run(id, opts.userId, hash, sellado, now);
  return { id, user_id: opts.userId, created_at: now, failures: 0 };
}

export const MAX_SUSCRIPCIONES = 8;

/** Darse de baja: se identifica por el endpoint, que solo tiene quien lo tiene. */
export function dropSubscription(userId: string, endpoint: string): boolean {
  const info = db
    .prepare("DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?")
    .run(huellaEndpoint(endpoint), userId);
  return info.changes > 0;
}

export function subscriptionCount(userId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").get(userId) as { n: number }).n;
}

/** ¿Está este navegador ya suscrito aquí? Sin decir cuáles hay. */
export function hasSubscription(userId: string, endpoint: string): boolean {
  const fila = db
    .prepare("SELECT endpoint_hash FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?")
    .get(huellaEndpoint(endpoint), userId) as { endpoint_hash: string } | undefined;
  if (!fila) return false;
  const esperado = Buffer.from(huellaEndpoint(endpoint));
  const visto = Buffer.from(fila.endpoint_hash);
  return esperado.length === visto.length && timingSafeEqual(esperado, visto);
}

/* ── entrega ───────────────────────────────────────────────────────────── */

/**
 * Lo único que viaja dentro del sobre cifrado.
 *
 * `t` es un código, no una frase: el texto lo pone el service worker, en el
 * idioma de quien lo lee. `n` es un número y nada más. Ni nombres de
 * comunidad, ni de canal, ni de quien escribió, ni direcciones.
 */
export interface PushPayload {
  v: 1;
  t: "instance_online" | "mention" | "invite";
  n?: number;
}

/** Todos los avisos pesan lo mismo por dentro: el tamaño también dice cosas. */
export const RELLENO_FIJO = 96;

export type DeliveryResult = "ok" | "gone" | "retry";

/** Cuánto se espera tras cada fallo seguido. Cinco y se abandona. */
const ESPERAS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 12 * 3600_000];
export const FALLOS_PARA_ABANDONAR = ESPERAS_MS.length;

async function enviar(secretos: SubscriptionSecrets, payload: PushPayload, ttl: number): Promise<DeliveryResult> {
  let cuerpo: Buffer;
  let autorizacion: string;
  try {
    cuerpo = encryptPush({
      plaintext: Buffer.from(JSON.stringify(payload), "utf8"),
      keys: secretos.keys,
      padTo: RELLENO_FIJO,
    });
    autorizacion = vapidAuthHeader(secretos.endpoint);
  } catch {
    /* Sin dirección pública o con claves rotas no hay nada que reintentar. */
    return "gone";
  }

  try {
    const respuesta = await fetch(secretos.endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: autorizacion,
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: String(ttl),
        urgency: "normal",
      },
      body: cuerpo,
      signal: AbortSignal.timeout(10_000),
    });
    /* 404 y 410 son definitivos y lo dice el RFC: esa suscripción ya no existe
       y reintentarla es golpear a un servicio ajeno para siempre. */
    if (respuesta.status === 404 || respuesta.status === 410) return "gone";
    return respuesta.ok ? "ok" : "retry";
  } catch {
    return "retry";
  }
}

/**
 * Manda un aviso a todos los navegadores de una persona.
 *
 * Devuelve cuántos salieron. No espera a nadie más de lo necesario y **nunca
 * entra en bucle**: cada fallo espacia el siguiente intento y al quinto la
 * suscripción se borra. Insistir contra un endpoint muerto es tráfico contra
 * un servicio ajeno que además nunca va a funcionar.
 */
export async function pushToUser(userId: string, payload: PushPayload, now = Date.now()): Promise<number> {
  const filas = db
    .prepare("SELECT * FROM push_subscriptions WHERE user_id = ? AND next_attempt <= ?")
    .all(userId, now) as FilaPush[];
  return entregar(filas, payload, now);
}

async function entregar(filas: FilaPush[], payload: PushPayload, now: number): Promise<number> {
  let enviados = 0;
  await Promise.all(
    filas.map(async (fila) => {
      const secretos = abrir<SubscriptionSecrets>(fila.sealed);
      if (!secretos) {
        /* No se puede abrir: o el fichero de claves se regeneró o la fila está
           corrupta. En los dos casos es basura que no sirve para nada. */
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(fila.id);
        return;
      }
      const resultado = await enviar(secretos, payload, payload.t === "instance_online" ? 3600 : 600);
      if (resultado === "ok") {
        enviados += 1;
        db.prepare("UPDATE push_subscriptions SET last_success = ?, failures = 0, next_attempt = 0 WHERE id = ?")
          .run(now, fila.id);
        return;
      }
      if (resultado === "gone") {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(fila.id);
        return;
      }
      const fallos = fila.failures + 1;
      if (fallos >= FALLOS_PARA_ABANDONAR) {
        db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(fila.id);
        return;
      }
      db.prepare("UPDATE push_subscriptions SET failures = ?, next_attempt = ? WHERE id = ?")
        .run(fallos, now + ESPERAS_MS[fallos - 1]!, fila.id);
    }),
  );
  return enviados;
}

/**
 * "Tu comunidad volvió", con la aplicación cerrada.
 *
 * Se manda una sola vez al arrancar, y solo si la instancia estuvo caída de
 * verdad: el mismo umbral de 90 s que usa el vigilante de escritorio, para que
 * un reinicio rápido no despierte a nadie. Los dos caminos comparten el
 * criterio a propósito — quien tenga los dos activos no debe recibir dos
 * versiones distintas de la misma verdad.
 */
export const CAIDA_MINIMA_MS = 90_000;

export async function pushInstanceOnline(downtimeMs: number, now = Date.now()): Promise<number> {
  if (downtimeMs < CAIDA_MINIMA_MS) return 0;
  const filas = db.prepare("SELECT * FROM push_subscriptions WHERE next_attempt <= ?").all(now) as FilaPush[];
  return entregar(filas, { v: 1, t: "instance_online" }, now);
}

/**
 * "Te mencionaron", a quien no está delante.
 *
 * Dos filtros antes de mandar nada, y los dos importan más que la función:
 *
 * - **Solo menciones directas, nunca `@everyone`.** Despertar los móviles de
 *   una comunidad entera porque alguien escribió dos palabras es exactamente
 *   lo que hace que la gente apague los avisos para siempre. Quien quiera ver
 *   los `@everyone` los tiene en la aplicación.
 * - **Solo a quien no tiene la aplicación abierta.** Si está delante ya lo vio.
 *
 * Y una espera corta por persona: veinte menciones seguidas en una conversación
 * animada son una notificación, no veinte.
 */
const ESPERA_MENCION_MS = 2 * 60_000;
const ultimaMencion = new Map<string, number>();

export async function pushMention(userIds: string[], now = Date.now()): Promise<number> {
  const pendientes = userIds.filter((id) => now - (ultimaMencion.get(id) ?? 0) >= ESPERA_MENCION_MS);
  if (pendientes.length === 0) return 0;
  for (const id of pendientes) ultimaMencion.set(id, now);

  /* Se limpia sobre la marcha: un Map que solo crece es una fuga en una
     instancia que lleva meses encendida. */
  if (ultimaMencion.size > 5_000) {
    for (const [id, cuando] of ultimaMencion) if (now - cuando >= ESPERA_MENCION_MS) ultimaMencion.delete(id);
  }

  const enviados = await Promise.all(pendientes.map((id) => pushToUser(id, { v: 1, t: "mention" }, now)));
  return enviados.reduce((total, uno) => total + uno, 0);
}

/** Solo para las pruebas: olvida las esperas por persona. */
export function resetMentionCooldown(): void {
  ultimaMencion.clear();
}

/* ── cuánto llevaba apagada ────────────────────────────────────────────
 *
 * Un latido periódico, y no una marca al apagar limpiamente. La diferencia
 * importa: el escenario de este producto es "apagué el PC", y un corte de luz
 * o un cierre a lo bruto no dejan escribir nada. Con una marca de apagado, el
 * único caso que de verdad hace falta cubrir sería justo el que se pierde.
 *
 * El precio es una escritura cada medio minuto y una imprecisión de hasta ese
 * medio minuto, sobre un umbral de noventa segundos. Sale a cuenta.
 */
const CLAVE_LATIDO = "push_heartbeat";
const LATIDO_MS = 30_000;

function latido(): number {
  const fila = db.prepare("SELECT value FROM meta WHERE key = ?").get(CLAVE_LATIDO) as { value: string } | undefined;
  const valor = Number(fila?.value ?? 0);
  return Number.isFinite(valor) ? valor : 0;
}

/** Cuánto estuvo sin dar señales. 0 la primera vez: nadie la echó de menos. */
export function downtimeAtStartup(now = Date.now()): number {
  const ultimo = latido();
  return ultimo > 0 && now > ultimo ? now - ultimo : 0;
}

export function startPushHeartbeat(): () => void {
  const escribir = (): void => {
    /* Congelada por una copia o un relevo: no se toca la base. Un latido
       perdido solo estira la cuenta de la caída, y eso no rompe nada. */
    if (writesAccepted()) setMeta(CLAVE_LATIDO, String(Date.now()));
  };
  escribir();
  const timer = setInterval(escribir, LATIDO_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * El aviso de arranque, entero: mira cuánto estuvo caída, avisa si de verdad
 * lo estuvo, y arranca el latido. Se llama una vez, al empezar a escuchar.
 */
export async function announceStartup(now = Date.now()): Promise<number> {
  const caida = downtimeAtStartup(now);
  const enviados = caida >= CAIDA_MINIMA_MS ? await pushInstanceOnline(caida, now) : 0;
  return enviados;
}

/** Solo para las pruebas: olvida el material cargado en memoria. */
export function resetPushSecretsCache(): void {
  secretos = null;
}
