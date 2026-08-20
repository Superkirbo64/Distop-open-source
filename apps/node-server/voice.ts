/**
 * Estado de las salas de voz (§9.4): quién está dentro de cada canal, cómo, y
 * quién puede callar a quién.
 *
 * Aquí NO pasa media. El audio lo reenvía `relayMedia` en gateway.ts, por el
 * mismo socket que todo lo demás; el vídeo va directo entre navegadores y esta
 * pieza solo reenvía su señalización. Este módulo es el registro: sin él nadie
 * sabría a quién conectarse ni a quién dejar de escuchar.
 *
 * Vive en memoria a propósito: una llamada no sobrevive a que se apague el
 * equipo anfitrión, así que guardarla en disco solo dejaría salas fantasma.
 */
import { PERMISSIONS, has } from "@distop/protocol";
import type { Snowflake, VideoSource, VoiceAction, VoiceState } from "@distop/protocol";
import { canActOn, channelPermissions } from "./permissions.ts";
import { getChannel } from "./entities.ts";

interface Participant {
  userId: Snowflake;
  communityId: Snowflake;
  muted: boolean;
  deafened: boolean;
  video: VideoSource | null;
  joinedAt: number;
  /**
   * Silenciado por un moderador, no por uno mismo.
   * Va aparte de `muted` porque si fuera la misma bandera el propio cliente la
   * quitaría con el botón de siempre, y un silencio que el silenciado puede
   * deshacer no es moderación.
   */
  forceMuted: boolean;
  forceDeafened: boolean;
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
    force_muted: p.forceMuted,
    force_deafened: p.forceDeafened,
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
    forceMuted: false,
    forceDeafened: false,
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
  // Y lo que impuso un moderador no se quita desde aquí.
  if (participant.forceMuted) participant.muted = true;
  if (participant.forceDeafened) {
    participant.deafened = true;
    participant.muted = true;
  }
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

/**
 * Moderación dentro de una sala (§11, §23).
 *
 * El permiso se comprueba en el canal donde ocurre, no en la comunidad: un rol
 * puede moderar la sala de reuniones y no la de charla. `canActOn` impide además
 * lo que ningún permiso arregla —silenciar a alguien por encima de ti, o al
 * dueño—, que es como un moderador se convertiría en administrador.
 *
 * Devuelve false cuando no cambia nada, para no anunciar estados iguales.
 */
export function moderate(
  channelId: Snowflake,
  actorId: Snowflake,
  targetId: Snowflake,
  action: VoiceAction,
): boolean {
  const participant = rooms.get(channelId)?.get(targetId);
  if (!participant) return false;
  if (actorId === targetId) return false;

  const permissions = channelPermissions(channelId, actorId);
  const needed =
    action === "mute" || action === "unmute"
      ? PERMISSIONS.MUTE_MEMBERS
      : action === "deafen" || action === "undeafen"
        ? PERMISSIONS.DEAFEN_MEMBERS
        : PERMISSIONS.MOVE_MEMBERS;
  if (!has(permissions, needed)) return false;
  if (!canActOn(participant.communityId, actorId, targetId)) return false;

  switch (action) {
    case "mute":
      if (participant.forceMuted) return false;
      participant.forceMuted = true;
      participant.muted = true;
      return true;

    case "unmute":
      if (!participant.forceMuted) return false;
      participant.forceMuted = false;
      // No se le devuelve la voz a la fuerza: queda como si se hubiera callado
      // solo, y decide con su propio botón. Salvo que siga sin permiso de hablar.
      participant.muted = !has(channelPermissions(channelId, targetId), PERMISSIONS.SPEAK);
      return true;

    case "deafen":
      if (participant.forceDeafened) return false;
      participant.forceDeafened = true;
      participant.deafened = true;
      participant.muted = true;
      return true;

    case "undeafen":
      if (!participant.forceDeafened) return false;
      participant.forceDeafened = false;
      participant.deafened = false;
      participant.muted = participant.forceMuted || !has(channelPermissions(channelId, targetId), PERMISSIONS.SPEAK);
      return true;

    // Sacar de la llamada, no de la comunidad: puede volver a entrar. Es la
    // herramienta para cortar un micro abierto, no un castigo.
    case "disconnect":
      return leave(channelId, targetId);
  }
}
