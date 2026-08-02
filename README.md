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
| Voz y vídeo (WebRTC/SFU) | ⛔ fase 3 |
| Mensajes directos | ⛔ fase 3 |
| Bots, plugins, webhooks | ⛔ fase 2 |
| Integración con servidores de Minecraft | ⛔ fase 4 |
| Plataforma central, descubrimiento global y federación | ⛔ fase 5 |

Lo marcado con ⛔ **no está empezado**. La arquitectura lo contempla (el protocolo
está versionado, los IDs son globales y la identidad está separada de la comunidad),
pero decir que existe sería mentir.

## Arquitectura

```text
apps/web/           Cliente React + Vite (SPA/PWA). Es también el frontend del futuro cliente Tauri.
apps/node-server/   La instancia self-hosted: API v1 + gateway WebSocket + SQLite + archivos.
packages/protocol/  Contrato único cliente ↔ instancia: tipos, eventos, permisos, UUIDv7.
```

Una instancia aloja **varias comunidades**. La comunidad no está atada a la instancia:
por eso existe la exportación, y por eso los IDs son globalmente únicos.

## Requisitos

- **Node 24 o superior** (ejecuta TypeScript de forma nativa y trae `node:sqlite`; el servidor no necesita compilarse).
- Nada más. Sin Bun, sin Postgres, sin Redis, sin servicios externos.

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

## Producción con Docker

```bash
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
docker compose up --build
```

Queda todo en **http://localhost:5000**: la misma instancia sirve la API, el gateway
y el cliente compilado. Tus datos viven en `./data` — ese directorio **es** tu copia de seguridad.

## Verificar

```bash
npm test          # 8 comprobaciones: API, permisos, escalada de privilegios, gateway, canales privados
npm run typecheck # TypeScript estricto en cliente e instancia
curl http://localhost:5000/health
```

## Lo que esta arquitectura no puede hacer en capas gratuitas

Conviene decirlo antes de que alguien lo descubra desplegando:

- **La instancia no cabe en serverless.** Mantiene WebSockets abiertos, escribe en SQLite
  y guarda archivos en disco. Cloudflare Workers y Vercel Functions no sirven para esto.
  El sitio público y la futura API central sí encajarían ahí; la instancia no.
- **Una instancia en un ordenador personal está apagada cuando el ordenador lo está.**
  La interfaz lo dice con todas las letras en vez de mostrar un error genérico.
- **Sin puertos abiertos hace falta un túnel** (Cloudflare Tunnel, Tailscale Funnel o
  similar). El asistente automático de §6 todavía no está construido.
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

AGPL-3.0 (§24). Pendiente de añadir el archivo `LICENSE` y de revisar compatibilidad
con las dependencias antes de publicar.
