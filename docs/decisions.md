# Decisiones de arquitectura

Registro de las decisiones que no se pueden deducir leyendo el código, con su
porqué. Formato corto: contexto → decisión → consecuencias.

## 2026-08: Electron para la app de Windows (y no Tauri)

CLAUDE.md §15 declara preferencia por Tauri. Se eligió Electron a conciencia,
por tres razones verificadas:

1. **La voz exige Chromium.** El pipeline de audio/vídeo usa WebCodecs +
   MediaStreamTrackProcessor/Generator sin fallback (`apps/web/src/lib/relay.ts`,
   `supported()`). Electron empaqueta Chromium con versión fijada por nosotros;
   Tauri en Windows depende del WebView2 del sistema, cuya versión no controla
   la app y cuyo soporte de estas APIs no está documentado explícitamente.
2. **"Hospedar aquí" necesita Node ≥24.** El node-server corre TypeScript
   nativo con `node:sqlite`. Electron 40 embebe Node 24 y `utilityProcess.fork`
   lo ejecuta sin empaquetar ningún runtime extra. Con Tauri habría que
   distribuir un `node.exe` aparte (~70 MB), evaporando su ventaja de tamaño;
   y sus sidecars no funcionan en Android (tauri#9774).
3. **Detección de juegos.** El main process lista procesos (tasklist) para el
   "Jugando a X"; un navegador no puede ni debe.

Consecuencia aceptada: instalador de ~100 MB. Mitigación: ninguna necesaria —
es la misma pila que usa Discord y el público objetivo ya la instala.

## 2026-08: Capacitor para el APK de Android (y no Tauri Mobile ni TWA)

- **TWA/Bubblewrap** exige un sitio HTTPS fijo con Digital Asset Links:
  incompatible con el modelo multi-instancia (la app se conecta al nodo que
  la persona elija) y con presupuesto cero.
- **Tauri Android** usa el mismo System WebView que Capacitor pero con menos
  madurez móvil y la doble capa de permisos de `getUserMedia` a mano.
- **Capacitor** es JS-céntrico (encaja en el monorepo), maduro, y resuelve los
  permisos nativos. El System WebView ≥94 trae MediaStreamTrackProcessor según
  MDN BCD y se actualiza por Play Store con el mismo tren que Chrome.

Limitación honesta (§29.3): **Android no puede hospedar una instancia** (no hay
Node en el teléfono). La app Android es cliente puro. Y la voz en WebView debe
verificarse en dispositivo real antes de publicar; si falta soporte, el cliente
ya lo dice (`relay.supported()`), y el plan B es usar Chrome/PWA contra la
instancia.

## 2026-08: El cliente empaquetado viaja con la app y elige instancia

La app NO hace `loadURL` a una instancia: sirve el build de Vite desde el
protocolo `app://distop` (escritorio) o `https://localhost` (Capacitor) y añade
la capa multi-instancia (`apps/web/src/lib/instance.ts`): base de URL elegida,
sesión por instancia (`distop.session::<origen>`), y reescritura de rutas de
media en la frontera (respuestas de API y eventos del gateway), no en cada
componente. En la web servida por una instancia, `instanceBase` es vacía y nada
cambia. Consecuencia: CORS de la instancia acepta siempre los orígenes fijos de
las apps (`app://distop`, `capacitor://localhost`, `https://localhost`).

## 2026-08: El protocolo se transpila a JS solo para el paquete de escritorio

En el repo, `@distop/protocol` se ejecuta como `.ts` (type stripping) porque el
workspace es un symlink y Node resuelve la ruta real fuera de `node_modules`.
Empaquetado vive físicamente bajo `node_modules`, donde Node se niega a hacer
type stripping (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`). Por eso
`scripts/stage-protocol.mjs` lo transpila a JS en el paso de `dist`. El resto
del monorepo sigue sin paso de build.

## 2026-08: "Jugando a X" — el servidor nunca ve la lista de procesos

La detección corre en el main process de la app de escritorio contra un
catálogo local editable (`%APPDATA%/Distop/games.json`). A la instancia solo
viaja el nombre del juego que casó, por REST con la sesión normal (sin tokens
de agente). El estado vivo es efímero en memoria con heartbeat + barrido
(patrón voice.ts); solo las partidas terminadas ≥60 s entran al historial
(tabla `game_sessions`, tope 50 filas/persona). Dos interruptores en
`users.settings`: `share_game_activity` y `show_game_history` (ausente = sí:
instalar la app de escritorio ya es el acto de consentimiento; el interruptor
es la pausa, §29.6).
