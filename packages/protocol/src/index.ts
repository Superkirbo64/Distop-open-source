/**
 * Protocolo Distop v1 — contrato único entre cliente e instancia (§18).
 * Todo cambio incompatible sube PROTOCOL_VERSION; los aditivos no.
 */

export const PROTOCOL_VERSION = "v1";

export { RINGS, RING_IDS, type Ring } from "./rings.ts";
import { RING_IDS } from "./rings.ts";

/* ─────────────────────────── Permisos (§11) ───────────────────────────
   Bitfield de más de 32 flags → BigInt. Viaja por JSON como string decimal. */

export const PERMISSIONS = {
  ADMINISTRATOR: 1n << 0n,
  MANAGE_COMMUNITY: 1n << 1n,
  MANAGE_CHANNELS: 1n << 2n,
  MANAGE_ROLES: 1n << 3n,
  MANAGE_MEMBERS: 1n << 4n,
  KICK_MEMBERS: 1n << 5n,
  BAN_MEMBERS: 1n << 6n,
  TIMEOUT_MEMBERS: 1n << 7n,
  VIEW_CHANNEL: 1n << 8n,
  SEND_MESSAGES: 1n << 9n,
  MANAGE_MESSAGES: 1n << 10n,
  READ_HISTORY: 1n << 11n,
  ATTACH_FILES: 1n << 12n,
  EMBED_LINKS: 1n << 13n,
  ADD_REACTIONS: 1n << 14n,
  USE_CUSTOM_EMOJIS: 1n << 15n,
  MENTION_EVERYONE: 1n << 16n,
  CREATE_THREADS: 1n << 17n,
  MANAGE_THREADS: 1n << 18n,
  CONNECT_VOICE: 1n << 19n,
  SPEAK: 1n << 20n,
  MUTE_MEMBERS: 1n << 21n,
  DEAFEN_MEMBERS: 1n << 22n,
  MOVE_MEMBERS: 1n << 23n,
  STREAM: 1n << 24n,
  USE_CAMERA: 1n << 25n,
  MANAGE_WEBHOOKS: 1n << 26n,
  MANAGE_BOTS: 1n << 27n,
  MANAGE_INTEGRATIONS: 1n << 28n,
  MANAGE_GAME_SERVERS: 1n << 29n,
  VIEW_AUDIT_LOG: 1n << 30n,
  CREATE_INVITE: 1n << 31n,
  MANAGE_INVITES: 1n << 32n,
} as const;

export type PermissionName = keyof typeof PERMISSIONS;

export const PERMISSION_NAMES = Object.keys(PERMISSIONS) as PermissionName[];

/** Lo que recibe un miembro nuevo sin roles: participar, no administrar. */
export const DEFAULT_MEMBER_PERMISSIONS =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.READ_HISTORY |
  PERMISSIONS.ATTACH_FILES |
  PERMISSIONS.EMBED_LINKS |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.USE_CUSTOM_EMOJIS |
  PERMISSIONS.CREATE_THREADS |
  PERMISSIONS.CONNECT_VOICE |
  PERMISSIONS.SPEAK |
  PERMISSIONS.STREAM |
  PERMISSIONS.USE_CAMERA |
  PERMISSIONS.CREATE_INVITE;

export const ALL_PERMISSIONS = PERMISSION_NAMES.reduce(
  (acc, name) => acc | PERMISSIONS[name],
  0n,
);

export function has(bits: bigint, perm: bigint): boolean {
  return (bits & PERMISSIONS.ADMINISTRATOR) !== 0n || (bits & perm) === perm;
}

export function toBits(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === "") return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

export function permissionList(bits: bigint): PermissionName[] {
  return PERMISSION_NAMES.filter((name) => (bits & PERMISSIONS[name]) !== 0n);
}

/* ───────────────────────────── Entidades (§20) ───────────────────────────── */

export type Snowflake = string;

export type UserKind = "local" | "guest";

/**
 * Estado elegido a mano, distinto de "tiene un socket abierto" (§9.1).
 * Son dos cosas que la gente confunde: la conexión la sabe la instancia, el
 * estado lo decide la persona. `invisible` es la excepción a propósito: quien
 * lo elige desaparece de la lista de conectados aunque esté dentro.
 */
