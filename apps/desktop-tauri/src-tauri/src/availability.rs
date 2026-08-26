//! Vigilancia de instancias para el cascarón Tauri (§2.2 del plan).
//!
//! Este fichero NO decide nada sobre disponibilidad ni sucesión. Solo arranca
//! el sidecar de Node que lleva el motor compartido, le pasa las órdenes y
//! convierte lo que responde en avisos del sistema y eventos para el cliente.
//!
//! La decisión de fondo, y el motivo de que aquí no haya lógica: verificar que
//! una comunidad "se trasladó" son firmas ES256 sobre JSON canónico, con la
//! época, el linaje y la cadena de certificados. Esas reglas viven en
//! `@distop/protocol` y las comparte el cascarón Electron. Reescribirlas en
//! Rust daría dos jueces distintos para la misma pregunta, y el día que uno se
//! corrigiera sin el otro, un cascarón diría "volvió" donde el otro dice "se
//! trasladó". Un sidecar cuesta memoria; dos verdades cuestan la comunidad.
//!
//! Por eso el proceso solo vive mientras hay algo que vigilar: quien no usa la
//! función no paga el `node.exe`.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use std::os::windows::process::CommandExt;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct AvailabilityRuntime(Arc<Mutex<Inner>>);

impl Default for AvailabilityRuntime {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Inner { child: None, stdin: None, generation: 0 })))
    }
}

struct Inner {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Sube en cada arranque: un lector de una generación vieja se calla solo.
    generation: u64,
}

/// Dónde vive el vigilante: en desarrollo el del repo, empaquetado el de recursos.
fn watcher_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("staging").join("watcher"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("watcher"))
            .map_err(|err| format!("sin carpeta de recursos: {err}"))
    }
}

/// El mismo Node del sidecar de "Hospedar aquí".
fn node_exe() -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join("node-x86_64-pc-windows-msvc.exe"))
    } else {
        let exe = std::env::current_exe().map_err(|err| err.to_string())?;
        let dir = exe.parent().ok_or("el ejecutable no tiene carpeta")?;
        Ok(dir.join("node.exe"))
    }
}

/// Arranca el sidecar si no estaba, y devuelve si hay con quién hablar.
fn ensure(app: &AppHandle) -> Result<(), String> {
    let runtime = app.state::<AvailabilityRuntime>();
    let inner = runtime.0.clone();
    {
        let guard = inner.lock().map_err(|_| "estado envenenado")?;
        if guard.stdin.is_some() {
            return Ok(());
        }
    }

    let dir = watcher_dir(app)?;
    let node = node_exe()?;
    if !node.exists() {
        return Err(format!("falta el runtime del sidecar: {}", node.display()));
    }

    let datos = app
        .path()
        .app_data_dir()
        .map_err(|err| format!("sin carpeta de datos: {err}"))?;
    std::fs::create_dir_all(&datos).map_err(|err| err.to_string())?;

    let mut child = Command::new(&node)
        .arg("main.ts")
        .current_dir(&dir)
        .env("DISTOP_WATCH_STATE", datos.join("availability-watch.json"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|err| format!("el vigilante no arrancó: {err}"))?;

    let stdin = child.stdin.take().ok_or("el vigilante no aceptó órdenes")?;
    let stdout = child.stdout.take().ok_or("el vigilante no respondió")?;

    let generation = {
        let mut guard = inner.lock().map_err(|_| "estado envenenado")?;
        guard.generation += 1;
        guard.child = Some(child);
        guard.stdin = Some(stdin);
        guard.generation
    };

    let handle = app.clone();
    let vigilado = inner.clone();
    std::thread::spawn(move || {
        for linea in BufReader::new(stdout).lines() {
            {
                let guard = match vigilado.lock() {
                    Ok(guard) => guard,
                    Err(_) => return,
                };
                // Un sidecar reemplazado deja su lector hablando por un muerto.
                if guard.generation != generation {
                    return;
                }
            }
            let Ok(linea) = linea else { return };
            let Ok(mensaje) = serde_json::from_str::<serde_json::Value>(&linea) else {
                continue;
            };
            match mensaje.get("event").and_then(|v| v.as_str()) {
                Some("notice") => {
                    if let Some(notice) = mensaje.get("notice") {
                        notify(&handle, notice);
                    }
                }
                Some("alert") => {
                    /* Sin ventana emergente, igual que en Electron: un conflicto
                       de identidad no se mira de reojo en una esquina mientras
                       haces otra cosa. Se guarda y lo enseña el cliente. */
                    let _ = handle.emit("availability:alert", mensaje.get("alert").cloned());
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// "Volvió" y "se trasladó" son dos avisos distintos, no dos matices del mismo:
/// el primero lleva a la dirección de siempre y el segundo a otro equipo.
fn notify(app: &AppHandle, notice: &serde_json::Value) {
    let nombre = notice.get("name").and_then(|v| v.as_str()).unwrap_or("Tu comunidad");
    let trasladada = notice.get("kind").and_then(|v| v.as_str()) == Some("moved");
    let cuerpo = if trasladada {
        format!("{nombre} se trasladó a otro equipo. Ábrelo para continuar allí.")
    } else {
        format!("{nombre} volvió a estar disponible.")
    };
    let destino = notice
        .get(if trasladada { "origin" } else { "url" })
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let _ = app.notification().builder().title("Distop").body(&cuerpo).show();

    /* La notificación de Tauri no trae clic con datos como la de Electron, así
       que el destino se manda igualmente al cliente: la ventana ya sabe a qué
       instancia llevar a quien la abra. */
    let _ = app.emit("availability:open", destino);
}

fn enviar(app: &AppHandle, orden: serde_json::Value) -> Result<(), String> {
    ensure(app)?;
    let runtime = app.state::<AvailabilityRuntime>();
    let mut guard = runtime.0.lock().map_err(|_| "estado envenenado")?;
    let stdin = guard.stdin.as_mut().ok_or("el vigilante no está escuchando")?;
    writeln!(stdin, "{orden}").map_err(|err| err.to_string())?;
    stdin.flush().map_err(|err| err.to_string())
}

/// Para el sidecar. Soltar su stdin es la señal: termina solo y sin matarlo.
fn detener(app: &AppHandle) {
    let runtime = app.state::<AvailabilityRuntime>();
    let Ok(mut guard) = runtime.0.lock() else { return };
    guard.stdin = None;
    if let Some(mut child) = guard.child.take() {
        let _ = child.wait();
    }
}

#[tauri::command]
pub fn availability_replace(app: AppHandle, items: Vec<serde_json::Value>) -> bool {
    /* Sin nada que vigilar no hace falta el proceso. Es la diferencia entre
       "la función existe" y "la función te cuesta memoria aunque no la uses". */
    if items.is_empty() {
        detener(&app);
        return true;
    }
    enviar(&app, serde_json::json!({ "cmd": "replace", "items": items })).is_ok()
}

#[tauri::command]
pub fn availability_status(app: AppHandle, url: String, connected: bool) {
    let _ = enviar(&app, serde_json::json!({ "cmd": "status", "url": url, "connected": connected }));
}

#[tauri::command]
pub fn availability_forget(app: AppHandle, url: String) -> bool {
    enviar(&app, serde_json::json!({ "cmd": "forget", "url": url })).is_ok()
}
