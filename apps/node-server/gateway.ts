/**
 * Gateway en tiempo real (§18).
 * Un socket por sesión; el cliente se suscribe a las comunidades que mira.
 * La visibilidad se recalcula por socket: un canal privado no se emite a quien
 * no tiene VIEW_CHANNEL, aunque esté suscrito a la comunidad.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { PERMISSIONS, has } from "@distop/protocol";
import type { ClientCommand, RecordingState, ServerEvent, Snowflake, VideoSource, VoiceAction, VoiceSoundRejectReason } from "@distop/protocol";
import { authenticate, findUserById } from "./auth.ts";
import { communitiesForUser, getChannel } from "./entities.ts";
import { channelPermissions, memberState } from "./permissions.ts";
import { instanceHealth } from "./instance.ts";
import { rateLimit } from "./http.ts";
import * as voice from "./voice.ts";
import * as meetings from "./meetings.ts";
import * as presupuesto from "./video-budget.ts";
import { videoMode } from "./ice.ts";
import * as race from "./race.ts";
import { getEmoji } from "./expressions.ts";
import { freezeReason, writesAccepted } from "./lifecycle.ts";

interface Client {
  ws: WebSocket;
  userId: Snowflake;
  sessionId: string;
  subs: Set<Snowflake>;
  /**
   * Canal de la reunión a la que está invitada esta sesión, o null.
   *
   * Un invitado no es miembro, así que `SUBSCRIBE` lo rechaza —y debe
   * rechazarlo—. Sin esto no recibiría nada, ni siquiera de la reunión a la que
   * le invitaron. Este campo es su única puerta de entrada a eventos, y solo
   * para ese canal.
   */
  guestChannel: Snowflake | null;
  /** Cubos de un segundo por tipo de comando. Ver `dentroDeLimite`. */
  cmdRate: Record<string, { n: number; since: number }>;
  alive: boolean;
  /** Cuota de paquetes multimedia del segundo en curso. */
  media: { frames: number; bytes: number; since: number };
}

interface VideoClient {
  ws: WebSocket;
  userId: Snowflake;
  sessionId: string;
  alive: boolean;
  media: { frames: number; bytes: number; since: number };
}

/** Lo que el cliente puede pedir sobre otra persona en una sala. */
const VOICE_ACTIONS: readonly VoiceAction[] = ["mute", "unmute", "deafen", "undeafen", "disconnect"];

const clients = new Set<Client>();
/** Sockets de vídeo separados para que sus keyframes no bloqueen voz ni mandos. */
const videoClients = new Set<VideoClient>();
/* 64 KB bastaban para mandos y audio, pero un fotograma clave de pantalla
   compartida los pasa de largo. El límite de verdad lo pone LIMITS por tipo de
   paquete; esto es solo la red de seguridad del protocolo. */
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
let gatewayClosing = false;

export function onlineCount(): number {
  return new Set([...clients].map((c) => c.userId)).size;
}

/**
 * ¿Tiene esta persona la aplicación abierta ahora mismo?
 *
 * Distinto de `onlineIn`: aquí no se filtra por "invisible". Quien eligió no
 * aparecer en la lista sigue teniendo Distop delante, y mandarle una
 * notificación al móvil por algo que acaba de ver en pantalla es justo el ruido
 * que hace que la gente apague los avisos.
 */
export function hasOpenSocket(userId: Snowflake): boolean {
  for (const client of clients) if (client.userId === userId) return true;
  return false;
}

/**
 * Quién figura conectado en una comunidad.
 *
 * Tener el socket abierto no basta: quien eligió `invisible` queda fuera de la
 * lista aunque esté dentro leyendo. Se mira la base y no lo que dijo el cliente
 * al conectarse, porque el estado se puede cambiar desde otro dispositivo
 * mientras esta sesión sigue abierta.
 */
export function onlineIn(communityId: Snowflake): Snowflake[] {
  const ids = new Set<Snowflake>();
  for (const client of clients) if (client.subs.has(communityId)) ids.add(client.userId);
  return [...ids].filter((id) => findUserById(id)?.status !== "invisible");
}

function send(client: Client, event: ServerEvent): void {
  if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(event));
}

/** Rechazo dirigido solo al socket que pulsó el botón, no a todas sus sesiones. */
function rejectVoiceSound(
  client: Client,
  channelId: Snowflake,
  soundId: Snowflake,
  reason: VoiceSoundRejectReason,
): void {
  send(client, { t: "VOICE_SOUND_ERROR", d: { channel_id: channelId, sound_id: soundId, reason } });
}