export const USER_STATUSES = ["online", "idle", "dnd", "invisible"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * "Jugando a X" (§9.1). Efímero como la presencia de conexión: lo alimenta la
 * app de escritorio de quien juega y muere con un timeout, nunca se persiste.
 * Solo viaja el NOMBRE ya casado con el catálogo local del jugador: la lista
 * de procesos de su equipo no sale de su máquina (§8).
 */
export interface GamePresence {
  user_id: Snowflake;
  game_name: string;
  started_at: number;
}

/** Una partida ya terminada, del historial "jugados recientemente" del perfil. */
export interface GameSession {
  id: Snowflake;
  game_name: string;
  started_at: number;
  ended_at: number;
}

export interface PublicUser {
  id: Snowflake;
  username: string;
  display_name: string;
  avatar_url: string | null;
  banner_url: string | null;
  bio: string | null;
  pronouns: string | null;
  accent_color: string | null;
  kind: UserKind;
  /** Lo que ha elegido; para saber si está en línea hace falta además la presencia. */
  status: UserStatus;
  /** Frase corta y opcional junto al nombre. Texto plano: no se interpreta nada. */
  custom_status: string | null;
  /** Marco, placa, fuente y efectos. Público porque el punto es que se vea (§10.1). */
  profile_style: ProfileStyle;
  created_at: number;
}

export interface SelfUser extends PublicUser {
  locale: string;
  theme: string;
  settings: Record<string, unknown>;
  /** Si la cuenta tiene contraseña. Decide qué ofrece Ajustes → Cuenta:
      ponerla (invitado o anfitrión recién puesto en marcha) o cambiarla. */
  has_password: boolean;
}

/* ── personalización del perfil (§10.1, §10.2) ─────────────────────────
   Todo esto es GRATIS, y no por generosidad: es el punto del proyecto (§10).
   En las plataformas comerciales el marco del avatar, la placa del nombre y
   los efectos son justo lo que se vende, y por eso aquí no hay ni tienda ni
   "exclusivo de X" — solo un catálogo abierto.

   Se guardan IDENTIFICADORES de un catálogo cerrado, nunca CSS ni una URL que
   escriba el cliente. Ese es el detalle de seguridad que sostiene todo lo
   demás: el id acaba pegado a un nombre de clase CSS, así que si el cliente
   pudiera inventarse el valor tendríamos una vía de inyección en cada perfil
   de la comunidad (§22). Con catálogo, lo peor que puede mandar es un id que
   no existe, y ese se descarta al normalizar.

   Los efectos no dependen de ningún asset remoto: los primeros cinco son CSS
   puro y los últimos cuatro son presets de tsParticles (MIT) empaquetados en
   el build del cliente. Cero bytes de red en runtime y se ven igual en
   cualquier instancia recién instalada. */

export const NAMEPLATES = ["none", "mist", "aurora", "sunset", "forest", "ocean", "ember"] as const;
export type Nameplate = (typeof NAMEPLATES)[number];

export const NAME_FONTS = ["default", "display", "mono", "serif", "round", "wide", "pixel", "arcade"] as const;
export type NameFont = (typeof NAME_FONTS)[number];

export const NAME_EFFECTS = ["plain", "gradient", "neon", "pop", "animated"] as const;
export type NameEffect = (typeof NAME_EFFECTS)[number];

export const PROFILE_EFFECTS = [
  "none",
  "embers",
  "aurora",
  "snow",
  "fireworks",
  "bubbles",
] as const;
export type ProfileEffect = (typeof PROFILE_EFFECTS)[number];

export interface ProfileStyle {
  /**
   * Imagen propia superpuesta al avatar.
   *
   * La trae quien la usa: aquí no se distribuye ninguna ilustración, porque
   * el proyecto no puede repartir arte del que no tiene licencia (§24). El
   * techo es el disco del anfitrión, no una lista cerrada de marcos.
   */
  avatar_deco_url: string | null;
  /**
   * Aro del catalogo incluido (CC BY 4.0, ver rings.ts). Es un id validado, no
   * una ruta: acaba componiendo /rings/<id>.png, asi que dejar pasar texto
   * libre seria dejar que el cliente pida cualquier fichero (§22).
   */
  avatar_ring: string | null;
  nameplate: Nameplate;
  name_font: NameFont;
  name_effect: NameEffect;
  /** null = hereda `accent_color`, para no tener que elegir el color dos veces. */
  name_color: string | null;
  profile_effect: ProfileEffect;
  /** Degradado de la tarjeta de perfil. null = se usa `accent_color`. */
  theme_a: string | null;
  theme_b: string | null;
  /** Dirección del degradado CSS, en grados. */
  theme_angle: number;
  /** Punto en que ambos colores quedan mezclados por igual, de 10 a 90 %. */
  theme_balance: number;
}

export const DEFAULT_PROFILE_STYLE: ProfileStyle = {
  avatar_deco_url: null,
  avatar_ring: null,
  nameplate: "none",
  name_font: "default",
  name_effect: "plain",
  name_color: null,
  profile_effect: "none",
  theme_a: null,
  theme_b: null,
  theme_angle: 135,
  theme_balance: 50,
};

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * Cualquier cosa → un ProfileStyle válido.
 *
 * La usan las dos puntas: el servidor al guardar y al leer, el cliente al
 * pintar. Un id que no está en su catálogo no es un error que reventar, es un
 * valor que se cae al de por defecto — así una instancia vieja leyendo un
 * perfil nuevo pinta el perfil sin adornos en vez de romperse (§28.6).
 */
export function toProfileStyle(raw: unknown): ProfileStyle {
  const source = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;

  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const value = source[key];
    return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
  };
  const color = (key: string): string | null => {
    const value = source[key];
    return typeof value === "string" && HEX_COLOR.test(value) ? value : null;
  };
  const integer = (key: string, min: number, max: number, fallback: number): number => {
    const value = source[key];
    return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };

  /* Acaba en un <img src>, asi que solo pasan rutas de esta instancia o enlaces
     http(s). Se descartan `data:` y `javascript:` por lista blanca y no por
     lista negra: lo que no se reconoce, fuera (§22). */
  const imagen = (key: string): string | null => {
    const value = source[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 300) return null;
    return /^(https?:\/\/|\/)/.test(value) ? value : null;
  };

  return {
    avatar_deco_url: imagen("avatar_deco_url"),
    avatar_ring: typeof source.avatar_ring === "string" && RING_IDS.includes(source.avatar_ring) ? source.avatar_ring : null,
    nameplate: pick("nameplate", NAMEPLATES, "none"),
    name_font: pick("name_font", NAME_FONTS, "default"),
    name_effect: pick("name_effect", NAME_EFFECTS, "plain"),
    name_color: color("name_color"),
    profile_effect: pick("profile_effect", PROFILE_EFFECTS, "none"),
    theme_a: color("theme_a"),
    theme_b: color("theme_b"),
    theme_angle: integer("theme_angle", 0, 360, 135),
    theme_balance: integer("theme_balance", 10, 90, 50),
  };
}

