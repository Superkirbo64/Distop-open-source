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
  /* Quién puede convocar. Va aparte de MANAGE_CHANNELS porque programar una
     reunión y reordenar la barra lateral no son la misma responsabilidad: en
     una comunidad real convoca mucha más gente de la que toca la estructura. */
  MANAGE_MEETINGS: 1n << 33n,
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

export type UserKind = "local" | "guest" | "imported";

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

/* "breathe" es la respiración que antes llevaba "plain" de serie. Se separó
   porque el default animaba cada nombre visible de la app a la vez —lista de
   miembros entera incluida— sin que nadie lo pidiera: ahora quien la quiera
   la elige, y "plain" queda quieto de verdad. */
export const NAME_EFFECTS = ["plain", "gradient", "neon", "pop", "animated", "breathe"] as const;
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
  /** Encuadre de la imagen del banner. 50/50 = centrada. */
  banner_position_x: number;
  banner_position_y: number;
  /** Ajustes de imagen del banner; no afectan al texto ni al avatar. */
  banner_veil: number;
  banner_blur: number;
  banner_brightness: number;
  banner_contrast: number;
  banner_saturation: number;
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
  banner_position_x: 50,
  banner_position_y: 50,
  banner_veil: 0,
  banner_blur: 0,
  banner_brightness: 100,
  banner_contrast: 100,
  banner_saturation: 100,
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
    banner_position_x: integer("banner_position_x", 0, 100, 50),
    banner_position_y: integer("banner_position_y", 0, 100, 50),
    banner_veil: integer("banner_veil", 0, 95, 0),
    banner_blur: integer("banner_blur", 0, 24, 0),
    banner_brightness: integer("banner_brightness", 30, 170, 100),
    banner_contrast: integer("banner_contrast", 40, 180, 100),
    banner_saturation: integer("banner_saturation", 0, 200, 100),
  };
}

export const COMMUNITY_VISIBILITIES = ["private", "unlisted", "public"] as const;
export type CommunityVisibility = (typeof COMMUNITY_VISIBILITIES)[number];
export const COMMUNITY_JOIN_POLICIES = ["open", "invite", "request"] as const;
export type CommunityJoinPolicy = (typeof COMMUNITY_JOIN_POLICIES)[number];
/**
 * De qué va la comunidad. Es un dato que declara quien la crea, no algo que se
 * adivine leyendo el nombre: el directorio filtra por este campo, así que una
 * comunidad llamada "Radio Minecraft" no acaba en dos sitios a la vez ni
 * depende del idioma en que esté escrita. `other` es la salida para lo que no
 * encaja, y es lo que llevan las comunidades anteriores a este campo.
 */
export const COMMUNITY_CATEGORIES = [
  "games",
  "music",
  "entertainment",
  "science",
  "education",
  "students",
  "other",
] as const;
export type CommunityCategory = (typeof COMMUNITY_CATEGORIES)[number];

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
  /** Quién puede encontrar la comunidad. No concede acceso por sí solo. */
  visibility: CommunityVisibility;
  /** Cómo consigue acceso alguien que ya encontró la comunidad. */
  join_policy: CommunityJoinPolicy;
  /** De qué va, para el directorio. Lo elige quien la crea. */
  category: CommunityCategory;
  /** Compatibilidad con clientes anteriores: equivale a visibility === "public". */
  is_public: boolean;
  /** Si se pueden mandar audios aquí. Apagarlo rechaza el adjunto en el
      servidor, no solo esconde el botón. */
  voice_messages: boolean;
  owner_id: Snowflake;
  created_at: number;
}

export interface Category {
  id: Snowflake;
  community_id: Snowflake;
  name: string;
  position: number;
}

/**
 * `meeting` es un canal como los demás —con sus mensajes, sus adjuntos, sus
 * permisos y sus overwrites— que además tiene una fila en `meetings`. No es un
 * tipo de sala de voz: las salas de voz siguen siendo `voice` y no cambian.
 * La barra lateral lo aparta en su propia sección; el resto del sistema no
 * necesita enterarse.
 */
export type ChannelKind = "text" | "voice" | "announcement" | "meeting";

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

/** Mensaje privado entre dos cuentas de la misma instancia. */
export interface DirectMessage {
  id: Snowflake;
  conversation_id: Snowflake;
  author_id: Snowflake;
  content: string;
  created_at: number;
  edited_at: number | null;
  reply_to_id: Snowflake | null;
  attachments: Attachment[];
}