/** Emite a todos los sockets suscritos a la comunidad. */
export function publish(communityId: Snowflake, event: ServerEvent): void {
  for (const client of clients) if (client.subs.has(communityId)) send(client, event);
}

/** Emite solo a quien puede ver ese canal. */
export function publishToChannel(communityId: Snowflake, channelId: Snowflake, event: ServerEvent): void {
  for (const client of clients) {
    /* Miembro suscrito a la comunidad, o invitado de ESE canal. En los dos
       casos se comprueba VIEW_CHANNEL después: la suscripción dice a qué
       escuchas, el permiso dice qué puedes oír. */
    const alcance = client.subs.has(communityId) || client.guestChannel === channelId;
    if (!alcance) continue;
    if (!has(channelPermissions(channelId, client.userId), PERMISSIONS.VIEW_CHANNEL)) continue;
    send(client, event);
  }
}

/** Emite a todas las sesiones de una persona, esté donde esté. */
export function publishToUser(userId: Snowflake, event: ServerEvent): void {
  for (const client of clients) if (client.userId === userId) send(client, event);
}

export function disconnectSession(sessionId: string): void {
  for (const client of clients) if (client.sessionId === sessionId) client.ws.close(4001, "sesión revocada");
  for (const client of videoClients) if (client.sessionId === sessionId) client.ws.close(4001, "sesión revocada");
}

/**
 * Cierra TODOS los sockets de una persona. Revocar sesiones solo borra filas:
 * un socket ya abierto seguiría recibiendo eventos con una sesión que no
 * existe, y "cerrar sesión en todos los dispositivos" quedaría en mentira.
 * Cada cliente reintenta con su token guardado: el que lo tenga nuevo vuelve
 * a entrar; el revocado se queda en la pantalla de acceso, que es el punto.
 */
export function disconnectUser(userId: Snowflake): void {
  for (const client of clients) if (client.userId === userId) client.ws.close(4001, "sesión revocada");
  for (const client of videoClients) if (client.userId === userId) client.ws.close(4001, "sesión revocada");
}

function broadcastPresence(communityId: Snowflake): void {
  publish(communityId, { t: "PRESENCE_UPDATE", d: { community_id: communityId, online: onlineIn(communityId) } });
}

