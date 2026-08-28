# Importar una comunidad de Discord

Traer un servidor de Discord a Distop **una vez**: estructura, roles, miembros,
historial reciente, adjuntos y emojis pasan a vivir en la instancia propia. No
es un puente ni una sincronización — es una mudanza con fecha.

Este tópico responde a la petición original del proyecto: *"adicionar
comunidades minhas do discord para o distop"*. No estaba en ningún plan
anterior; este documento lo convierte en una fase real y visible.

## Premisas verificadas (2026-08-26, docs oficiales de Discord)

| Afirmación | Estado |
|---|---|
| No existe exportación oficial completa de un servidor; el "Data Package" solo trae los datos del propio usuario | Confirmado |
| Automatizar una cuenta de usuario (self-bot) viola los Términos de Servicio y puede terminar la cuenta | Confirmado — solo se acepta token de **bot** oficial |
| `MESSAGE_CONTENT`, `GUILD_MEMBERS` y `GUILD_PRESENCES` son intents privilegiados; un bot en menos de 100 servidores los activa en el portal **sin verificación** | Confirmado |
| Sin `MESSAGE_CONTENT`, los campos `content`, `embeds`, `attachments` y `components` llegan **vacíos** — también por REST, no solo por gateway | Confirmado |
| Historial: `GET /channels/:id/messages`, máximo 100 por página; miembros: `GET /guilds/:id/members`, máximo 1000 por página | Confirmado |
| Límite global de 50 peticiones/segundo; el 429 trae `retry_after`; 10.000 peticiones inválidas en 10 minutos restringen temporalmente la IP | Confirmado |
| Las URLs de **adjuntos** del CDN van firmadas y caducan (`ex`, `is`, `hm`) — hay que descargar los archivos durante la importación | Confirmado |
| Las URLs de **avatares e íconos** del CDN no van firmadas y no caducan | Confirmado |

Fuentes: docs.discord.com — gateway (intents), reference (CDN firmado),
rate-limits, resources/message; support.discord.com — artículo 115002192352
(self-bots).

## Decisión estructural

**La importación corre en la instancia de quien importa, con un bot que esa
persona crea en su propio servidor de Discord.** El token nunca toca ninguna
plataforma central, nunca se escribe en la base, en los logs ni en el informe
(§22): viaja en el **cuerpo** de un POST y solo existe en la memoria de esa
petición.

Camino de la persona:

1. Crear una aplicación en el portal de desarrolladores de Discord.
2. Activar los intents `MESSAGE_CONTENT` y `GUILD_MEMBERS` (dos casillas; sin
   verificación para un bot personal).
3. Invitar al bot a su servidor con permisos de lectura.
4. Pegar el token y el ID del servidor en Distop → **previsualización** con
   conteos reales (canales, categorías, roles, emojis, miembros aproximados).
5. Elegir cuánto historial por canal y si importar la lista de miembros.
6. Importar. Al terminar, un informe dice exactamente qué llegó y qué no.

## Qué se convierte en qué

| Discord | Distop |
|---|---|
| Servidor (guild) | Comunidad nueva, privada, con ícono y descripción |
| Categorías | Categorías |
| Canales de texto y anuncios | Canales `text` / `announcement` |
| Canales de voz y escenario | Canales `voice` (vacíos: la voz no tiene historial) |
| Roles, colores, jerarquía | Roles, con los permisos **traducidos bit a bit** a los de Distop |
| Overwrites por canal | Overwrites por canal |
| Miembros | Perfiles archivados `kind='imported'` (ver abajo) |
| Mensajes (respuestas, fijados, ediciones, fechas originales) | Mensajes, con menciones reescritas a los IDs locales |
| Adjuntos | **Descargados** al disco del anfitrión (las URLs firmadas caducan) |
| Emojis personalizados | Emojis de la comunidad, descargados |

## Los miembros no se mudan — se archivan

Una cuenta de Discord no puede transferirse; nadie más que Discord tiene sus
credenciales. Cada autor se importa como un **perfil archivado** (`kind =
'imported'`, usuario `discord_<id>`, sin contraseña, sin sesión posible): el
historial conserva quién dijo qué, con su apodo y su avatar.

Las personas reales entran a Distop por el enlace de invitación normal, como
miembros nuevos. Reclamar un perfil archivado ("ese `discord_123` soy yo") es
una fase posterior y necesita verificación real — no se improvisa en v1.

## Estado en el código

Hecho, sin commit todavía:

- `apps/node-server/discord-import.ts` — `previewDiscord()` y `importDiscord()`
  completos: metadatos en paralelo, historial paginado, miembros paginados
  (techo 10.000), mapeo de permisos, transacción única con rollback, descarga
  de adjuntos y emojis fuera de la transacción, reintentos ante 429 con
  `retry_after`, informe con avisos.
- Migración `external_imports` — `UNIQUE(provider, source_id)` impide importar
  dos veces el mismo servidor, y guarda el informe auditable. El token **no**
  vive ahí.

Falta para que sea una función y no un módulo:

- Rutas HTTP (`preview` e `import`), solo para usuarios autenticados con
  derecho a crear comunidades, con el token en el cuerpo y límite de frecuencia.
- El asistente en `apps/web` con los seis pasos de arriba, la previsualización
  con conteos, y el informe final legible.
- Claves i18n en los tres idiomas.
- Pruebas: duplicado → 409, token jamás en logs/auditoría/informe, contenido
  vacío → aviso `MESSAGE_CONTENT_EMPTY` y no silencio, descargas solo desde
  `cdn.discordapp.com` / `media.discordapp.net`.

## Límites honestos (§29.3)

- **Los mensajes directos no se importan.** El bot no los ve, y no deben verse.
- **Historial limitado en v1**: hasta 1000 mensajes por canal. La importación
  es una petición síncrona; traer años de historial exige un trabajo en
  segundo plano reanudable, que es fase posterior, no un límite comercial.
- **Hilos y foros no traen su contenido**: la lista de canales del guild no
  incluye hilos; recorrer hilos activos y archivados por canal es fase
  posterior. Los foros se crean como canales vacíos.
- **Reacciones y stickers no se importan** en v1.
- **Avatares e íconos siguen sirviéndose desde el CDN de Discord** (no caducan,
  pero si Discord los borra, desaparecen). Copiarlos localmente es mejora
  posterior.
- **Un servidor grande tarda**: 50 peticiones/segundo es el techo de Discord,
  no de Distop. La interfaz muestra progreso, no promete velocidad.
- **Los adjuntos ocupan disco del anfitrión** y respetan `maxUploadMb`; lo que
  no cabe se cuenta en `attachments_skipped`, no se oculta.
- **Si el bot no tiene el intent de contenido**, el historial llega vacío. El
  informe lo dice con nombre (`MESSAGE_CONTENT_EMPTY`) y la guía enseña la
  casilla exacta del portal.

## Coste cero

La API de bots de Discord es gratuita, la importación corre en el equipo de
quien importa, y el almacenamiento es su disco. Ninguna pantalla de este flujo
puede sugerir comprar nada.

## Criterios de aceptación

Importar dos veces el mismo servidor devuelve 409 · el token no aparece en
base, logs, auditoría ni informe · un bot sin permiso sobre un canal produce
canal vacío, no importación rota · el 429 se respeta con `retry_after` · las
descargas rechazan cualquier host que no sea el CDN de Discord y cualquier
redirección · la comunidad importada se comporta como cualquier otra: se
respalda, se restaura, se releva y se exporta con los mecanismos ya existentes.
