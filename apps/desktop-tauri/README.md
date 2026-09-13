# Distop Desktop — Proyecto B (migración total a Tauri 2)

Carril paralelo al cascarón Electron (`apps/desktop`), que sigue siendo la
versión estable hasta que este proyecto alcance paridad. **No comparte release
ni rompe nada de A**: es un cascarón nuevo sobre el MISMO cliente web
(`apps/web/dist`) y el MISMO node-server.

## Por qué

Electron paga ~150-250 MB de base por llevar Chromium entero. Tauri 2 usa el
WebView2 del sistema (compartido entre apps): cascarón idle de ~30-50 MB e
instalador de un dígito de MB. El costo de WhatsApp Web/Telegram Web **no
desaparece** (son las mismas webs), pero la base sí.

## Estado

**Etapa B3 — paridad implementada (2026-08-24).** Todo el cascarón Electron
está portado (plan y gates en [PLAN-PARIDAD.md](PLAN-PARIDAD.md)):

| Pieza | Cómo | Verificado |
|-------|------|------------|
| Hospedar (B3.1) | El MISMO node-server con Node 24 oficial como sidecar + Job Object kill-on-close (`src/host.rs`) | ✔ runtime: health/info/cliente 200, eventos, y matar el cascarón a lo bruto NO deja node.exe huérfano |
| Permisos y enlaces (B3.2) | `PermissionRequested` + `NewWindowRequested` por COM (`src/permissions.rs`): lista GRANTED de Electron en el cliente, huéspedes solo su dominio, enlaces al navegador | ✔ runtime: getUserMedia devolvió pista de audio SIN prompt |
| Captura de pantalla (B3.2) | `getDisplayMedia` nativo de WebView2 (selector del sistema) | ◐ la función existe; falta el smoke interactivo (compartir de verdad en llamada) |
| Overlay de llamada (B3.3) | El MISMO voice-overlay.html, ventana transparente click-through (`src/overlay.rs`) | ✔ runtime: nace con la llamada, pinta participantes, muere al colgar |
| Bandeja + autostart + splash + una instancia (B3.4) | tray-icon nativo, plugins autostart/single-instance, el MISMO splash.html embebido | ✔ compila y corre; smoke visual pendiente |
| Detección de juegos (B3.5) | Port a Rust: sysinfo + winreg — CERO spawns (muere el tasklist de cada 12s de Electron) (`src/games.rs`) | ✔ runtime: scan 129 procesos, catálogo 38 sembrado, toggle on/off |
| Auto-update (B3.6) | tauri-plugin-updater firmado, GitHub Releases, instala SOLO al salir (`src/updates.rs`) | ✔ compila; necesita release publicada con latest.json para el ciclo real |
| F11, métricas, navegación (B3.7) | Script F11 en franja+cliente, `DISTOP_METRICS` con atribución WebView2, allowlist de navegación del cliente | ✔ compila |

El job `tauri` de `.github/workflows/shells.yml` compila este cascarón
(`cargo check`) en cada cambio bajo `apps/desktop-tauri/`. No publica nada:
solo responde a "¿esto sigue compilando?" sin depender de que alguien tenga
Rust instalado en su equipo.

El puente `window.distop` expone la superficie COMPLETA de
`apps/web/src/lib/instance.ts`: platform, host, games, apps, overlay —
verificado por CDP. El cliente no distingue cascarón.

**Falta para el corte B4** (hasta entonces la release para usuarios es la
Electron): smoke interactivo de llamada Tauri↔Electron con pantalla
compartida, medición A/B formal de RAM (≤ Electron−100MB), herramienta de
migración de datos desde Electron (durante la coexistencia cada app usa SUS
datos — dos servers sobre el mismo SQLite sería corrupción), publicar una
release con latest.json y 2 semanas de beta.

Limitaciones conocidas y honestas: F11 no cambia pantalla completa DENTRO de
las pestañas WhatsApp/Telegram (los huéspedes no tienen capabilities a
propósito — dárselas expondría los comandos del puente a webs ajenas); el
selector de compartir pantalla es el del sistema, no el de marca propia de
Electron (misma función, cero código).

