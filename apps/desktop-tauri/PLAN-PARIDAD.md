# Plan B3/B4 — Paridad TOTAL del cascarón Tauri con Electron

> **ESTADO (2026-08-24): B3 IMPLEMENTADO ENTERO** — las siete etapas B3.1→B3.7
> están en código, compilan y las críticas se verificaron en runtime por CDP:
> hospedar (server on + Job Object matando huérfanos), permisos COM
> (getUserMedia sin prompt), overlay (nace/pinta/muere), juegos en Rust
> (129 procesos sin tasklist), toggles y prefs. Queda el corte B4 (§7): smoke
> interactivo de voz/captura, medición A/B, migración de datos, release con
> latest.json y beta. Detalle por pieza en el README.

> **META**: que la app Tauri haga EXACTAMENTE lo mismo que la Electron —hospedar,
> voz, captura de pantalla, overlay, bandeja, juegos, updater, todo— consumiendo
> menos RAM. Nada recortado, nada "beta para siempre". Cuando este plan termine,
> el instalador Tauri REEMPLAZA al de Electron como release para usuarios.

## 0. Respuesta directa a las tres preguntas

**¿Es posible?** Sí. La evidencia decisiva:
- El cascarón Electron entero son ~2.150 líneas en 10 módulos ya inventariados
  función por función (§2) — TODO lo demás es el cliente web compartido, que ya
  corre en Tauri (B2 verificado en runtime).
- El contrato completo entre cascarón y cliente es UNA superficie tipada:
  `window.distop` en `apps/web/src/lib/instance.ts:49-95` — 4 grupos (host,
  games, apps, overlay). `apps` ya está portado; los otros 3 tienen equivalente
  Tauri verificado abajo.
- Las dos dudas históricas de WebView2 están resueltas: `getDisplayMedia`
  (compartir pantalla) está soportado con selector propio del sistema y evento
  `ScreenCaptureStarting` documentado por Microsoft; el micrófono funciona vía
  `PermissionRequested` (acceso COM desde Tauri con `with_webview`).
- La pieza que Tauri no trae (el runtime Node del node-server) se resuelve con
  sidecar del Node oficial: el MISMO server.ts, sin port, sin bifurcación (§3).

**¿Cómo?** Etapas B3.1→B3.7 ordenadas por riesgo (lo incierto primero, para
fallar barato), cada una con gate de salida, fallback definido de antemano y
tope de intentos (§5). Ninguna etapa inventa lógica nueva: cada una PORTA un
módulo concreto de `apps/desktop/src/*` cuya semántica ya está escrita y testeada.

**¿Puedo hacerlo?** Sí. Ya está hecho el ~25%: toolchain Rust+MSVC instalado,
multi-webview funcionando, huéspedes con allowlist y toggles verificados por
CDP, protocolo de assets con CSP, instalador NSIS que compila. Estimación de
trabajo activo restante: **10-15 días** + 2 semanas de beta (B4).

---

## 1. Principio rector: paridad por contrato, no por imitación

- **El cliente web no debe distinguir cascarón.** `instance.ts` es el contrato:
  cada función de `window.distop` existe con los mismos tipos y la misma
  semántica. Cero cambios en apps/web por culpa de Tauri (los tipos ya son los
  correctos; `apps?`/`watch?` opcionales quedan obligatorios al final de B3).
- **El node-server es EL MISMO**, no un port: mismos .ts, mismos 68 tests, mismo
  túnel (cloudflared/tailscale viven DENTRO del server — `tunnel.ts`,
  `tailscale.ts` — así que hospedar con URL pública viaja gratis con el sidecar).
- **Los invariantes de seguridad del plan madre no se negocian**: allowlist de
  permisos idéntica a `GRANTED` (security.ts:13), navegación cerrada, CSP,
  enlaces externos al navegador del sistema, sidecar sin privilegios, huéspedes
  sin capabilities de Tauri (ya así en B2).

## 2. Inventario de paridad (todo lo que hace Electron, con su equivalente)

