/**
 * Señalización de voz (§9.4).
 * La instancia no toca el audio: guarda quién está en cada canal y reenvía las
 * ofertas SDP y los candidatos ICE entre pares. Eso significa que hospedar voz
 * no cuesta ancho de banda ni CPU de servidor, que es justo lo que hace que
 * esta plataforma pueda vivir en el PC de alguien (§3).
 *
 * ponytail: malla entre pares, sin SFU. Cada persona manda su audio a cada
 * otra, así que el coste sube al cuadrado: por encima de ~6 por canal toca
 * meter un SFU (mediasoup o LiveKit self-hosted). El protocolo no cambia.
 */
import { PERMISSIONS, has } from "@distop/protocol";
import type { Snowflake, VideoSource, VoiceState } from "@distop/protocol";
import { channelPermissions } from "./permissions.ts";
import { getChannel } from "./entities.ts";

interface Participant {
  userId: Snowflake;
  communityId: Snowflake;
  muted: boolean;
  deafened: boolean;
  video: VideoSource | null;
  joinedAt: number;
}

/** canal → participantes. Vive en memoria: si la instancia cae, la llamada también. */
const rooms = new Map<Snowflake, Map<Snowflake, Participant>>();

export function statesOf(channelId: Snowflake): VoiceState[] {
  const room = rooms.get(channelId);
  if (!room) return [];
  return [...room.values()].map((p) => ({
    user_id: p.userId,
    channel_id: channelId,
    community_id: p.communityId,
    muted: p.muted,
    deafened: p.deafened,
    video: p.video,
    joined_at: p.joinedAt,
  }));
}

/** Todos los canales de voz de una comunidad con gente dentro. */
export function statesOfCommunity(communityId: Snowflake): VoiceState[] {
  const out: VoiceState[] = [];
  for (const channelId of rooms.keys()) {
    for (const state of statesOf(channelId)) if (state.community_id === communityId) out.push(state);
  }
  return out;
}

export function peersOf(channelId: Snowflake): Snowflake[] {
  return [...(rooms.get(channelId)?.keys() ?? [])];
}

/** Estado de una persona dentro de una sala, o undefined si no está. */
export function participantOf(channelId: Snowflake, userId: Snowflake): Readonly<Participant> | undefined {
  return rooms.get(channelId)?.get(userId);
}

export function channelOf(userId: Snowflake): Snowflake | null {
  for (const [channelId, room] of rooms) if (room.has(userId)) return channelId;
  return null;
}

export interface JoinResult {
  ok: boolean;
  channelId: Snowflake;
  communityId: Snowflake;
  /** Canal que abandonó al entrar aquí: solo se puede estar en una llamada. */
  left: Snowflake | null;
}

export function join(channelId: Snowflake, userId: Snowflake): JoinResult | null {
  const channel = getChannel(channelId);
  if (!channel || channel.kind !== "voice") return null;
  if (!has(channelPermissions(channelId, userId), PERMISSIONS.CONNECT_VOICE)) return null;

  // Una persona, una llamada: entrar en otra sala saca de la anterior.
  const previous = channelOf(userId);
  if (previous && previous !== channelId) leave(previous, userId);

  /* Volver a entrar en la MISMA sala no es no hacer nada: es una pestaña nueva,
     con otra conexión WebRTC. Antes se salía por aquí sin tocar el estado, así
     que el resto seguía hablándole al navegador anterior —que ya no existe— y se
     quedaba en "conectando" para siempre. Renovar `joinedAt` es la señal de que
     hay que rehacer la conexión con esta persona. */
  const room = rooms.get(channelId) ?? new Map<Snowflake, Participant>();
  room.set(userId, {
    userId,
    communityId: channel.community_id,
    // Sin permiso para hablar se entra en silencio: se escucha, no se interrumpe.
    muted: !has(channelPermissions(channelId, userId), PERMISSIONS.SPEAK),
    deafened: false,
    video: null,
    joinedAt: Date.now(),
  });
  rooms.set(channelId, room);

  return { ok: true, channelId, communityId: channel.community_id, left: previous === channelId ? null : previous };
}

export function leave(channelId: Snowflake, userId: Snowflake): boolean {
  const room = rooms.get(channelId);
  if (!room?.delete(userId)) return false;
  if (room.size === 0) rooms.delete(channelId);
  return true;
}

/** Al cerrarse un socket hay que sacar a esa persona de donde estuviera. */
export function leaveAll(userId: Snowflake): Snowflake[] {
  const left: Snowflake[] = [];
  for (const [channelId, room] of [...rooms]) {
    if (room.delete(userId)) {
      left.push(channelId);
      if (room.size === 0) rooms.delete(channelId);
    }
  }
  return left;
}

export function setMute(channelId: Snowflake, userId: Snowflake, muted: boolean, deafened: boolean): boolean {
  const participant = rooms.get(channelId)?.get(userId);
  if (!participant) return false;

  // Sin permiso de hablar no hay forma de quitarse el silencio desde el cliente.
  const canSpeak = has(channelPermissions(channelId, userId), PERMISSIONS.SPEAK);
  participant.muted = canSpeak ? muted : true;
  participant.deafened = deafened;
  // Ensordecer implica callar: escuchar a nadie mientras hablas confunde a todos.
  if (deafened) participant.muted = true;
  return true;
}

/**
 * Cámara y pantalla son permisos distintos (§11): compartir la pantalla enseña
 * cosas que la cámara no, así que una comunidad puede permitir una y no la otra.
 * Devuelve false si no cambió nada, para no anunciar estados iguales.
 */
export function setVideo(channelId: Snowflake, userId: Snowflake, source: VideoSource | null): boolean {
  const participant = rooms.get(channelId)?.get(userId);
  if (!participant || participant.video === source) return false;

  if (source) {
    const needed = source === "screen" ? PERMISSIONS.STREAM : PERMISSIONS.USE_CAMERA;
    if (!has(channelPermissions(channelId, userId), needed)) return false;
  }

  participant.video = source;
  return true;
}

/** Solo se reenvía entre dos personas que ya están en la misma sala. */
export function canSignal(channelId: Snowflake, from: Snowflake, to: Snowflake): boolean {
  const room = rooms.get(channelId);
  return Boolean(room?.has(from) && room.has(to));
}
