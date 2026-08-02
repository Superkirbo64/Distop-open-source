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
import type { ClientCommand, ServerEvent, Snowflake } from "@distop/protocol";
import { authenticate } from "./auth.ts";
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
}

const clients = new Set<Client>();
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

export function onlineCount(): number {
  return new Set([...clients].map((c) => c.userId)).size;
}

export function onlineIn(communityId: Snowflake): Snowflake[] {
  const ids = new Set<Snowflake>();
  for (const client of clients) if (client.subs.has(communityId)) ids.add(client.userId);
  return [...ids];
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
    const client: Client = { ws, userId: auth.user.id, sessionId: auth.sessionId, subs: new Set(), alive: true };
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

    ws.on("message", (data) => handleCommand(client, String(data)));
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
