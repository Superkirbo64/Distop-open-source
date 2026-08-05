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
/** Voz o imagen de alguien de la sala: [1 byte de tipo][16 bytes de quién][datos]. */
type MediaHandler = (userId: string, kind: number, payload: Uint8Array) => void;

let socket: WebSocket | null = null;
let retries = 0;
let reconnectTimer: number | undefined;
let closedOnPurpose = false;

const eventHandlers = new Set<EventHandler>();
const statusHandlers = new Set<StatusHandler>();
let mediaHandler: MediaHandler | null = null;

export function onMedia(handler: MediaHandler | null): void {
  mediaHandler = handler;
}

/** Vuelve a poner los guiones que se le quitaron para caber en 16 bytes. */
function readSender(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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

  // Los paquetes de voz llegan en binario por este mismo socket; no hay que
  // pasarlos por JSON ni despertar a los oyentes de eventos por cada uno.
  socket.binaryType = "arraybuffer";

  socket.onmessage = (raw) => {
    if (raw.data instanceof ArrayBuffer) {
      if (!mediaHandler || raw.data.byteLength <= 17) return;
      const bytes = new Uint8Array(raw.data);
      mediaHandler(readSender(bytes.subarray(1, 17)), bytes[0]!, bytes.subarray(17));
      return;
    }

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

/** Un paquete de voz o imagen. Se descarta si el socket va justo: lo viejo no sirve. */
export function sendMedia(frame: ArrayBuffer): void {
  if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 524_288) return;
  socket.send(frame);
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