export interface Community {
  id: Snowflake;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
  accent_color: string;
  theme: string;
  rules: string | null;
  is_public: boolean;
  owner_id: Snowflake;
  created_at: number;
}

export interface Category {
  id: Snowflake;
  community_id: Snowflake;
  name: string;
  position: number;
}

export type ChannelKind = "text" | "voice" | "announcement";

export interface Channel {
  id: Snowflake;
  community_id: Snowflake;
  category_id: Snowflake | null;
  name: string;
  topic: string | null;
  kind: ChannelKind;
  position: number;
  slowmode_s: number;
  created_at: number;
}

export interface Role {
  id: Snowflake;
  community_id: Snowflake;
  name: string;
  color: string | null;
  permissions: string; // bitfield decimal
  position: number;
  hoist: boolean;
  mentionable: boolean;
  is_default: boolean;
}

/** Overwrite por canal: primero se quita `deny`, después se suma `allow`. */
export interface PermissionOverwrite {
  channel_id: Snowflake;
  target_id: Snowflake;
  target_type: "role" | "member";
  allow: string;
  deny: string;
}

export interface Member {
  user: PublicUser;
  community_id: Snowflake;
  nickname: string | null;
  role_ids: Snowflake[];
  joined_at: number;
  timeout_until: number | null;
  banned: boolean;
}

