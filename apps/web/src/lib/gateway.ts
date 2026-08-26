/**
 * Conexión en tiempo real con la instancia.
 * Una instancia self-hosted se apaga: reconectar con espera creciente y decir
 * en qué estado está no es un extra, es el comportamiento normal aquí (§26, §28.1).
 */
import type { ClientCommand, ServerEvent } from "@distop/protocol";
import { getTokens } from "./api.ts";
import { absolutizeUrls, wsUrl } from "./instance.ts";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";

type EventHandler = (event: ServerEvent) => void;
type StatusHandler = (status: ConnectionStatus) => void;
/** Voz o imagen de alguien de la sala: [1 byte de tipo][16 bytes de quién][datos]. */
type MediaHandler = (userId: string, kind: number, payload: Uint8Array) => void;

let socket: WebSocket | null = null;
/** Vídeo en otro TCP: un fotograma grande no puede ponerse delante de la voz o de un botón. */
let videoSocket: WebSocket | null = null;
let retries = 0;
let reconnectTimer: number | undefined;
let videoReconnectTimer: number | undefined;
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

function receiveMedia(data: ArrayBuffer): void {
  if (!mediaHandler || data.byteLength <= 17) return;
  const bytes = new Uint8Array(data);
  mediaHandler(readSender(bytes.subarray(1, 17)), bytes[0]!, bytes.subarray(17));
}

/**
 * El vídeo usa una conexión dedicada. WebSocket va sobre TCP: sin esta separación,
 * un keyframe de cientos de KB bloquea detrás de sí audio, presencia y controles.
 * El servidor conserva la ruta antigua como respaldo durante actualizaciones.
 */
function connectVideo(token: string): void {
  if (closedOnPurpose || videoSocket || socket?.readyState !== WebSocket.OPEN) return;
  const media = new WebSocket(wsUrl(`/realtime?token=${encodeURIComponent(token)}&media=video`));
  videoSocket = media;
  media.binaryType = "arraybuffer";
  media.onmessage = (raw) => {
    if (raw.data instanceof ArrayBuffer) receiveMedia(raw.data);
  };
  media.onerror = () => media.close();
  media.onclose = () => {
    if (videoSocket === media) videoSocket = null;
    if (closedOnPurpose || socket?.readyState !== WebSocket.OPEN) return;
    clearTimeout(videoReconnectTimer);
    videoReconnectTimer = window.setTimeout(() => connectVideo(token), 1000);
  };
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

  socket = new WebSocket(wsUrl(`/realtime?token=${encodeURIComponent(tokens.access_token)}`));

  socket.onopen = () => {
    /* La conexi�n TCP sola no demuestra sesi�n ni membres�a. READY decide. */
  };

  // Los paquetes de voz llegan en binario por este mismo socket; no hay que
  // pasarlos por JSON ni despertar a los oyentes de eventos por cada uno.
  socket.binaryType = "arraybuffer";

  socket.onmessage = (raw) => {
    if (raw.data instanceof ArrayBuffer) {
      receiveMedia(raw.data);
      return;
    }

    let event: ServerEvent;
    try {
      event = JSON.parse(String(raw.data)) as ServerEvent;
    } catch {
      return;
    }
    // Misma frontera que api.ts: empaquetado, las rutas de media se absolutizan.
    absolutizeUrls(event);
    for (const handler of eventHandlers) handler(event);
    if (event.t === "READY") {
      retries = 0;
      emitStatus("online");
      connectVideo(tokens.access_token);
    }
  };

  socket.onerror = () => socket?.close();

  socket.onclose = () => {
    socket = null;
    clearTimeout(videoReconnectTimer);
    videoSocket?.close();
    videoSocket = null;
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
  clearTimeout(videoReconnectTimer);
  retries = 0;
  videoSocket?.close();
  videoSocket = null;
  socket?.close();
  socket = null;
  emitStatus("offline");
}

export function sendCommand(command: ClientCommand): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
}

/**
 * Envía voz o imagen e informa si entró en la cola. El codificador de vídeo usa
 * el `false` para pedir inmediatamente otro fotograma clave: seguir mandando
 * deltas que dependen de uno descartado solo gastaría red en una imagen rota.
 */
export function sendMedia(frame: ArrayBuffer): boolean {
  const kind = new Uint8Array(frame, 0, 1)[0];
  const video = kind !== 0;
  const dedicated = videoSocket?.readyState === WebSocket.OPEN ? videoSocket : null;
  const target = video && dedicated ? dedicated : socket;
  const maxBuffered = video && dedicated ? 2_097_152 : 524_288;
  if (target?.readyState !== WebSocket.OPEN || target.bufferedAmount > maxBuffered) return false;
  target.send(frame);
  return true;
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
