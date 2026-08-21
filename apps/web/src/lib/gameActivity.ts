/**
 * Puente entre la detección de juegos de la app de escritorio y la instancia
 * (§9.1). Solo existe dentro de la app: en el navegador window.distop no está
 * y este módulo no hace nada.
 *
 * El proceso principal detecta y avisa; ESTE lado hace el PUT/DELETE con la
 * sesión normal del usuario — así no hay una segunda autenticación que
 * gestionar y el interruptor de privacidad del servidor corta a todos por
 * igual. Mientras hay partida se relate cada minuto: si el equipo desaparece
 * sin despedirse, el barrido del servidor limpia solo (gamePresence.ts).
 */
import { api, getTokens, onTokensChanged } from "./api.ts";

const HEARTBEAT_MS = 60_000;

let current: string | null = null;
let heartbeat: number | undefined;
let started = false;

async function report(): Promise<void> {
  if (!getTokens()) return;
  try {
    if (current) await api("PUT", "/api/v1/users/me/game-presence", { game_name: current });
    else await api("DELETE", "/api/v1/users/me/game-presence");
  } catch {
    // Sin permiso (compartir desactivado) o sin instancia: no es asunto de
    // reintentar en bucle; el siguiente cambio o latido lo vuelve a intentar.
  }
}

function setGame(game: string | null): void {
  current = game;
  clearInterval(heartbeat);
  if (current) heartbeat = window.setInterval(() => void report(), HEARTBEAT_MS);
  void report();
}

export function watchGameActivity(): void {
  const bridge = window.distop?.games;
  if (!bridge || started) return;
  started = true;

  bridge.onChange(setGame);
  void bridge.current().then((game) => {
    if (game !== current) setGame(game);
  });

  // Entrar con sesión nueva (o cambiar de cuenta) re-anuncia la partida en curso.
  onTokensChanged((tokens) => {
    if (tokens && current) void report();
  });
}