export interface Attachment {
  id: Snowflake;
  message_id: Snowflake | null;
  filename: string;
  content_type: string;
  size: number;
  url: string;
}

export interface Reaction {
  emoji: string;
  count: number;
  user_ids: Snowflake[];
}

export interface Message {
  id: Snowflake;
  channel_id: Snowflake;
  community_id: Snowflake;
  author_id: Snowflake;
  content: string;
  created_at: number;
  edited_at: number | null;
  reply_to_id: Snowflake | null;
  pinned: boolean;
  attachments: Attachment[];
  reactions: Reaction[];
  /** Se resolvió al escribir, con el permiso de entonces: reescribir el texto no lo cambia. */
  mentions_everyone: boolean;
}

/* ── menciones (§9.2) ──────────────────────────────────────────────────
   Van en el texto como `<@id>` y `<#id>`, no como el nombre escrito. El nombre
   se pinta al leer, así que renombrarse no rompe las menciones viejas ni
   convierte a nadie en otra persona. */

export const MENTION_USER = /<@([0-9a-f-]{36})>/g;
export const MENTION_CHANNEL = /<#([0-9a-f-]{36})>/g;

export function mentionsUser(content: string, userId: Snowflake): boolean {
  return content.includes(`<@${userId}>`);
}

/** Qué hay sin leer en un canal. `mentions > 0` es lo que merece interrumpir. */
export interface Unread {
  count: number;
  mentions: number;
}

/* ── emojis, stickers y sonidos propios (§10.3) ────────────────────────
   No hay tope por suscripción: el límite es el disco de quien hospeda, y eso
   se dice claro en vez de inventar un número. Un sticker es lo mismo que un
   emoji con otro tamaño de pintado, así que comparten tabla y comparten sintaxis
   en el texto: `<:nombre:id>`.

   Un sonido de la tabla de sonidos es el mismo registro con otro tipo de
   archivo. Cabe aquí y no en una tabla propia porque es exactamente lo mismo:
   un archivo con nombre que pertenece a una comunidad, se sube o se importa,
   se lista y se borra igual. Lo único que cambia es con qué etiqueta se pinta.
   Los sonidos NO entran en CUSTOM_EMOJI: no se escriben dentro de un mensaje. */

export const EMOJI_KINDS = ["emoji", "sticker", "sound"] as const;
export type EmojiKind = (typeof EMOJI_KINDS)[number];

export interface CustomEmoji {
  id: Snowflake;
  community_id: Snowflake;
  name: string;
  kind: EmojiKind;
  url: string;
  /** Identidad visual opcional de un sonido. Solo uno de estos dos se guarda. */
  icon_emoji: string | null;
  icon_url: string | null;
  creator_id: Snowflake;
  created_at: number;
}

/** `<:nombre:id>`. El nombre viaja para poder leerlo si el archivo ya no está. */
export const CUSTOM_EMOJI = /<:([a-zA-Z0-9_]{2,32}):([0-9a-f-]{36})>/g;

/** Nombres válidos: lo que se puede escribir entre dos puntos sin ambigüedad. */
export const EMOJI_NAME = /^[a-zA-Z0-9_]{2,32}$/;

/**
 * Un mensaje hecho solo de emojis se pinta en grande.
 *
 * Cubre los dos tipos, que es lo que fallaba antes: los personalizados
 * `<:nombre:id>` y los de Unicode. Un emoji no es un caracter suelto —lleva
 * selector de variación, modificador de tono, o varios pictogramas cosidos
 * con ZWJ, y una bandera son dos indicadores regionales—, así que la
 * comprobación va sobre esa forma completa y no sobre \p{Emoji}, que da por
 * bueno cualquier dígito.
 */
const SOLO_EMOJIS =
  /^(?:\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*|\p{Regional_Indicator}{2}|\s)+$/u;

export function isJumbo(content: string): boolean {
  if (content.trim().length === 0) return false;
  const sinPersonalizados = content.replace(CUSTOM_EMOJI, "").trim();
  return sinPersonalizados.length === 0 || SOLO_EMOJIS.test(sinPersonalizados);
}

