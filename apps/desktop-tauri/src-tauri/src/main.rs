// Cascarón Tauri de Distop — Proyecto B, camino a paridad total con Electron
// (etapas y gates en ../../PLAN-PARIDAD.md).
//
// Qué hace ya: conectar y entrar a comunidades (mismo cliente web), pestañas
// WhatsApp/Telegram con toggles (creación perezosa, destruir al apagar,
// sesión persistente), y HOSPEDAR la comunidad en este equipo (B3.1): el
// MISMO node-server, con el Node oficial como sidecar (src/host.rs).
//
// Y además: permisos WebView2 con la lista blanca de Electron y enlaces
// externos al navegador (B3.2, src/permissions.rs), overlay de llamada con el
// MISMO widget (B3.3, src/overlay.rs), bandeja + cerrar-a-bandeja + arranque
// con Windows + splash + una sola instancia (B3.4), detección de juegos
// nativa en Rust sin tasklist (B3.5, src/games.rs) y auto-update firmado que
// instala al salir (B3.6, src/updates.rs).
//
// Hasta cerrar el corte B4 (checklist + medición + beta), la release para
// usuarios sigue siendo Electron.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod availability;
mod games;
mod host;
mod overlay;
mod permissions;
mod splash;
mod updates;

use std::fs;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{
    webview::WebviewBuilder, window::WindowBuilder, AppHandle, Emitter, LogicalPosition,
    LogicalSize, Manager, State, WebviewUrl, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt;

/// Alto de la franja de pestañas, como TAB_STRIP_H del cascarón Electron.
const STRIP_H: f64 = 36.0;

/// Chrome de verdad, sin delatar el WebView: WhatsApp Web rechaza navegadores
/// que no reconoce (mismo truco que apps/desktop/src/apps.ts:103).
const GUEST_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/// La franja: HTML propio embebido, servido por el protocolo strip://.
const STRIP_HTML: &str = include_str!("../strip.html");

/// F11 pertenece al cascarón (main.ts:60-73): la franja y el cliente lo
/// interceptan y lo mandan al comando. Las vistas huésped no pueden invocar
/// (sin capabilities a propósito), así que allí F11 no cambia de pantalla —
/// limitación documentada en el README.
const F11_SCRIPT: &str = r#"document.addEventListener("keydown", (event) => {
  if ((event.key === "F11" || event.code === "F11") && !event.repeat) {
    event.preventDefault();
    window.__TAURI__?.core.invoke("toggle_fullscreen");
  }
}, true);"#;

/// Lo que viaja al strip y al cliente por `shell:tabs`/`apps_prefs` — el
/// contrato exacto de Electron (solo las dos pestañas).
#[derive(Clone, Copy, serde::Serialize)]
struct Tabs {
    whatsapp: bool,
    telegram: bool,
}

/// El desktop-prefs.json completo, MISMO formato que el de Electron
/// (apps/desktop/src/desktop-prefs.ts): cada clave con su valor por defecto
/// para que un fichero viejo o a medio editar no rompa nada.
#[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
struct DesktopPrefs {
    #[serde(default = "yes")]
    whatsapp: bool,
    #[serde(default = "yes")]
    telegram: bool,
    #[serde(rename = "gameWatch", default = "yes")]
    game_watch: bool,
}

fn yes() -> bool {
    true
}

impl Default for DesktopPrefs {
    fn default() -> Self {
        Self { whatsapp: true, telegram: true, game_watch: true }
    }
}

impl DesktopPrefs {
    fn tabs(&self) -> Tabs {
        Tabs { whatsapp: self.whatsapp, telegram: self.telegram }
    }
}

struct AppState {
    prefs: Mutex<DesktopPrefs>,
    /// Pestaña visible ahora mismo. Rastreada aquí, no preguntada a la vista:
    /// el propio show() es la única puerta, así que el estado es cierto.
    active: Mutex<String>,
}

fn prefs_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|dir| dir.join("desktop-prefs.json"))
}

