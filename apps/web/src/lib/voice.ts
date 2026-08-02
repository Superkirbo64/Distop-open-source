/**
 * Voz en el navegador (§9.4).
 * Malla WebRTC: una conexión por pareja. El audio va directo entre personas y
 * nunca toca la instancia, así que hospedar una llamada no cuesta ancho de banda
 * de servidor. La instancia solo presenta a los pares entre sí.
 *
 * Quién ofrece y quién responde se decide comparando ids, no por orden de
 * llegada: si los dos ofrecen a la vez, la negociación se rompe (glare).
 */
import type { Snowflake } from "@distop/protocol";
import { sendCommand } from "./gateway.ts";

export interface VoiceLocalState {
  channelId: Snowflake | null;
  muted: boolean;
  deafened: boolean;
  /** Quién está hablando ahora mismo, yo incluida. */
  speaking: Set<Snowflake>;
  error: string | null;
}

type Listener = (state: VoiceLocalState) => void;

const state: VoiceLocalState = { channelId: null, muted: false, deafened: false, speaking: new Set(), error: null };
const listeners = new Set<Listener>();

let selfId: Snowflake = "";
let iceServers: RTCIceServer[] = [];
let localStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;

interface Peer {
  connection: RTCPeerConnection;
  audio: HTMLAudioElement;
  analyser?: AnalyserNode;
}
const peers = new Map<Snowflake, Peer>();

/** Contenedor oculto donde viven las salidas de audio de cada par. */
function sinks(): HTMLElement {
  let node = document.getElementById("distop-voice-sinks");
  if (!node) {
    node = document.createElement("div");
    node.id = "distop-voice-sinks";
    node.hidden = true;
    document.body.append(node);
  }
  return node;
}

function emit(): void {
  for (const listener of listeners) listener({ ...state, speaking: new Set(state.speaking) });
}

export function onVoice(listener: Listener): () => void {
  listeners.add(listener);
  listener({ ...state, speaking: new Set(state.speaking) });
  return () => listeners.delete(listener);
}

export function configureVoice(userId: Snowflake, servers: RTCIceServer[]): void {
  selfId = userId;
  iceServers = servers;
}

/* ── quién habla ───────────────────────────────────────────────────────
   Un medidor de volumen sencillo sobre el análisis de frecuencias. No es
   detección de voz de verdad (no distingue voz de un portazo), pero es lo que
   hace que la interfaz se sienta viva y no cuesta ni una dependencia. */

const SPEAKING_THRESHOLD = 18;

function watchLevel(id: Snowflake, stream: MediaStream): AnalyserNode | undefined {
  try {
    audioContext ??= new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.5;
    source.connect(analyser);
    return analyser;
  } catch {
    return undefined;
  }
}

const meters = new Map<Snowflake, AnalyserNode>();
let meterTimer: number | undefined;

function pollLevels(): void {
  let changed = false;
  const buffer = new Uint8Array(256);

  for (const [id, analyser] of meters) {
    analyser.getByteFrequencyData(buffer);
    let sum = 0;
    for (const value of buffer) sum += value;
    const average = sum / buffer.length;

    // Quien está en silencio no "habla" aunque su micro capte algo.
    const active = average > SPEAKING_THRESHOLD && !(id === selfId && state.muted);
    if (active !== state.speaking.has(id)) {
      if (active) state.speaking.add(id);
      else state.speaking.delete(id);
      changed = true;
    }
  }
  if (changed) emit();
}

/* ── conexiones ────────────────────────────────────────────────────── */

function createPeer(remoteId: Snowflake): Peer {
  const connection = new RTCPeerConnection({ iceServers });

  for (const track of localStream?.getTracks() ?? []) connection.addTrack(track, localStream!);

  const audio = new Audio();
  audio.autoplay = true;
  // Va al DOM (invisible) en vez de vivir suelto en memoria: así el navegador
  // lo trata como una salida de sonido de verdad, se puede inspeccionar, y
  // queda el sitio donde colgar el volumen por persona más adelante.
  audio.dataset.peer = remoteId;
  sinks().append(audio);
  connection.ontrack = (event) => {
    const [stream] = event.streams;
    if (!stream) return;
    audio.srcObject = stream;
    audio.muted = state.deafened;
    void audio.play().catch(() => {
      // Autoplay bloqueado hasta que haya un gesto; el botón de entrar ya lo es.
    });
    const analyser = watchLevel(remoteId, stream);
    if (analyser) meters.set(remoteId, analyser);
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate || !state.channelId) return;
    sendCommand({
      t: "VOICE_SIGNAL",
      d: { channel_id: state.channelId, to_user_id: remoteId, payload: { candidate: event.candidate } },
    });
  };

  connection.onconnectionstatechange = () => {
    audio.dataset.state = connection.connectionState;
    if (connection.connectionState === "failed" || connection.connectionState === "closed") dropPeer(remoteId);
  };

  const peer: Peer = { connection, audio };
  peers.set(remoteId, peer);
  return peer;
}