**Firewall de Windows (§26 — no ocultar fallos)**: al hospedar por primera
vez, Windows pregunta si permitir a `Distop Tauri Beta` (la comprobación de
puerto) y a `node.exe` (el server escuchando en 0.0.0.0). Hay que dar
**Permitir acceso**: con "Cancelar", la app y el hospedaje local siguen
funcionando (loopback nunca se bloquea) y el túnel también (marca hacia
fuera), pero los invitados DIRECTOS por LAN no podrán entrar. Arreglo si ya
quedó bloqueado (PowerShell como admin):
`Get-NetFirewallRule | ? DisplayName -eq "distop-desktop.exe" | Set-NetFirewallRule -Action Allow`

Tres lecciones que costaron debugging (no re-descubrirlas):
1. Crear webviews en runtime SOLO desde comandos `async`: tauri documenta que
   en Windows un comando síncrono (o un event handler, incl. run_on_main_thread)
   deadlockea — `add_child` despacha al hilo principal y espera bloqueado.
2. `on_navigation` ve TODA navegación, incluida la inicial `about:blank` del
   WebView2: un allowlist que la vete deja al huésped en blanco para siempre.
3. `navigator.permissions.query` dice "prompt" aunque el handler COM vaya a
   conceder: el estado consultado es el almacenado, la concesión ocurre al
   PEDIR de verdad (getUserMedia). Verificar pidiendo, no consultando.

```powershell
# Toolchain. Comprueba que está: `cargo --version`. Sin Rust, este cascarón
# no se compila en local y su código Rust se escribe a ciegas — que es como
# el arreglo de suspensión de la 0.1.7 llegó a estar escrito sin compilar.
winget install Rustlang.Rustup
winget install Microsoft.VisualStudio.2022.BuildTools  # workload VCTools
cd apps/desktop-tauri
npx @tauri-apps/cli@latest dev     # desarrollo (stage-server.mjs corre solo)

# Build de release: el updater exige firmar. La clave privada NO está en el
# repo: se generó con `signer generate` y vive en ~/.tauri/ de quien publica.
# (la variable acepta la ruta al fichero o su contenido; la variante _PATH no existe)
$env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\distop-updater.key"
npx @tauri-apps/cli@latest build   # NSIS en src-tauri/target/release/bundle/nsis/
node scripts/make-latest-json.mjs  # el manifiesto del updater para la release
```

## Las 4 incógnitas del spike — RESPONDIDAS

| # | Incógnita | Veredicto |
|---|-----------|-----------|
| 1 | Multi-webview en una ventana | **GO** (B2): pestañas instantáneas, huéspedes destruibles/recreables con sesión persistente |
| 2 | Overlay transparente + captura | **GO** el overlay (B3.3, verificado); captura: `getDisplayMedia` existe en WebView2 con selector del sistema — smoke interactivo pendiente |
| 3 | node-server sin el Node de Electron | **GO** (B3.1): sidecar del Node oficial, mismo server.ts sin transpilar (type stripping), instalador total ~37 MB (< 60), arranque a `on` en ~2 s |
| 4 | WhatsApp/Telegram Web en WebView2 | **GO** (B2): UA limpio, login QR, sesión entre arranques |

Medición pendiente (B4): mismo protocolo A/B del Proyecto A (`DISTOP_METRICS`
existe en ambos cascarones), 3 repeticiones, mediana, mismos escenarios.
Atribuir los procesos msedgewebview2 por `--user-data-folder`.

## Seguridad (invariantes heredados del plan)

CSP equivalente a `apps/desktop/src/protocol.ts`; navegación de huéspedes con
allowlist (portar `apps-policy.ts`); permisos mínimos del runtime en
`tauri.conf.json > app > security`; el sidecar corre sin privilegios extra; la
superficie `window.distop` se replica con `invoke` manteniendo los MISMOS tipos
de `apps/web/src/lib/instance.ts` — el cliente web no debe distinguir cascarón.

## Etapa siguiente: B4, el corte de release

B1 (spike) ✔ → B2 (cliente instalable) ✔ → **B3 (paridad implementada) ✔** →
B4: smoke interactivo de voz/captura, medición RAM ≤ Electron−100MB en los 4
escenarios, migración de datos desde Electron, release publicada con
latest.json, 2 semanas de beta. Al cerrar B4, este instalador REEMPLAZA al de
Electron como release para usuarios.