export interface Invite {
  code: string;
  community_id: Snowflake;
  channel_id: Snowflake | null;
  creator_id: Snowflake;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
  created_at: number;
}

/* ── voz (§9.4) ────────────────────────────────────────────────────────
   El audio pasa por la instancia, por el mismo socket que el resto: es lo único
   que funciona siempre, sin puertos que abrir ni STUN ni TURN. El vídeo va
   directo entre navegadores, porque reenviarlo tumbaría una conexión doméstica.
   Cuesta subida a quien hospeda: cada quien habla se reenvía a los demás. */

/**
 * Cada persona publica como mucho un vídeo a la vez: cámara o pantalla.
 * Una sola pista por par mantiene la malla previsible (el coste sube al
 * cuadrado con la gente, no también con las fuentes) y permite negociar el
 * hueco de vídeo al conectar, sin renegociar cada vez que alguien enciende
 * la cámara. `null` es "no manda vídeo".
 */
export type VideoSource = "camera" | "screen";

export interface VoiceState {
  user_id: Snowflake;
  channel_id: Snowflake;
  community_id: Snowflake;
  muted: boolean;
  deafened: boolean;
  /** Impuesto por un moderador: el cliente enseña candado, no un botón que no funciona. */
  force_muted: boolean;
  force_deafened: boolean;
  video: VideoSource | null;
  joined_at: number;
}

/** SDP e ICE viajan opacos: la instancia los reenvía sin leerlos. */
export interface VoiceSignal {
  channel_id: Snowflake;
  from_user_id: Snowflake;
  to_user_id: Snowflake;
  payload: unknown;
}

/** Motivo concreto por el que la instancia rechazó un sonido de la sala. */
export const VOICE_SOUND_REJECT_REASONS = ["not_in_voice", "muted", "rate_limited", "not_available"] as const;
export type VoiceSoundRejectReason = (typeof VOICE_SOUND_REJECT_REASONS)[number];

export interface AuditLogEntry {
  id: Snowflake;
  community_id: Snowflake;
  actor_id: Snowflake;
  action: string;
  target_id: Snowflake | null;
  details: Record<string, unknown>;
  created_at: number;
}

/* ─────────────────────────── Estado de instancia (§26) ─────────────────────────── */

export const INSTANCE_STATES = [
  "ONLINE",
  "OFFLINE",
  "STARTING",
  "DEGRADED",
  "UPDATING",
  "MAINTENANCE",
  "AUTHENTICATION_ERROR",
  "VERSION_INCOMPATIBLE",
  "CERTIFICATE_ERROR",
  "UNREACHABLE",
] as const;

export type InstanceState = (typeof INSTANCE_STATES)[number];

export interface InstanceHealth {
  status: InstanceState;
  protocol: string;
  version: string;
  instance_id: string;
  instance_name: string;
  uptime_s: number;
  online_users: number;
  communities: number;
  cpu_load: number;
  memory_used_mb: number;
  memory_total_mb: number;
  storage_used_mb: number;
  /** Lo que queda libre en el disco donde viven los archivos. Quien hospeda
      decide con esto cuándo limpiar, no cuando el disco ya se llenó (§26). */
  storage_free_mb: number;
  max_upload_mb: number;
  registration_enabled: boolean;
  guest_mode_enabled: boolean;
}

/* ─────────────────────────── Eventos WebSocket (§18) ─────────────────────────── */

export const GATEWAY_EVENTS = [
  "READY",
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "REACTION_UPDATE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "CATEGORY_UPDATE",
  "COMMUNITY_UPDATE",
  "MEMBER_JOIN",
  "MEMBER_LEAVE",
  "MEMBER_UPDATE",
  "PRESENCE_UPDATE",
  "GAME_PRESENCE_UPDATE",
  "TYPING_START",
  "VOICE_STATE_UPDATE",
  "VOICE_SIGNAL",
  "VOICE_SOUND",
  "VOICE_SOUND_ERROR",
  "ROLE_UPDATE",
  "ROLE_DELETE",
  "READ_UPDATE",
  "EMOJI_UPDATE",
  "MESSAGES_PURGED",
  "ERROR",
  "PONG",
] as const;

export type GatewayEventName = (typeof GATEWAY_EVENTS)[number];

