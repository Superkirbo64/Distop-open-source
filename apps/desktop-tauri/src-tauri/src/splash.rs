//! La splash (etapa B3.4 del PLAN-PARIDAD.md): el MISMO splash.html de
//! Electron con sus tres assets embebidos (~310KB), servido por el protocolo
//! splash://. Mismas reglas que main.ts:75-138: nunca retrasa una carga lenta
//! (espera al cliente real) y solo fija un mínimo de 3,05s para que la entrada
//! no sea un destello en equipos rápidos.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, WebviewUrl};

const MIN_SPLASH: Duration = Duration::from_millis(3_050);
const EXIT_ANIMATION: Duration = Duration::from_millis(260);
/// Si el cliente jamás termina de cargar (URL rota en desarrollo), nadie se
/// queda mirando la splash para siempre — el did-fail-load de Electron.
const GIVE_UP: Duration = Duration::from_secs(20);

const SPLASH_LABEL: &str = "splash";

const HTML: &str = include_str!("../../../desktop/src/splash.html");
const FONT: &[u8] = include_bytes!("../../../desktop/src/assets/press-start-2p-latin.woff2");
const ICON: &[u8] = include_bytes!("../../../desktop/src/assets/icon.png");
const SOUND: &[u8] = include_bytes!("../../../desktop/src/assets/splash-reveal.mp3");

pub fn serve(path: &str) -> (&'static [u8], &'static str) {
    match path {
        "/assets/press-start-2p-latin.woff2" => (FONT, "font/woff2"),
        "/assets/icon.png" => (ICON, "image/png"),
        "/assets/splash-reveal.mp3" => (SOUND, "audio/mpeg"),
        _ => (HTML.as_bytes(), "text/html; charset=utf-8"),
    }
}

pub struct SplashState {
    started_at: Instant,
    revealing: AtomicBool,
}

impl Default for SplashState {
    fn default() -> Self {
        Self { started_at: Instant::now(), revealing: AtomicBool::new(false) }
    }
}

pub fn create(app: &AppHandle) {
    let built = tauri::WebviewWindowBuilder::new(
        app,
        SPLASH_LABEL,
        WebviewUrl::CustomProtocol("splash://localhost".parse().expect("url splash")),
    )
    .title("Distop")
    .inner_size(580.0, 360.0)
    .transparent(true)
    .decorations(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .skip_taskbar(true)
    .center()
    .shadow(true)
    .build();
    if let Err(err) = built {
        eprintln!("distop: splash no creada: {err}");
    }
    // El fallback de rendición corre desde ya: pase lo que pase con el
    // cliente, la ventana principal termina enseñándose.
    let fallback = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GIVE_UP);
        reveal(&fallback);
    });
}

/// Enseña la ventana principal cerrando la splash con su animación de salida.
/// Idempotente: la primera llamada gana (cliente cargado o rendición).
pub fn reveal(app: &AppHandle) {
    let state = app.state::<SplashState>();
    if state.revealing.swap(true, Ordering::SeqCst) {
        return;
    }
    let elapsed = state.started_at.elapsed();
    let wait = MIN_SPLASH.saturating_sub(elapsed);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(wait);
        let show_main = |app: &AppHandle| {
            if let Some(main) = app.get_window("main") {
                let _ = main.show();
                let _ = main.set_focus();
            }
        };
        match app.get_webview_window(SPLASH_LABEL) {
            Some(splash) => {
                let _ = splash.eval("document.body.classList.add('is-leaving')");
                std::thread::sleep(EXIT_ANIMATION);
                let _ = splash.destroy();
                show_main(&app);
            }
            None => show_main(&app),
        }
    });
}
