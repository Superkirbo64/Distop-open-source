//! "Hospedar aquí" (etapa B3.1 del PLAN-PARIDAD.md): el MISMO node-server que
//! usa el cascarón Electron, corriendo como sidecar con el Node oficial.
//!
//! Es el port línea a línea de apps/desktop/src/host.ts — mismos estados
//! (off|starting|on|error), mismo contrato HostStatus hacia el cliente, mismo
//! log de cola 200/ventana 40, mismo health check con deadline de 30s y mismo
//! puerto preferido — con una garantía extra que Electron no da: el proceso
//! hijo vive dentro de un Job Object con KILL_ON_JOB_CLOSE, así que ni un
//! crash del cascarón deja un node.exe huérfano sirviendo la comunidad.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Mientras la instancia esté "on", que Windows no la suspenda por
/// inactividad (§28.1: la máquina se dormía y el server se caía con ella).
/// Solo evita el sueño del sistema, no el apagado de pantalla.
fn keep_awake() {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED};
    unsafe {
        let _ = SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    }
}

fn allow_sleep() {
    use windows::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
    unsafe {
        let _ = SetThreadExecutionState(ES_CONTINUOUS);
    }
}
// El 5000 es solo la preferencia, nunca un requisito (port.ts): si está
// tomado, el sistema da otro libre.
const PREFERRED_PORT: u16 = 5000;
const HOST_ADDRESS: &str = "0.0.0.0";
const HEALTH_DEADLINE: Duration = Duration::from_secs(30);

#[derive(Clone, serde::Serialize)]
pub struct HostStatus {
    state: &'static str,
    url: String,
    error: String,
    /// Últimas líneas del servidor, para que un fallo no sea un misterio (§26).
    log: Vec<String>,
}

pub struct HostRuntime(Arc<Mutex<HostInner>>);

impl Default for HostRuntime {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(HostInner {
            state: "off",
            url: String::new(),
            error: String::new(),
            log: VecDeque::new(),
            child: None,
            _job: None,
            generation: 0,
        })))
    }
}

struct HostInner {
    state: &'static str,
    url: String,
    error: String,
    log: VecDeque<String>,
    child: Option<Child>,
    /// Vivo mientras el server corre: soltarlo mata al hijo (kill-on-close).
    _job: Option<win32job::Job>,
    /// Cada arranque es una generación: los hilos de un server anterior que
    /// despierten tarde reconocen que ya no hablan del proceso actual.
    generation: u64,
}

impl HostInner {
    fn snapshot(&self) -> HostStatus {
        HostStatus {
            state: self.state,
            url: if self.state == "on" { self.url.clone() } else { String::new() },
            error: self.error.clone(),
            log: self.log.iter().rev().take(40).rev().cloned().collect(),
        }
    }

    fn remember(&mut self, chunk: &str) {
        for piece in chunk.split('\n') {
            let text = piece.trim_end();
            if !text.is_empty() {
                self.log.push_back(text.to_string());
            }
        }
        while self.log.len() > 200 {
            self.log.pop_front();
        }
    }
}

fn emit(app: &AppHandle, status: &HostStatus) {
    // Solo la vista Distop recibe el estado, como en Electron (main.ts:253).
    let _ = app.emit_to("distop", "host:status", status.clone());
}

fn set_state(app: &AppHandle, inner: &mut HostInner, state: &'static str, error: String) -> HostStatus {
    inner.state = state;
    inner.error = error;
    let status = inner.snapshot();
    emit(app, &status);
    status
}

/// Dónde vive el server: en desarrollo el del repo (idéntico a Electron dev);
/// empaquetado, la copia de staging bajo los recursos del instalador.
fn server_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("node-server"))
    } else {
        app.path()
            .resource_dir()
            .map(|dir| dir.join("node-server"))
            .map_err(|err| format!("sin carpeta de recursos: {err}"))
    }
}

/// El Node oficial del sidecar. Empaquetado, Tauri lo deja junto al ejecutable
/// como node.exe (externalBin sin el target triple).
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

/// Puerto libre, prefiriendo `preferred` (la semántica de port.ts: se
/// comprueba abriéndolo de verdad, y con el 0 elige el sistema).
fn free_port(preferred: u16) -> Result<u16, String> {
    if let Ok(probe) = TcpListener::bind((HOST_ADDRESS, preferred)) {
        if let Ok(addr) = probe.local_addr() {
            return Ok(addr.port());
        }
    }
    TcpListener::bind((HOST_ADDRESS, 0))
        .and_then(|probe| probe.local_addr())
        .map(|addr| addr.port())
        .map_err(|_| "No hay ningún puerto libre en este equipo.".to_string())
}

/// GET /health a mano: 20 líneas de TCP evitan arrastrar un cliente HTTP
/// entero al cascarón por una comprobación de un solo endpoint.
fn health_ok(port: u16) -> bool {
    let address = format!("127.0.0.1:{port}");
    let Ok(parsed) = address.parse() else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&parsed, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let request = format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 32];
    let Ok(count) = stream.read(&mut head) else { return false };
    String::from_utf8_lossy(&head[..count]).contains(" 200")
}

/// El hijo dentro de un Job con kill-on-close: si este proceso muere de
/// cualquier manera, Windows cierra el handle del Job y mata al server.
fn confine(child: &Child) -> Result<win32job::Job, String> {
    let job = win32job::Job::create().map_err(|err| err.to_string())?;
    let mut info = job.query_extended_limit_info().map_err(|err| err.to_string())?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&info).map_err(|err| err.to_string())?;
    job.assign_process(child.as_raw_handle() as isize)
        .map_err(|err| err.to_string())?;
    Ok(job)
}