function handleCommand(client: Client, raw: string): void {
  if (!writesAccepted()) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") return;
  const cmd = parsed as ClientCommand;

  switch (cmd.t) {
    case "SUBSCRIBE": {
      const communityId = cmd.d?.community_id;
      if (typeof communityId !== "string") return;
      if (!memberState(communityId, client.userId).isMember) return;
      client.subs.add(communityId);
      broadcastPresence(communityId);
      return;
    }
    case "UNSUBSCRIBE": {
      const communityId = cmd.d?.community_id;
      if (typeof communityId !== "string" || !client.subs.delete(communityId)) return;
      broadcastPresence(communityId);
      return;
    }
    case "TYPING": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      try {
        rateLimit(`typing:${client.userId}`, 10, 10_000);
      } catch {
        return;
      }
      if (!has(channelPermissions(channelId, client.userId), PERMISSIONS.SEND_MESSAGES)) return;
      const channel = getChannel(channelId);
      if (!channel) return;
      publishToChannel(channel.community_id, channelId, {
        t: "TYPING_START",
        d: { channel_id: channelId, user_id: client.userId, until: Date.now() + 6000 },
      });
      return;
    }
    case "VOICE_JOIN": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;

      /* Una reunión con sala de espera no se entra: se llama a la puerta. Y
         mientras se espera NO se entra en el registro de voz, así que
         `relayMedia` descarta cualquier paquete por construcción — ni audio ni
         vídeo escapan antes de la admisión, sin una comprobación aparte que
         alguien pueda olvidarse de poner. */
      if (meetings.meetingOf(channelId)) {
        const salida = meetings.joinMeeting(channelId, client.userId);
        if (salida === "waiting") {
          const enEspera = meetings.meetingOf(channelId)!;
          send(client, { t: "VOICE_JOIN_RESULT", d: { channel_id: channelId, outcome: "waiting" } });
          send(client, {
            t: "MEETING_WAITING",
            d: { meeting_id: enEspera.id, channel_id: channelId, admitted: false },
          });
          /* Si ya se está grabando, se dice AHORA, desde la puerta: enterarse
             después de haber entrado y hablado no es consentir nada. */
          send(client, {
            t: "RECORDING_UPDATE",
            d: { channel_id: channelId, recording: meetings.liveRecording(enEspera.id) },
          });
          announceLobby(channelId);
          return;
        }
        if (salida !== "joined") {
          send(client, { t: "VOICE_JOIN_RESULT", d: { channel_id: channelId, outcome: salida } });
          return;
        }
        send(client, { t: "VOICE_JOIN_RESULT", d: { channel_id: channelId, outcome: "joined" } });
        announceVoice(channelId);
        announceMeeting(channelId);
        return;
      }

      const result = voice.join(channelId, client.userId);
      if (!result) {
        send(client, { t: "VOICE_JOIN_RESULT", d: { channel_id: channelId, outcome: "denied" } });
        return;
      }
      send(client, { t: "VOICE_JOIN_RESULT", d: { channel_id: channelId, outcome: "joined" } });
      if (result.left) {
        announceVoice(result.left);
        // Cambiar de sala es irse de la carrera de la anterior.
        if (race.leave(result.left, client.userId)) announceRace(result.left);
      }
      announceVoice(channelId);
      // Quien acaba de entrar necesita saber si aquí hay una carrera esperando.
      if (race.lobbyOf(channelId)) announceRace(channelId);
      return;
    }

    case "VOICE_LEAVE": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      const salido = voice.leave(channelId, client.userId);
      /* El turno de palabra se suelta al salir: si no, quien se va con la tecla
         pulsada deja a la sala muda hasta que salte el tiempo máximo. */
      for (const suelto of meetings.dropFloorOf(client.userId)) announceFloor(suelto);
      if (salido) announceVoice(channelId);
      if (race.leave(channelId, client.userId)) announceRace(channelId);
      if (meetings.meetingOf(channelId)) {
        const terminada = meetings.leaveMeeting(channelId, client.userId);
        announceLobby(channelId);
        if (terminada) publish(terminada.community_id, { t: "MEETING_UPDATE", d: terminada });
        else announceMeeting(channelId);
      }
      return;
    }

    /* ── reuniones (V1) ────────────────────────────────────────────────
       El permiso se revalida aquí en cada comando. Que el cliente haya
       enseñado el botón no autoriza nada: la interfaz es una sugerencia. */

    case "MEETING_ADMIT": {
      const { channel_id: channelId, user_id: target } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof target !== "string") return;
      if (!meetings.admit(channelId, client.userId, target)) return;
      publishToUser(target, {
        t: "MEETING_WAITING",
        d: { meeting_id: meetings.meetingOf(channelId)!.id, channel_id: channelId, admitted: true },
      });
      announceVoice(channelId);
      announceLobby(channelId);
      return;
    }

    case "MEETING_ADMIT_ALL": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      const esperando = meetings.waitingOf(channelId).map((quien) => quien.user_id);
      if (meetings.admitAll(channelId, client.userId) === 0) return;
      const reunion = meetings.meetingOf(channelId)!;
      for (const userId of esperando) {
        publishToUser(userId, {
          t: "MEETING_WAITING",
          d: { meeting_id: reunion.id, channel_id: channelId, admitted: true },
        });
      }
      announceVoice(channelId);
      announceLobby(channelId);
      return;
    }

    case "MEETING_DENY": {
      const { channel_id: channelId, user_id: target } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof target !== "string") return;
      const reunion = meetings.meetingOf(channelId);
      if (!reunion || !meetings.deny(channelId, client.userId, target)) return;
      /* Se le dice que no está admitido, sin explicar quién lo decidió: la
         alternativa es una lista de a quién culpar dentro de la comunidad. */
      publishToUser(target, {
        t: "MEETING_WAITING",
        d: { meeting_id: reunion.id, channel_id: channelId, admitted: false },
      });
      announceLobby(channelId);
      return;
    }

    /* Grabación LOCAL (V3). Por aquí no viaja un solo byte de vídeo: el
       fichero está en el ordenador de quien graba. Lo único que hace el
       servidor es lo que un cliente no puede hacer solo — que la sala entera
       se entere, y que quede escrito. */
    case "MEETING_RECORD": {
      const { channel_id: channelId, state } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof state !== "string") return;
      const reunion = meetings.meetingOf(channelId);
      if (!reunion) return;

      if (state === "CONSENTING") {
        /* Empezar es pedirlo: el aviso sale a la sala ANTES de que se grabe el
           primer fotograma. Avisar después no es avisar. */
        if (!meetings.requestRecording(channelId, client.userId)) return;
        announceRecording(channelId);
        return;
      }

      const viva = meetings.liveRecording(reunion.id);
      if (!viva) return;
      if (!meetings.advanceRecording(viva.id, state as RecordingState, client.userId)) return;
      announceRecording(channelId);
      return;
    }

    case "MEETING_FLOOR": {
      const { channel_id: channelId, hold } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof hold !== "boolean") return;
      /* Un límite alto: pulsar para hablar produce muchos mensajes cortos y
         legítimos. Lo que corta es el abuso, no el uso. */
      if (!dentroDeLimite(client, "floor", 120)) return;
      const cambio = hold
        ? meetings.takeFloor(channelId, client.userId)
        : meetings.releaseFloor(channelId, client.userId);
      if (cambio) announceFloor(channelId);
      return;
    }

    case "MEETING_HAND": {
      const { channel_id: channelId, raised } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof raised !== "boolean") return;
      /* Solo desde dentro: la mano se levanta en la sala, no desde la puerta. */
      if (voice.setHand(channelId, client.userId, raised)) announceVoice(channelId);
      return;
    }

    case "VOICE_MUTE": {
      const { channel_id: channelId, muted, deafened } = cmd.d ?? {};
      if (typeof channelId !== "string") return;
      if (voice.setMute(channelId, client.userId, Boolean(muted), Boolean(deafened))) announceVoice(channelId);
      return;
    }

    case "VOICE_VIDEO": {
      const { channel_id: channelId, source } = cmd.d ?? {};
      if (typeof channelId !== "string") return;
      if (source !== null && source !== "camera" && source !== "screen") return;

      /* Apagar la cámara nunca se rechaza: dejar de ocupar sitio no necesita
         permiso de nadie, y negarlo sería absurdo. */
      if (source === null) {
        if (voice.setVideo(channelId, client.userId, null)) {
          announceVoice(channelId);
          announceBudget(channelId);
        }
        return;
      }

      /* Encenderla sí pasa por el presupuesto (V3). El permiso se comprueba
         primero —dentro de setVideo— y el ancho de banda después: sin permiso
         no hay presupuesto que discutir. */
      if (!voice.setVideo(channelId, client.userId, source)) return;

      const veredicto = presupuestoCon(channelId, client.userId, source);
      if (!veredicto.admitido) {
        /* No cabe: se deshace. La fuente nunca llega a estar puesta, así que
           `relayMedia` la descarta por construcción — igual que la sala de
           espera, sin una condición que alguien pueda olvidarse de escribir. */
        voice.setVideo(channelId, client.userId, null);
        announceBudget(channelId);
        return;
      }
      /* Cabe, pero a costa de alguien menos prioritario. Ninguna reserva rompe
         el techo físico: el desplazado pierde la fuente de verdad. */
      for (const desplazado of veredicto.desplazados) voice.setVideo(channelId, desplazado, null);

      announceVoice(channelId);
      announceBudget(channelId);
      return;
    }

    case "VOICE_MODERATE": {
      const { channel_id: channelId, user_id: target, action } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof target !== "string") return;
      if (!VOICE_ACTIONS.includes(action)) return;
      if (voice.moderate(channelId, client.userId, target, action)) {
        announceVoice(channelId);
        // Si lo echaron de la sala, tampoco sigue en la carrera.
        if (action === "disconnect" && race.leave(channelId, target)) announceRace(channelId);
      }
      return;
    }

    /* Tabla de sonidos de la sala de voz (§9.4).
       Solo viaja el id: cada cliente pide el archivo a la instancia y lo suena
       por su cuenta. Meterlo por el micrófono habría sido menos código, pero el
       supresor de ruido y la cancelación de eco están afinados para una voz y
       convierten un sonido en un chirrido — y encima quien lo dispara se oye a
       sí mismo con retardo. */
    case "VOICE_SOUND": {
      const { channel_id: channelId, sound_id: soundId } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof soundId !== "string") return;

      const sender = voice.participantOf(channelId, client.userId);
      if (!sender) {
        rejectVoiceSound(client, channelId, soundId, "not_in_voice");
        return;
      }
      // Silenciado no es solo "no te oigo hablar": tampoco puedes hacer ruido.
      if (sender.muted) {
        rejectVoiceSound(client, channelId, soundId, "muted");
        return;
      }

      // El id lo escribe el cliente: tiene que ser un sonido, y de ESTA comunidad.
      // Se valida antes de gastar cuota: los ids rotos no deben bloquear botones válidos.
      const sound = getEmoji(soundId);
      if (!sound || sound.kind !== "sound" || sound.community_id !== sender.communityId) {
        rejectVoiceSound(client, channelId, soundId, "not_available");
        return;
      }

      /* Un botón que suena es un botón para machacar. Sin este límite basta con
         dejar el dedo apoyado para que nadie más pueda usar la sala. El techo es
         alto adrede: la tabla de sonidos existe para jugar, y cortar a la quinta
         pulsación castigaba el uso normal, no el abuso. */
      try {
        rateLimit(`vsound:${client.userId}`, 50, 10_000);
      } catch {
        rejectVoiceSound(client, channelId, soundId, "rate_limited");
        return;
      }

      const evento: ServerEvent = {
        t: "VOICE_SOUND",
        d: { channel_id: channelId, user_id: client.userId, sound_id: soundId },
      };
      // También a quien lo dispara: así todos lo oyen en el mismo momento y no
      // hay una versión local que suene antes que la de los demás.
      for (const listener of voice.peersOf(channelId)) {
        if (voice.participantOf(channelId, listener)?.deafened) continue;
        publishToUser(listener, evento);
      }
      return;
    }

    /* Carrera de canicas (§9.4). Igual que la tabla de sonidos: por aquí no
       viaja el juego, viaja el dato mínimo para que cada cliente calcule lo
       mismo. La semilla la pone la instancia. */
    case "RACE_OPEN": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      if (race.open(channelId, client.userId)) announceRace(channelId);
      return;
    }

    case "RACE_LEAVE": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      if (race.leave(channelId, client.userId)) announceRace(channelId);
      return;
    }

    case "RACE_WORLD": {
      const { channel_id: channelId, world } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof world !== "number") return;
      if (race.setWorld(channelId, client.userId, world)) announceRace(channelId);
      return;
    }

    case "RACE_START": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      // Un botón de salida es un botón para machacar, y cada pulsación reinicia
      // la carrera de todos los que la están mirando.
      try {
        rateLimit(`race:${client.userId}`, 6, 10_000);
      } catch {
        return;
      }
      if (race.start(channelId, client.userId)) announceRace(channelId);
      return;
    }

    case "VOICE_SIGNAL": {
      const { channel_id: channelId, to_user_id: to, payload } = cmd.d ?? {};
      if (typeof channelId !== "string" || typeof to !== "string") return;
      // Reenvío ciego pero no libre: solo entre dos que ya comparten sala.
      if (!voice.canSignal(channelId, client.userId, to)) return;
      publishToUser(to, {
        t: "VOICE_SIGNAL",
        d: { channel_id: channelId, from_user_id: client.userId, to_user_id: to, payload },
      });
      return;
    }

    case "PING":
      send(client, { t: "PONG", d: { at: Date.now() } });
      return;
  }
}

