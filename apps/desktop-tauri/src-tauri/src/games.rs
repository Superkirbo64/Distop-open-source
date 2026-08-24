//! Detección del juego abierto (etapa B3.5 del PLAN-PARIDAD.md): el port de
//! apps/desktop/src/games.ts + game-detection.ts, con la mejora que el plan
//! prometía: CERO procesos externos. Donde Electron lanzaba tasklist.exe (4MB)
//! y reg.exe cada 12 segundos, aquí sysinfo enumera procesos y winreg lee el
//! registro, todo dentro del proceso.
//!
//! Mismas reglas de privacidad (§8, §22 del claude.md): la lista de procesos
//! NUNCA sale de esta máquina; al cliente solo cruza el nombre del juego que
//! casó, y en el escaneo de diagnóstico solo recuentos.
//!
//! Mismas tres fuentes y mismo orden de prioridad (comprobado por los tests de
//! game-detection en Electron): Steam (hecho, no indicio) → catálogo de la
//! persona → manifiestos de Epic.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const POLL: Duration = Duration::from_secs(12);
const EPIC_RESCAN: Duration = Duration::from_secs(5 * 60);

/// Corto y curado, idéntico a games.ts:35-74: el respaldo para lo que no
/// viene de Steam ni de Epic. El fichero games.json de la persona manda.
const DEFAULT_CATALOG: &[(&str, &str)] = &[
    ("RocketLeague.exe", "Rocket League"),
    ("cs2.exe", "Counter-Strike 2"),
    ("dota2.exe", "Dota 2"),
    ("FortniteClient-Win64-Shipping.exe", "Fortnite"),
    ("VALORANT-Win64-Shipping.exe", "VALORANT"),
    ("League of Legends.exe", "League of Legends"),
    ("GTA5.exe", "Grand Theft Auto V"),
    ("FiveM.exe", "FiveM"),
    ("RDR2.exe", "Red Dead Redemption 2"),
    ("witcher3.exe", "The Witcher 3"),
    ("Cyberpunk2077.exe", "Cyberpunk 2077"),
    ("eldenring.exe", "Elden Ring"),
    ("Overwatch.exe", "Overwatch 2"),
    ("Wow.exe", "World of Warcraft"),
    ("Diablo IV.exe", "Diablo IV"),
    ("destiny2.exe", "Destiny 2"),
    ("r5apex.exe", "Apex Legends"),
    ("TslGame.exe", "PUBG: Battlegrounds"),
    ("RainbowSix.exe", "Rainbow Six Siege"),
    ("RustClient.exe", "Rust"),
    ("Palworld-Win64-Shipping.exe", "Palworld"),
    ("helldivers2.exe", "Helldivers 2"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
    ("HogwartsLegacy.exe", "Hogwarts Legacy"),
    ("SoTGame.exe", "Sea of Thieves"),
    ("Minecraft.Windows.exe", "Minecraft"),
    ("RobloxPlayerBeta.exe", "Roblox"),
    ("Terraria.exe", "Terraria"),
    ("Stardew Valley.exe", "Stardew Valley"),
    ("factorio.exe", "Factorio"),
    ("Among Us.exe", "Among Us"),
    ("Brawlhalla.exe", "Brawlhalla"),
    ("Hades.exe", "Hades"),
    ("Hades2.exe", "Hades II"),
    ("Celeste.exe", "Celeste"),
    ("hollow_knight.exe", "Hollow Knight"),
    ("Silksong.exe", "Hollow Knight: Silksong"),
];

/// El contrato exacto de games.ts:94-100 hacia Ajustes → Actividad de juego.
/// `tasklist` conserva su nombre en el JSON (el cliente lo lee así); aquí
/// significa "la enumeración de procesos funcionó".
#[derive(Clone, serde::Serialize)]
pub struct GameScan {
    at: u64,
    steam: Option<String>,
    processes: usize,
    catalog: usize,
    tasklist: bool,
}

#[derive(Default)]
pub struct GamesRuntime {
    current: Mutex<Option<String>>,
    last_scan: Mutex<Option<GameScan>>,
    /// Generación del vigilante: subirla apaga el hilo de la anterior.
    generation: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

pub fn current(app: &AppHandle) -> Option<String> {
    app.state::<GamesRuntime>().current.lock().unwrap().clone()
}

pub fn last_scan(app: &AppHandle) -> Option<GameScan> {
    app.state::<GamesRuntime>().last_scan.lock().unwrap().clone()
}

/* ── Catálogo de la persona (games.json en la carpeta de la app) ───────── */

fn catalog_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("games.json"))
}