pub fn status(app: &AppHandle) -> HostStatus {
    app.state::<HostRuntime>().0.lock().unwrap().snapshot()
}

pub fn stop(app: &AppHandle) -> HostStatus {
    let runtime = app.state::<HostRuntime>();
    let child = {
        let mut inner = runtime.0.lock().unwrap();
        let child = inner.child.take();
        inner._job = None;
        set_state(app, &mut inner, "off", String::new());
        child
    };
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
    allow_sleep();
    status(app)
}

/// Arranque completo, bloqueante (se llama desde spawn_blocking): la promesa
/// del cliente se resuelve con el estado final, igual que host.start() de
/// Electron. La secuencia es host.ts:78-128 tal cual.
pub fn start(app: &AppHandle) -> HostStatus {
    let runtime = app.state::<HostRuntime>();
    let shared = runtime.0.clone();

    // Ya corriendo o arrancando: se devuelve lo que hay, sin segundo proceso.
    {
        let mut inner = shared.lock().unwrap();
        if inner.state == "on" || inner.state == "starting" {
            return inner.snapshot();
        }
        set_state(app, &mut inner, "starting", String::new());
    }

    let fail = |message: String| -> HostStatus {
        allow_sleep();
        let mut inner = shared.lock().unwrap();
        inner.child = None;
        inner._job = None;
        set_state(app, &mut inner, "error", message)
    };

    let data_dir = match app.path().app_config_dir() {
        Ok(dir) => dir.join("instance").join("data"),
        Err(err) => return fail(format!("sin carpeta de datos: {err}")),
    };
    if let Err(err) = std::fs::create_dir_all(&data_dir) {
        return fail(format!("no se pudo crear {}: {err}", data_dir.display()));
    }
    let server = match server_dir(app) {
        Ok(dir) => dir,
        Err(err) => return fail(err),
    };
    let node = match node_exe() {
        Ok(path) if path.exists() => path,
        Ok(path) => return fail(format!("falta el runtime del sidecar: {}", path.display())),
        Err(err) => return fail(err),
    };
    let port = match free_port(PREFERRED_PORT) {
        Ok(port) => port,
        Err(err) => return fail(err),
    };

    let spawned = Command::new(&node)
        .arg("server.ts")
        .current_dir(&server)
        .env("PORT", port.to_string())
        .env("HOST", HOST_ADDRESS)
        .env("DATABASE_PATH", data_dir.join("app.db"))
        .env("DEFAULT_STORAGE_PATH", data_dir.join("uploads"))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => return fail(format!("la instancia no arrancó: {err}")),
    };

    let job = match confine(&child) {
        Ok(job) => job,
        Err(err) => {
            let _ = child.kill();
            return fail(format!("sin Job Object para la instancia: {err}"));
        }
    };

    // stdout y stderr del server → el log del estado, línea a línea.
    for pipe in [
        child.stdout.take().map(|out| Box::new(out) as Box<dyn std::io::Read + Send>),
        child.stderr.take().map(|err| Box::new(err) as Box<dyn std::io::Read + Send>),
    ]
    .into_iter()
    .flatten()
    {
        let sink = shared.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                sink.lock().unwrap().remember(&line);
            }
        });
    }

    let generation = {
        let mut inner = shared.lock().unwrap();
        inner.generation += 1;
        inner.url = format!("http://127.0.0.1:{port}");
        inner.child = Some(child);
        inner._job = Some(job);
        inner.generation
    };

    // Vigía de salida: morir sin que nadie lo pidiera es un fallo, y el porqué
    // está en el log (host.ts:111-116).
    {
        let watched = shared.clone();
        let watcher_app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));
            let mut inner = watched.lock().unwrap();
            if inner.generation != generation {
                return;
            }
            let Some(child) = inner.child.as_mut() else { return };
            match child.try_wait() {
                Ok(Some(code)) => {
                    inner.child = None;
                    inner._job = None;
                    allow_sleep();
                    if inner.state != "off" {
                        let exit = code.code().map(|c| c.to_string()).unwrap_or_else(|| "?".into());
                        set_state(
                            &watcher_app,
                            &mut inner,
                            "error",
                            format!("La instancia terminó con código {exit}."),
                        );
                    }
                    return;
                }
                Ok(None) => {}
                Err(_) => return,
            }
        });
    }

    // Health check con plazo: el server tarda lo que tarde en abrir su base y
    // escuchar; se pregunta hasta 30s antes de rendirse.
    let deadline = Instant::now() + HEALTH_DEADLINE;
    let healthy = loop {
        if Instant::now() >= deadline {
            break false;
        }
        {
            let inner = shared.lock().unwrap();
            if inner.generation != generation || inner.child.is_none() {
                // Murió mientras arrancaba: el vigía ya puso el error.
                return inner.snapshot();
            }
        }
        if health_ok(port) {
            break true;
        }
        std::thread::sleep(Duration::from_millis(400));
    };

    let mut inner = shared.lock().unwrap();
    if inner.generation != generation {
        return inner.snapshot();
    }
    if !healthy {
        if let Some(mut child) = inner.child.take() {
            let _ = child.kill();
        }
        inner._job = None;
        allow_sleep();
        return set_state(app, &mut inner, "error", "La instancia no respondió a /health en 30 segundos.".into());
    }
    keep_awake();
    set_state(app, &mut inner, "on", String::new())
}
