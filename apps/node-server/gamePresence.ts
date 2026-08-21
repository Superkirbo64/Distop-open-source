/**
 * "Jugando a X" (§9.1): quién está jugando a qué, ahora mismo.
 *
 * Vive en memoria como las salas de voz (voice.ts): una partida no sobrevive a
 * que se apague la instancia, y guardarla en disco solo dejaría estados
 * fantasma. Lo alimenta la app de escritorio del jugador con un heartbeat; si
 * el heartbeat calla —se cerró la app, se apagó el PC— el barrido lo limpia.
 * El navegador NO limpia nada al cerrarse: el juego no corre en el navegador.
 *
 * Lo único que se persiste es el HISTORIAL de partidas terminadas (tabla
 * game_sessions), y solo si duraron lo bastante para no ser ruido.
 *
 * Este módulo no publica eventos él mismo para no crear un ciclo con
 * gateway.ts: api.ts registra un oyente y hace el fan-out.
 */
import type { GamePresence, GameSession, Snowflake } from "@distop/protocol";
import { uuidv7 } from "@distop/protocol";
import { db } from "./db.ts";
import { findUserById } from "./auth.ts";
import { getMember } from "./entities.ts";

interface Playing {
  gameName: string;
  startedAt: number;
  lastBeat: number;
}

const playing = new Map<Snowflake, Playing>();

/** Menos de un minuto no es una partida, es abrir y cerrar: no ensucia el historial. */
const MIN_SESSION_MS = 60_000;
/** Tres heartbeats perdidos (el agente late cada 60 s) = el equipo ya no está. */
const STALE_MS = 180_000;
const HISTORY_CAP = 50;

const changeListeners = new Set<(userId: Snowflake) => void>();

/** api.ts se registra aquí para difundir GAME_PRESENCE_UPDATE sin ciclo de imports. */
export function onGamePresenceChange(listener: (userId: Snowflake) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notify(userId: Snowflake): void {
  for (const listener of changeListeners) listener(userId);
}

/** El interruptor de privacidad. Ausente = comparte: instalar la app y activar
    la detección ya fue el acto de consentimiento; esto es la pausa (§29.6). */
export function sharesGameActivity(userId: Snowflake): boolean {
  return readSetting(userId, "share_game_activity");
}

export function showsGameHistory(userId: Snowflake): boolean {
  return readSetting(userId, "show_game_history");
}

function readSetting(userId: Snowflake, key: string): boolean {
  const row = findUserById(userId);
  if (!row) return false;
  try {
    const settings = JSON.parse(row.settings) as Record<string, unknown>;
    return settings[key] !== false;
  } catch {
    return true;
  }
}

function recordSession(userId: Snowflake, session: Playing, endedAt: number): void {
  if (endedAt - session.startedAt < MIN_SESSION_MS) return;
  db.prepare("INSERT INTO game_sessions (id, user_id, game_name, started_at, ended_at) VALUES (?, ?, ?, ?, ?)").run(
    uuidv7(),
    userId,
    session.gameName,
    session.startedAt,
    endedAt,
  );
  // Un tope por persona: el historial es "a qué juego últimamente", no un log.
  db.prepare(
    `DELETE FROM game_sessions WHERE user_id = ? AND id NOT IN
       (SELECT id FROM game_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?)`,
  ).run(userId, userId, HISTORY_CAP);
}

/**
 * Inicio y heartbeat son la misma llamada: mismo juego = late y conserva su
 * started_at; juego distinto = cierra la partida anterior y abre la nueva.
 * Devuelve si cambió algo que los demás deban ver.
 */
export function setPlaying(userId: Snowflake, gameName: string, now = Date.now()): boolean {
  const current = playing.get(userId);
  if (current && current.gameName === gameName) {
    current.lastBeat = now;
    return false;
  }
  if (current) recordSession(userId, current, now);
  playing.set(userId, { gameName, startedAt: now, lastBeat: now });
  return true;
}

/** Devuelve si había algo que quitar. */
export function clearPlaying(userId: Snowflake, now = Date.now()): boolean {
  const current = playing.get(userId);
  if (!current) return false;
  playing.delete(userId);
  recordSession(userId, current, now);
  return true;
}

/** Lo que ve una comunidad: solo miembros, no invisibles, y que quieran compartir. */
export function presencesIn(communityId: Snowflake): GamePresence[] {
  const out: GamePresence[] = [];
  for (const [userId, session] of playing) {
    if (!getMember(communityId, userId)) continue;
    // Coherente con onlineIn (gateway.ts): invisible es invisible en todo.
    if (findUserById(userId)?.status === "invisible") continue;
    if (!sharesGameActivity(userId)) continue;
    out.push({ user_id: userId, game_name: session.gameName, started_at: session.startedAt });
  }
  return out;
}

export function historyOf(userId: Snowflake, limit = 10): GameSession[] {
  const rows = db
    .prepare("SELECT id, game_name, started_at, ended_at FROM game_sessions WHERE user_id = ? ORDER BY started_at DESC LIMIT ?")
    .all(userId, limit) as Array<{ id: string; game_name: string; started_at: number; ended_at: number }>;
  return rows.map((row) => ({ id: row.id, game_name: row.game_name, started_at: row.started_at, ended_at: row.ended_at }));
}

/**
 * Limpia a quien dejó de latir y devuelve a quiénes limpió. Exportada aparte
 * del temporizador para poder probarla sin esperar tres minutos de reloj.
 */
export function sweepStale(now = Date.now()): Snowflake[] {
  const gone: Snowflake[] = [];
  for (const [userId, session] of playing) {
    if (now - session.lastBeat > STALE_MS) {
      playing.delete(userId);
      recordSession(userId, session, session.lastBeat);
      gone.push(userId);
    }
  }
  for (const userId of gone) notify(userId);
  return gone;
}

setInterval(() => sweepStale(), 60_000).unref();