| # | Feature Electron (evidencia) | Equivalente Tauri | Estado |
|---|------------------------------|-------------------|--------|
| 1 | Franja + multi-webview + huéspedes lazy con allowlist y UA limpio (apps.ts) | `add_child` + `on_navigation` | **HECHO (B2)** |
| 2 | Toggles WhatsApp/Telegram, prefs JSON, destruir vista (main.ts:235-244) | comandos async + `view.close()` | **HECHO (B2)** |
| 3 | Cliente web servido con CSP (protocol.ts) | `WebviewUrl::App` + CSP en tauri.conf | **HECHO (B2)** |
| 4 | **Hospedar**: utilityProcess.fork del server.ts con Node 24 embebido (host.ts:95) | **Sidecar Node oficial** (§3) | B3.1 |
| 5 | Voz WebRTC + micrófono (permiso "media" auto-concedido, security.ts:13) | `PermissionRequested` vía COM: auto-grant solo en la vista distop (§4) | B3.2 |
| 6 | Compartir pantalla: setDisplayMediaRequestHandler + picker propio (picker.ts) | `getDisplayMedia` nativo de WebView2 (selector del sistema, mismo nivel de elección) | B3.2 |
| 7 | Overlay de voz transparente always-on-top click-through (voice-overlay.ts) | `WindowBuilder` transparent + always_on_top + `set_ignore_cursor_events` | B3.3 |
| 8 | Bandeja + cerrar-a-bandeja + "Iniciar con Windows" (tray.ts) | `TrayIconBuilder` (built-in) + plugin autostart + interceptar CloseRequested | B3.4 |
| 9 | Single instance (main.ts:45) | plugin single-instance | B3.4 |
| 10 | Splash transparente con mínimo 3.05s (main.ts:75-138) | ventana transparente + evento del cliente al cargar | B3.4 |
| 11 | Game watch: tasklist+registro cada 12s, catálogo games.json (games.ts) | **Port a Rust con sysinfo+winreg — MEJORA: sin spawn de tasklist.exe** | B3.5 |
| 12 | Auto-update contra GitHub Releases (updates.ts) | plugin updater + latest.json firmado en la misma release | B3.6 |
| 13 | F11 fullscreen desde cualquier vista (main.ts:63-73,184-192) | script de inicialización en las 4 webviews → `invoke("toggle_fullscreen")` | B3.7 |
| 14 | Notificaciones web (notify.ts usa `Notification` estándar) | WebView2 soporta Notification API (permiso auto-grant §4); fallback: shim → plugin notification | B3.7 |
| 15 | window.open deny + enlaces http(s) al navegador (security.ts:34-47) | `on_navigation` (hecho) + NewWindowRequested vía COM / plugin opener | B3.7 |
| 16 | AppUserModelId, iconos, título (main.ts:31-33) | tauri.conf (identifier ya fijado com.distop.tauri) | B3.7 |
| 17 | Métricas DISTOP_METRICS (main.ts:297-308) | sysinfo: procesos msedgewebview2 filtrados por `--user-data-folder` + sidecar + propio | B3.7 |
| 18 | backgroundThrottling dinámico en llamada (main.ts:274-277) | WebView2 ya throttlea timers oculto; en llamada la vista está visible → paridad de facto. Experimento post-paridad: `TrySuspend`/MemoryUsageTargetLevel al minimizar (NUNCA en mensajerías — decisión de usuario: sin hibernación) | B3.7 |

Sin equivalente 1:1 asumido a ciegas — los 3 puntos que dependen de APIs COM
(5, 14, 15) tienen verificación en spike y fallback escrito (§6).

## 3. B3.1 — Hospedar: sidecar del Node oficial (la pieza gorda)

**Decisión: Node oficial como sidecar. Rechazados con motivo:**
- *Port del server a Rust*: bifurca el producto (el server self-hosted seguiría
  en Node), invalida 68 tests, semanas de riesgo. NO.
- *Node SEA (ejecutable único)*: exige entrada CommonJS (el server es ESM), no
  ahorra peso (el binario ES Node entero). NO.
- *Bun/Deno*: compatibilidad de `node:sqlite`/`ws`/streams no garantizada al
  100% — "casi el mismo server" no es el mismo server. NO.

**Cómo (todo es la semántica de host.ts:78-136 portada línea a línea):**
1. **Runtime**: `node.exe` oficial v24 LTS win-x64 como `bundle > externalBin`
   (nombre con target triple: `binaries/node-x86_64-pc-windows-msvc.exe`).
   Node 24 ejecuta los .ts por type stripping — exactamente igual que hoy con
   el Node de Electron. Pesa ~85MB (≈28-30MB comprimido en NSIS).
2. **Server**: mismos ficheros que empaqueta electron-builder.yml:34-45 —
   `*.ts` + package.json del node-server, `@distop/protocol` transpilado
   (reusar `scripts/stage-protocol.mjs`) y `ws` bajo node_modules, como
   `bundle > resources`.