struct CatalogCache {
    map: HashMap<String, String>,
    mtime: Option<SystemTime>,
    seeded: bool,
}

/// El fichero de la persona manda; el de fábrica solo siembra el primero.
/// Se relee solo cuando su mtime cambia (games.ts:120-153).
fn load_catalog(app: &AppHandle, cache: &mut CatalogCache) {
    let Some(file) = catalog_path(app) else { return };
    if !cache.seeded {
        cache.seeded = true;
        if !file.exists() {
            let seed: HashMap<&str, &str> = DEFAULT_CATALOG.iter().copied().collect();
            if let Some(dir) = file.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&file, format!("{}\n", serde_json::to_string_pretty(&seed).unwrap_or_default()));
        }
    }
    let mtime = std::fs::metadata(&file).and_then(|m| m.modified()).ok();
    if mtime.is_some() && mtime == cache.mtime && !cache.map.is_empty() {
        return;
    }
    cache.mtime = mtime;

    let parsed: HashMap<String, serde_json::Value> = std::fs::read_to_string(&file)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| {
            // JSON a medio editar o ilegible: la versión de fábrica antes que nada.
            DEFAULT_CATALOG.iter().map(|(exe, name)| ((*exe).to_string(), serde_json::Value::from(*name))).collect()
        });
    let mut map = HashMap::new();
    for (exe, name) in parsed {
        if let Some(name) = name.as_str() {
            let trimmed: String = name.trim().chars().take(100).collect();
            if !trimmed.is_empty() {
                map.insert(exe.to_lowercase(), trimmed);
            }
        }
    }
    cache.map = map;
}

/* ── Epic: el catálogo se escribe solo desde los manifiestos ───────────── */

const EPIC_SUBDIRS: &[&str] = &["", "Binaries\\Win64", "Binaries\\Win32"];

fn epic_manifests_dir() -> PathBuf {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| "C:\\ProgramData".into());
    PathBuf::from(base).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")
}

/// El port de parseEpicManifest: nombre, carpeta y ejecutable de arranque.
fn parse_epic_manifest(raw: &str) -> Option<(String, String, String)> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let name: String = parsed.get("DisplayName")?.as_str()?.trim().chars().take(100).collect();
    let install = parsed.get("InstallLocation")?.as_str()?.trim().to_string();
    if name.is_empty() || install.is_empty() {
        return None;
    }
    let exe = parsed
        .get("LaunchExecutable")
        .and_then(|v| v.as_str())
        .and_then(|path| path.trim().rsplit(['\\', '/']).next())
        .unwrap_or("")
        .to_lowercase();
    Some((name, install, exe))
}

fn load_epic(cache: &mut (HashMap<String, String>, Option<SystemTime>)) -> HashMap<String, String> {
    if let Some(scanned) = cache.1 {
        if scanned.elapsed().map(|e| e < EPIC_RESCAN).unwrap_or(false) {
            return cache.0.clone();
        }
    }
    cache.1 = Some(SystemTime::now());

    let mut map = HashMap::new();
    let Ok(entries) = std::fs::read_dir(epic_manifests_dir()) else {
        cache.0 = map.clone(); // sin Epic instalado no hay nada que leer
        return map;
    };
    for entry in entries.flatten() {
        let file = entry.path();
        if !file.extension().map(|e| e.eq_ignore_ascii_case("item")).unwrap_or(false) {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&file) else { continue };
        let Some((name, install, exe)) = parse_epic_manifest(&raw) else { continue };
        if !exe.is_empty() {
            map.insert(exe, name.clone());
        }
        for sub in EPIC_SUBDIRS {
            let Ok(found) = std::fs::read_dir(PathBuf::from(&install).join(sub)) else { continue };
            for candidate in found.flatten() {
                let candidate_name = candidate.file_name().to_string_lossy().to_string();
                if candidate_name.to_lowercase().ends_with(".exe") {
                    map.insert(candidate_name.to_lowercase(), name.clone());
                }
            }
        }
    }
    cache.0 = map.clone();
    map
}

