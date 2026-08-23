/**
 * Detección del juego abierto (§9, perfil "Jugando a…").
 *
 * Corre en el proceso principal porque un navegador no puede —ni debe— ver los
 * procesos del sistema. La lista de procesos NUNCA sale de esta máquina: aquí
 * se compara contra el catálogo y al renderer solo cruza el nombre del juego
 * que casó, que es lo único que la instancia llegará a saber (§8, §22).
 *
 * Tres fuentes, y ninguna pide mantener una lista de juegos:
 *
 *   1. Steam apunta él mismo en el registro qué partida tiene abierta y cómo se
 *      llama. Es exacto y cubre su biblioteca entera.
 *   2. Epic no apunta nada, pero deja un manifiesto por juego instalado con su
 *      nombre y su carpeta: de ahí sale solo qué ejecutables son juegos suyos.
 *   3. El catálogo de ejecutables, para lo que no viene de ninguna de las dos
 *      —Riot, Battle.net, un ejecutable suelto— y para renombrar a mano.
 *
 * El catálogo es un JSON en userData que la persona puede editar para añadir
 * sus propios juegos ("MiJuego.exe": "Mi Juego"); se relee en cada pasada, sin
 * reiniciar nada. Sin servicios externos ni de pago (§3).
 */
import { app } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectGame, parseEpicManifest, parseRegDword, parseRegString, parseTasklist, pickGame } from "./game-detection";

/**
 * Corto y curado: los lanzadores (Steam, Epic…) no son juegos y no están.
 *
 * Esta lista es solo el respaldo para lo que NO viene de Steam —Riot, Battle.net,
 * Epic, un ejecutable suelto—; la biblioteca de Steam entera la reconoce
 * `steamGame()` sin que haya que apuntar nada aquí.
 */
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

/**
 * Lo que vio la última pasada, para el botón de Ajustes → Actividad de juego.
 *
 * Existe porque "no me detecta el juego" tiene cuatro causas distintas —Steam
 * apagado, juego fuera de las tiendas, `tasklist` sin permiso, la detección
 * pausada— y desde fuera se ven todas iguales. Aquí no cruza la lista de
 * procesos, solo cuántos había: el recuento no dice a qué juega nadie (§22).
 */
export interface GameScan {
  at: number;
  steam: string | null;
  processes: number;
  catalog: number;
  tasklist: boolean;
}

let lastScan: GameScan | null = null;

export function lastGameScan(): GameScan | null {
  return lastScan;
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

/* ── Epic ──────────────────────────────────────────────────────────────
   Epic no lleva la cuenta de qué se está jugando, así que aquí sí hay que mirar
   los procesos. Lo que se evita es la lista a mano: cada juego instalado deja un
   manifiesto con su nombre y su carpeta, y de ahí sale qué ejecutables son suyos.

   Tres carpetas y sin bajar recursivamente: la raíz de la instalación y las dos
   de Unreal, que es donde están los ejecutables de casi todo su catálogo. Un
   recorrido completo encontraría alguno más, a cambio de recorrer miles de
   carpetas de contenido en el proceso principal, que es el que dibuja la
   ventana. */
const EPIC_MANIFESTS = join(process.env["ProgramData"] ?? "C:\\ProgramData", "Epic", "EpicGamesLauncher", "Data", "Manifests");
const EPIC_SUBDIRS = ["", "Binaries\\Win64", "Binaries\\Win32"];
/** Instalar o desinstalar un juego es raro; releer los manifiestos cada 12 s, tonto. */
const EPIC_RESCAN_MS = 5 * 60_000;

let epicCatalog = new Map<string, string>();
let epicScanned = 0;

/** Ejecutables de los juegos de Epic instalados, en minúsculas y sin ruta. */
function loadEpic(): Map<string, string> {
  if (epicScanned && Date.now() - epicScanned < EPIC_RESCAN_MS) return epicCatalog;
  epicScanned = Date.now();

  const map = new Map<string, string>();
  let manifests: string[];
  try {
    manifests = readdirSync(EPIC_MANIFESTS);
  } catch {
    epicCatalog = map; // sin Epic instalado no hay nada que leer, y no es un error
    return map;
  }

  for (const file of manifests) {
    if (!file.toLowerCase().endsWith(".item")) continue;
    let entry: ReturnType<typeof parseEpicManifest> = null;
    try {
      entry = parseEpicManifest(readFileSync(join(EPIC_MANIFESTS, file), "utf8"));
    } catch {
      continue; // manifiesto ilegible: se salta ese juego, no la pasada entera
    }
    if (!entry) continue;

    // El de arrancar siempre cuenta, aunque su carpeta ya no exista porque el
    // juego se desinstaló y el manifiesto se quedó atrás.
    if (entry.exe) map.set(entry.exe, entry.name);
    for (const sub of EPIC_SUBDIRS) {
      let found: string[];
      try {
        found = readdirSync(join(entry.install, sub));
      } catch {
        continue;
      }
      for (const name of found) {
        if (name.toLowerCase().endsWith(".exe")) map.set(name.toLowerCase(), entry.name);
      }
    }
  }

  epicCatalog = map;
  return map;
}

const STEAM_KEY = "HKCU\\Software\\Valve\\Steam";

/** Un valor del registro, o null si la clave no existe o `reg` no está. */
function regValue(key: string, name: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("reg", ["query", key, "/v", name], { windowsHide: true, timeout: 4000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

/**
 * El juego de Steam abierto ahora mismo, o null. Dos lecturas del registro: el
 * appid en marcha y, si lo hay, su nombre. Sin Steam instalado la primera falla
 * y aquí se acaba — la detección por catálogo sigue igual.
 */
async function steamGame(): Promise<string | null> {
  const running = await regValue(STEAM_KEY, "RunningAppID");
  const appId = running === null ? null : parseRegDword(running);
  if (!appId) return null; // 0 = ninguna partida abierta
  const name = await regValue(`${STEAM_KEY}\\Apps\\${appId}`, "Name");
  return name === null ? null : parseRegString(name);
}

function scan(): void {
  execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    // Sin tasklist se sigue igualmente: Steam solo, que ya reconoce más que la lista.
    const running = err ? new Set<string>() : parseTasklist(stdout);
    // El de la persona primero: si le puso otro nombre a un juego de Epic, manda el suyo.
    const catalog = new Map([...loadEpic(), ...loadCatalog()]);

    void steamGame().then((steam) => {
      /* Steam primero, y no al revés. Lo suyo no es "hay un proceso que se llama
         así": es Steam diciendo qué partida tiene abierta, que es un hecho, no un
         indicio. El catálogo es lo contrario —adivina por el nombre del
         ejecutable— y ahí hay nombres tan genéricos como `launcher.exe`, que el
         de Epic aporta solo. Con el catálogo delante bastaba que cualquier
         programa del equipo se llamase así para que Steam no saliera nunca. */
      const found = pickGame(steam, detectGame(running, catalog, current));
      lastScan = { at: Date.now(), steam, processes: running.size, catalog: catalog.size, tasklist: !err };

      if (found !== current) {
        current = found;
        for (const listener of listeners) listener(current);
      }
    });
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
