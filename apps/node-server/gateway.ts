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
import type { ClientCommand, ServerEvent, Snowflake, VoiceAction } from "@distop/protocol";
import { authenticate, findUserById } from "./auth.ts";
import { communitiesForUser, getChannel } from "./entities.ts";
import { channelPermissions, memberState } from "./permissions.ts";
import { instanceHealth } from "./instance.ts";
import { rateLimit } from "./http.ts";
import * as voice from "./voice.ts";

interface Client {
  ws: WebSocket;
  userId: Snowflake;
  sessionId: string;
  subs: Set<Snowflake>;
  alive: boolean;
  /** Cuota de paquetes de audio del segundo en curso (ver relayAudio). */
  audio: { frames: number; since: number };
}

/** Lo que el cliente puede pedir sobre otra persona en una sala. */
const VOICE_ACTIONS: readonly VoiceAction[] = ["mute", "unmute", "deafen", "undeafen", "disconnect"];

const clients = new Set<Client>();
/* 64 KB bastaban para mandos y audio, pero un fotograma clave de pantalla
   compartida los pasa de largo. El límite de verdad lo pone LIMITS por tipo de
   paquete; esto es solo la red de seguridad del protocolo. */
const wss = new WebSocketServer({ noServer: true, maxPayload: 768 * 1024 });

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
      if (result.left) announceVoice(result.left);
      announceVoice(channelId);
      return;
    }

    case "VOICE_LEAVE": {
      const channelId = cmd.d?.channel_id;
      if (typeof channelId !== "string") return;
      if (voice.leave(channelId, client.userId)) announceVoice(channelId);
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
      if (voice.moderate(channelId, client.userId, target, action)) announceVoice(channelId);
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

/* ── audio por la instancia (§9.4) ──────────────────────────────────────
   La voz NO va entre navegadores: pasa por aquí, como el resto de la
   plataforma. Es lo que convierte esto en un servidor de verdad —el equipo que
   hospeda da vida a la sala y al apagarlo se acaba— y, sobre todo, es lo único
   que funciona siempre: si la persona ya está viendo la aplicación, su conexión
   con la instancia existe, y el audio va por esa misma conexión. Sin agujeros
   que perforar, sin STUN, sin TURN, sin cuenta en ningún servicio.

   Cuesta subida a quien hospeda: cada persona que habla se reenvía a las demás.
   Con Opus a 32 kbit/s, cinco personas hablando a la vez son ~640 kbit/s. El
   vídeo NO pasa por aquí: eso sí tumbaría una conexión doméstica. */

/* Del cliente llega [1 byte de tipo][datos]; a los demás sale
   [1 byte de tipo][16 bytes de quién][datos]. El id va en binario y no en texto
   porque son decenas de paquetes por segundo. */
const KIND_AUDIO = 0;
const KIND_VIDEO_KEY = 1;
const KIND_VIDEO_DELTA = 2;

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
  [KIND_VIDEO_KEY]: { bytes: 512_000, rate: 90, buffered: 1_048_576 },
  [KIND_VIDEO_DELTA]: { bytes: 256_000, rate: 200, buffered: 524_288 },
};

function writeSender(userId: Snowflake, into: Buffer): void {
  into.write(userId.replaceAll("-", ""), 1, 16, "hex");
}

function relayMedia(client: Client, packet: Buffer): void {
  if (packet.length < 2) return;
  const kind = packet[0]!;
  const limit = LIMITS[kind];
  if (!limit || packet.length - 1 > limit.bytes) return;

  const now = Date.now();
  if (now - client.audio.since >= 1000) client.audio = { frames: 0, since: now };
  if (++client.audio.frames > limit.rate) return;

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

  for (const other of clients) {
    if (other.userId === client.userId || other.ws.readyState !== other.ws.OPEN) continue;
    const listener = voice.participantOf(channelId, other.userId);
    if (!listener) continue;
    // Quien está ensordecido no recibe audio: no lo iba a oír y ocupa subida.
    if (kind === KIND_AUDIO && listener.deafened) continue;
    if (other.ws.bufferedAmount > limit.buffered) continue;
    other.ws.send(out, { binary: true });
  }
}

/** El estado de una sala de voz se emite entero: es pequeño y evita desincronías. */
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

  wss.handleUpgrade(req, socket, head, (ws) => {
    const client: Client = {
      ws,
      userId: auth.user.id,
      sessionId: auth.sessionId,
      subs: new Set(),
      alive: true,
      audio: { frames: 0, since: 0 },
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

    // El audio viaja en binario y los mandos en JSON por el mismo socket: así no
    // hay un segundo puerto que abrir ni un segundo túnel que montar.
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
      if (!stillHere) for (const channelId of voice.leaveAll(client.userId)) announceVoice(channelId);
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
}, 30_000).unref();
