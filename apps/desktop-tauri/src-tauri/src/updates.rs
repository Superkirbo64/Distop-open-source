//! Auto-update (etapa B3.6 del PLAN-PARIDAD.md): la política exacta de
//! apps/desktop/src/updates.ts sobre tauri-plugin-updater — comprobar al
//! arrancar y cada 4 horas contra GitHub Releases (el único canal que no
//! cuesta nada, §3), descargar en segundo plano, e instalar SOLO al salir.
//! Una actualización jamás interrumpe una llamada.
//!
//! Requiere que la release lleve `latest.json` (lo genera
//! scripts/make-latest-json.mjs) y que el build se firme con la clave privada
//! (TAURI_SIGNING_PRIVATE_KEY = ruta o contenido; la variante _PATH no
//! existe). Sin release publicada o sin red, la app funciona igual y se
//! reintenta en el siguiente ciclo — el mismo catch{} silencioso de updates.ts.

use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

const CHECK_EVERY: Duration = Duration::from_secs(4 * 60 * 60);

/// Actualización ya descargada, esperando a que la persona cierre la app.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>);

async fn check_once(app: &AppHandle) {
    let Ok(updater) = app.updater() else { return };
    let Ok(Some(update)) = updater.check().await else { return };
    // Descarga completa a memoria; la instalación espera a la salida.
    let Ok(bytes) = update.download(|_received, _total| {}, || {}).await else {
        return;
    };
    *app.state::<PendingUpdate>().0.lock().unwrap() = Some((update, bytes));
}

pub fn setup(app: &AppHandle) {
    // En desarrollo no hay paquete ni feed: no hay nada que comprobar.
    if cfg!(debug_assertions) {
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || loop {
        // Si ya hay una descargada, no se re-descarga: se instalará al salir.
        if handle.state::<PendingUpdate>().0.lock().unwrap().is_none() {
            tauri::async_runtime::block_on(check_once(&handle));
        }
        std::thread::sleep(CHECK_EVERY);
    });
}

/// Se llama desde RunEvent::Exit: instalar lo descargado, si lo hay
/// (el autoInstallOnAppQuit de electron-updater).
pub fn install_pending(app: &AppHandle) {
    let pending = app.state::<PendingUpdate>().0.lock().unwrap().take();
    if let Some((update, bytes)) = pending {
        let _ = update.install(bytes);
    }
}