/* ── multimedia por la instancia (§9.4, §9.5) ───────────────────────────
   La voz siempre pasa por aquí. El vídeo también puede hacerlo si quien hospeda
   eligió el modo compatible; en modo directo usa WebRTC. Los clientes actuales
   abren un TCP separado para la imagen, evitando que un keyframe bloquee voz y
   mandos. La ruta antigua se conserva para actualizaciones sin corte. */

/* Del cliente llega [1 byte de tipo][datos]; a los demás sale
   [1 byte de tipo][16 bytes de quién][datos]. El id va en binario y no en texto
   porque son decenas de paquetes por segundo. */
const KIND_AUDIO = 0;
const KIND_VIDEO_KEY = 1;
const KIND_VIDEO_DELTA = 2;
const KIND_VIDEO_KEY_TIMED = 3;
const KIND_VIDEO_DELTA_TIMED = 4;

interface Limit {
  /** Tamaño máximo de un paquete. */
  bytes: number;
  /** Paquetes por segundo tolerados antes de tirarlos. */
  rate: number;
  /** Cola del socket de destino a partir de la cual se descarta. */
  buffered: number;
}

/* El vídeo aguanta mucho menos cola que el audio a propósito. Sobre TCP, dejar
   que se acumule no lo hace llegar: lo hace llegar TARDE, y cada vez más tarde.
   Tirar fotogramas es lo que mantiene la imagen pegada al presente. */