fn load_prefs(app: &AppHandle) -> DesktopPrefs {
    prefs_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_prefs(app: &AppHandle, prefs: DesktopPrefs) {
    if let Some(path) = prefs_path(app) {
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        let _ = fs::write(path, serde_json::to_string_pretty(&prefs).unwrap_or_default());
    }
}

/// URL y hosts permitidos de cada huésped (el apps-policy.ts de Electron).
fn guest_policy(id: &str) -> Option<(&'static str, &'static [&'static str])> {
    match id {
        "whatsapp" => Some(("https://web.whatsapp.com/", &["web.whatsapp.com"])),
        "telegram" => Some(("https://web.telegram.org/k/", &["web.telegram.org"])),
        _ => None,
    }
}

/// Coloca cada vista en su sitio: franja arriba, contenido debajo.
fn layout(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let Ok(size) = window.inner_size() else { return };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;

    if let Some(strip) = app.get_webview("strip") {
        let _ = strip.set_position(LogicalPosition::new(0.0, 0.0));
        let _ = strip.set_size(LogicalSize::new(width, STRIP_H));
    }
    for id in ["distop", "whatsapp", "telegram"] {
        if let Some(view) = app.get_webview(id) {
            let _ = view.set_position(LogicalPosition::new(0.0, STRIP_H));
            let _ = view.set_size(LogicalSize::new(width, (height - STRIP_H).max(0.0)));
        }
    }
}

/// Enseña una vista y esconde las demás. El huésped se crea al primer clic:
/// quien no lo usa no lo carga nunca (misma promesa que apps.ts:54).
fn show(app: &AppHandle, id: &str) {
    if app.get_webview(id).is_none() {
        let Some((url, hosts)) = guest_policy(id) else { return };
        let Some(window) = app.get_window("main") else { return };
        let Ok(parsed) = url.parse() else { return };
        // Una web ajena no navega fuera de su casa: allowlist de hosts, y el
        // resto se corta (los enlaces externos los abre el propio sitio en
        // pestaña, que aquí muere por la misma regla — honesto y cerrado).
        let allowed: Vec<String> = hosts.iter().map(|h| h.to_string()).collect();
        let builder = WebviewBuilder::new(id, WebviewUrl::External(parsed))
            .user_agent(GUEST_UA)
            // El handler ve TODA navegación, incluida la inicial about:blank
            // del WebView2: vetarla dejaba al huésped en blanco para siempre.
            .on_navigation(move |nav| {
                nav.scheme() == "about"
                    || nav.host_str().map(|h| allowed.iter().any(|a| a == h)).unwrap_or(false)
            });
        if let Ok(view) = window.add_child(
            builder,
            LogicalPosition::new(0.0, STRIP_H),
            LogicalSize::new(100.0, 100.0),
        ) {
            // Micrófono/cámara/notificaciones solo para SU dominio: lo que
            // WhatsApp Web necesita para sus llamadas, y nada más (B3.2).
            permissions::harden(&view, permissions::Who::Guest(hosts));
        }
        layout(app);
    }
    for other in ["distop", "whatsapp", "telegram"] {
        if let Some(view) = app.get_webview(other) {
            if other == id {
                let _ = view.show();
                let _ = view.set_focus();
            } else {
                let _ = view.hide();
            }
        }
    }
    if let Some(state) = app.try_state::<AppState>() {
        *state.active.lock().unwrap() = id.to_string();
    }
}

#[tauri::command]
fn shell_tabs(state: State<AppState>) -> Tabs {
    state.prefs.lock().unwrap().tabs()
}

/* F11 pertenece al cascarón, no a la vista que tenga el foco (main.ts:60-73
   de Electron): la franja y el cliente lo interceptan por script y lo mandan
   aquí. Pantalla completa real: la vista tapa también la franja. */
#[tauri::command]
fn toggle_fullscreen(app: AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    let full = window.is_fullscreen().unwrap_or(false);
    let _ = window.set_fullscreen(!full);
    layout(&app);
}

/* Hospedar (B3.1): la espera del health check (hasta 30s) corre en el pool de
   bloqueo, nunca en el hilo principal — la promesa del cliente se resuelve con
   el estado final, exactamente como host.start() en Electron. */
#[tauri::command]
async fn host_start(app: AppHandle) -> host::HostStatus {
    let fallback = app.clone();
    tauri::async_runtime::spawn_blocking(move || host::start(&app))
        .await
        .unwrap_or_else(|_| host::status(&fallback))
}

#[tauri::command]
async fn host_stop(app: AppHandle) -> host::HostStatus {
    host::stop(&app)
}

#[tauri::command]
fn host_status(app: AppHandle) -> host::HostStatus {
    host::status(&app)
}

/* Overlay de llamada (B3.3). Async porque puede crear una ventana (la misma
   regla anti-deadlock que shell_switch). Solo el cliente Distop, nunca
   WhatsApp/Telegram, alimenta una ventana que flota sobre otras aplicaciones
   (la guarda de main.ts:265-268 de Electron). */
#[tauri::command]
async fn overlay_update(app: AppHandle, webview: tauri::Webview, state: serde_json::Value) {
    if webview.label() != "distop" {
        return;
    }
    overlay::update(&app, state);
}

/* Async a propósito, no por gusto: Tauri documenta que crear webviews desde un
   comando SÍNCRONO deadlockea en Windows (la construcción del WebView2 se
   despacha al hilo principal y el invoke síncrono se atiende DENTRO de un
   callback del event loop, que queda anidado esperando su propia respuesta).
   Con el comando async, la llamada corre en el runtime y el event loop queda
   libre para completar la creación. */
#[tauri::command]
async fn shell_switch(app: AppHandle, id: String) {
    let prefs: DesktopPrefs;
    {
        let state = app.state::<AppState>();
        let guard = state.prefs.lock().unwrap();
        prefs = *guard;
    }
    let enabled = match id.as_str() {
        "distop" => true,
        "whatsapp" => prefs.whatsapp,
        "telegram" => prefs.telegram,
        _ => false,
    };
    // main manda: un id desactivado se ignora aunque llegue la orden.
    if enabled {
        show(&app, &id);
    }
}

#[tauri::command]
fn apps_prefs(state: State<AppState>) -> Tabs {
    state.prefs.lock().unwrap().tabs()
}

/* Detección de juegos (B3.5): el contrato de preload.ts:28-41. El toggle
   apaga el sondeo local ENTERO, no solo el reporte (main.ts:219-231). */
#[tauri::command]
fn games_current(app: AppHandle) -> Option<String> {
    games::current(&app)
}

#[tauri::command]
fn games_scan(app: AppHandle) -> Option<games::GameScan> {
    games::last_scan(&app)
}

#[tauri::command]
fn games_watch(state: State<AppState>) -> bool {
    state.prefs.lock().unwrap().game_watch
}

#[tauri::command]
fn games_set_watch(app: AppHandle, enabled: bool) -> bool {
    let snapshot: DesktopPrefs;
    let changed: bool;
    {
        let state = app.state::<AppState>();
        let mut prefs = state.prefs.lock().unwrap();
        changed = prefs.game_watch != enabled;
        prefs.game_watch = enabled;
        snapshot = *prefs;
    }
    if changed {
        save_prefs(&app, snapshot);
        if enabled {
            games::start(&app);
        } else {
            games::stop(&app);
        }
    }
    snapshot.game_watch
}

/// Apagar = pestaña fuera y vista destruida (la sesión del WebView2 queda en
/// disco: al reactivar se entra sin volver a vincular). Async por el mismo
/// motivo que shell_switch.
#[tauri::command]
async fn apps_set(app: AppHandle, id: String, enabled: bool) -> Option<Tabs> {
    let snapshot: DesktopPrefs;
    let was_active: bool;
    {
        let state = app.state::<AppState>();
        let mut prefs = state.prefs.lock().unwrap();
        match id.as_str() {
            "whatsapp" => prefs.whatsapp = enabled,
            "telegram" => prefs.telegram = enabled,
            _ => return None,
        }
        snapshot = *prefs;
        drop(prefs);
        was_active = *state.active.lock().unwrap() == id;
    }
    save_prefs(&app, snapshot);

    if !enabled {
        if let Some(view) = app.get_webview(&id) {
            let _ = view.close();
        }
        if was_active {
            show(&app, "distop");
        }
    }
    let _ = app.emit_to("strip", "shell:tabs", snapshot.tabs());
    Some(snapshot.tabs())
}

/// Bandeja del sistema (tray.ts): cerrar la ventana no mata la app — con
/// "Hospedar aquí" eso deja de ser comodidad: cerrar no debe apagar la
/// comunidad de nadie sin avisar.
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let show_main = |app: &AppHandle| {
        if let Some(window) = app.get_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            overlay::refresh(app);
        }
    };

    let open = MenuItemBuilder::with_id("open", "Abrir Distop").build(app)?;
    let autostart = CheckMenuItemBuilder::with_id("autostart", "Iniciar con Windows")
        .checked(app.autolaunch().is_enabled().unwrap_or(false))
        .build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Salir").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&autostart)
        .separator()
        .item(&quit)
        .build()?;

    let autostart_item = autostart.clone();
    let mut tray = TrayIconBuilder::with_id("distop-tray")
        .tooltip("Distop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "autostart" => {
                // El item ya cambió su check al clicarse: el sistema se alinea.
                let manager = app.autolaunch();
                if autostart_item.is_checked().unwrap_or(false) {
                    let _ = manager.enable();
                } else {
                    let _ = manager.disable();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn main() {
    /* Los sonidos del cliente (notificaciones, timbres de llamada) y los de
       los huéspedes suenan sin gesto previo, como en Electron
       (autoplayPolicy: no-user-gesture-required). El entorno WebView2 lee
       esta variable al crearse; se AÑADE a lo que ya hubiera (p. ej. el
       puerto de depuración CDP durante el desarrollo). */
    let autoplay = "--autoplay-policy=no-user-gesture-required";
    let merged = match std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        Ok(existing) if !existing.is_empty() => format!("{existing} {autoplay}"),
        _ => autoplay.to_string(),
    };
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", merged);

    tauri::Builder::default()
        // Dos copias pelearían por la bandeja y el puerto de la instancia
        // (main.ts:45): la segunda muere aquí y la primera se enseña.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .register_uri_scheme_protocol("strip", |_ctx, _request| {
            tauri::http::Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .body(STRIP_HTML.as_bytes().to_vec())
                .unwrap()
        })
        // El widget de llamada: el MISMO html que Electron (ver overlay.rs).
        .register_uri_scheme_protocol("overlay", |_ctx, _request| {
            tauri::http::Response::builder()
                .header("content-type", "text/html; charset=utf-8")
                .body(overlay::OVERLAY_HTML.as_bytes().to_vec())
                .unwrap()
        })
        // La splash: el MISMO splash.html de Electron con sus assets (splash.rs).
        .register_uri_scheme_protocol("splash", |_ctx, request| {
            let (body, kind) = splash::serve(request.uri().path());
            tauri::http::Response::builder()
                .header("content-type", kind)
                .body(body.to_vec())
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            shell_tabs, shell_switch, apps_prefs, apps_set, host_start, host_stop, host_status,
            overlay_update, games_current, games_scan, games_watch, games_set_watch,
            toggle_fullscreen,
            availability::availability_replace,
            availability::availability_status,
            availability::availability_forget
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let prefs = load_prefs(&handle);
            app.manage(AppState {
                prefs: Mutex::new(prefs),
                active: Mutex::new("distop".to_string()),
            });
            app.manage(host::HostRuntime::default());
            app.manage(overlay::OverlayRuntime::default());
            app.manage(games::GamesRuntime::default());
            app.manage(availability::AvailabilityRuntime::default());
            app.manage(splash::SplashState::default());
            app.manage(updates::PendingUpdate::default());

            // La splash primero: la ventana principal nace oculta y solo se
            // enseña cuando el cliente cargó (main.ts:75-138).
            splash::create(&handle);

            let window = WindowBuilder::new(app, "main")
                .title("Distop")
                .inner_size(1280.0, 800.0)
                .min_inner_size(720.0, 480.0)
                .visible(false)
                .build()?;

            // La franja, con su HTML embebido y acceso al puente (invoke).
            window.add_child(
                WebviewBuilder::new("strip", WebviewUrl::CustomProtocol("strip://localhost".parse()?))
                    .initialization_script(F11_SCRIPT),
                LogicalPosition::new(0.0, 0.0),
                LogicalSize::new(1280.0, STRIP_H),
            )?;

            // El MISMO cliente de apps/web/dist. El puente window.distop se
            // inyecta ANTES de que corra el cliente, con la MISMA superficie
            // tipada que declara apps/web/src/lib/instance.ts. `availability` corre
            // sobre el MISMO motor que Electron (staging/watcher), no sobre una
            // copia de las reglas en Rust: ver src/availability.rs.
            window.add_child(
                WebviewBuilder::new("distop", WebviewUrl::App("index.html".into()))
                    .initialization_script(
                        r#"window.distop = {
                             platform: "win32",
                             host: {
                               start: () => window.__TAURI__.core.invoke("host_start"),
                               stop: () => window.__TAURI__.core.invoke("host_stop"),
                               status: () => window.__TAURI__.core.invoke("host_status"),
                               /* listen() es asíncrono pero el contrato del cliente
                                  devuelve el des-suscriptor en el acto: si llega a
                                  ejecutarse antes de que listen resuelva, se apunta
                                  y se corta en cuanto exista. */
                               onStatus: (callback) => {
                                 let cancelled = false;
                                 let unlisten = null;
                                 window.__TAURI__.event
                                   .listen("host:status", (event) => callback(event.payload))
                                   .then((stop) => { if (cancelled) stop(); else unlisten = stop; });
                                 return () => { cancelled = true; if (unlisten) unlisten(); };
                               },
                             },
                             apps: {
                               prefs: () => window.__TAURI__.core.invoke("apps_prefs"),
                               set: (id, enabled) => window.__TAURI__.core.invoke("apps_set", { id, enabled }),
                             },
                             availability: {
                               replace: (items) => window.__TAURI__.core.invoke("availability_replace", { items }),
                               status: (url, connected) => { window.__TAURI__.core.invoke("availability_status", { url, connected }); },
                               forget: (url) => window.__TAURI__.core.invoke("availability_forget", { url }),
                               /* Mismo contrato que Electron: el des-suscriptor
                                  se devuelve en el acto aunque listen() aún no
                                  haya resuelto. */
                               onOpen: (callback) => {
                                 let cancelled = false;
                                 let unlisten = null;
                                 window.__TAURI__.event
                                   .listen("availability:open", (event) => callback(event.payload))
                                   .then((stop) => { if (cancelled) stop(); else unlisten = stop; });
                                 return () => { cancelled = true; if (unlisten) unlisten(); };
                               },
                               onAlert: (callback) => {
                                 let cancelled = false;
                                 let unlisten = null;
                                 window.__TAURI__.event
                                   .listen("availability:alert", (event) => callback(event.payload))
                                   .then((stop) => { if (cancelled) stop(); else unlisten = stop; });
                                 return () => { cancelled = true; if (unlisten) unlisten(); };
                               },
                             },
                             games: {
                               current: () => window.__TAURI__.core.invoke("games_current"),
                               scan: () => window.__TAURI__.core.invoke("games_scan"),
                               onChange: (callback) => {
                                 let cancelled = false;
                                 let unlisten = null;
                                 window.__TAURI__.event
                                   .listen("games:change", (event) => callback(event.payload))
                                   .then((stop) => { if (cancelled) stop(); else unlisten = stop; });
                                 return () => { cancelled = true; if (unlisten) unlisten(); };
                               },
                               watch: () => window.__TAURI__.core.invoke("games_watch"),
                               setWatch: (enabled) => window.__TAURI__.core.invoke("games_set_watch", { enabled }),
                             },
                             overlay: {
                               update: (state) => { window.__TAURI__.core.invoke("overlay_update", { state }); },
                             },
                           };"#,
                    )
                    .initialization_script(F11_SCRIPT)
                    /* La política de hardenWindow (security.ts:42-47): el
                       cliente no navega fuera del origen de la app. Los
                       enlaces target=_blank van aparte (NewWindowRequested en
                       permissions.rs, al navegador del sistema). */
                    .on_navigation(|url| {
                        url.scheme() == "tauri"
                            || url.scheme() == "about"
                            || url.host_str() == Some("tauri.localhost")
                            || (cfg!(debug_assertions)
                                && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1")))
                    })
                    // Manda el cliente, no la ventana: la splash se retira
                    // cuando él terminó de cargar (main.ts:194-197).
                    .on_page_load(|webview, payload| {
                        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                            splash::reveal(webview.app_handle());
                        }
                    }),
                LogicalPosition::new(0.0, STRIP_H),
                LogicalSize::new(1280.0, 800.0 - STRIP_H),
            )
            .map(|view| {
                // El cliente recibe micrófono/cámara/notificaciones sin
                // prompts — la lista GRANTED de Electron (security.ts:13).
                permissions::harden(&view, permissions::Who::Client);
            })?;

            let resize_handle = app.handle().clone();
            window.on_window_event(move |event| match event {
                WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
                    layout(&resize_handle);
                    // Minimizar y restaurar llegan como Resized: el overlay de
                    // llamada decide aquí si le toca verse (voice-overlay.ts
                    // escuchaba minimize/restore/hide/show del host).
                    overlay::refresh(&resize_handle);
                }
                // Con bandeja, cerrar no es salir (tray.ts:43-47): la ventana
                // se esconde y la instancia local, si corre, sigue sirviendo.
                WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    if let Some(window) = resize_handle.get_window("main") {
                        let _ = window.hide();
                    }
                    overlay::refresh(&resize_handle);
                }
                _ => {}
            });

            setup_tray(&handle)?;
            if prefs.game_watch {
                games::start(&handle);
            }
            updates::setup(&handle);

            /* Medición A/B del plan de RAM (paridad con main.ts:294-308):
               DISTOP_METRICS=1 vuelca cada 20s el working set del cascarón,
               del sidecar y de los procesos WebView2 de ESTA app (los
               msedgewebview2 se comparten entre apps: se filtra por la
               carpeta de datos propia en su línea de comandos). */
            if std::env::var("DISTOP_METRICS").is_ok() {
                std::thread::spawn(|| {
                    let own_pid = std::process::id();
                    let mut system = sysinfo::System::new();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(20));
                        system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
                        let mut rows = Vec::new();
                        let mut total = 0u64;
                        for (pid, process) in system.processes() {
                            let name = process.name().to_string_lossy().to_lowercase();
                            let cmd_matches = process.cmd().iter().any(|part| {
                                part.to_string_lossy().contains("com.distop.tauri")
                            });
                            let ours = pid.as_u32() == own_pid
                                || process.parent().map(|p| p.as_u32()) == Some(own_pid)
                                || (name.contains("msedgewebview2") && cmd_matches);
                            if !ours {
                                continue;
                            }
                            let ws_mb = process.memory() / (1024 * 1024);
                            total += ws_mb;
                            rows.push(format!("{{\"pid\":{},\"name\":\"{}\",\"wsMB\":{}}}", pid.as_u32(), name, ws_mb));
                        }
                        println!("[mem] total={total}MB [{}]", rows.join(","));
                    }
                });
            }

            layout(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("distop-tauri: fallo al arrancar")
        .run(|app, event| {
            // La instancia es un hijo del cascarón: si la app se cierra, se
            // apaga con ella (host.ts:140-143). El Job Object cubre además el
            // caso que Electron no cubre: morir sin pasar por aquí. Y si hay
            // una actualización descargada, se instala AHORA, al salir —
            // jamás en mitad de una llamada (updates.ts).
            if matches!(event, tauri::RunEvent::Exit) {
                host::stop(app);
                updates::install_pending(app);
            }
        });
}