function dropPeer(remoteId: Snowflake): void {
  const peer = peers.get(remoteId);
  if (!peer) return;
  peer.connection.close();
  peer.audio.srcObject = null;
  peer.audio.remove();
  peers.delete(remoteId);
  meters.delete(remoteId);
  state.speaking.delete(remoteId);
  emit();
}

/** El id mayor ofrece: regla estable que evita que los dos lados ofrezcan a la vez. */
function shouldOffer(remoteId: Snowflake): boolean {
  return selfId > remoteId;
}

export async function syncPeers(channelId: Snowflake, participantIds: Snowflake[]): Promise<void> {
  if (state.channelId !== channelId) return;

  const others = participantIds.filter((id) => id !== selfId);
  for (const id of [...peers.keys()]) if (!others.includes(id)) dropPeer(id);

  for (const remoteId of others) {
    if (peers.has(remoteId)) continue;
    const peer = createPeer(remoteId);
    if (!shouldOffer(remoteId)) continue;

    const offer = await peer.connection.createOffer();
    await peer.connection.setLocalDescription(offer);
    sendCommand({ t: "VOICE_SIGNAL", d: { channel_id: channelId, to_user_id: remoteId, payload: { sdp: offer } } });
  }
}

export async function handleSignal(from: Snowflake, payload: unknown): Promise<void> {
  if (!state.channelId || !payload || typeof payload !== "object") return;
  const message = payload as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
  const peer = peers.get(from) ?? createPeer(from);

  if (message.sdp) {
    await peer.connection.setRemoteDescription(message.sdp);
    if (message.sdp.type === "offer") {
      const answer = await peer.connection.createAnswer();
      await peer.connection.setLocalDescription(answer);
      sendCommand({ t: "VOICE_SIGNAL", d: { channel_id: state.channelId, to_user_id: from, payload: { sdp: answer } } });
    }
    return;
  }

  if (message.candidate) {
    try {
      await peer.connection.addIceCandidate(message.candidate);
    } catch {
      // Candidato tardío tras cerrar la conexión: no es un fallo que contar.
    }
  }
}

/* ── entrar y salir ────────────────────────────────────────────────── */

export async function joinVoice(channelId: Snowflake): Promise<boolean> {
  if (state.channelId === channelId) return true;
  if (state.channelId) leaveVoice();

  state.error = null;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  } catch (err) {
    // Sin micrófono no hay llamada, y el motivo importa: permiso denegado y
    // "no hay dispositivo" se arreglan de formas distintas.
    state.error = err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "nodevice";
    emit();
    return false;
  }

  state.channelId = channelId;
  const analyser = watchLevel(selfId, localStream);
  if (analyser) meters.set(selfId, analyser);
  meterTimer ??= window.setInterval(pollLevels, 180);

  sendCommand({ t: "VOICE_JOIN", d: { channel_id: channelId } });
  emit();
  return true;
}

export function leaveVoice(): void {
  if (state.channelId) sendCommand({ t: "VOICE_LEAVE", d: { channel_id: state.channelId } });

  for (const id of [...peers.keys()]) dropPeer(id);
  for (const track of localStream?.getTracks() ?? []) track.stop();
  localStream = null;

  meters.clear();
  state.speaking.clear();
  state.channelId = null;
  state.muted = false;
  state.deafened = false;

  if (meterTimer) {
    clearInterval(meterTimer);
    meterTimer = undefined;
  }
  emit();
}

export function setMuted(muted: boolean): void {
  state.muted = muted;
  // Se apaga la pista, no solo el icono: el audio deja de salir de verdad.
  for (const track of localStream?.getAudioTracks() ?? []) track.enabled = !muted;
  if (muted) state.speaking.delete(selfId);
  if (state.channelId)
    sendCommand({ t: "VOICE_MUTE", d: { channel_id: state.channelId, muted, deafened: state.deafened } });
  emit();
}

export function setDeafened(deafened: boolean): void {
  state.deafened = deafened;
  for (const peer of peers.values()) peer.audio.muted = deafened;
  // Ensordecer implica callar: si no oyes a nadie, hablar es de mala educación.
  if (deafened) setMuted(true);
  else emit();
}

export function currentChannel(): Snowflake | null {
  return state.channelId;
}