3. **Arranque** (comando `host_start`, async): puerto libre desde 5000 (port
   del pequeño port.ts), spawn del sidecar con env `PORT/HOST/DATABASE_PATH/
   DEFAULT_STORAGE_PATH`, poll a `/health` con deadline 30s, estados
   `off|starting|on|error` + ring buffer de 200 líneas de log → evento
   `host:status` al cliente. Idéntico contrato `HostStatus`.
4. **Ciclo de vida**: matar al salir (RunEvent::ExitRequested) Y **Job Object
   de Windows con KILL_ON_JOB_CLOSE** — más fuerte que Electron: ni un crash
   del cascarón deja un node.exe huérfano sirviendo. Spawn con CREATE_NO_WINDOW
   (sin consola fantasma).
5. **Datos durante la coexistencia**: la beta Tauri usa SU carpeta
   (`%APPDATA%/com.distop.tauri/instance/data`) — dos apps apuntando al mismo
   app.db serían corrupción esperando turno (SQLite + dos servers). En B4, al
   reemplazar a Electron, herramienta de migración: con Electron cerrado,
   copiar `app.db` + `uploads/` + verificación de integridad (principio §21
   del claude.md: los datos son del usuario, exportables siempre).

**Gate B3.1**: instalador total < 60MB · arranque a `on` < 3s · crear
comunidad + invitación + mensajes desde la app Tauri · matar el proceso
cascarón a lo bruto no deja node.exe vivo · el log de un fallo se ve en la UI.

## 4. B3.2 — Voz y captura (permisos WebView2 de verdad)

Electron concede por lista blanca (`GRANTED`: media, notifications, fullscreen,
clipboard-sanitized-write, display-capture) y deniega el resto sin preguntar.
Paridad exacta en Tauri:
- Vía `webview.with_webview()` se llega al `ICoreWebView2` (crate
  `webview2-com`, la que Tauri ya usa por debajo) y se registra
  `add_PermissionRequested`: **auto-conceder mic/cámara/notificaciones/
  clipboard SOLO en la vista `distop`; denegar TODO en whatsapp/telegram**
  (hoy Electron les aplica el mismo handler de sesión; aquí quedamos MÁS
  estrictos, y de paso se esquiva el bug conocido de "bloqueado para siempre"
  de la prompt de WebView2).
- **Compartir pantalla**: `getDisplayMedia()` está soportado en WebView2 con
  selector propio del sistema (pantallas + ventanas + checkbox de audio del
  sistema — mismo nivel de elección que el picker de picker.ts; el evento
  `ScreenCaptureStarting` permite gobernarlo). No se reimplementa el picker
  visual de Electron: el del sistema da la misma función con cero código.
- **Verificar en spike (2 intentos máx cada uno)**: (a) llamada de voz completa
  entre Tauri y Electron contra la misma instancia; (b) compartir pantalla con
  audio loopback; (c) autoplay de sonidos (args de navegador
  `--autoplay-policy=no-user-gesture-required` vía `additionalBrowserArgs`).

**Gate B3.2**: llamada bidireccional Tauri↔Electron con voz audible en ambos
sentidos · compartir pantalla visible desde el otro extremo · mute/deafen ·
reconexión al colgar y volver.

## 5. B3.3→B3.7 — el resto, por orden de riesgo

- **B3.3 Overlay de voz** (2 días): ventana `transparent(true).always_on_top
  (true).skip_taskbar(true).focusable(false)` + `set_ignore_cursor_events
  (true)`; reusar `voice-overlay.html` tal cual por protocolo propio; portar
  `cleanState` (sanitización) a Rust; posicionamiento con los Monitor APIs
  (paridad de `place()`); nace con el primer `overlay_update` con channelId y
  muere al colgar — la MISMA regla lazy que ya ganó RAM en Electron.
- **B3.4 Bandeja + arranque** (1-2 días): TrayIconBuilder con menú (Abrir /
  Iniciar con Windows checkbox / Salir), CloseRequested → hide (cerrar no mata
  la comunidad hospedada — la razón de ser de tray.ts), plugin single-instance
  (segunda instancia → restaurar ventana), plugin autostart, splash
  transparente con el mismo mínimo de 3.05s y reveal cuando el cliente cargó.
- **B3.5 Game watch en Rust** (1-2 días): port de games.ts con `sysinfo`
  (procesos, sin spawn de tasklist.exe cada 12s — mejora objetiva de CPU/RAM
  sobre Electron) + `winreg` (Steam RunningAppID) + el mismo games.json como
  resource con caché por mtime; comandos `games_current/scan/watch/set_watch`
  + evento `games:change`; respeta el toggle gameWatch de desktop-prefs.json.
