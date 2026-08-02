/**
 * Protocolo Distop v1 — contrato único entre cliente e instancia (§18).
 * Todo cambio incompatible sube PROTOCOL_VERSION; los aditivos no.
 */

export const PROTOCOL_VERSION = "v1";

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
  created_at: number;
}

export interface SelfUser extends PublicUser {
  locale: string;
  theme: string;
  settings: Record<string, unknown>;
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
   Malla WebRTC entre pares: la instancia solo hace de señalización, el audio
   nunca la atraviesa. Para grupos pequeños esto sobra y no exige montar un SFU
   ni pagar servidores de medios; el techo práctico está en torno a 6 personas
   por canal, a partir de ahí toca un SFU (fase posterior). */

export interface VoiceState {
  user_id: Snowflake;
  channel_id: Snowflake;
  community_id: Snowflake;
  muted: boolean;
  deafened: boolean;
  joined_at: number;
}

/** SDP e ICE viajan opacos: la instancia los reenvía sin leerlos. */
export interface VoiceSignal {
  channel_id: Snowflake;
  from_user_id: Snowflake;
  to_user_id: Snowflake;
  payload: unknown;
}

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
  "TYPING_START",
  "VOICE_STATE_UPDATE",
  "VOICE_SIGNAL",
  "ROLE_UPDATE",
  "ROLE_DELETE",
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
  | { t: "TYPING_START"; d: { channel_id: Snowflake; user_id: Snowflake; until: number } }
  | { t: "VOICE_STATE_UPDATE"; d: { channel_id: Snowflake; community_id: Snowflake; states: VoiceState[] } }
  | { t: "VOICE_SIGNAL"; d: VoiceSignal }
  | { t: "ROLE_UPDATE"; d: Role }
  | { t: "ROLE_DELETE"; d: { id: Snowflake; community_id: Snowflake } }
  | { t: "ERROR"; d: ApiError }
  | { t: "PONG"; d: { at: number } };

export type ClientCommand =
  | { t: "SUBSCRIBE"; d: { community_id: Snowflake } }
  | { t: "UNSUBSCRIBE"; d: { community_id: Snowflake } }
  | { t: "TYPING"; d: { channel_id: Snowflake } }
  | { t: "VOICE_JOIN"; d: { channel_id: Snowflake } }
  | { t: "VOICE_LEAVE"; d: { channel_id: Snowflake } }
  | { t: "VOICE_MUTE"; d: { channel_id: Snowflake; muted: boolean; deafened: boolean } }
  | { t: "VOICE_SIGNAL"; d: { channel_id: Snowflake; to_user_id: Snowflake; payload: unknown } }
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
