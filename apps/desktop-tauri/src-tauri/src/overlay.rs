//! Widget de llamada para Windows (etapa B3.3 del PLAN-PARIDAD.md): el port
//! de apps/desktop/src/voice-overlay.ts, sirviendo EL MISMO voice-overlay.html
//! (una sola fuente para los dos cascarones — si el widget cambia, cambia en
//! ambos). Mismas reglas: es otra ventana en vez de inyectarse en el juego
//! (ni toca procesos ajenos ni dispara anticheats), nace con la primera
//! llamada, muere al colgar, y solo aparece cuando la ventana principal está
//! minimizada u oculta.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};

/// El MISMO HTML que usa Electron (apps/desktop/src/voice-overlay.html).
pub const OVERLAY_HTML: &str = include_str!("../../../desktop/src/voice-overlay.html");

const OVERLAY_LABEL: &str = "voice-overlay";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    id: String,
    name: String,
    avatar_url: Option<String>,
    speaking: bool,
    muted: bool,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayState {
    channel_id: Option<String>,
    channel_name: String,
    participants: Vec<Participant>,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self { channel_id: None, channel_name: String::new(), participants: Vec::new() }
    }
}

#[derive(Default)]
pub struct OverlayRuntime(pub Mutex<OverlayState>);

fn clean_text(value: Option<&serde_json::Value>, max: usize) -> String {
    value
        .and_then(|v| v.as_str())
        .map(|s| s.trim().chars().take(max).collect())
        .unwrap_or_default()
}

fn clean_avatar(value: Option<&serde_json::Value>) -> Option<String> {
    let text = value?.as_str()?;
    if text.len() > 2_048 {
        return None;
    }
    let lower = text.to_ascii_lowercase();
    let ok = lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("app://distop/")
        || ["png", "jpeg", "jpg", "webp", "gif"]
            .iter()
            .any(|kind| lower.starts_with(&format!("data:image/{kind};base64,")));
    ok.then(|| text.to_string())
}

/// El port de cleanState (voice-overlay.ts:29-52): nada del renderer se pinta
/// en una ventana que flota sobre otras aplicaciones sin pasar por aquí.
fn clean_state(raw: &serde_json::Value) -> OverlayState {
    let participants = raw
        .get("participants")
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .take(24)
                .filter_map(|item| {
                    let id = clean_text(item.get("id"), 80);
                    let name = clean_text(item.get("name"), 80);
                    if id.is_empty() || name.is_empty() {
                        return None;
                    }
                    Some(Participant {
                        id,
                        name,
                        avatar_url: clean_avatar(item.get("avatarUrl")),
                        speaking: item.get("speaking").and_then(|v| v.as_bool()) == Some(true),
                        muted: item.get("muted").and_then(|v| v.as_bool()) == Some(true),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let channel_id = clean_text(raw.get("channelId"), 80);
    OverlayState {
        channel_id: (!channel_id.is_empty()).then_some(channel_id),
        channel_name: clean_text(raw.get("channelName"), 80),
        participants,
    }
}

/// ¿Toca verse? En llamada, con gente, y con la principal fuera de la vista
/// (minimizada u oculta) — voice-overlay.ts:103-104.
fn should_show(app: &AppHandle, state: &OverlayState) -> bool {
    let Some(main) = app.get_window("main") else { return false };
    let hidden = main.is_minimized().unwrap_or(false) || !main.is_visible().unwrap_or(true);
    state.channel_id.is_some() && !state.participants.is_empty() && hidden
}

/// Esquina superior izquierda del área de trabajo del monitor donde vive la
/// ventana principal, con alto proporcional a la gente (voice-overlay.ts:106-111).
fn place(app: &AppHandle, state: &OverlayState) {
    let Some(overlay) = app.get_window(OVERLAY_LABEL) else { return };
    let Some(main) = app.get_window("main") else { return };
    let Ok(Some(monitor)) = main.current_monitor() else { return };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let x = area.position.x as f64 / scale;
    let y = area.position.y as f64 / scale;
    let width = area.size.width as f64 / scale;
    let height = area.size.height as f64 / scale;
    let wanted = (28 + state.participants.len() * 54) as f64;
    let overlay_height = wanted.max(80.0).min((height - 72.0).max(80.0));
    let _ = overlay.set_position(LogicalPosition::new(x + 22.0, y + 48.0));
    let _ = overlay.set_size(LogicalSize::new(284.0_f64.min(width - 44.0), overlay_height));
}

/// Reevalúa visibilidad y contenido. Se llama al recibir estado y cuando la
/// ventana principal cambia (minimizar, restaurar, ocultar a bandeja).
pub fn refresh(app: &AppHandle) {
    let Some(overlay) = app.get_window(OVERLAY_LABEL) else { return };
    let state = app.state::<OverlayRuntime>().0.lock().unwrap().clone();
    if !should_show(app, &state) {
        let _ = overlay.hide();
        return;
    }
    place(app, &state);
    let _ = app.emit_to(OVERLAY_LABEL, "voice-overlay:state", state);
    let _ = overlay.show();
}

fn create_window(app: &AppHandle) {
    let builder = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::CustomProtocol("overlay://localhost".parse().expect("url overlay")),
    )
    .title("Distop — llamada")
    .inner_size(284.0, 120.0)
    .visible(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .focused(false)
    .focusable(false)
    .resizable(false)
    .minimizable(false)
    .maximizable(false)
    .closable(false)
    .skip_taskbar(true)
    .shadow(false)
    // El HTML espera window.voiceOverlay.onState (el preload de Electron);
    // aquí el mismo contrato son dos líneas sobre el bus de eventos.
    .initialization_script(
        r#"window.voiceOverlay = {
             onState: (callback) => {
               window.__TAURI__.event.listen("voice-overlay:state", (event) => callback(event.payload));
             },
           };"#,
    )
    // Al crearse en plena llamada, el primer estado pudo emitirse antes de
    // que la página escuchara: al terminar de cargar se reenvía el último
    // (el mismo apaño que did-finish-load en voice-overlay.ts:126-128).
    .on_page_load(|window, _payload| {
        let app = window.app_handle().clone();
        let state = app.state::<OverlayRuntime>().0.lock().unwrap().clone();
        let _ = app.emit_to(OVERLAY_LABEL, "voice-overlay:state", state);
    });

    match builder.build() {
        Ok(window) => {
            // Los clics la atraviesan: es un letrero, no una ventana de verdad.
            let _ = window.set_ignore_cursor_events(true);
        }
        Err(err) => eprintln!("distop: overlay no creado: {err}"),
    }
}

/// Entrada única desde el cliente (overlay_update en main.rs). En llamada
/// crea/actualiza; al colgar destruye — su renderer solo existe mientras hay
/// algo que mostrar (la regla que ganó RAM en Electron).
pub fn update(app: &AppHandle, raw: serde_json::Value) {
    let state = clean_state(&raw);
    let in_call = state.channel_id.is_some();
    *app.state::<OverlayRuntime>().0.lock().unwrap() = state;

    let exists = app.get_window(OVERLAY_LABEL).is_some();
    if !exists {
        if !in_call {
            return;
        }
        create_window(app);
    } else if !in_call {
        if let Some(overlay) = app.get_window(OVERLAY_LABEL) {
            let _ = overlay.destroy();
        }
        return;
    }
    refresh(app);
}