- **B3.6 Updater** (1-2 días): plugin updater firmando el NSIS (claves
  minisign), `latest.json` subido a la MISMA GitHub Release que ya publica
  electron-builder (coste cero, §3 del claude.md); comprobar al arrancar y cada
  4h; descargar y aplicar al cerrar — la política exacta de updates.ts (jamás
  interrumpir una llamada).
- **B3.7 Pulido de paridad** (2-3 días): F11 en las 4 vistas (script de
  inicialización → `toggle_fullscreen`), notificaciones (probar Notification
  API nativa de WebView2; si no llega a toast de Windows, shim transparente →
  plugin notification — el cliente no se entera), política de ventanas nuevas
  (NewWindowRequested → navegador del sistema), métricas `DISTOP_METRICS`
  equivalentes (atribución por `--user-data-folder`, ya anotado en memoria),
  quitar los `?` de `apps`/`watch` en instance.ts cuando ambos cascarones los
  expongan.

**Topes anti-bucle (heredados del plan madre, obligatorios)**: cada etapa tiene
timebox (arriba); cada incógnita técnica 2 intentos máximo y luego fallback
documentado (§6); si un fallback tampoco entra en presupuesto, la etapa se
marca bloqueada con informe y se sigue con la siguiente — el plan entero se
re-evalúa al final de B3, no en mitad de una madriguera.

## 6. Fallbacks escritos ANTES de necesitarlos

| Riesgo | Probabilidad | Fallback |
|--------|--------------|----------|
| PermissionRequested COM no accesible desde `with_webview` | Baja (webview2-com es la base de wry) | Prompt nativa de WebView2 (funciona; pierde solo el auto-grant) |
| getDisplayMedia sin audio loopback | Media | Compartir sin audio de sistema (aviso honesto en UI) hasta soporte del runtime |
| Notification API no llega a toast de Windows | Media | Shim `Notification` por script de inicialización → plugin notification (idéntico para el cliente) |
| Transparencia del overlay falla en algún driver | Baja | Fondo sólido oscuro con esquinas redondeadas (mismo widget, sin cristal) |
| Sidecar Node > 60MB instalador | Ya medido ~28-30MB comprimido | — (si Node engordara: descargar runtime al primer "Hospedar", como hace el propio cliente con emojis) |
| Antivirus marca node.exe renombrado | Media | Es el binario oficial con hash publicado; firmarlo con la firma del updater; documentar |

## 7. B4 — Criterio de corte (cuándo Tauri REEMPLAZA a Electron)

1. **Checklist funcional completa**: los 12 puntos del "éxito del MVP" (§37 del
   claude.md) ejecutados enteros en la app Tauri, más: llamada con pantalla
   compartida, overlay sobre juego en ventana, update automático real entre dos
   versiones publicadas, migración de datos desde Electron verificada.
2. **Seguridad**: revisión contra los invariantes (§1) + `/code-review`.
3. **RAM medida** (protocolo del plan madre: 3 repeticiones, mediana, mismos 4
   escenarios): **Tauri ≤ Electron optimizado − 100MB** en cada escenario.
   Atribución por user-data-folder (WebView2 comparte procesos entre apps).
4. **2 semanas de beta** con ambos instaladores publicados sin regresión
   reportada.
   Solo entonces: la release por defecto pasa a ser Tauri, Electron queda un
   ciclo más como "legacy" y luego se archiva.

## 8. Estimación honesta (a validar midiendo, regla ECC)

| Escenario | Electron optimizado | Tauri en paridad |
|-----------|--------------------|------------------|
| Instalador | 93.1MB | **~45-50MB** (12.7 actual + ~30 Node + recursos) |
| Uso normal (solo Distop) | ~300-420MB | **~180-280MB** |
| Hospedando | + ~60-150MB (server) | + lo MISMO (es el mismo server) |
| Mensajerías abiertas | + ~450-700MB (webs de terceros) | + lo MISMO (mismas webs; la ganancia es la base, no ellas) |
| Cascarón/base (main+GPU+shell de Electron vs rust+parte compartida WebView2) | ~150-250MB | **~40-90MB** |
| En bandeja | ~250-350MB | **~120-200MB** |

Lo que NO va a bajar y no se promete: WhatsApp Web, Telegram Web y el propio
cliente Distop renderizando — son las mismas webs sobre el mismo motor
Chromium (WebView2). La ganancia estructural es la base del cascarón y los
procesos compartidos del sistema. El hallazgo del proceso GPU de Electron
(713-984MB anómalos) se re-mide en WebView2: si ahí no aparece, la ganancia
real superará la tabla — pero eso lo dice la medición, no este documento.