/** Una conversación privada vista desde uno de sus dos participantes. */
export interface DirectConversation {
  id: Snowflake;
  other_user: PublicUser;
  created_at: number;
  updated_at: number;
  last_message: DirectMessage | null;
  unread_count: number;
  /** `incoming` espera que esta persona acepte; `outgoing` espera a la otra. */
  request_state: "accepted" | "incoming" | "outgoing";
}

export interface FriendRequest {
  user: PublicUser;
  created_at: number;
}

export interface SocialOverview {
  friends: PublicUser[];
  incoming_friend_requests: FriendRequest[];
  outgoing_friend_requests: FriendRequest[];
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
  /**
   * Cuándo levantó la mano, o null si no la tiene levantada.
   *
   * Es una marca de tiempo y no un booleano porque lo que hace falta enseñar es
   * la COLA: saber quién pidió primero es la mitad del valor de levantar la
   * mano, y con un booleano el orden lo decidiría el orden de la lista, que no
   * significa nada.
   */
  hand_raised_at: number | null;
}

/**
 * Lo que la sala necesita saber del presupuesto de vídeo (V3).
 *
 * `queued` son quienes querían transmitir y no caben. No es una lista de
 * culpables: el techo lo pone la subida de quien hospeda, y `mode` dice si ese
 * techo lo mide el servidor (`host`) o lo aplican los clientes (`direct`),
 * porque no son la misma medida y mezclarlas daría un número falso.
 */
export interface VideoBudget {
  channel_id: Snowflake;
  mode: "host" | "direct";
  /** Fuentes simultáneas que caben ahora mismo. */
  slots: number;
  /** Coste estimado de lo aceptado y techo aplicado, en kbps de subida. */
  cost_kbps: number;
  ceiling_kbps: number;
  queued: Snowflake[];
}

/* ─────────────────────────── Reuniones (V1, §8) ───────────────────────────
 *
 * Una reunión NO es un tipo de sala de voz nuevo: es un canal con
 * `kind="meeting"` más una fila en `meetings`. Mensajes, adjuntos, permisos,
 * overwrites, búsqueda, fijados, el registro de salas y el relay binario
 * funcionan sin una línea de cambio, y las salas de voz de siempre quedan
 * intactas.
 *
 * La diferencia con una sala de voz es que una reunión **termina**: tiene
 * principio, final, quién estuvo y cuánto.
 */

/**
 * El ciclo de vida, y no hay más estados.
 *
 * `LOBBY` y `LIVE` son distintos a propósito: en `LOBBY` la gente puede llegar
 * y esperar, pero **nadie transmite nada**. La reunión la abre una persona, no
 * el primer invitado que llama a la puerta — si no, cualquiera podría empezar
 * la reunión de otro por el simple hecho de llegar pronto.
 */
export const MEETING_STATES = ["DRAFT", "SCHEDULED", "LOBBY", "LIVE", "ENDED", "CANCELLED"] as const;
export type MeetingState = (typeof MEETING_STATES)[number];

/** Qué transiciones existen. Lo que no está aquí, no pasa. */
export const MEETING_TRANSITIONS: Record<MeetingState, readonly MeetingState[]> = {
  DRAFT: ["SCHEDULED", "LOBBY", "LIVE", "CANCELLED"],
  SCHEDULED: ["LOBBY", "LIVE", "CANCELLED"],
  LOBBY: ["LIVE", "ENDED", "CANCELLED"],
  LIVE: ["ENDED"],
  /* Terminada es terminada. Reabrir una reunión cerrada falsearía su asistencia
     —dos tramos distintos contados como uno— y su duración. Se convoca otra. */
  ENDED: [],
  CANCELLED: [],
};

export function canTransition(from: MeetingState, to: MeetingState): boolean {
  return MEETING_TRANSITIONS[from].includes(to);
}

/** Una reunión ha empezado de verdad: aquí sí puede viajar media. */
export function meetingIsOpen(state: MeetingState): boolean {
  return state === "LOBBY" || state === "LIVE";
}

/**
 * Papeles dentro de una reunión, efímeros y sin relación con los roles de la
 * comunidad: quien organiza una reunión no gana ningún poder sobre el servidor,
 * y quien administra el servidor no se convierte en organizador en silencio.
 */
export const MEETING_ROLES = ["host", "cohost", "presenter", "attendee", "viewer"] as const;
export type MeetingRole = (typeof MEETING_ROLES)[number];