const LIMITS: Record<number, Limit> = {
  [KIND_AUDIO]: { bytes: 4096, rate: 150, buffered: 262_144 },
  [KIND_VIDEO_KEY]: { bytes: 1_572_864, rate: 90, buffered: 2_097_152 },
  [KIND_VIDEO_DELTA]: { bytes: 524_288, rate: 200, buffered: 1_048_576 },
  [KIND_VIDEO_KEY_TIMED]: { bytes: 1_572_872, rate: 130, buffered: 2_097_152 },
  [KIND_VIDEO_DELTA_TIMED]: { bytes: 524_296, rate: 240, buffered: 1_048_576 },
};
/** Permite el perfil máximo con ráfagas de keyframe, pero no un emisor malicioso ilimitado. */
const MAX_MEDIA_BYTES_PER_SECOND = 8 * 1024 * 1024;

function writeSender(userId: Snowflake, into: Buffer): void {
  into.write(userId.replaceAll("-", ""), 1, 16, "hex");
}

function relayMedia(client: Client | VideoClient, packet: Buffer): void {
  if (packet.length < 2) return;
  const kind = packet[0]!;
  const limit = LIMITS[kind];
  if (!limit || packet.length - 1 > limit.bytes) return;

  const now = Date.now();
  if (now - client.media.since >= 1000) client.media = { frames: 0, bytes: 0, since: now };
  if (++client.media.frames > limit.rate) return;
  client.media.bytes += packet.length;
  if (client.media.bytes > MAX_MEDIA_BYTES_PER_SECOND) return;

  const channelId = voice.channelOf(client.userId);
  if (!channelId) return;
  const sender = voice.participantOf(channelId, client.userId);
  if (!sender) return;
  // Silenciado o sin vídeo anunciado, el servidor no lo reenvía. No basta con que
  // el cliente deje de mandarlo: el cliente lo escribe cualquiera.
  if (kind === KIND_AUDIO ? sender.muted : !sender.video) return;
  /* Modo turno de palabra (V4): solo suena quien lo tiene. Se comprueba aquí,
     donde pasa el audio, y no donde se pide el turno: si estuviera solo allí,
     un cliente que no pidiera nada seguiría sonando. */
  if (kind === KIND_AUDIO && !meetings.maySpeakNow(channelId, client.userId)) return;

  const out = Buffer.allocUnsafe(17 + packet.length - 1);
  out[0] = kind;
  writeSender(client.userId, out);
  packet.copy(out, 17, 1);

  for (const listenerId of voice.peersOf(channelId)) {
    if (listenerId === client.userId) continue;
    const listener = voice.participantOf(channelId, listenerId);
    if (!listener) continue;
    // Quien está ensordecido no recibe audio: no lo iba a oír y ocupa subida.
    if (kind === KIND_AUDIO && listener.deafened) continue;
    const dedicated = kind === KIND_AUDIO
      ? []
      : [...videoClients].filter((other) => other.userId === listenerId && other.ws.readyState === other.ws.OPEN);
    const targets = dedicated.length > 0
      ? dedicated
      : [...clients].filter((other) => other.userId === listenerId && other.ws.readyState === other.ws.OPEN);
    for (const other of targets) {
      if (other.ws.bufferedAmount > limit.buffered) continue;
      other.ws.send(out, { binary: true });
    }
  }
}