export interface ReadyPayload {
  user: SelfUser;
  communities: Community[];
  instance: InstanceHealth;
  session_id: string;
}

export type ServerEvent =
  | { t: "READY"; d: ReadyPayload }
  | { t: "MESSAGE_CREATE"; d: Message }
  | { t: "MESSAGE_UPDATE"; d: Message }
  | { t: "MESSAGE_DELETE"; d: { id: Snowflake; channel_id: Snowflake } }
  | { t: "REACTION_UPDATE"; d: { message_id: Snowflake; channel_id: Snowflake; reactions: Reaction[] } }
  | { t: "CHANNEL_CREATE"; d: Channel }
  | { t: "CHANNEL_UPDATE"; d: Channel }
  | { t: "CHANNEL_DELETE"; d: { id: Snowflake; community_id: Snowflake } }
  | { t: "CATEGORY_UPDATE"; d: { community_id: Snowflake; categories: Category[] } }
  | { t: "COMMUNITY_UPDATE"; d: Community }
  | { t: "MEMBER_JOIN"; d: Member }
  | { t: "MEMBER_LEAVE"; d: { community_id: Snowflake; user_id: Snowflake } }
  | { t: "MEMBER_UPDATE"; d: Member }
  | { t: "PRESENCE_UPDATE"; d: { community_id: Snowflake; online: Snowflake[] } }
  /* La lista entera por comunidad, como PRESENCE_UPDATE: es corta y así no hay
     dos maneras de tenerla desincronizada entre quien estaba y quien llega. */
  | { t: "GAME_PRESENCE_UPDATE"; d: { community_id: Snowflake; presences: GamePresence[] } }
  | { t: "TYPING_START"; d: { channel_id: Snowflake; user_id: Snowflake; until: number } }
  | { t: "VOICE_STATE_UPDATE"; d: { channel_id: Snowflake; community_id: Snowflake; states: VoiceState[] } }
  | { t: "VOICE_SIGNAL"; d: VoiceSignal }
  /* Tabla de sonidos (§9.4): NO viaja el audio, viaja el id. Cada cliente ya
     puede pedir el archivo a la instancia y lo reproduce a su calidad original,
     en vez de meterlo por el micrófono —donde la cancelación de eco y la
     supresión de ruido, que existen para una voz, lo destrozarían. */
  | { t: "VOICE_SOUND"; d: { channel_id: Snowflake; user_id: Snowflake; sound_id: Snowflake } }
  | {
      t: "VOICE_SOUND_ERROR";
      d: { channel_id: Snowflake; sound_id: Snowflake; reason: VoiceSoundRejectReason };
    }
  /* La sala de la carrera entera y no el cambio: son cinco campos y así no hay
     dos maneras de tenerla desincronizada. `lobby` en null es "aquí ya no hay
     carrera", que es lo que ve quien llega cuando el anfitrión la cerró. */
  | { t: "RACE_UPDATE"; d: { channel_id: Snowflake; lobby: RaceLobby | null } }
  | { t: "ROLE_UPDATE"; d: Role }
  | { t: "ROLE_DELETE"; d: { id: Snowflake; community_id: Snowflake } }
  /* Va a todas TUS sesiones: leer en el móvil tiene que apagar el aviso del escritorio. */
  | { t: "READ_UPDATE"; d: { channel_id: Snowflake; last_read_id: Snowflake } }
  /* La lista entera y no el que cambió: es corta y así no hay dos formas de
     tenerla desincronizada entre quien estaba conectado y quien acaba de entrar. */
  | { t: "EMOJI_UPDATE"; d: { community_id: Snowflake; emojis: CustomEmoji[] } }
  /* Quien hospeda vació el historial de la instancia (§28.4): mensajes y
     archivos de chat fuera. La comunidad, sus miembros, roles y canales siguen.
     Sin este aviso, los demás clientes enseñarían una conversación que ya no
     existe hasta la próxima recarga. */
  | { t: "MESSAGES_PURGED"; d: { community_id: Snowflake } }
  | { t: "ERROR"; d: ApiError }
  | { t: "PONG"; d: { at: number } };