/** Mayor manda. Sirve para comparar, no para almacenar. */
export const MEETING_RANK: Record<MeetingRole, number> = {
  host: 4,
  cohost: 3,
  presenter: 2,
  attendee: 1,
  viewer: 0,
};

/** Quién puede admitir, expulsar y cerrar: de coanfitrión para arriba. */
export function meetingCanModerate(role: MeetingRole): boolean {
  return MEETING_RANK[role] >= MEETING_RANK.cohost;
}

/** Quién puede transmitir. Un asistente escucha; un espectador ni eso. */
export function meetingCanSpeak(role: MeetingRole): boolean {
  return MEETING_RANK[role] >= MEETING_RANK.attendee;
}

export interface Meeting {
  id: Snowflake;
  channel_id: Snowflake;
  community_id: Snowflake;
  title: string;
  agenda: string | null;
  organizer_id: Snowflake;
  state: MeetingState;
  starts_at: number | null;
  ends_at: number | null;
  opened_at: number | null;
  closed_at: number | null;
  /** Sala de espera: sin ella, entrar es entrar. */
  lobby: boolean;
  mute_on_entry: boolean;
  guests_allowed: boolean;
  created_at: number;
  /** Sube en cada reprogramación, con el mismo id. Lo lee el `.ics`. */
  sequence: number;
  /**
   * Zona en la que se convocó, **solo para enseñarla**.
   *
   * El instante vive en UTC porque una zona cambia de reglas —un país mueve su
   * horario de verano— y una hora guardada como "18:00 en Madrid" se desplaza
   * sola cuando eso pasa.
   */
  timezone: string | null;
  /** Solo suena quien tiene el turno, y el turno lo da el servidor. */
  push_to_talk: boolean;
}

/**
 * Grabación de una reunión (V3, §8.9).
 *
 * **El fichero vive en el ordenador de quien graba**, no aquí. El servidor no
 * mezcla nada: mezclar exigiría decodificar, componer y recodificar cada
 * fotograma de cada persona en el PC de quien hospeda, que es exactamente el
 * trabajo que este proyecto no le puede pedir a un ordenador doméstico.
 *
 * Lo que sí lleva el servidor es el **estado y el aviso**: quién graba, desde
 * cuándo, y que todo el mundo lo sepa mientras dura.
 *
 * `CONSENTING` existe porque avisar después no es avisar. Si la grabación ya
 * empezó, a quien llega se le dice **antes** de admitirle.
 */
export const RECORDING_STATES = [
  "REQUESTED",
  "CONSENTING",
  "RECORDING",
  "FINALIZING",
  "AVAILABLE",
  "FAILED",
  "DELETED",
] as const;
export type RecordingState = (typeof RECORDING_STATES)[number];

export const RECORDING_TRANSITIONS: Record<RecordingState, readonly RecordingState[]> = {
  REQUESTED: ["CONSENTING", "FAILED"],
  CONSENTING: ["RECORDING", "FAILED"],
  RECORDING: ["FINALIZING", "FAILED"],
  /* Cerrar un fichero de vídeo puede fallar, y decir que está disponible cuando
     no lo está es peor que decir que falló. */
  FINALIZING: ["AVAILABLE", "FAILED"],
  AVAILABLE: ["DELETED"],
  FAILED: ["DELETED"],
  DELETED: [],
};

export function canRecordingTransition(from: RecordingState, to: RecordingState): boolean {
  return RECORDING_TRANSITIONS[from].includes(to);
}

/** Mientras esté en uno de estos, hay un aviso permanente en pantalla. */
export function recordingIsLive(state: RecordingState): boolean {
  return state === "CONSENTING" || state === "RECORDING";
}

