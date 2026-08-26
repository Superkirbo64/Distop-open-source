# Distop — plataforma de comunicación comunitaria

Comunidades, canales y chat en tiempo real sobre una **instancia que tú hospedas**.
Todo lo que existe está disponible para todo el mundo: no hay funciones bajo suscripción,
ni personalización de pago, ni límites artificiales. Los límites son los de tu disco y tu conexión.

## Qué hay funcionando hoy

| Área | Estado |
|---|---|
| Puesta en marcha sin cuenta: quien hospeda entra sin login | ✅ |
| Cuentas locales, modo invitado y conversión de invitado a cuenta | ✅ |
| Sesiones revocables con refresh rotativo | ✅ |
| Comunidades, categorías y canales (texto, anuncios, voz como contenedor) | ✅ |
| Mensajes en tiempo real, edición, borrado, respuestas, fijados, reacciones, búsqueda | ✅ |
| Adjuntos con límites y tipos configurables | ✅ |
| Roles con 33 permisos, jerarquía y overwrites por canal (canales privados) | ✅ |
| Miembros: apodos, expulsión, bloqueo, silencio temporal | ✅ |
| Invitaciones con usos y caducidad | ✅ |
| Registro de auditoría | ✅ |
| Exportación completa de la comunidad en JSON | ✅ |
| Tema claro y oscuro reales, escala de texto, densidad, español/portugués/inglés | ✅ |
| PWA instalable con estado de conexión honesto | ✅ |
| Voz por la instancia: funciona siempre, sin STUN, sin TURN y sin abrir puertos | ✅ |
| Cámara y pantalla por la instancia, o directas entre navegadores si se prefiere | ✅ |
| Servidor de medios (SFU) para salas de más de ~6 personas | ⛔ fase 3 |
| Mensajes directos | ⛔ fase 3 |
| Bots, plugins, webhooks | ⛔ fase 2 |
| Plataforma central, descubrimiento global y federación | ⛔ fase 5 |

Lo marcado con ⛔ **no está empezado**. La arquitectura lo contempla (el protocolo
está versionado, los IDs son globales y la identidad está separada de la comunidad),
pero decir que existe sería mentir.

## Arquitectura

```text
apps/web/           Cliente React + Vite (SPA/PWA). Es también el frontend del futuro cliente Tauri.
apps/node-server/   La instancia self-hosted: API v1 + gateway WebSocket + SQLite + archivos.
apps/marketing/     Sitio público (Astro, estático, es/en/pt-BR). No habla con ninguna instancia.
packages/protocol/  Contrato único cliente ↔ instancia: tipos, eventos, permisos, UUIDv7.
```

El sitio público es **estático de verdad**: son HTML y CSS en una carpeta, sin API ni
base de datos detrás, así que cabe en cualquier capa gratuita. Se levanta con
`npm run site` y se compila con `npm run site:build` (queda en `apps/marketing/dist`).

Una instancia aloja **varias comunidades**. La comunidad no está atada a la instancia:
por eso existe la exportación, y por eso los IDs son globalmente únicos.

## Requisitos

- **Node 24 o superior** (ejecuta TypeScript de forma nativa y trae `node:sqlite`; el servidor no necesita compilarse).
- Nada más. Sin Bun, sin Postgres, sin Redis, sin servicios externos.

## Hospedar con un doble clic

En Windows, **`Hospedar Distop.cmd`**. En cualquier sistema, `npm run host`.

Las dos cosas hacen lo mismo ([scripts/host.mjs](scripts/host.mjs)): instalan dependencias si
faltan, generan un `AUTH_SECRET` fijo en `.env` la primera vez (sin él, cada reinicio
cerraría todas las sesiones), compilan el cliente si hace falta, arrancan la instancia y
abren el navegador cuando el puerto responde de verdad. Si el puerto ya está ocupado lo
dicen y no arrancan nada.

Mientras la ventana esté abierta, tu comunidad está en línea. Al cerrarla se apaga: es
un servicio en tu equipo, no en la nube de nadie.

### Que se llegue desde fuera de tu casa

```bash
npm run host -- --tunnel          # o:  "Hospedar Distop.cmd" --tunnel
```