/** El estado de una sala de voz se emite entero: es pequeño y evita desincronías. */
/** La sala de la carrera, a quien pueda ver el canal. */
export function announceRace(channelId: Snowflake): void {
  const communityId = getChannel(channelId)?.community_id;
  if (!communityId) return;
  publishToChannel(communityId, channelId, {
    t: "RACE_UPDATE",
    d: { channel_id: channelId, lobby: race.lobbyOf(channelId) },
  });
}

/**
 * La sala de espera va SOLO a quien puede admitir.
 *
 * Publicarla a la reunión entera convertiría "esperar" en "que te miren
 * esperar", y además diría a todo el mundo quién intentó entrar y no pudo.
 */
export function announceLobby(channelId: Snowflake): void {
  const reunion = meetings.meetingOf(channelId);
  if (!reunion) return;
  const waiting = meetings.waitingOf(channelId);
  for (const client of clients) {
    if (!client.subs.has(reunion.community_id)) continue;
    if (!meetings.canModerate(reunion, client.userId)) continue;
    send(client, { t: "MEETING_LOBBY", d: { meeting_id: reunion.id, channel_id: channelId, waiting } });
  }
}

/** La reunión entera, a su comunidad. */
export function announceMeeting(channelId: Snowflake): void {
  const reunion = meetings.meetingOf(channelId);
  if (reunion) publish(reunion.community_id, { t: "MEETING_UPDATE", d: reunion });
}