export interface MeetingRecording {
  id: Snowflake;
  meeting_id: Snowflake;
  /** Quién graba. Se enseña: una grabación anónima no es un aviso. */
  recorder_id: Snowflake;
  state: RecordingState;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/** Quién espera fuera, en orden de llegada. */
export interface MeetingWaiting {
  user_id: Snowflake;
  display_name: string;
  since: number;
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

/* ────────────────────── Firma canónica y sucesión (C2) ──────────────────────
   Todo lo que se firma en Distop se firma sobre ESTA codificación. Vive aquí y
   no en cada lado porque servidor y cliente tienen que producir byte a byte lo
   mismo: si difieren en el orden de una clave, una firma legítima no valida y
   el cliente concluye que su comunidad es un impostor.

   Lo que NO se comparte es la primitiva criptográfica: el servidor firma con
   `node:crypto` y el navegador verifica con WebCrypto. Lo que se comparte son
   las reglas, que es donde están los errores que importan. */

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export const SUCCESSION_CERT_TYPE = "DISTOP_SUCCESSION_CERT";

/**
 * Un eslabón de la cadena: "yo, la instancia A en la época N, autorizo a la
 * instancia B con ESTA clave a continuar la línea en la época N+1".
 *
 * La clave privada de A nunca viaja. Esto es lo único que hace que B pueda
 * demostrar a quien tenía fijada a A que no es un impostor.
 */
export interface SuccessionCertPayload {
  t: typeof SUCCESSION_CERT_TYPE;
  version: 1;
  lineage_id: Snowflake;
  from_instance_id: Snowflake;
  from_epoch: number;
  from_fingerprint: string;
  to_instance_id: Snowflake;
  to_epoch: number;
  to_fingerprint: string;
  to_public_key: JsonWebKeyLike;
  /** Direcciones desde las que se acepta al sucesor. Vacío = ninguna todavía. */
  allowed_origins: string[];
  issued_at: number;
  not_before: number;
  expires_at: number;
  handover_id: Snowflake;
}

/** JWK sin depender de los tipos de Node: el cliente también lo usa. */
export type JsonWebKeyLike = Record<string, unknown>;

export interface SuccessionCert {
  payload: SuccessionCertPayload;
  signature: string;
  signer_public_key: JsonWebKeyLike;
  signer_fingerprint: string;
}

/** Dónde está fijada una identidad ahora mismo, para el cliente. */
export interface InstanceIdentityRef {
  instance_id: Snowflake;
  lineage_id: Snowflake;
  epoch: number;
  fingerprint: string;
}

/**
 * Tope de eslabones. Una comunidad que cambia de manos catorce veces existe;
 * una cadena de mil es alguien intentando que gastes CPU verificándola.
 */
export const SUCCESSION_CHAIN_MAX = 16;

/**
 * Las reglas de un eslabón, sin tocar criptografía.
 *
 * Aparte de la firma a propósito: verificar la firma solo dice "esto lo escribió
 * quien dice"; estas reglas dicen "y además tiene sentido". Un certificado
 * perfectamente firmado que salta de la época 3 a la 7, o que cambia de linaje,
 * o que ya caducó, es un certificado válido y una mentira.
 *
 * Devuelve `null` si el paso es bueno, o el motivo del rechazo.
 */
export function checkSuccessionStep(
  from: InstanceIdentityRef,
  payload: SuccessionCertPayload,
  now: number,
): string | null {
  if (payload?.t !== SUCCESSION_CERT_TYPE || payload.version !== 1) return "NOT_A_CERT";
  if (payload.lineage_id !== from.lineage_id) return "LINEAGE_MISMATCH";
  if (payload.from_instance_id !== from.instance_id) return "FROM_INSTANCE_MISMATCH";
  if (payload.from_epoch !== from.epoch) return "FROM_EPOCH_MISMATCH";
  if (payload.from_fingerprint !== from.fingerprint) return "FROM_KEY_MISMATCH";
  /* Exactamente uno. Saltar épocas dejaría un hueco en el que nadie sabe qué
     pasó, y repetir una permitiría dos sucesores para el mismo número: un fork
     firmado con nuestra propia clave. */
  if (payload.to_epoch !== from.epoch + 1) return "EPOCH_NOT_NEXT";
  if (payload.to_instance_id === from.instance_id) return "SAME_INSTANCE";
  if (payload.to_fingerprint === from.fingerprint) return "SAME_KEY";
  if (!payload.to_instance_id || !payload.to_fingerprint) return "INCOMPLETE";
  if (!Number.isSafeInteger(payload.not_before) || !Number.isSafeInteger(payload.expires_at)) return "BAD_WINDOW";
  if (now < payload.not_before) return "NOT_YET_VALID";
  if (now >= payload.expires_at) return "EXPIRED";
  if (!Array.isArray(payload.allowed_origins) || payload.allowed_origins.length > 4) return "BAD_ORIGINS";
  return null;
}

export const ORIGIN_SET_TYPE = "DISTOP_ORIGIN_SET";

/** Cómo se llega a una instancia. La etiqueta la escribe quien hospeda. */
export interface SignedOrigin {
  url: string;
  /** Menor es antes. Sirve para probar la buena primero, no para nada más. */
  priority: number;
  kind: "tunnel" | "tailscale" | "custom" | "lan";
  label: string;
}

/**
 * Las direcciones por las que una instancia acepta que se la busque, firmadas.
 *
 * Existe porque una dirección puede cambiar sin que cambie la instancia: un
 * túnel rápido estrena URL en cada arranque, un dominio se muda, una tailnet se
 * renombra. Sin esto, la única forma de reencontrar una comunidad sería que
 * alguien reparta el enlace nuevo a mano.
 *
 * Va firmado y con `generation` porque una lista de direcciones es exactamente
 * lo que un atacante querría envenenar: "tu comunidad ahora está aquí". Sin
 * firma no es una pista, es una redirección gratis.
 */
export interface OriginSetPayload {
  t: typeof ORIGIN_SET_TYPE;
  version: 1;
  lineage_id: Snowflake;
  instance_id: Snowflake;
  epoch: number;
  /** Sube en cada cambio. Nunca se acepta uno menor que el ya conocido. */
  generation: number;
  origins: SignedOrigin[];
  issued_at: number;
  expires_at: number;
}

export interface SignedOriginSet {
  payload: OriginSetPayload;
  signature: string;
  signer_public_key: JsonWebKeyLike;
  signer_fingerprint: string;
}

/** Tres pistas y no más: la lista es para reencontrar una instancia, no un
    directorio. Cada una de más es una dirección más que alguien puede mirar. */
export const MAX_SIGNED_ORIGINS = 3;

/**
 * Las reglas de un conjunto de orígenes, sin criptografía.
 *
 * `conocida` es lo que el cliente tenía fijado. `generationConocida` es la
 * última generación que aceptó: volver atrás es el ataque obvio —reponer una
 * lista vieja que apuntaba a una dirección que el atacante ya controla— y por
 * eso se rechaza aunque la firma sea perfecta.
 */
export function checkOriginSet(
  conocida: InstanceIdentityRef,
  generationConocida: number,
  payload: OriginSetPayload,
  now: number,
): string | null {
  if (payload?.t !== ORIGIN_SET_TYPE || payload.version !== 1) return "NOT_AN_ORIGIN_SET";
  if (payload.lineage_id !== conocida.lineage_id) return "LINEAGE_MISMATCH";
  if (payload.instance_id !== conocida.instance_id) return "INSTANCE_MISMATCH";
  if (payload.epoch !== conocida.epoch) return "EPOCH_MISMATCH";
  if (!Number.isSafeInteger(payload.generation) || payload.generation < generationConocida) return "STALE_GENERATION";
  if (!Number.isSafeInteger(payload.expires_at) || now >= payload.expires_at) return "EXPIRED";
  if (!Array.isArray(payload.origins) || payload.origins.length > MAX_SIGNED_ORIGINS) return "TOO_MANY_ORIGINS";
  for (const origen of payload.origins) {
    if (typeof origen?.url !== "string" || origen.url.length > 300) return "BAD_ORIGIN";
    if (typeof origen.label !== "string" || origen.label.length > 60) return "BAD_LABEL";
  }
  return null;
}

/**
 * Qué pasa cuando dos respuestas dicen ser la misma comunidad.
 *
 * `fork` es el caso grave y el que no se resuelve solo: mismo linaje, misma
 * época, claves distintas. Alguien restauró una copia, o alguien miente. Una
 * máquina no puede elegir —las dos parecen legítimas desde fuera— y elegir mal
 * significa mandar el token de sesión al sitio equivocado.
 */
export type ContinuityVerdict = "same" | "successor" | "stale" | "fork" | "unrelated";

export function compareIdentities(
  conocida: InstanceIdentityRef,
  vista: InstanceIdentityRef,
): ContinuityVerdict {
  if (vista.lineage_id !== conocida.lineage_id) return "unrelated";
  if (vista.epoch === conocida.epoch) {
    return vista.fingerprint === conocida.fingerprint ? "same" : "fork";
  }
  return vista.epoch > conocida.epoch ? "successor" : "stale";
}

export const COMMUNITY_MIGRATION_TYPE = "DISTOP_COMMUNITY_MIGRATION";

/**
 * Mover UNA comunidad a otra instancia, no la instancia entera.
 *
 * Es distinto de un relevo y por eso tiene su propio certificado. Un relevo
 * entrega la máquina con todo lo que aloja; esto saca una comunidad de una
 * máquina que sigue funcionando y alojando otras. La firma la pone la instancia
 * de origen, porque es quien tiene los datos y quien deja de servirlos.
 */
export interface CommunityMigrationPayload {
  t: typeof COMMUNITY_MIGRATION_TYPE;
  version: 1;
  community_id: Snowflake;
  source_instance: Snowflake;
  source_lineage: Snowflake;
  destination_instance: Snowflake;
  destination_origin: string;
  /** Hash del bundle exportado: el destino comprueba que importa justo eso. */
  snapshot_hash: string;
  /** Versión de protocolo del origen, para no importar lo que no se entiende. */
  protocol: string;
  issued_at: number;
  expires_at: number;
}

export interface CommunityMigrationCert {
  payload: CommunityMigrationPayload;
  signature: string;
  signer_public_key: JsonWebKeyLike;
  signer_fingerprint: string;
}

export const MIGRATION_STATES = [
  "DRAFT",
  "EXPORTING",
  "VERIFYING",
  "READY",
  "ACTIVATING",
  "COMPLETED",
  "FAILED",
] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];

/**
 * Reglas de un certificado de migración, sin criptografía.
 *
 * `destino` es la instancia que va a importar: comprobar que el certificado la
 * nombra a ELLA evita que un bundle destinado a un sitio se importe en otro,
 * que es como una comunidad acabaría existiendo dos veces.
 */
export function checkMigrationCert(
  destino: { instance_id: Snowflake; protocol: string },
  payload: CommunityMigrationPayload,
  now: number,
): string | null {
  if (payload?.t !== COMMUNITY_MIGRATION_TYPE || payload.version !== 1) return "NOT_A_MIGRATION";
  if (!payload.community_id || !payload.source_instance) return "INCOMPLETE";
  if (payload.destination_instance !== destino.instance_id) return "WRONG_DESTINATION";
  if (payload.source_instance === payload.destination_instance) return "SAME_INSTANCE";
  if (payload.protocol !== destino.protocol) return "PROTOCOL_MISMATCH";
  if (!/^[0-9a-f]{64}$/.test(payload.snapshot_hash)) return "BAD_SNAPSHOT_HASH";
  if (!Number.isSafeInteger(payload.expires_at) || now >= payload.expires_at) return "EXPIRED";
  return null;
}

/* ─────────────────────────── Estado de instancia (§26) ─────────────────────────── */

export const INSTANCE_STATES = [
  "ONLINE",
  "HOST_UNCLAIMED",
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

/* ── Integridad observable ────────────────────────────────────────────────
   Rellenar los hashes de adjuntos viejos es trabajo de fondo que puede durar
   horas en un disco lento. Sin progreso visible, quien hospeda no distingue
   "va por la mitad" de "lleva parado desde el martes", y una copia de
   seguridad tomada a ciegas heredaría esa duda. */

export const BACKFILL_STATES = [
  "idle",
  "running",
  /** Hay gente en una llamada: el disco y la CPU son suyos mientras dure. */
  "paused_call",
  "paused_disk_pressure",
  /** Copia, restauración o relevo en curso: nadie más toca el almacenamiento. */
  "paused_maintenance",
  "complete",
  /** Terminó, pero algún adjunto no se pudo leer. No es lo mismo que completo. */
  "degraded",
] as const;

export type BackfillState = (typeof BACKFILL_STATES)[number];

export interface AttachmentHashProgress {
  state: BackfillState;
  scanned: number;
  updated: number;
  failed: number;
  remaining: number;
  /** Código estable, nunca un mensaje: una ruta o un nombre de fichero
      publicados en /health serían una fuga (§8). Vacío si no hubo fallos. */
  last_error: string;
}

export interface InstanceIntegrity {
  attachment_hashes: AttachmentHashProgress;
}

/**
 * Lo que esta instancia sabe hacer, por nombre y versión.
 *
 * Un cliente no debe deducir soporte de la versión del programa: las instancias
 * se actualizan en momentos distintos (§28.6) y una función puede existir en
 * 0.1.0 y faltar en otra 0.1.0 compilada sin ella. Se declara, no se infiere.
 */
export const CAPABILITIES = [
  /** Prueba de origen firmada ES256 con nonce del cliente (`/instance/challenge`). */
  "signed_identity_v1",
  /** Progreso de integridad publicado en `/health`. */
  "integrity_report_v1",
  /** Copia cifrada `.distop-backup` v1, e inspección sin restaurar. */
  "encrypted_backup_v1",
  /** Relevo planificado con certificado de sucesión. */
  "succession_v1",
  /** Direcciones alternativas firmadas, con generación. */
  "signed_origins_v1",
  /** Migración de una sola comunidad entre instancias. */
  "community_migration_v1",
  /** Web Push propio de la instancia (RFC 8291/8292), opcional y sin terceros. */
  "web_push_v1",
  /**
   * Reuniones: sala de espera, roles efímeros, manos y asistencia.
   *
   * Es el núcleo, y por eso las piezas que se construyeron encima se declaran
   * aparte, abajo. Agruparlas todas aquí funcionaba solo mientras cliente y
   * servidor viajaban en el mismo instalador: en cuanto una instancia se
   * actualiza antes que otra (§28.6), un cliente que preguntase por
   * `meetings_v1` daría por hecho que hay grabación y calendario donde puede no
   * haberlos. Se declara lo que se sabe hacer, pieza a pieza.
   */
  "meetings_v1",
  /** Invitados por enlace, con la sesión acotada a una sola reunión. */
  "meeting_guests_v1",
  /** Grabación local avisada, con su máquina de estados y consentimiento previo. */
  "meeting_recording_v1",
  /** Reparto de vídeo con techo real de subida y cola de espera. */
  "video_budget_v1",
  /** Agenda `.ics` por token revocable, sin OAuth ni terceros. */
  "meeting_calendar_v1",
  /** Turno de palabra arbitrado por el servidor (push-to-talk de reunión). */
  "push_to_talk_v1",
  /** NodeInfo 2.1 en /.well-known/nodeinfo cuando el descubrimiento público está activo. */
  "nodeinfo_v1",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

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
  integrity: InstanceIntegrity;
}

/* ─────────────────────────── Eventos WebSocket (§18) ─────────────────────────── */

export const GATEWAY_EVENTS = [
  "READY",
  "MESSAGE_CREATE",
  "MESSAGE_UPDATE",
  "MESSAGE_DELETE",
  "DIRECT_CONVERSATION_UPSERT",
  "DIRECT_MESSAGE_CREATE",
  "DIRECT_MESSAGE_UPDATE",
  "DIRECT_MESSAGE_DELETE",
  "DIRECT_READ_UPDATE",
  "DIRECT_MESSAGES_PURGED",
  "DIRECT_CONVERSATION_DELETE",
  "SOCIAL_UPDATE",
  "REACTION_UPDATE",
  "CHANNEL_CREATE",
  "CHANNEL_UPDATE",
  "CHANNEL_DELETE",
  "CATEGORY_UPDATE",
  "COMMUNITY_UPDATE",
  "COMMUNITY_DELETE",
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
  | { t: "DIRECT_CONVERSATION_UPSERT"; d: DirectConversation }
  | { t: "DIRECT_MESSAGE_CREATE"; d: DirectMessage }
  | { t: "DIRECT_MESSAGE_UPDATE"; d: DirectMessage }
  | { t: "DIRECT_MESSAGE_DELETE"; d: { id: Snowflake; conversation_id: Snowflake } }
  | { t: "DIRECT_READ_UPDATE"; d: { conversation_id: Snowflake; last_read_id: Snowflake } }
  | { t: "DIRECT_MESSAGES_PURGED"; d: Record<string, never> }
  | { t: "DIRECT_CONVERSATION_DELETE"; d: { id: Snowflake } }
  | { t: "SOCIAL_UPDATE"; d: SocialOverview }
  | { t: "REACTION_UPDATE"; d: { message_id: Snowflake; channel_id: Snowflake; reactions: Reaction[] } }
  | { t: "CHANNEL_CREATE"; d: Channel }
  | { t: "CHANNEL_UPDATE"; d: Channel }
  | { t: "CHANNEL_DELETE"; d: { id: Snowflake; community_id: Snowflake } }
  | { t: "CATEGORY_UPDATE"; d: { community_id: Snowflake; categories: Category[] } }
  | { t: "COMMUNITY_UPDATE"; d: Community }
  /* Borrada de verdad, para todos los conectados: sin este evento solo quien
     la borraba dejaba de verla y para el resto quedaba un cascarón que daba
     error al abrirlo. */
  | { t: "COMMUNITY_DELETE"; d: { community_id: Snowflake } }
  | { t: "MEMBER_JOIN"; d: Member }
  | { t: "MEMBER_LEAVE"; d: { community_id: Snowflake; user_id: Snowflake } }
  | { t: "MEMBER_UPDATE"; d: Member }
  | { t: "PRESENCE_UPDATE"; d: { community_id: Snowflake; online: Snowflake[] } }
  /* La lista entera por comunidad, como PRESENCE_UPDATE: es corta y así no hay
     dos maneras de tenerla desincronizada entre quien estaba y quien llega. */
  | { t: "GAME_PRESENCE_UPDATE"; d: { community_id: Snowflake; presences: GamePresence[] } }
  | { t: "TYPING_START"; d: { channel_id: Snowflake; user_id: Snowflake; until: number } }
  | { t: "VOICE_STATE_UPDATE"; d: { channel_id: Snowflake; community_id: Snowflake; states: VoiceState[] } }
  /* Confirmación dirigida al socket que intentó entrar. Antes, el cliente se
     daba por conectado antes de que la instancia aceptara la entrada; un
     rechazo por reunión cerrada o por permisos quedaba completamente mudo. */
  /* `full` va aparte de `denied` a propósito (§26): la sala llena no es una
     falta de permisos, y quien se queda fuera necesita saber que puede volver
     a intentarlo cuando salga alguien, en vez de creer que no le dejan. */
  | {
      t: "VOICE_JOIN_RESULT";
      d: { channel_id: Snowflake; outcome: "joined" | "waiting" | "closed" | "denied" | "full" };
    }
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
  /* Reuniones (V1). La reunión entera y no el campo que cambió: son pocos
     campos y así no hay dos maneras de tenerla desincronizada. */
  | { t: "MEETING_UPDATE"; d: Meeting }
  /* Solo a quien espera: "estás fuera, todavía". Va a esa persona y a nadie
     más, porque el resto no tiene por qué saber quién llamó a la puerta. */
  | { t: "MEETING_WAITING"; d: { meeting_id: Snowflake; channel_id: Snowflake; admitted: boolean } }
  /* Solo a quien puede admitir. La sala de espera no se publica a la reunión:
     enseñarla a todo el mundo convertiría "esperar" en "que te miren esperar". */
  | { t: "MEETING_LOBBY"; d: { meeting_id: Snowflake; channel_id: Snowflake; waiting: MeetingWaiting[] } }
  /* Tu papel cambió: te hicieron presentador, o te lo quitaron. */
  | { t: "MEETING_ROLE"; d: { meeting_id: Snowflake; channel_id: Snowflake; user_id: Snowflake; role: MeetingRole } }
  /* Presupuesto de vídeo (V3): cuántas fuentes caben y quién espera turno.
     Va a la sala entera y no solo a quien se quedó fuera, porque el motivo es
     compartido —la conexión del anfitrión— y no un problema de esa persona. */
  | { t: "VIDEO_BUDGET"; d: VideoBudget }
  /* Alguien está grabando, o dejó de hacerlo. A la sala entera y sin
     excepciones: una grabación que no se anuncia no es una grabación, es otra
     cosa. */
  | { t: "RECORDING_UPDATE"; d: { channel_id: Snowflake; recording: MeetingRecording | null } }
  /* Quién tiene el turno de palabra ahora mismo, o nadie. */
  | { t: "MEETING_FLOOR"; d: { channel_id: Snowflake; user_id: Snowflake | null } }
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
  /* Reuniones (V1). El servidor revalida el permiso en cada uno: que el cliente
     haya enseñado el botón no es autorización de nada. */
  | { t: "MEETING_ADMIT"; d: { channel_id: Snowflake; user_id: Snowflake } }
  | { t: "MEETING_DENY"; d: { channel_id: Snowflake; user_id: Snowflake } }
  | { t: "MEETING_ADMIT_ALL"; d: { channel_id: Snowflake } }
  | { t: "MEETING_HAND"; d: { channel_id: Snowflake; raised: boolean } }
  /* Empezar o terminar una grabación LOCAL. El servidor no recibe ni un byte
     de vídeo por aquí: solo el estado, para poder avisar a la sala. */
  | { t: "MEETING_RECORD"; d: { channel_id: Snowflake; state: RecordingState } }
  /* Turno de palabra con la aplicación enfocada (V4). El turno lo arbitra el
     servidor: si lo decidiera el cliente, "tengo el turno" sería una frase que
     cualquiera escribe. El PTT global queda fuera — necesita un hook nativo de
     teclado y su propia revisión de permisos. */
  | { t: "MEETING_FLOOR"; d: { channel_id: Snowflake; hold: boolean } }
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

/**
 * Adelanta el reloj monotónico de UUIDv7 hasta un instante ya persistido.
 * Al restaurar una base en un equipo cuyo reloj va atrasado, arrancar en cero
 * haría que los ids nuevos ordenasen antes que los antiguos.
 */
export function seedUuidClock(ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return;
  if (ms > lastMs) {
    lastMs = Math.floor(ms);
    sequence = 0;
  }
}

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
