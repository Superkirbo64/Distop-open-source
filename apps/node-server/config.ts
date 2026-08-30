/**
 * Configuración por entorno, validada al arrancar (§33).
 * Si algo falta o es inválido el proceso muere aquí, no a mitad de una petición.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KLIPY_API_KEY } from "./klipy-key.ts";

function str(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${key} debe ser un número entero, recibido: ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  throw new Error(`${key} debe ser true o false, recibido: ${v}`);
}

function list(key: string, fallback: string[]): string[] {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Secreto de firma de sesiones, sin pedírselo a nadie (§22).
 *
 * Manda la variable de entorno cuando existe (Docker, un despliegue serio). Si
 * no, la instancia se genera el suyo y lo guarda junto a su base de datos, con
 * permisos de solo-dueño. Antes se generaba uno nuevo en cada arranque, así que
 * reiniciar dejaba a todo el mundo fuera; y la alternativa era escribirlo en el
 * .env, un fichero que se abre, se comparte en capturas y se sube por error.
 *
 * El fichero no se imprime en ningún log ni se devuelve por ninguna ruta: solo
 * lo lee este proceso al arrancar.
 */
function loadSecret(databasePath: string): string {
  const fromEnv = str("AUTH_SECRET", "");
  if (fromEnv) return fromEnv;

  const file = join(dirname(resolve(databasePath)), "secret.key");
  if (existsSync(file)) {
    const stored = readFileSync(file, "utf8").trim();
    if (stored.length >= 32) return stored;
  }

  const generated = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${generated}\n`, { mode: 0o600 });
  try {
    // En Windows no hace nada; en Linux y macOS es la diferencia entre que lo
    // lea solo tu usuario o cualquiera con cuenta en la máquina.
    chmodSync(file, 0o600);
  } catch {
    // Sistema de ficheros sin permisos POSIX: el fichero ya está escrito.
  }
  return generated;
}

/**
 * El secreto de sesiones ANTERIOR, mientras dure su ventana.
 *
 * Existe por el relevo: el sucesor hereda el secreto del anfitrión anterior
 * —si no, todo el mundo aparecería desconectado de golpe y quien no tenga
 * contraseña quedaría fuera— pero no puede quedárselo para siempre, porque el
 * anfitrión anterior también lo conoce. Genera el suyo y acepta el viejo un
 * tiempo, reanclando cada sesión la primera vez que la ve (§5.5).
 */
function loadPreviousSecret(databasePath: string): { secret: string; expiresAt: number } | null {
  const file = join(dirname(resolve(databasePath)), "secret.previous.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { secret?: unknown; expires_at?: unknown };
    if (typeof parsed.secret !== "string" || parsed.secret.length < 32) return null;
    if (typeof parsed.expires_at !== "number" || parsed.expires_at < Date.now()) return null;
    return { secret: parsed.secret, expiresAt: parsed.expires_at };
  } catch {
    return null;
  }
}

const databasePath = str("DATABASE_PATH", "./data/app.db");

/**
 * TURN propio por entorno (coturn con `use-auth-secret`), para despliegues
 * donde cloud-init configura coturn y la instancia a la vez (§9.4, §22).
 * Van juntos o ninguno: con TURN_URL solo, la instancia anunciaría un relevo
 * sin credenciales que "parece configurado" y falla; con TURN_SECRET solo,
 * guardaría un secreto que no releva nada. Las credenciales que ven los
 * navegadores se derivan del secreto y caducan solas; el secreto no viaja.
 */
const turnUrls = list("TURN_URL", []);
const turnSecret = str("TURN_SECRET", "");
if (turnUrls.length > 0 !== (turnSecret !== "")) {
  throw new Error("TURN_URL y TURN_SECRET van juntos: define los dos o ninguno.");
}
for (const entry of turnUrls) {
  if (!/^turns?:/.test(entry)) throw new Error(`TURN_URL debe empezar por turn: o turns:, recibido: ${entry}`);
}

/**
 * Copias programadas (§21). Apagadas de fábrica: quien hospeda en su PC ya
 * tiene el botón local. Existen porque detrás de un proxy con TRUST_PROXY y
 * PUBLIC_URL ninguna petición es "local" (http.ts:isLocalRequest) y la ruta
 * HTTP de crear copias queda fuera de alcance a propósito: sin esto, el
 * despliegue en nube no tendría ninguna forma de hacer su copia diaria.
 */
const backupIntervalHours = int("BACKUP_INTERVAL_HOURS", 0);
if (backupIntervalHours < 0) throw new Error(`BACKUP_INTERVAL_HOURS no puede ser negativo, recibido: ${backupIntervalHours}`);
const backupKeep = int("BACKUP_KEEP", 7);
if (backupKeep < 1) throw new Error(`BACKUP_KEEP debe ser al menos 1, recibido: ${backupKeep}`);

/**
 * La frase vive en un FICHERO, nunca en el .env: un .env se abre, se comparte
 * en capturas y se sube por error (misma razón que AUTH_SECRET). Si las copias
 * están activas y la frase falta o es débil, el proceso muere AQUÍ: descubrir
 * "copias desactivadas + una línea de log" el día que muere el disco es el
 * peor momento posible. Se quita exactamente un salto de línea final —los
 * ficheros casi siempre acaban en uno— y nada más: lo que queda es, byte a
 * byte, lo que irá en DISTOP_BACKUP_PASSPHRASE al restaurar (restore.ts).
 */
function loadBackupPassphrase(): string {
  const file = str("BACKUP_PASSPHRASE_FILE", "");
  if (file === "") {
    throw new Error("BACKUP_INTERVAL_HOURS está activo pero falta BACKUP_PASSPHRASE_FILE: sin frase no hay copia cifrada.");
  }
  const ruta = resolve(file);
  let contenido: string;
  try {
    contenido = readFileSync(ruta, "utf8");
  } catch {
    throw new Error(`No se pudo leer BACKUP_PASSPHRASE_FILE (${file}): la copia programada no puede arrancar a ciegas.`);
  }
  const frase = contenido.replace(/\r?\n$/, "");
  if (frase.length < 12) {
    throw new Error("La frase de BACKUP_PASSPHRASE_FILE necesita al menos 12 caracteres (backup-format.ts exige lo mismo).");
  }
  if (process.platform !== "win32") {
    try {
      // El fichero lo crea la infraestructura, no nosotros: se avisa, no se
      // corrige en silencio un permiso que su dueño puso a propósito.
      if ((statSync(ruta).mode & 0o077) !== 0) {
        console.warn(`[config] ${file} es legible por otros usuarios del equipo; debería tener permisos 0600.`);
      }
    } catch {
      // Sistema de ficheros sin permisos POSIX: nada que avisar.
    }
  }
  return frase;
}
const backupPassphrase = backupIntervalHours > 0 ? loadBackupPassphrase() : "";

export const config = {
  port: int("PORT", 5000),
  host: str("HOST", "0.0.0.0"),
  instanceName: str("INSTANCE_NAME", "Instancia Distop"),
  publicUrl: str("PUBLIC_URL", ""),

  /**
   * Con quién se queja el servicio de push si algo va mal (RFC 8292, `sub`).
   * Vacío = la dirección pública de la instancia, que ya conoce quien se
   * suscribió. Un `mailto:` sirve si prefieres que te escriban.
   */
  pushContact: str("PUSH_CONTACT", ""),

  databasePath,
  storagePath: str("DEFAULT_STORAGE_PATH", "./data/uploads"),

  /** De la variable de entorno, o del fichero que la instancia se crea sola. */
  authSecret: loadSecret(databasePath),
  authSecretPrevious: loadPreviousSecret(databasePath),

  /**
   * Código de un solo uso para reclamar una instancia recién instalada.
   * Solo hace falta si reclamas desde fuera del equipo que la hospeda: desde
   * el propio equipo no se pide nada, porque estar sentado delante ya es la
   * prueba. Se genera solo y se imprime al arrancar; se puede fijar con
   * SETUP_CODE para instalaciones desatendidas.
   */
  setupCode: str("SETUP_CODE", "") || randomBytes(4).toString("hex").toUpperCase(),

  accessTokenTtlS: int("ACCESS_TOKEN_TTL_S", 60 * 60),
  refreshTokenTtlS: int("REFRESH_TOKEN_TTL_S", 60 * 60 * 24 * 30),

  registrationEnabled: bool("REGISTRATION_ENABLED", true),
  guestModeEnabled: bool("GUEST_MODE_ENABLED", true),
  publicDiscoveryEnabled: bool("PUBLIC_DISCOVERY_ENABLED", false),
  /**
   * El índice público del proyecto, puesto de fábrica para que Explorar
   * enseñe algo desde el primer arranque. Solo lee: publicar tu comunidad
   * ahí exige además abrir el descubrimiento y marcarla como pública, las
   * dos cosas a mano.
   *
   * `DIRECTORY_URL=` vacío lo apaga del todo, y por eso aquí no se usa str():
   * str() trata el vacío como «sin definir» y devolvería el valor de fábrica,
   * dejando sin salida a quien quiere desconectarse.
   */
  directoryUrl: (process.env.DIRECTORY_URL ?? "https://distop-open-source.superkirbo64.deno.net").replace(/\/+$/, ""),

  /**
   * Confiar en X-Forwarded-For solo cuando hay de verdad un proxy delante.
   * Si se confía siempre, cualquiera falsea la cabecera y salta los límites;
   * si no se confía nunca detrás de un túnel, toda la comunidad comparte una
   * sola IP y el primero que entra deja fuera al resto. Por eso es explícito.
   */
  trustProxy: bool("TRUST_PROXY", false),

  /**
   * Límites por IP y hora. Los de fábrica dan margen a una comunidad entrando
   * a la vez desde una misma casa, oficina o red universitaria: una comunidad
   * self-hosted no es un servicio público con millones de altas.
   */
  maxRegistrationsPerHour: int("MAX_REGISTRATIONS_PER_HOUR", 30),
  maxGuestsPerHour: int("MAX_GUESTS_PER_HOUR", 60),
  maxLoginAttemptsPerQuarterHour: int("MAX_LOGIN_ATTEMPTS_PER_15MIN", 20),

  /* 500 de fábrica: lo pide el disco y el ancho de banda de quien hospeda, no
     un plan (§28.3). Las subidas van en streaming a disco con este límite
     vigilado al vuelo (storage.ts:saveUploadStream): ninguna aguanta el cuerpo
     entero en memoria, también en una Raspberry Pi. Y si la instancia se
     publica por Cloudflare Tunnel, Cloudflare recorta las subidas a ~100 MB en
     su borde antes de que este límite entre en juego (§29.3): subir el número
     aquí no cambia eso. */
  maxUploadMb: int("MAX_UPLOAD_SIZE_MB", 500),
  allowedUploadTypes: list("ALLOWED_UPLOAD_TYPES", [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/svg+xml",
    "video/mp4",
    "video/webm",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "application/pdf",
    "text/plain",
    /* Comprimidos y programas. El navegador NO manda un tipo estable aquí: el
       mismo .zip sale como application/zip en Linux y x-zip-compressed en
       Windows, y un .exe casi siempre llega sin tipo, que api.ts convierte en
       octet-stream. Sin estas variantes "mandar un zip" fallaba según el
       sistema de quien lo enviaba, que es un límite falso.
       octet-stream es, de hecho, "cualquier archivo": el anfitrión que quiera
       una lista cerrada la pone en ALLOWED_UPLOAD_TYPES. Lo que se guarda son
       bytes, y storage.ts los sirve SIEMPRE como descarga (content-disposition
       attachment + nosniff + CSP sandbox), así que nada de esto se ejecuta ni
       se interpreta en el navegador de nadie: ejecutarlo es una decisión
       deliberada de quien lo descarga, igual que en cualquier chat (§22). */
    "application/zip",
    "application/x-zip-compressed",
    "application/gzip",
    "application/x-7z-compressed",
    "application/vnd.rar",
    "application/x-msdownload",
    "application/vnd.microsoft.portable-executable",
    "application/octet-stream",
  ]),

  /** Orígenes del cliente web. "*" solo se acepta fuera de producción. */
  corsOrigins: [
    ...list("CORS_ORIGINS", ["http://localhost:5173", "http://127.0.0.1:5173"]),
    /* Las apps empaquetadas no las sirve esta instancia: traen su propio origen
       fijo (el protocolo de la app de escritorio, el WebView de Android). Van
       siempre, no en la variable: toda instancia debe aceptar a sus clientes
       instalados sin que cada anfitrión tenga que saber que esto existe. */
    "app://distop",
    "capacitor://localhost",
    "https://localhost",
    /* La app Android sirve su cliente desde http://localhost (esquema http a
       propósito: sigue siendo contexto seguro y permite hablar con instancias
       http de la red local sin el bloqueo de contenido mixto del WebView). */
    "http://localhost",
  ],

  /**
   * Servidores ICE para la voz (§9.4).
   * Dentro de una misma red no hacen falta. Para atravesar NAT hace falta STUN,
   * y para las redes más cerradas (NAT simétrica, algunas móviles) hace falta
   * TURN, que sí retransmite audio y por tanto consume ancho de banda de quien
   * lo hospede. Por eso es una lista abierta y no una decisión tomada aquí:
   *   ICE_SERVERS=stun:stun.ejemplo.org:3478,turn:usuario:clave@turn.ejemplo.org:3478
   */
  /** TURN propio con credenciales efímeras; validados arriba, juntos o ninguno. */
  turnUrls,
  turnSecret,

  /** Copias programadas; validadas arriba, con la frase leída de su fichero. */
  backupIntervalHours,
  backupKeep,
  backupPassphrase,

  iceServers: list("ICE_SERVERS", []).map((entry) => {
    const at = entry.lastIndexOf("@");
    if (at === -1) return { urls: entry };
    const [scheme, credentials] = entry.slice(0, at).split(/:(.+)/);
    const [username, credential] = (credentials ?? "").split(":");
    return { urls: `${scheme}:${entry.slice(at + 1)}`, username: username ?? "", credential: credential ?? "" };
  }),

  /**
   * Buscador de GIF (§12). Apagado mientras no haya clave.
   *
   * La búsqueda la hace la INSTANCIA, nunca el navegador: si la hiciera el
   * cliente, cada miembro le entregaría su IP y lo que busca a un tercero, y la
   * clave del admin acabaría dentro del JavaScript que cualquiera puede leer
   * (§13.3, §22). Con proxy, Giphy solo ve una máquina: la del anfitrión.
   *
   * La clave gratuita se pide en developers.giphy.com. Sin ella la pestaña de
   * GIF no aparece, y nada más deja de funcionar.
   */
  giphyApiKey: str("GIPHY_API_KEY", ""),

  /**
   * Galeria de stickers, contra la API de Klipy.
   *
   * Separada de la de GIF a proposito: son dos servicios distintos y cada
   * anfitrion decide si quiere uno, el otro, los dos o ninguno. Mismo trato que
   * Giphy — la peticion la hace la INSTANCIA, nunca el navegador, asi que Klipy
   * ve una maquina y no la IP de cada miembro (§13.3, §22).
   *
   * La clave se pide en klipy.com/developers. La de prueba admite 100 llamadas
   * por hora; sin clave, la galeria no aparece y los stickers propios de la
   * comunidad siguen funcionando igual.
   */
  klipyApiKey: KLIPY_API_KEY,

  /**
   * Buscador de fondos de pantalla (§10.2), contra la API de Wallhaven.
   *
   * Igual que el de GIF: lo pide la INSTANCIA. Aquí no es solo privacidad —
   * wallhaven.cc no manda cabeceras CORS, así que desde el navegador la
   * petición ni sale. La búsqueda va forzada a purity=100 (SFW), y con eso la
   * clave sobra: solo hace falta para contenido que aquí no se pide. Se deja
   * configurable por si algún día la cuota con cuenta difiere de los 45/min.
   */
  wallhavenApiKey: str("WALLHAVEN_API_KEY", ""),

  /**
   * Importar stickers desde un paquete de Telegram (§10.3), como sticker propio
   * de la comunidad. Apagado mientras no haya token.
   *
   * El token identifica a un BOT, no a una cuenta: se saca hablándole a
   * @BotFather en Telegram, en segundos y gratis. Lo pide la INSTANCIA, nunca
   * el navegador — el token no puede viajar al cliente (§22), y por eso hace
   * falta este proxy igual que con Giphy o la galería de avatares.
   */
  telegramBotToken: str("TELEGRAM_BOT_TOKEN", ""),

  logLevel: str("LOG_LEVEL", "info"),
  isProduction: process.env.NODE_ENV === "production",
} as const;

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;
