# Bots de Discord en Distop

Responde a la petición original: *"existe a posibilidade de aplicar bots de
discord no proyeto atual?"*. La respuesta corta es: **un bot de Discord no
puede ejecutarse contra Distop sin cambios**, porque habla el protocolo de
Discord (su REST, su gateway, sus snowflakes, sus intents) contra
`discord.com`. Pero hay tres caminos reales, ordenados del más barato al más
ambicioso, y ninguno cuesta dinero.

## 1. Webhooks entrantes compatibles con Discord — el primer entregable

La mayoría de "bots" que la gente usa no son bots: son **webhooks**. GitHub,
GitLab, Grafana, Ko-fi y decenas de servicios saben publicar en "formato
Discord" (`content`, `username`, `avatar_url`, `embeds`) contra una URL.

Distop puede aceptar ese mismo formato:

```text
POST /api/v1/webhooks/:id/:token        ← la forma que esos servicios ya conocen
```

Con eso, mover una integración de Discord a Distop es **cambiar una URL**, sin
escribir código. Es la compatibilidad de mayor valor por línea de código de
todo este tópico.

Estado real: hoy el node-server **no tiene webhooks**. Existen los permisos
(`MANAGE_WEBHOOKS` en `packages/protocol`) y la tabla está prevista en el
diseño (§12 de claude.md), pero no hay implementación. Es lo primero a
construir.

Seguridad (§22): el token del webhook se guarda **hasheado**, como las
sesiones; se revoca desde la configuración del canal; tiene límite de
frecuencia y tamaño; los `embeds` se validan con esquema y se sanitizan — un
webhook no ejecuta nada, solo publica.

## 2. Bot puente durante la migración

Un bot oficial de Discord, corriendo en el equipo de quien administra, que
**refleja mensajes** entre un canal de Discord y un canal de Distop mientras la
comunidad se muda. Del lado Discord usa la API oficial con token de bot (los
self-bots violan los ToS y no se ofrecen jamás); del lado Distop usa la API de
bots nativa (abajo).

Es una herramienta de transición, no una función permanente: existe para que
la comunidad no se parta en dos durante las semanas de mudanza, y se apaga
cuando la mudanza termina. Complementa a la importación puntual
(`docs/importacion-discord.md`): la importación trae el pasado, el puente
acompaña el presente.

## 3. API de bots nativa de Distop

El destino real de la petición: que un bot escrito para Discord se pueda
**portar** con cambios pequeños, no que corra sin cambios.

- Una cuenta de bot es un usuario con `kind='bot'`, creada por quien tiene
  `MANAGE_BOTS`, con token propio (hasheado en la base, mostrado una sola
  vez), sin contraseña y sin sesión interactiva.
- Habla el mismo protocolo documentado que el cliente
  (`packages/protocol`): REST para actuar, WebSocket del gateway para
  escuchar. No se inventa un protocolo aparte.
- Sus permisos son los del sistema existente: se le asignan roles como a
  cualquier miembro, y los overwrites por canal le aplican igual.
- Los conceptos son deliberadamente paralelos a los de Discord (mensaje,
  canal, rol, reacción, webhook), así que portar un bot de discord.js es
  traducir llamadas, no repensar el diseño. Una guía de equivalencias
  (`discord.js → Distop`) forma parte del entregable.

**Lo que no se promete**: una capa de emulación completa de la API de Discord
para ejecutar bots compilados sin tocarlos. Es una superficie enorme, movediza
y sin fin — el esfuerzo va a la API propia y a la guía de porte.

## Plugins y aislamiento

El marco general está en claude.md §12 (restaurado): manifiestos con permisos
declarativos, sandboxing, lista de permisos antes de instalar, firma opcional,
instalación desde GitHub/URL/archivo. Un bot es un proceso externo con token
(no ejecuta dentro de Distop); un plugin ejecuta dentro y por eso exige
aislamiento estricto. No son lo mismo (`Plugin != Bot`, §20) y no comparten
mecanismo de seguridad.

## Orden de construcción

1. **Webhooks entrantes** compatibles con Discord — desbloquea integraciones
   existentes de inmediato.
2. **API de bots nativa** (cuentas `kind='bot'`, token, gateway) + guía de
   porte desde discord.js.
3. **Bot puente** de migración, construido sobre la API anterior.
4. Plugins con sandbox y marketplace — fase de ecosistema (§27, Fase 5).

## Coste cero

Todo corre en la instancia de quien hospeda o en el equipo de quien administra
el bot. No hay servicio central, no hay cuota por bot, no hay tienda de pago.

## Criterios de aceptación

Un webhook con el payload de ejemplo de la documentación de Discord publica en
un canal de Distop sin modificar el emisor · un token de webhook filtrado se
revoca y deja de servir en el acto · un bot sin `SEND_MESSAGES` en un canal no
puede publicar ahí aunque su token sea válido · ningún token aparece en logs
ni auditoría · un bot desconectado no bloquea nada: es un cliente más.
