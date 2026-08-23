/**
 * Detección del juego abierto (§9, perfil "Jugando a…").
 *
 * Corre en el proceso principal porque un navegador no puede —ni debe— ver los
 * procesos del sistema. La lista de procesos NUNCA sale de esta máquina: aquí
 * se compara contra el catálogo y al renderer solo cruza el nombre del juego
 * que casó, que es lo único que la instancia llegará a saber (§8, §22).
 *
 * El catálogo es un JSON en userData que la persona puede editar para añadir
 * sus propios juegos ("MiJuego.exe": "Mi Juego"); se relee en cada pasada, sin
 * reiniciar nada. Sin servicios externos ni de pago (§3).
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectGame, parseTasklist } from "./game-detection";

/** Corto y curado: los lanzadores (Steam, Epic…) no son juegos y no están. */
const DEFAULT_CATALOG: Record<string, string> = {
  "RocketLeague.exe": "Rocket League",
  "cs2.exe": "Counter-Strike 2",
  "dota2.exe": "Dota 2",
  "FortniteClient-Win64-Shipping.exe": "Fortnite",
  "VALORANT-Win64-Shipping.exe": "VALORANT",
  "League of Legends.exe": "League of Legends",
  "GTA5.exe": "Grand Theft Auto V",
  "FiveM.exe": "FiveM",
  "RDR2.exe": "Red Dead Redemption 2",
  "witcher3.exe": "The Witcher 3",
  "Cyberpunk2077.exe": "Cyberpunk 2077",
  "eldenring.exe": "Elden Ring",
  "Overwatch.exe": "Overwatch 2",
  "Wow.exe": "World of Warcraft",
  "Diablo IV.exe": "Diablo IV",
  "destiny2.exe": "Destiny 2",
  "r5apex.exe": "Apex Legends",
  "TslGame.exe": "PUBG: Battlegrounds",
  "RainbowSix.exe": "Rainbow Six Siege",
  "RustClient.exe": "Rust",
  "Palworld-Win64-Shipping.exe": "Palworld",
  "helldivers2.exe": "Helldivers 2",
  "bg3.exe": "Baldur's Gate 3",
  "bg3_dx11.exe": "Baldur's Gate 3",
  "HogwartsLegacy.exe": "Hogwarts Legacy",
  "SoTGame.exe": "Sea of Thieves",
  "Minecraft.Windows.exe": "Minecraft",
  "RobloxPlayerBeta.exe": "Roblox",
  "Terraria.exe": "Terraria",
  "Stardew Valley.exe": "Stardew Valley",
  "factorio.exe": "Factorio",
  "Among Us.exe": "Among Us",
  "Brawlhalla.exe": "Brawlhalla",
  "Hades.exe": "Hades",
  "Hades2.exe": "Hades II",
  "Celeste.exe": "Celeste",
  "hollow_knight.exe": "Hollow Knight",
  "Silksong.exe": "Hollow Knight: Silksong",
};

const POLL_MS = 12_000;

let current: string | null = null;
let timer: NodeJS.Timeout | null = null;
const listeners = new Set<(game: string | null) => void>();

export function currentGame(): string | null {
  return current;
}

export function onGameChange(listener: (game: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function catalogPath(): string {
  return join(app.getPath("userData"), "games.json");
}

/** El fichero de la persona manda; el de fábrica solo siembra el primero. */
function loadCatalog(): Map<string, string> {
  const file = catalogPath();
  if (!existsSync(file)) {
    try {
      writeFileSync(file, `${JSON.stringify(DEFAULT_CATALOG, null, 2)}\n`);
    } catch {
      // Sin permisos de escritura se sigue con el de fábrica.
    }
  }
  let raw: Record<string, unknown> = DEFAULT_CATALOG;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    // JSON a medio editar: mejor la última versión válida embebida que nada.
  }
  const map = new Map<string, string>();
  for (const [exe, name] of Object.entries(raw)) {
    if (typeof name === "string" && name.trim()) map.set(exe.toLowerCase(), name.trim().slice(0, 100));
  }
  return map;
}

function scan(): void {
  execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    if (err) return; // sin tasklist no hay detección; se reintenta en la próxima
    const running = parseTasklist(stdout);
    const catalog = loadCatalog();

    const found = detectGame(running, catalog, current);

    if (found !== current) {
      current = found;
      for (const listener of listeners) listener(current);
    }
  });
}

export function startGameWatch(): void {
  if (timer || process.platform !== "win32") return;
  scan();
  timer = setInterval(scan, POLL_MS);
  timer.unref?.();
}

export function stopGameWatch(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (current !== null) {
    current = null;
    for (const listener of listeners) listener(null);
  }
}