/**
 * Convierte la sala en la entrada que entiende el presupuesto.
 *
 * El papel de cada persona lo resuelve el servidor a partir de la reunión, y
 * "está hablando" sale de si tiene el micrófono abierto. Ninguna de las dos
 * cosas la declara el cliente: si lo hiciera, la prioridad sería una palabra
 * que cualquiera escribe en un JSON.
 */
function entradaDePresupuesto(channelId: Snowflake): presupuesto.Entrada {
  const reunion = meetings.meetingOf(channelId);
  const estados = voice.statesOf(channelId);
  const emisores: presupuesto.Emisor[] = estados
    .filter((estado) => estado.video !== null)
    .map((estado) => ({
      userId: estado.user_id,
      source: estado.video!,
      role: reunion ? meetings.roleOf(reunion.id, estado.user_id) : null,
      speaking: !estado.muted && !estado.force_muted,
      since: estado.joined_at,
    }));

  return {
    emisores,
    participantes: estados.length,
    modo: videoMode().mode === "direct" ? "direct" : "host",
    /* Apretada por otra cosa: la voz se protege antes que la imagen. Una voz
       entrecortada es un fallo visible; una cámara menos, una molestia. */
    presion: freezeReason() !== null,
  };
}

/** El veredicto para una fuente que alguien acaba de encender. */
function presupuestoCon(channelId: Snowflake, userId: Snowflake, source: VideoSource): presupuesto.Veredicto {
  const entrada = entradaDePresupuesto(channelId);
  const candidato = entrada.emisores.find((e) => e.userId === userId) ?? {
    userId,
    source,
    role: null,
    speaking: false,
    since: Date.now(),
  };
  return presupuesto.admitir(
    { ...entrada, emisores: entrada.emisores.filter((e) => e.userId !== userId) },
    { ...candidato, source },
  );
}

/** Cuántas fuentes caben y quién espera turno, a toda la sala. */
export function announceBudget(channelId: Snowflake): void {
  const reparto = presupuesto.repartir(entradaDePresupuesto(channelId));
  const communityId = getChannel(channelId)?.community_id;
  if (!communityId) return;
  const evento: ServerEvent = {
    t: "VIDEO_BUDGET",
    d: {
      channel_id: channelId,
      mode: reparto.modo,
      slots: reparto.cabidas,
      cost_kbps: reparto.coste_kbps,
      ceiling_kbps: reparto.techo_kbps,
      queued: reparto.cola.map((e) => e.userId),
    },
  };
  for (const client of clients) {
    if (client.subs.has(communityId) || client.guestChannel === channelId) send(client, evento);
  }
}

/**
 * Quién graba, a la sala entera y sin excepciones.
 *
 * Una grabación que no se anuncia no es una grabación, es otra cosa. Y va con
 * el nombre de quien graba: un aviso anónimo no deja a nadie decidir si se
 * queda.
 */
export function announceRecording(channelId: Snowflake): void {
  const reunion = meetings.meetingOf(channelId);
  if (!reunion) return;
  const evento: ServerEvent = {
    t: "RECORDING_UPDATE",
    d: { channel_id: channelId, recording: meetings.liveRecording(reunion.id) },
  };
  for (const client of clients) {
    if (client.subs.has(reunion.community_id) || client.guestChannel === channelId) send(client, evento);
  }
}

/** Quién tiene el turno de palabra, a la sala. */
export function announceFloor(channelId: Snowflake): void {
  const reunion = meetings.meetingOf(channelId);
  if (!reunion) return;
  const evento: ServerEvent = {
    t: "MEETING_FLOOR",
    d: { channel_id: channelId, user_id: meetings.floorOf(channelId) },
  };
  for (const client of clients) {
    if (client.subs.has(reunion.community_id) || client.guestChannel === channelId) send(client, evento);
  }
}

/**
 * Límite por socket y por tipo de comando, en una ventana de un segundo.
 *
 * `rateLimit` va por IP y por hora, que es la escala equivocada aquí: pulsar
 * para hablar produce decenas de mensajes por minuto de forma completamente
 * legítima, y una casa entera comparte IP.
 */
