/**
 * Conexión en tiempo real con la instancia.
 * Una instancia self-hosted se apaga: reconectar con espera creciente y decir
 * en qué estado está no es un extra, es el comportamiento normal aquí (§26, §28.1).
 */
import type { ClientCommand, ServerEvent } from "@distop/protocol";
import { getTokens } from "./api.ts";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;

let socket: WebSocket | null = null;
let retries = 0;
let reconnectTimer: number | undefined;
let closedOnPurpose = false;

const eventHandlers = new Set<EventHandler>();
const statusHandlers = new Set<StatusHandler>();

function emitStatus(status: ConnectionStatus): void {
  for (const handler of statusHandlers) handler(status);
}

export function onEvent(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => eventHandlers.delete(handler);
}

export function onStatus(handler: StatusHandler): () => void {
  statusHandlers.add(handler);
  return () => statusHandlers.delete(handler);
}

export function connect(): void {
  const tokens = getTokens();
  if (!tokens || socket) return;

  closedOnPurpose = false;
  emitStatus(retries === 0 ? "connecting" : "reconnecting");

  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/realtime?token=${encodeURIComponent(tokens.access_token)}`);

  socket.onopen = () => {
    retries = 0;
    emitStatus("online");
  };

  socket.onmessage = (raw) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(String(raw.data)) as ServerEvent;
    } catch {
      return;
    }
    for (const handler of eventHandlers) handler(event);
  };

  socket.onerror = () => socket?.close();

  socket.onclose = () => {
    socket = null;
    if (closedOnPurpose) {
      emitStatus("offline");
      return;
    }
    emitStatus("reconnecting");
    // Espera creciente hasta 15 s: reconectar en bucle contra una instancia
    // apagada solo calienta el portátil de quien hospeda.
    const delay = Math.min(500 * 2 ** retries++, 15_000);
    reconnectTimer = window.setTimeout(connect, delay);
  };
}

export function disconnect(): void {
  closedOnPurpose = true;
  clearTimeout(reconnectTimer);
  retries = 0;
  socket?.close();
  socket = null;
  emitStatus("offline");
}

export function sendCommand(command: ClientCommand): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
}

/** Volver a la pestaña con la instancia caída no debería costar 15 s de espera. */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !socket && !closedOnPurpose && getTokens()) {
    clearTimeout(reconnectTimer);
    retries = 0;
    connect();
  }
});

window.addEventListener("online", () => {
  if (!socket && !closedOnPurpose && getTokens()) {
    clearTimeout(reconnectTimer);
    retries = 0;
    connect();
  }
});
