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

## 2026-08: Hospedar en Android — motor Node embebido en el APK (sin Termux)

El teléfono también puede ser el servidor de su comunidad, con un botón y sin
instalar nada. Cómo: **Capacitor-NodeJS (beta.9) → nodejs-mobile 18.20.4**, el
único runtime Node que existe para Android (precedente de producción: CoMapeo).
El mismo node-server del repo se transpila a JS (`scripts/stage-server.mjs
--mobile`) y `node:sqlite` (que exige Node ≥22.5) se sustituye por
**node-sqlite3-wasm** — SQLite en WASM con VFS sobre node:fs, persistencia real
a disco — mediante un shim con la forma de `DatabaseSync`
(`scripts/mobile/sqlite-shim.js`). Validado contra un Node 18.20.4 real:
registro, comunidades, mensajes, invitaciones, game presence y persistencia
tras reinicio, todo en verde.

Piezas nativas: un foreground service `specialUse` propio (`HostForegroundService`,
~70 líneas Java) sostiene el aviso "comunidad en el aire" para que Android no
duerma el proceso — `dataSync` tiene tope de 6 h desde Android 15 y no vale.
El plugin `DistopHost` (enable/disable) es la única superficie que el WebView
puede tocar.

Limitaciones dichas sin adornos (§29.3): el motor embebido es **Node 18 (EOL)**
— sin parches del runtime; mitigado porque el servidor lo expone su dueño a su
comunidad, no a internet abierto (sin túnel: cloudflared no existe para
Android). La comunidad del teléfono sirve a su Wi-Fi; para invitar por
internet, un PC. Cerrar la app del todo la apaga. Alternativa avanzada con
túnel incluido: `scripts/termux-host.sh` (Termux tiene Node 24 y cloudflared),
fuera de la interfaz para no pedirle terminal a nadie.

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

## 2026-08: Discord — importación puntual con bot oficial, nunca sincronización

Las peticiones originales del proyecto pedían traer comunidades y bots de
Discord, y ningún plan las había recogido. Decisión en dos partes:

1. **Importar = mudanza con fecha, no puente permanente.** Un bot que crea la
   propia persona en su servidor lee estructura, roles, miembros, historial
   reciente, adjuntos y emojis, y la instancia local los convierte en una
   comunidad Distop normal (`apps/node-server/discord-import.ts`, tabla
   `external_imports` con `UNIQUE(provider, source_id)`). El token de bot solo
   existe en la memoria de la petición: ni base, ni logs, ni informe (§22).
   Los self-bots (token de usuario) violan los ToS de Discord y no se aceptan.
   Los autores se archivan como `kind='imported'` — las cuentas no se mudan.
   Diseño completo: `docs/importacion-discord.md`.
2. **Bots: compatibilidad por capas, no emulación.** Primero webhooks
   entrantes con el formato de Discord (cambiar una URL basta para GitHub y
   compañía), después API de bots nativa con guía de porte, después bot
   puente de migración. No se promete ejecutar bots de Discord sin cambios.
   Diseño completo: `docs/bots-de-discord.md`.

Además se restauraron en `claude.md` las secciones §12 (bots, plugins) y §13
(Minecraft) que un resumen anterior había reducido a punteros hacia skills
inexistentes — esa pérdida de contexto fue la raíz de que estos tópicos
quedaran fuera de los planes. No volver a resumirlas.

## 2026-08: Oracle Cloud Always Free como despliegue de referencia en la nube (y no VPS de pago)

Una comunidad hospedada en un PC se apaga con el PC, y §3 prohíbe depender de
VPS pagos — el coste cero es regla dura, no aspiración. Oracle Cloud Always
Free es la única capa gratuita vigente con una VM persistente capaz de correr
la instancia entera (A1 de 1 OCPU/6 GB, IPv4 reservada, 10 TB de salida al
mes): ni Workers ni Vercel pueden (§29.3 — la instancia mantiene WebSockets,
SQLite y archivos en disco), y cualquier VPS de pago rompería la regla.

Decisión: la referencia "siempre encendida" es una VM Always Free descrita en
`docs/nube-oracle.md`, operada por el mismo dueño con Terraform + cloud-init,
Caddy, coturn y copias cifradas que salen de la máquina (§21, §22). Es un
**tercer modo opcional** junto al PC de casa y al teléfono — mismo dueño,
mismos datos, coste cero — y no "Distop-en-la-nube": nadie hospeda por ti y no
aparece ninguna plataforma central obligatoria.

Consecuencias: sin SLA y con riesgo de reclamación por inactividad (tres
condiciones en Y; el right-sizing legítimo la evita, la carga falsa no se
acepta); detrás del proxy nada es "local", así que la copia por HTTP y el
relevo web no existen ahí (§26 exige decirlo) — de ahí el planificador interno
de copias y el restore por CLI; y la copia debe salir periódicamente de la
cuenta de Oracle, porque una suspensión se lleva VM, IP y bucket a la vez.

Consecuencia aceptada: el primer arranque compila desde el código en la VM
(10–20 minutos) mientras no exista imagen Docker publicada, y la
disponibilidad depende de un proveedor que puede cambiar sus cuotas cuando
quiera. Mitigación: la comunidad nunca queda cautiva — copia cifrada portable,
identidad exportable y el PC de casa sigue siendo el modo por defecto.