function dentroDeLimite(client: Client, clave: string, porSegundo: number): boolean {
  const ahora = Date.now();
  const cubo = client.cmdRate[clave];
  if (!cubo || ahora - cubo.since >= 1000) {
    client.cmdRate[clave] = { n: 1, since: ahora };
    return true;
  }
  cubo.n += 1;
  return cubo.n <= porSegundo;
}

export function announceVoice(channelId: Snowflake): void {
  const states = voice.statesOf(channelId);
  const communityId = states[0]?.community_id ?? getChannel(channelId)?.community_id;
  if (!communityId) return;
  const evento: ServerEvent = {
    t: "VOICE_STATE_UPDATE",
    d: { channel_id: channelId, community_id: communityId, states },
  };
  /* A la comunidad —la barra lateral enseña quién está en cada sala— y además a
     los invitados de ESTE canal, que no están suscritos a nada porque no son
     miembros y aun así tienen que ver con quién están hablando. */
  for (const client of clients) {
    if (client.subs.has(communityId) || client.guestChannel === channelId) send(client, evento);
  }
}

/**
 * El token viaja en la query porque el navegador no deja poner cabeceras en el
 * handshake WebSocket. Es de vida corta y revocable, y sobre wss no sale del túnel TLS.
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (gatewayClosing) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const auth = authenticate(url.searchParams.get("token"));

  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  if (url.searchParams.get("media") === "video") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: VideoClient = {
        ws,
        userId: auth.user.id,
        sessionId: auth.sessionId,
        alive: true,
        media: { frames: 0, bytes: 0, since: 0 },
      };
      videoClients.add(client);
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const packet = data as Buffer;
        if (packet[0] === KIND_AUDIO) return;
        relayMedia(client, packet);
      });
      ws.on("pong", () => { client.alive = true; });
      ws.on("error", () => ws.close());
      ws.on("close", () => videoClients.delete(client));
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    const client: Client = {
      ws,
      userId: auth.user.id,
      sessionId: auth.sessionId,
      subs: new Set(),
      /* Solo si la sesión viene acotada a una reunión. Se resuelve una vez, al
         conectar: preguntarlo en cada evento sería una consulta por mensaje. */
      guestChannel: auth.meetingId ? meetings.guestChannelOf(auth.user.id) : null,
      cmdRate: {},
      alive: true,
      media: { frames: 0, bytes: 0, since: 0 },
    };
    clients.add(client);

    send(client, {
      t: "READY",
      d: {
        user: auth.user,
        communities: communitiesForUser(auth.user.id),
        instance: instanceHealth(onlineCount()),
        session_id: auth.sessionId,
      },
    });

    // Voz binaria y mandos JSON comparten este socket. El vídeo usa otro WebSocket
    // sobre el mismo puerto/túnel: conexión distinta, despliegue igual de simple.
    ws.on("message", (data, isBinary) => {
      if (isBinary) relayMedia(client, data as Buffer);
      else handleCommand(client, String(data));
    });
    ws.on("pong", () => {
      client.alive = true;
    });
    ws.on("error", () => ws.close());
    ws.on("close", () => {
      clients.delete(client);
      // Si era su última pestaña, sale de la llamada; con otra abierta sigue dentro.
      const stillHere = [...clients].some((other) => other.userId === client.userId);
      if (!stillHere) {
        /* Cerrar la pestaña también suelta el turno de palabra. */
        for (const suelto of meetings.dropFloorOf(client.userId)) announceFloor(suelto);
        for (const channelId of voice.leaveAll(client.userId)) announceVoice(channelId);
        for (const channelId of race.leaveAll(client.userId)) announceRace(channelId);
      }
      for (const communityId of client.subs) broadcastPresence(communityId);
    });
  });
}

/* Sin esto un cliente que pierde la red queda "online" hasta el timeout del SO. */
const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
  for (const client of videoClients) {
    if (!client.alive) {
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    client.ws.ping();
  }
}, 30_000).unref();

/** Avisa cierre normal (1001), da tiempo a vaciar buffers y termina rezagados. */
export async function closeGateway(code = 1001, reason = "instancia en mantenimiento"): Promise<void> {
  if (gatewayClosing) return;
  gatewayClosing = true;
  clearInterval(heartbeat);
  const sockets = [
    ...[...clients].map((client) => client.ws),
    ...[...videoClients].map((client) => client.ws),
  ];
  for (const socket of sockets) {
    if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) socket.close(code, reason);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const socket of sockets) {
    if (socket.readyState !== socket.CLOSED) socket.terminate();
  }
}
