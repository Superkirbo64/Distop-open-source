/**
 * Configuración por entorno, validada al arrancar (§33).
 * Si algo falta o es inválido el proceso muere aquí, no a mitad de una petición.
 */
import { randomBytes } from "node:crypto";

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

const authSecret = str("AUTH_SECRET", "");
if (!authSecret && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_SECRET es obligatorio en producción. Genera uno: openssl rand -hex 32");
}

export const config = {
  port: int("PORT", 5000),
  host: str("HOST", "0.0.0.0"),
  instanceName: str("INSTANCE_NAME", "Instancia Distop"),
  publicUrl: str("PUBLIC_URL", ""),

  databasePath: str("DATABASE_PATH", "./data/app.db"),
  storagePath: str("DEFAULT_STORAGE_PATH", "./data/uploads"),

  /** Sin AUTH_SECRET en desarrollo se genera uno efímero: reiniciar cierra sesiones. */
  authSecret: authSecret || randomBytes(32).toString("hex"),

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

  maxUploadMb: int("MAX_UPLOAD_SIZE_MB", 25),
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
    "application/zip",
  ]),

  /** Orígenes del cliente web. "*" solo se acepta fuera de producción. */
  corsOrigins: list("CORS_ORIGINS", ["http://localhost:5173", "http://127.0.0.1:5173"]),

  /**
   * Servidores ICE para la voz (§9.4).
   * Dentro de una misma red no hacen falta. Para atravesar NAT hace falta STUN,
   * y para las redes más cerradas (NAT simétrica, algunas móviles) hace falta
   * TURN, que sí retransmite audio y por tanto consume ancho de banda de quien
   * lo hospede. Por eso es una lista abierta y no una decisión tomada aquí:
   *   ICE_SERVERS=stun:stun.ejemplo.org:3478,turn:usuario:clave@turn.ejemplo.org:3478
   */
  iceServers: list("ICE_SERVERS", []).map((entry) => {
    const at = entry.lastIndexOf("@");
    if (at === -1) return { urls: entry };
    const [scheme, credentials] = entry.slice(0, at).split(/:(.+)/);
    const [username, credential] = (credentials ?? "").split(":");
    return { urls: `${scheme}:${entry.slice(at + 1)}`, username: username ?? "", credential: credential ?? "" };
  }),

  logLevel: str("LOG_LEVEL", "info"),
  isProduction: process.env.NODE_ENV === "production",
} as const;

export const MAX_UPLOAD_BYTES = config.maxUploadMb * 1024 * 1024;
