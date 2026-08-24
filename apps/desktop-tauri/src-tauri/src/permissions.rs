//! Permisos de WebView2 (etapa B3.2 del PLAN-PARIDAD.md): el port de la
//! postura de security.ts — lista blanca, y lo demás denegado sin preguntar.
//!
//! Electron concede por `GRANTED` (media, notificaciones…) en la sesión por
//! defecto y las webs huésped viven en particiones sin handler (= permitir).
//! Aquí quedamos igual de funcionales y MÁS estrictos: el cliente Distop
//! recibe micrófono/cámara/notificaciones sin prompts (sus llamadas de voz no
//! le preguntan a nadie), y un huésped SOLO los recibe para su propio dominio
//! de la allowlist — cualquier otra petición muere en silencio. De paso se
//! esquiva el fallo conocido del prompt de WebView2 ("bloquear" no tiene
//! vuelta atrás): al decidir nosotros, el prompt no existe.

use tauri::webview::Webview;
use webview2_com::take_pwstr;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
    COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS,
    COREWEBVIEW2_PERMISSION_STATE_ALLOW, COREWEBVIEW2_PERMISSION_STATE_DENY,
};
use webview2_com::{NewWindowRequestedEventHandler, PermissionRequestedEventHandler};
use windows::core::PWSTR;

/// De quién es la vista: el cliente Distop (permisos de la app) o una web
/// ajena (solo lo suyo, y solo en su dominio).
#[derive(Clone, Copy)]
pub enum Who {
    Client,
    Guest(&'static [&'static str]),
}

/// Host de una URL sin arrastrar un parser entero: esquema fuera, autoridad
/// hasta el primer separador, credenciales y puerto fuera.
fn host_of(uri: &str) -> &str {
    let rest = uri.split_once("://").map(|(_, rest)| rest).unwrap_or(uri);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host = authority.rsplit('@').next().unwrap_or(authority);
    host.split(':').next().unwrap_or(host)
}

pub fn harden(webview: &Webview, who: Who) {
    let _ = webview.with_webview(move |platform| {
        #[cfg(windows)]
        unsafe {
            let Ok(core) = platform.controller().CoreWebView2() else {
                return;
            };
            let handler = PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                // La lista de security.ts:13 traducida: "media" son micrófono
                // y cámara; las notificaciones, ellas mismas. La captura de
                // pantalla no pasa por aquí (tiene su propio selector) y la
                // pantalla completa no es permiso en WebView2.
                let wanted = kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                    || kind == COREWEBVIEW2_PERMISSION_KIND_NOTIFICATIONS;
                let allowed = wanted
                    && match who {
                        Who::Client => true,
                        Who::Guest(hosts) => {
                            let mut uri = PWSTR::null();
                            args.Uri(&mut uri)?;
                            let uri = take_pwstr(uri);
                            let host = host_of(&uri);
                            hosts.iter().any(|allowed| *allowed == host)
                        }
                    };
                args.SetState(if allowed {
                    COREWEBVIEW2_PERMISSION_STATE_ALLOW
                } else {
                    COREWEBVIEW2_PERMISSION_STATE_DENY
                })
            }));
            let mut token = 0i64;
            let _ = core.add_PermissionRequested(&handler, &mut token);

            /* Ventanas nuevas: la política de hardenWindow (security.ts:34-40)
               y de las vistas huésped (apps.ts:69-77) — un enlace de un
               mensaje (o un target=_blank de WhatsApp) abre en el navegador
               del sistema, JAMÁS en una ventana con acceso a nada nuestro.
               Esquemas raros (file:, app:), ni eso. */
            let windows = NewWindowRequestedEventHandler::create(Box::new(|_sender, args| {
                let Some(args) = args else { return Ok(()) };
                args.SetHandled(true)?;
                let mut uri = PWSTR::null();
                args.Uri(&mut uri)?;
                let uri = take_pwstr(uri);
                if uri.starts_with("https://") || uri.starts_with("http://") {
                    let _ = tauri_plugin_opener::open_url(uri, None::<String>);
                }
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_NewWindowRequested(&windows, &mut token);
        }
    });
}