/* ── Steam: el registro dice qué partida está abierta ──────────────────── */

/// Dos lecturas del registro con winreg — sin lanzar reg.exe. Sin Steam la
/// primera falla y aquí se acaba; la detección por catálogo sigue igual.
fn steam_game() -> Option<String> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let steam = hkcu.open_subkey("Software\\Valve\\Steam").ok()?;
    let app_id: u32 = steam.get_value("RunningAppID").ok()?;
    if app_id == 0 {
        return None; // 0 = ninguna partida abierta
    }
    let name: String = hkcu
        .open_subkey(format!("Software\\Valve\\Steam\\Apps\\{app_id}"))
        .ok()?
        .get_value("Name")
        .ok()?;
    let trimmed: String = name.trim().chars().take(100).collect();
    (!trimmed.is_empty()).then_some(trimmed)
}

/* ── La pasada (el scan() de games.ts, sin procesos externos) ──────────── */

/// El port de detectGame: si el juego actual sigue abierto se conserva (que
/// arrancar un segundo juego no haga parpadear la presencia); si no, el primer
/// ejecutable del catálogo que esté vivo.
fn detect_game(
    running: &HashSet<String>,
    catalog: &HashMap<String, String>,
    current: Option<&str>,
) -> Option<String> {
    if let Some(current) = current {
        for (exe, name) in catalog {
            if name == current && running.contains(exe) {
                return Some(current.to_string());
            }
        }
    }
    for (exe, name) in catalog {
        if running.contains(exe) {
            return Some(name.clone());
        }
    }
    None
}

fn scan(
    app: &AppHandle,
    system: &mut sysinfo::System,
    catalog_cache: &mut CatalogCache,
    epic_cache: &mut (HashMap<String, String>, Option<SystemTime>),
) {
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let running: HashSet<String> = system
        .processes()
        .values()
        .map(|process| process.name().to_string_lossy().to_lowercase())
        .collect();

    // El de la persona primero: si le puso otro nombre a un juego de Epic,
    // manda el suyo (games.ts:246).
    load_catalog(app, catalog_cache);
    let mut catalog = load_epic(epic_cache);
    catalog.extend(catalog_cache.map.clone());

    let steam = steam_game();
    let runtime = app.state::<GamesRuntime>();
    let previous = runtime.current.lock().unwrap().clone();
    // Steam primero, y no al revés: lo suyo es un hecho, el catálogo adivina
    // por nombre de ejecutable (pickGame de game-detection.ts:53).
    let found = steam.clone().or_else(|| detect_game(&running, &catalog, previous.as_deref()));

    *runtime.last_scan.lock().unwrap() = Some(GameScan {
        at: now_ms(),
        steam,
        processes: running.len(),
        catalog: catalog.len(),
        tasklist: true,
    });

    if found != previous {
        *runtime.current.lock().unwrap() = found.clone();
        let _ = app.emit_to("distop", "games:change", found);
    }
}

pub fn start(app: &AppHandle) {
    let runtime = app.state::<GamesRuntime>();
    let generation = runtime.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let watcher_app = app.clone();
    std::thread::spawn(move || {
        let mut system = sysinfo::System::new();
        let mut catalog_cache = CatalogCache { map: HashMap::new(), mtime: None, seeded: false };
        let mut epic_cache: (HashMap<String, String>, Option<SystemTime>) = (HashMap::new(), None);
        loop {
            {
                let runtime = watcher_app.state::<GamesRuntime>();
                if runtime.generation.load(Ordering::SeqCst) != generation {
                    return; // llegó un stop() o un start() más nuevo
                }
            }
            scan(&watcher_app, &mut system, &mut catalog_cache, &mut epic_cache);
            std::thread::sleep(POLL);
        }
    });
}

pub fn stop(app: &AppHandle) {
    let runtime = app.state::<GamesRuntime>();
    runtime.generation.fetch_add(1, Ordering::SeqCst);
    let previous = runtime.current.lock().unwrap().take();
    if previous.is_some() {
        let _ = app.emit_to("distop", "games:change", Option::<String>::None);
    }
}
