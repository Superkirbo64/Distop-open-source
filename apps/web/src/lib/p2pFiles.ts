/**
 * Archivos P2P (fase 3): la instancia guarda solo la ficha (nombre, tipo,
 * tamaño, SHA-256) y el cuerpo viaja por WebRTC DataChannel desde quien lo
 * envió. La instancia solo presenta a las dos partes (P2P_FILE_*).
 *
 * Quien envía guarda el archivo en IndexedDB para seguir sirviéndolo tras
 * recargar. Quien recibe no lo muestra hasta comparar el SHA-256 completo.
 */
import type { Attachment, Snowflake } from "@distop/protocol";
import { sendCommand } from "./gateway";

const CHUNK = 64 * 1024;
const WAIT_MS = 15_000;
const RETRY_MS = 5_000;

let iceServers: RTCIceServer[] = [];
export function configureP2PFiles(servers: RTCIceServer[]): void {
  iceServers = servers;
}

/* ── lo que yo envié ─────────────────────────────────────────────── */

interface Held { id: Snowflake; channelId: Snowflake; blob: Blob }
const held = new Map<Snowflake, Held>();

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("distop-p2p-files", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files", { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const req = fn(db.transaction("files", mode).objectStore("files"));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export async function sha256(blob: Blob): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()));
  return `sha256:${Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Desde aquí esta pestaña es fuente del archivo. */
export async function rememberSent(id: Snowflake, channelId: Snowflake, blob: Blob): Promise<void> {
  const item = { id, channelId, blob };
  held.set(id, item);
  sendCommand({ t: "P2P_FILE_ANNOUNCE", d: { attachment_id: id, channel_id: channelId } });
  // Sin IndexedDB (ventana privada) se sirve mientras la pestaña siga abierta.
  await withStore("readwrite", (store) => store.put(item)).catch(() => undefined);
}

/** Lo que envié yo se ve sin red. */
export function heldBlob(id: Snowflake): Blob | undefined {
  return held.get(id)?.blob;
}

/** En cada READY: la instancia olvida las fuentes al cortarse el socket. */
export async function announceHeld(): Promise<void> {
  const saved = await withStore<Held[]>("readonly", (store) => store.getAll()).catch(() => []);
  for (const item of saved) held.set(item.id, item);
  for (const item of held.values())
    sendCommand({ t: "P2P_FILE_ANNOUNCE", d: { attachment_id: item.id, channel_id: item.channelId } });
}

/* ── conexiones ──────────────────────────────────────────────────── */

const peers = new Map<string, RTCPeerConnection>();
const chains = new Map<string, Promise<void>>();

interface Wanted {
  file: Attachment;
  onProgress: (fraction: number) => void;
  resolve: (blob: Blob) => void;
  reject: (reason: P2PFailure) => void;
  /** Deja de volver a preguntar (ya contestó una fuente). */
  stopAsking: () => void;
  /** Quita también el plazo (ya llegan datos). */
  stopWaiting: () => void;
}
const wanted = new Map<Snowflake, Wanted>();

export type P2PFailure = "offline" | "corrupt";

function signal(attachmentId: Snowflake, channelId: Snowflake, to: Snowflake, payload: unknown): void {
  sendCommand({ t: "P2P_FILE_SIGNAL", d: { attachment_id: attachmentId, channel_id: channelId, to_user_id: to, payload } });
}

function connection(key: string, attachmentId: Snowflake, channelId: Snowflake, other: Snowflake): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(key, pc);
  pc.onicecandidate = (e) => {
    if (e.candidate) signal(attachmentId, channelId, other, { candidate: e.candidate.toJSON() });
  };
  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      pc.close();
      if (peers.get(key) === pc) peers.delete(key);
    }
  };
  return pc;
}

/** Soy fuente: alguien pidió un archivo que tengo. */
export async function handleP2PRequest(d: { attachment_id: Snowflake; channel_id: Snowflake; requester_id: Snowflake }): Promise<void> {
  const item = held.get(d.attachment_id);
  if (!item) return;
  const key = `${d.attachment_id}:${d.requester_id}`;
  if (peers.has(key)) return; // ya en marcha con esa persona
  const pc = connection(key, d.attachment_id, d.channel_id, d.requester_id);
  const channel = pc.createDataChannel("file", { ordered: true });
  channel.binaryType = "arraybuffer";
  channel.bufferedAmountLowThreshold = CHUNK * 4;
  channel.onopen = async () => {
    const data = await item.blob.arrayBuffer();
    for (let offset = 0; offset < data.byteLength; offset += CHUNK) {
      if (channel.readyState !== "open") return;
      if (channel.bufferedAmount > CHUNK * 16)
        await new Promise<void>((done) => { channel.onbufferedamountlow = () => done(); });
      channel.send(data.slice(offset, offset + CHUNK));
    }
  };
  // Quien recibe cierra al verificar; entonces se suelta la conexión.
  channel.onclose = () => {
    pc.close();
    if (peers.get(key) === pc) peers.delete(key);
  };
  await pc.setLocalDescription(await pc.createOffer());
  signal(d.attachment_id, d.channel_id, d.requester_id, { sdp: pc.localDescription });
}

/** Pide un archivo P2P. Falla con "offline" si nadie que lo tenga responde. */
export function fetchP2PFile(file: Attachment, channelId: Snowflake, onProgress: (fraction: number) => void): Promise<Blob> {
  wanted.get(file.id)?.reject("offline");
  return new Promise<Blob>((resolve, reject) => {
    const ask = () => sendCommand({ t: "P2P_FILE_REQUEST", d: { attachment_id: file.id, channel_id: channelId } });
    // Si nadie contesta (la fuente aún conectándose), se vuelve a preguntar.
    const retry = setInterval(ask, RETRY_MS);
    const timer = setTimeout(() => entry.reject("offline"), WAIT_MS);
    const entry: Wanted = {
      file,
      onProgress,
      stopAsking: () => clearInterval(retry),
      stopWaiting: () => { clearInterval(retry); clearTimeout(timer); },
      resolve: (blob) => { entry.stopWaiting(); wanted.delete(file.id); resolve(blob); },
      reject: (reason) => {
        entry.stopWaiting();
        if (wanted.get(file.id) === entry) wanted.delete(file.id);
        reject(reason);
      },
    };
    wanted.set(file.id, entry);
    ask();
  });
}

/* Las señales de un mismo par se procesan en orden: un candidato ICE que llega
   mientras se aplica la oferta no puede adelantarse. */
export function handleP2PSignal(d: { attachment_id: Snowflake; channel_id: Snowflake; from_user_id: Snowflake; payload: unknown }): void {
  const key = `${d.attachment_id}:${d.from_user_id}`;
  const next = (chains.get(key) ?? Promise.resolve()).then(() => applySignal(key, d)).catch(() => undefined);
  chains.set(key, next);
}

async function applySignal(key: string, d: { attachment_id: Snowflake; channel_id: Snowflake; from_user_id: Snowflake; payload: unknown }): Promise<void> {
  const payload = d.payload as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } | null;
  if (payload?.candidate) {
    await peers.get(key)?.addIceCandidate(payload.candidate);
    return;
  }
  if (payload?.sdp?.type === "answer") {
    await peers.get(key)?.setRemoteDescription(payload.sdp);
    return;
  }
  if (payload?.sdp?.type !== "offer") return;

  const want = wanted.get(d.attachment_id);
  if (!want || peers.has(key)) return; // otra pestaña mía lo pidió, o ya en marcha
  want.stopAsking();
  const pc = connection(key, d.attachment_id, d.channel_id, d.from_user_id);
  pc.ondatachannel = ({ channel }) => {
    channel.binaryType = "arraybuffer";
    want.stopWaiting();
    const parts: ArrayBuffer[] = [];
    let received = 0;
    let done = false;
    channel.onmessage = async (e) => {
      if (done || !(e.data instanceof ArrayBuffer)) return;
      parts.push(e.data);
      received += e.data.byteLength;
      want.onProgress(Math.min(received / want.file.size, 1));
      if (received < want.file.size) return;
      done = true;
      channel.close();
      const blob = new Blob(parts, { type: want.file.content_type });
      if (received === want.file.size && (await sha256(blob)) === want.file.content_hash) want.resolve(blob);
      else want.reject("corrupt");
    };
    // Si la fuente se va a mitad, no esperar para siempre.
    channel.onclose = () => {
      pc.close();
      if (peers.get(key) === pc) peers.delete(key);
      if (!done) want.reject("offline");
    };
  };
  await pc.setRemoteDescription(payload.sdp);
  await pc.setLocalDescription(await pc.createAnswer());
  signal(d.attachment_id, d.channel_id, d.from_user_id, { sdp: pc.localDescription });
}
