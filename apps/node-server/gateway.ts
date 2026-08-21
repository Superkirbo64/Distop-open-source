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
import type { ClientCommand, ServerEvent, Snowflake, VoiceAction, VoiceSoundRejectReason } from "@distop/protocol";
import { authenticate, findUserById } from "./auth.ts";
import { communitiesForUser, getChannel } from "./entities.ts";
import { channelPermissions, memberState } from "./permissions.ts";
import { instanceHealth } from "./instance.ts";
import { rateLimit } from "./http.ts";
import * as voice from "./voice.ts";
import * as race from "./race.ts";
import { getEmoji } from "./expressions.ts";

interface Client {
  ws: WebSocket;
  userId: Snowflake;
  sessionId: string;
  subs: Set<Snowflake>;
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

export function onlineCount(): number {
  return new Set([...clients].map((c) => c.userId)).size;
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
    if (!client.subs.has(communityId)) continue;
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

function broadcastPresence(communityId: Snowflake): void {
  publish(communityId, { t: "PRESENCE_UPDATE", d: { community_id: communityId, online: onlineIn(communityId) } });
}

function handleCommand(client: Client, raw: string): void {
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
      const result = voice.join(channelId, client.userId);
      if (!result) return;
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
      if (voice.leave(channelId, client.userId)) announceVoice(channelId);
      if (race.leave(channelId, client.userId)) announceRace(channelId);
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
      if (voice.setVideo(channelId, client.userId, source)) announceVoice(channelId);
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
         dejar el dedo apoyado para que nadie más pueda usar la sala. */
      try {
        rateLimit(`vsound:${client.userId}`, 5, 10_000);
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

export function announceVoice(channelId: Snowflake): void {
  const states = voice.statesOf(channelId);
  const communityId = states[0]?.community_id ?? getChannel(channelId)?.community_id;
  if (!communityId) return;
  publish(communityId, { t: "VOICE_STATE_UPDATE", d: { channel_id: channelId, community_id: communityId, states } });
}

/**
 * El token viaja en la query porque el navegador no deja poner cabeceras en el
 * handshake WebSocket. Es de vida corta y revocable, y sobre wss no sale del túnel TLS.
 */
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
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
        for (const channelId of voice.leaveAll(client.userId)) announceVoice(channelId);
        for (const channelId of race.leaveAll(client.userId)) announceRace(channelId);
      }
      for (const communityId of client.subs) broadcastPresence(communityId);
    });
  });
}

/* Sin esto un cliente que pierde la red queda "online" hasta el timeout del SO. */
setInterval(() => {
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