Levanta un túnel rápido de Cloudflare (no hace falta cuenta ni dominio), escribe la
dirección resultante en `PUBLIC_URL` y la imprime al final para que la copies. Requiere
[cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
instalado.

Con la salvedad de siempre: **esa dirección es de usar y tirar**. Muere al cerrar la
ventana y la próxima vez es otra distinta, así que un enlace repartido hoy no sirve
mañana. Para una dirección fija hacen falta un túnel con nombre y un dominio propio
(`cloudflared tunnel create`), o Tailscale Funnel, que es gratis y no pide dominio.

## Hospedar no exige crear una cuenta

Al arrancar una instancia nueva, la primera pantalla **no es un formulario de acceso**:
es la puesta en marcha. Pones tu nombre y el de tu comunidad, y ya estás dentro
administrando. La contraseña es un paso posterior y opcional, desde Ajustes → Cuenta.

Nadie te la puede quitar por el camino:

- **Desde el equipo que la hospeda** no se pide nada. Estar sentado delante de la
  máquina ya es prueba suficiente: quien está ahí podría leer la base de datos entera.
- **Desde otro equipo** se pide el código que la instancia imprime en su terminal al
  arrancar. Sin él, el primer desconocido que encuentre tu URL se quedaría tu nodo.
- **La ventana se cierra sola** en cuanto existe una persona: a partir de ahí la
  reclamación devuelve 409 y la pantalla pasa a ser la de acceso normal.

## Desarrollo

```bash
npm install
cp .env.example .env        # opcional en desarrollo; obligatorio poner AUTH_SECRET en producción
npm run dev                 # instancia en :5000 + cliente en :5173
```

Abre **http://localhost:5173**, pon tu nombre y el de tu comunidad. Después genera una
invitación desde el menú de la comunidad y ábrela en otro navegador (o en incógnito):
ahí sí se puede entrar como invitado, sin cuenta. Escribid: los mensajes viajan al instante.

El cliente en desarrollo habla siempre con su propio origen; Vite hace de proxy hacia
la instancia, así que no hay CORS que configurar ni tokens cruzando dominios.

## Aplicación de escritorio (Windows)

El mismo cliente web, empaquetado con Electron (el porqué frente a Tauri está en
`docs/decisions.md`). Añade lo que el navegador no puede dar:

- **Conectar a instancias**: la app viaja contigo y arranca en "Conectar a una
  instancia"; tus sesiones se guardan por instancia, en tu equipo.
- **Hospedar aquí**: arranca la instancia node-server DENTRO de la app, con el
  Node 24 que Electron embebe. Tu cuenta y tus datos quedan literalmente en tu
  PC (`%APPDATA%/Distop/instance/data`).
- **Jugando a…**: detecta el juego abierto (catálogo editable en
  `%APPDATA%/Distop/games.json`) y lo enseña en tu perfil. Al servidor solo
  llega el nombre del juego, nunca tu lista de programas; se apaga en Ajustes.
- Bandeja, notificaciones nativas, inicio con Windows y auto-update desde
  GitHub Releases.

```bash
npm run dev  --workspace @distop/desktop   # desarrollo (usa apps/web/dist)
npm run dist --workspace @distop/desktop   # instalador NSIS en apps/desktop/release/
```

Sin certificado de firma de código (~300 USD/año que no hay, §3), SmartScreen
avisará de "editor desconocido" al instalar: es esperable, no un fallo.

## Aplicación Android (APK)

El mismo cliente, empaquetado con Capacitor (`apps/mobile`) — y también puede
**hospedar la comunidad en el propio teléfono, sin instalar nada**: el APK
lleva un motor Node embebido (nodejs-mobile vía Capacitor-NodeJS; el porqué y
sus límites, en `docs/decisions.md`) que ejecuta el mismo node-server con
SQLite en WASM. Un botón en la bienvenida lo enciende; los amigos entran desde
la misma Wi-Fi con el enlace de invitación, y un aviso fijo evita que Android
duerma el servidor. Para invitar por internet, hospeda en un PC (el teléfono no
tiene túnel). La voz necesita un Android System WebView ≥94 (se actualiza solo
por Play Store); si falta, la app lo dice y el resto funciona.

```bash
npm run sync --workspace @distop/mobile    # build del cliente + cap sync
npm run open --workspace @distop/mobile    # abre Android Studio para compilar
```

El APK de release lo construye GitHub Actions al taguear (`v*`); se firma solo
si existen los secretos del keystore (ver `.github/workflows/release.yml`).
**El keystore jamás entra al repo, y perderlo = no poder actualizar el APK.**

También se puede compilar en local sin Android Studio (JDK 21 + cmdline-tools):

```powershell
$env:JAVA_HOME = "ruta\al\jdk21"; $env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_KEYSTORE_PATH = "ruta\al\distop-release.keystore"
$env:ANDROID_KEYSTORE_PASSWORD = "..."; $env:ANDROID_KEY_ALIAS = "distop"; $env:ANDROID_KEY_PASSWORD = "..."
cd apps/mobile/android; .\gradlew.bat assembleRelease
# → app/build/outputs/apk/release/app-release.apk (firmado)
```

## Producción con Docker

```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up --build
```

Queda todo en **http://localhost:5000**: la misma instancia sirve la API, el gateway
y el cliente compilado. Tus datos viven en `./data` — ese directorio **es** tu copia de seguridad.

## Verificar

```bash
npm test          # suite completa: API, permisos, gateway, voz, sonidos, seguridad y no leídos
npm run typecheck # TypeScript estricto en cliente e instancia
curl http://localhost:5000/health
```

## Copias de seguridad

Una copia cifrada de la instancia entera —base, identidad, sesiones y archivos— y
su restauración verificada en otro directorio: **[docs/copias-de-seguridad.md](docs/copias-de-seguridad.md)**.

```bash
# hacer una copia (desde el equipo anfitrión, con la cuenta que hospeda)
curl -X POST http://localhost:5000/api/v1/instance/backups \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"passphrase":"una frase larga que puedas recordar"}'

# mirar dentro sin restaurar nada
DISTOP_BACKUP_PASSPHRASE='...' node apps/node-server/restore.ts --inspect --deep --file copia.distop-backup

# restaurar, con la instancia parada
DISTOP_BACKUP_PASSPHRASE='...' node apps/node-server/restore.ts --file copia.distop-backup --target ./data
```

La frase no se guarda en ningún sitio: si la pierdes, la copia es ruido. Restaurar
produce **la misma** instancia, no una sucesora — si la original sigue encendida,
tendrás dos.

## Cambiar de anfitrión

Otra máquina continúa la comunidad sin heredar la clave privada de la primera:
**[docs/relevo.md](docs/relevo.md)**. Los miembros no crean nada nuevo ni
vuelven a entrar; el equipo viejo queda retirado y dice a dónde ir.

## Avisar cuando la comunidad vuelve

Con la aplicación de escritorio en la bandeja, Distop comprueba la instancia y
te avisa cuando vuelve: **[docs/aviso-de-vuelta.md](docs/aviso-de-vuelta.md)**.
Dice *"volvió"* solo si es la misma de siempre y *"se trasladó"* solo con una
cadena de sucesión verificada — nunca las confunde, y no basta con que alguien
conteste en esa dirección.

## Lo que esta arquitectura no puede hacer en capas gratuitas

Conviene decirlo antes de que alguien lo descubra desplegando:

- **La instancia no cabe en serverless.** Mantiene WebSockets abiertos, escribe en SQLite
  y guarda archivos en disco. Cloudflare Workers y Vercel Functions no sirven para esto.
  El sitio público y la futura API central sí encajarían ahí; la instancia no.
- **Una instancia en un ordenador personal está apagada cuando el ordenador lo está.**
  La interfaz lo dice con todas las letras en vez de mostrar un error genérico.
- **Sin puertos abiertos hace falta un túnel** (Cloudflare Tunnel, Tailscale Funnel o
  similar). El asistente automático de §6 todavía no está construido.
- **Voz y vídeo pasan por la instancia, como todo lo demás.** No hay conexión directa
  entre navegadores que negociar, así que no hay nada que pueda fallar por culpa de un
  router o de una red móvil: si se puede abrir la aplicación, se puede hablar y ver.

  Lo que cuesta es **subida de quien hospeda**, una copia por cada persona que recibe:

  | | Por persona | Cinco personas |
  |---|---|---|
  | Voz (Opus 32 kbit/s) | ~4 KB/s | ~640 kbit/s |
  | Cámara equilibrada (hasta 4 Mbit/s) | ~500 KB/s | ~16 Mbit/s |
  | Pantalla equilibrada (hasta 8 Mbit/s) | ~1 MB/s | ~32 Mbit/s |

  Son techos adaptativos: la fuente, el navegador y la red pueden usar menos. La voz
  no se nota; el vídeo sí, y por eso **Ajustes → Voz y vídeo** deja pasarlo a
  directo entre navegadores: no cuesta nada a quien hospeda y da más calidad, pero
  solo llega si las dos redes se dejan hablar. Ahí mismo hay un botón que dice qué
  caminos encuentra tu red, y se puede configurar un relevo TURN para cuando no haya
  ninguno: **Metered** (0,5 GB al mes sin tarjeta, 20 GB si añades una), **Cloudflare
  Realtime** (1 TB al mes, pide datos de facturación) o cualquier TURN propio. La clave
  se queda en la instancia, nunca llega al navegador, y se valida al guardar.

  No viene ningún relevo puesto de fábrica porque los TURN públicos sin cuenta que
  circulan por los tutoriales —`openrelayproject` incluido— están caídos, y apuntar uno
  muerto falla igual pero parece configurado.
- **El transporte es TCP, así que se tiran paquetes a propósito.** Sobre un WebSocket,
  dejar que se acumule cola no hace llegar la imagen: la hace llegar cada vez más tarde.
  Cuando la cola crece, la instancia descarta en vez de esperar, y el codificador salta
  fotogramas antes de encolarlos. Se prefiere una imagen que salta a una conversación
  con retardo creciente.
- **Voz y vídeo necesitan WebCodecs.** Chrome, Edge y Chrome para Android lo traen. En
  Safari y iOS el soporte es más nuevo y desigual; si falta, la aplicación lo dice en vez
  de quedarse muda sin explicación.
- **`AUTH_SECRET` no es opcional en producción.** Sin él el proceso se niega a arrancar,
  porque cada reinicio invalidaría todas las sesiones. Cambiarlo cierra las sesiones
  abiertas a propósito: es la palanca para echar a todo el mundo si sospechas de una fuga.
- **Detrás de un túnel o un proxy, pon `TRUST_PROXY=true`.** Si no, todas las peticiones
  parecen venir de la misma IP y los límites por IP tratan a tu comunidad entera como a
  una sola persona. Y al revés: activarlo *sin* proxy delante deja que cualquiera falsee
  la cabecera `X-Forwarded-For` y se salte esos límites. Por eso no hay valor automático.

## Cuando algo no arranca

| Lo que ves | Lo que pasa |
|---|---|
| "La instancia no respondió (HTTP 503)" en el cliente | La instancia está apagada. El terminal de Vite te lo dice y te da el comando. Arranca `npm run dev:server`. |
| "Port 5173 is in use" | Ya tienes otro cliente corriendo. Vite se mueve solo a 5174; ciérralo o usa el puerto nuevo. |
| El proceso muere al arrancar citando `AUTH_SECRET` | Estás en producción sin secreto. `openssl rand -hex 32` y ponlo en `.env`. |
| "Demasiadas peticiones" al crear cuentas | Límite por IP. Sube `MAX_REGISTRATIONS_PER_HOUR` o revisa `TRUST_PROXY`. |

## Licencia

AGPL-3.0-only (§24). El texto completo está en `LICENSE`; las licencias de las
dependencias, en `THIRD_PARTY_NOTICES.md`.

El pack adaptado de sonidos de interfaz de `apps/web/public/sounds/` usa SND01
"sine" de Yasuhiro Tsuchiya. No redistribuye los WAV originales: combina,
reafina, reenvuelve y remasteriza varias fuentes para cada salida. Consulta su
procedencia, cambios y términos propios en `apps/web/public/sounds/LICENSE.txt`.