/**
 * Una carrera de canicas en una sala de voz (§9.4).
 *
 * La instancia no simula nada: reparte la semilla y quién corre, y cada cliente
 * calcula la misma carrera con eso. La física es determinista, así que con la
 * misma semilla y la misma lista sale exactamente el mismo resultado en todas
 * las pantallas — sin mandar posiciones sesenta veces por segundo.
 *
 * `seed` en null significa que la sala está esperando gente; en cuanto tiene
 * número, la carrera ya arrancó.
 */
export interface RaceLobby {
  channel_id: Snowflake;
  /** Quien la abrió: es quien elige mundo y da la salida. */
  host_id: Snowflake;
  /** Apuntados, en orden de llegada. */
  members: Snowflake[];
  /**
   * La parrilla de la carrera en marcha, congelada al dar la salida.
   * Va aparte de `members` porque quien se apunta a mitad tiene que ver la
   * carrera que ya corre, no una distinta con una canica de más.
   * El orden importa: entra en el sorteo de las posiciones de salida.
   */
  runners: Snowflake[];
  world: number;
  seed: number | null;
  started_at: number;
}

/** Lo que un moderador puede hacerle a alguien dentro de una sala de voz (§11). */
export type VoiceAction = "mute" | "unmute" | "deafen" | "undeafen" | "disconnect";

export type ClientCommand =
  | { t: "SUBSCRIBE"; d: { community_id: Snowflake } }
  | { t: "UNSUBSCRIBE"; d: { community_id: Snowflake } }
  | { t: "TYPING"; d: { channel_id: Snowflake } }
  | { t: "VOICE_JOIN"; d: { channel_id: Snowflake } }
  | { t: "VOICE_LEAVE"; d: { channel_id: Snowflake } }
  | { t: "VOICE_MUTE"; d: { channel_id: Snowflake; muted: boolean; deafened: boolean } }
  | { t: "VOICE_VIDEO"; d: { channel_id: Snowflake; source: VideoSource | null } }
  | { t: "VOICE_SIGNAL"; d: { channel_id: Snowflake; to_user_id: Snowflake; payload: unknown } }
  | { t: "VOICE_MODERATE"; d: { channel_id: Snowflake; user_id: Snowflake; action: VoiceAction } }
  | { t: "VOICE_SOUND"; d: { channel_id: Snowflake; sound_id: Snowflake } }
  /* Abrir es también apuntarse: quien pulsa el botón cuando ya hay una sala
     abierta se une a esa, no crea una segunda. */
  | { t: "RACE_OPEN"; d: { channel_id: Snowflake } }
  | { t: "RACE_LEAVE"; d: { channel_id: Snowflake } }
  | { t: "RACE_WORLD"; d: { channel_id: Snowflake; world: number } }
  | { t: "RACE_START"; d: { channel_id: Snowflake } }
  | { t: "PING"; d?: undefined };

/* ─────────────────────────── Errores tipados (§30) ─────────────────────────── */

export interface ApiError {
  code: string;
  message: string;
  status: number;
  details?: Record<string, unknown>;
  requestId: string;
  timestamp: string;
}

export const ERROR_CODES = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
} as const;

/* ─────────────────────────── IDs ordenables (§20) ───────────────────────────
   UUIDv7: 48 bits de timestamp + 12 de contador + aleatorio.
   El contador (método 2 de la RFC 9562) es lo que hace que dos IDs creados en
   el mismo milisegundo sigan ordenando: sin él, la paginación de mensajes por
   id devolvería el historial desordenado en ráfagas de escritura. */

let lastMs = 0;
let sequence = 0;

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);

  let ts = Date.now();
  if (ts === lastMs) {
    sequence++;
    if (sequence > 0xfff) {
      // Contador agotado: se pide prestado al milisegundo siguiente.
      ts = ++lastMs;
      sequence = 0;
    }
  } else if (ts > lastMs) {
    lastMs = ts;
    sequence = 0;
  } else {
    // El reloj retrocedió (NTP, suspensión): seguimos avanzando, nunca atrás.
    ts = ++lastMs;
    sequence = 0;
  }

  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f); // versión 7 + contador alto
  bytes[7] = sequence & 0xff; // contador bajo
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variante RFC 4122

  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Milisegundos embebidos en un UUIDv7, para ordenar sin tocar la base. */
export function uuidv7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}
