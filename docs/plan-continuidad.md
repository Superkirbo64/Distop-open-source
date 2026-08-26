# Plan de continuidad, reuniones y avisos — seguimiento

Documento de trabajo. Es la lista completa de pasos del plan, en orden, con lo
hecho marcado. **Nada se marca sin prueba que lo respalde y sin `npm test` y
`npm run typecheck` en verde.**

Se hace un commit al cerrar cada fase real, nunca a mitad.

## Orden y estado

| # | Fase | Qué entrega sola | Estado |
|---|---|---|---|
| 0 | Cierre de C0/A1 | Base resistente y observable | ✅ cerrada |
| 1 | C1 — copia cifrada y restauración | Recuperación ante pérdida | ✅ cerrada |
| 2 | C2 — relevo planificado | Cambio de anfitrión sin copiar la clave | ✅ cerrada |
| 3 | C3 — alternativas firmadas y migración | Recuperación de dirección | ✅ cerrada |
| 4 | A1 final — avisos conscientes de sucesión | "Se trasladó" con respaldo criptográfico | ✅ |
| 5 | A2 — Web Push opcional | Aviso con la aplicación cerrada | ✅ |
| 6 | V1 — reuniones, lobby y estados | Reunión funcional | ✅ |
| 7 | V2 — invitados, admisión y asistencia | Reunión con gente de fuera | ✅ |
| 8 | V3 — presupuesto de vídeo y grabación | Reunión dentro de límites reales | ✅ |
| 9 | V4 — calendario, ICS y push-to-talk | Agenda y pulido de voz | ✅ |

**Fuera de alcance, explícitamente:** Android, Capacitor, Java, servidor
embebido móvil · promoción automática de sucesores · sincronización continua
anfitrión↔sucesor · plataforma central obligatoria · SFU.

**Regla dura de coste:** ni quien hospeda ni quien participa paga nada. Ningún
camino recomendado puede terminar en "compra esto" o "contrata aquello".

---

## Fase 0 — cierre de C0/A1 ✅

- [x] 0.1 Prueba de apagado durante una subida activa — `shutdown.test.ts`
- [x] 0.2 Recuperación de temporales tras cierre forzado — `uploads/.incoming` + `sweepIncoming()`
- [x] 0.3 Progreso del backfill observable en `/health` — `integrity.attachment_hashes`
- [x] 0.4 Pausas operativas del backfill — llamada, mantenimiento, presión de disco
- [x] 0.5 Limpieza semántica de A1 — ninguna ruta anuncia "moved"
- [x] 0.6 Prueba de integración del vigilante contra servidor real
- [x] Ruta y pruebas de transferencia de autoridad del anfitrión

**Criterio de cierre cumplido:** apagado activo probado · temporales
recuperables · backfill con progreso visible · ninguna ruta dice "se mudó" · un
WebSocket falso no produce notificación · integración del vigilante probada.

---

## Fase C1 — copia cifrada y restauración ✅

- [x] Formato `.distop-backup` v1: encabezado en claro mínimo, resto cifrado
- [x] scrypt (N=32768, r=8, p=1) con sal aleatoria, parámetros en el encabezado
- [x] AES-256-GCM por bloques, nonce por bloque, índice y marca final autenticados
- [x] Escritura en streaming, `.partial`, `fsync` antes del renombrado
- [x] Snapshot coherente de SQLite con escrituras congeladas
- [x] Manifiesto cifrado con generación, conteos, redacciones y hash por archivo
- [x] Redacción de `voice_relay` y `public.fixed`
- [x] Inspección sin restaurar (rápida y `--deep`)
- [x] Restauración atómica con verificación previa completa
- [x] Verificación cruzada de la tabla `attachments` contra el manifiesto
- [x] Diario de restauración con reversión y reanudación
- [x] `INSTANCE_RESTORE_COMPLETED` en la auditoría de cada comunidad
- [x] Rechazo de esquema más nuevo, rutas que escapan, duplicados y truncamiento
- [x] Prueba end-to-end entre dos directorios independientes

---

## Fase C2 — relevo planificado ✅

Documentado en [relevo.md](relevo.md).

- [x] `instance_id` cambia, `lineage_id` permanece, `epoch` sube exactamente 1
- [x] El sucesor genera clave propia; la del predecesor **nunca** viaja
- [x] Certificado `DISTOP_SUCCESSION_CERT` firmado sobre JSON canónico
- [x] Cadena verificable desde la identidad fijada, con tope de eslabones
- [x] Estados `PREPARING · STANDBY_SYNC · READY_TO_ACTIVATE · ACTIVATING · COMPLETED · ABORTED · FAILED`
- [x] Roles `PRIMARY → SUPERSEDED` y `STANDBY → PRIMARY`; nunca dos PRIMARY mutando
- [x] Autorización a nivel de instancia, no de comunidad, y no como bit de permiso
- [x] Un solo mandato vivo por época de destino (índice único parcial)
- [x] Código de emparejamiento de un solo uso, TTL, guardado como hash
- [x] Transferencia **pull**, por rangos HTTP, reanudable
- [x] Certificado prefirmado al enrolar, no al final
- [x] Copia final con las escrituras congeladas: no se pierde lo escrito durante la espera
- [x] Recibo firmado por la clave del sucesor antes de que el predecesor se retire
- [x] `410 INSTANCE_SUPERSEDED` con origen y cadena; salud, info, cadena, login y export siguen abiertos
- [x] Cancelable antes y durante el corte, sin tocar la época
- [x] Una instancia retirada no vuelve a PRIMARY por su cuenta
- [x] Aviso de 24 h por defecto; emergencia con confirmación reforzada y auditada
- [x] Tres acciones de salida diferenciadas
- [x] Rotación del secreto de sesiones con ventana doble y reanclaje en el primer uso
- [x] Pruebas: firma manipulada · firmante que no es el predecesor · huella declarada ·
      época saltada/repetida/atrás · linaje distinto · caducado · auto-autorización ·
      lista de orígenes sin fondo · cadena demasiado larga · eslabón que no encaja ·
      relevo completo A→B con arranque real de B · sesión que sobrevive · dos relevos a la vez

**Pendiente consciente:** `--promote --force` cubre la muerte del predecesor, pero
no hay prueba automatizada de "A cae justo entre el recibo y la activación".

---

## Fase C3 — alternativas firmadas y migración ✅

### 3.1 Orígenes firmados ✅
- [x] `DISTOP_ORIGIN_SET` con `generation`, lista de orígenes y caducidad
- [x] Firmado por la clave actual; nunca se acepta un `generation` menor
- [x] Solo para autenticados (`GET /api/v1/instance/origins`); **jamás** en `/api/v1/info`
- [x] Máximo tres pistas; etiqueta elegida por quien hospeda, recortada a 60
- [x] Cambiarlas queda en la auditoría de cada comunidad

### 3.2 Cadena conocida en el cliente ✅
- [x] `KnownInstance.chain` persistente con los certificados verificados
- [x] `canonicalJson` compartido entre servidor y navegador (era una copia local
      en cada lado: si divergen, una firma legítima deja de validar)
- [x] `rememberCommunities` ya hace spread de `previous`

### 3.3 Detección de fork ✅
- [x] Mismo linaje + misma época + claves distintas → conflicto guardado, sin elegir
- [x] No se manda el token a ninguna; `continuityConflict()` lo expone a la interfaz
- [x] Época menor o linaje distinto se rechazan por separado, con motivo propio

### 3.4 Migración de una comunidad ✅
- [x] `DISTOP_COMMUNITY_MIGRATION` firmado, atado al destino Y al hash del bundle
- [x] Estados `DRAFT → EXPORTING → READY → COMPLETED/FAILED`
- [x] En `DRAFT` no cambia nada visible ni se notifica a nadie; sí se estima tamaño y qué falta
- [x] IDs preservados; importación idempotente (`INSERT OR IGNORE` + conteo)
- [x] Adjuntos deduplicados por contenido
- [x] Colisión incompatible (mismo id, otro contenido / mismo nombre de usuario, otra
      persona) → aborta y la nombra; nunca remapea en silencio
- [x] Orden de inserción respetando claves foráneas, con las personas primero
- [x] `410 COMMUNITY_MIGRATED` con la dirección nueva; la exportación sigue abierta
- [x] Lo pide quien administra la comunidad, no quien hospeda (§21)

### 3.5 Aceptación por miembros ✅
- [x] Sin cadena firmada verificada, **nunca automático**
- [x] Sucesión válida de una instancia ya fijada: se acepta tras verificar la cadena
- [ ] Borradores por linaje en el cliente (pendiente, va con la interfaz de C3)

---

## Fase A1 final — avisos conscientes de sucesión ✅

Documentado en [aviso-de-vuelta.md](aviso-de-vuelta.md).

- [x] Resultados: `available_same · available_successor · unavailable · identity_conflict · membership_revoked · protocol_incompatible`
- [x] "La comunidad volvió" solo para `available_same`
- [x] "La comunidad se trasladó" solo con cadena de sucesión válida
- [x] Dos caminos hasta esa cadena: el sucesor que firma aquí (`inbound_chain`)
      y la máquina retirada que dice a dónde se fue (`chain` + `superseded`)
- [x] El destino sale de `allowed_origins` **firmado**, no de `successor_origin`
- [x] `identity_conflict` no notifica vuelta: se guarda y se cuenta al abrir
- [x] Un conflicto **detiene el sondeo**; lo desbloquea una persona, no un temporizador
- [x] La alerta lleva la huella que contestó, para poder comprobarla por otro canal
- [x] `membership_revoked`: quitar vigilancia, no mostrar el nombre, limpiar caché
- [x] Detectado por el cliente (el vigilante sondea sin credenciales) comparando
      con lo que había: una cuenta nueva sin comunidades no ha perdido nada
- [x] `protocol_incompatible`: no cuenta como ausencia, no se le manda nada,
      se reintenta espaciado por si su anfitrión la actualiza
- [x] Cada alerta se emite **al cambiar**, no en bucle cada cinco minutos
- [x] Las reglas de sucesión vienen de `@distop/protocol`, no copiadas: el
      escritorio empaqueta una copia CommonJS del paquete (`stage-protocol.mjs`)
- [x] Pruebas: 60 en escritorio (reglas + vigilante contra servidor real) y 12
      en el cliente (frontera con el escritorio)

**Pendiente consciente:** la interfaz que enseña la alerta al abrir todavía no
está pintada; el dato se guarda en `watch_alert` y `conflict`, y `Settings.tsx`
ya lee `continuityConflict`.

---

## Fase A2 — Web Push opcional ✅

Documentado en [aviso-de-vuelta.md](aviso-de-vuelta.md).

- [x] Tabla `push_subscriptions` con endpoint **y** claves cifradas en reposo
      (AES-256-GCM, clave en `data/push.key`); solo se guarda en claro el hash
      del endpoint, para deduplicar y dar de baja sin conservar la dirección
- [x] VAPID propio de la instancia, generado solo; viaja en la copia C1 y en el
      relevo C2, con la advertencia escrita en las tres documentaciones
- [x] RFC 8291 (ECDH P-256 + HKDF-SHA256 + AES-128-GCM) y RFC 8292 (JWT ES256)
      a mano con `node:crypto`, sin dependencias nuevas
- [x] **El vector del RFC 8291 §5 se reproduce byte a byte** — la prueba que
      hace que "está bien" no sea una opinión
- [x] Relleno a tamaño fijo: el proveedor ve el tamaño aunque no el contenido
- [x] Payload mínimo `{v,t,n?}`: ni comunidad, ni canal, ni texto, ni quién, ni URL
- [x] Eventos hoy: instancia disponible y mención. `@everyone` **no** manda push
- [x] Mención solo a quien no tiene la aplicación abierta, es miembro y ve el
      canal; una cada dos minutos por persona
- [x] Caída medida con latido de 30 s, no con marca de apagado limpio (un corte
      de luz no deja escribir nada, y es justo el caso que hay que cubrir)
- [x] 404/410 → revocar; fallos temporales → 1 m · 5 m · 30 m · 2 h · 12 h y al
      quinto se borra; nunca bucle
- [x] Umbral de 90 s compartido con A1: quien tenga los dos no recibe dos
      versiones distintas de la misma verdad
- [x] Solo https y sin credenciales en el endpoint (protección SSRF, §22);
      tope de 8 suscripciones por persona
- [x] Service worker con `push` y `notificationclick`, textos en los tres
      idiomas, una sola notificación por tipo
- [x] Interruptor en Ajustes que solo aparece donde puede funcionar, con la
      contrapartida de privacidad escrita **antes** de activarlo
- [x] 23 pruebas propias

**Fuera de alcance por orden, no por olvido:** "reunión próxima" y "admisión"
son eventos de V1 y V2 — no existen todavía las reuniones. La invitación tiene
su código de aviso reservado y no está cableada: un enlace de invitación se
comparte por fuera, así que no hay un momento claro en el que avisar.

**Límite consciente:** el cifrado en reposo protege la base por su cuenta —un
`app.db` compartido, una copia suelta—, no a quien tiene el directorio de datos
entero, porque la clave vive ahí al lado.

---

## Fase V1 — reuniones, lobby y estados ✅

Documentado en [reuniones.md](reuniones.md).

- [x] Tablas `meetings`, `meeting_roles`, `meeting_attendance` con `CHECK` en estados y banderas
- [x] Canal con `kind='meeting'`; la barra lateral lo aparta en su propia sección
- [x] Estados `DRAFT · SCHEDULED · LOBBY · LIVE · ENDED · CANCELLED`, con la tabla de
      transiciones en el protocolo — compartida con el cliente, para que la interfaz
      no enseñe botones que fallan
- [x] `ENDED` no vuelve a abrir: reabrir falsearía asistencia y duración
- [x] Permiso `MANAGE_MEETINGS` (bit 33; las columnas son cadenas de BigInt, sin migración)
- [x] Roles efímeros `host · cohost · presenter · attendee · viewer`, sin relación con
      los roles de la comunidad
- [x] Nadie reparte un papel igual o superior al suyo; no se destituye al último anfitrión
- [x] La comunidad conserva poderes de seguridad, auditados: puede cerrar, no apropiarse
- [x] **Lobby estructural**: quien espera no entra en el registro de voz, así que
      `relayMedia` no tiene a dónde mandarle nada. Probado byte a byte en las dos
      direcciones, con el anfitrión sin silenciar para que la aserción pruebe la sala
      de espera y no el silencio
- [x] La lista de quién espera solo llega a quien puede abrir; denegar no dice quién decidió
- [x] Mano levantada con marca de tiempo y cola por orden de llegada; insistir no adelanta
- [x] Cada comando del gateway revalida el permiso en el servidor, y está probado que
      un asistente que lo manda a mano no admite a nadie
- [x] Sin moderador presente no se cierra ni se promociona a nadie; sala vacía sí termina
- [x] 16 pruebas propias, contra el gateway real con WebSockets

**Deuda consciente:** la interfaz de la reunión (sala de espera, manos, papeles)
todavía no está pintada más allá de la sección en la barra lateral; el protocolo,
las rutas y los eventos están completos y probados.

---

## Fase V2 — invitados, admisión y asistencia ✅

Documentado en [reuniones.md](reuniones.md).

- [x] `meeting_invites` con `token_hash`, `max_uses`, `expires_at`, `revoked_at`;
      el token se enseña una sola vez y en la base solo vive su hash
- [x] La comprobación ocurre **antes** de crear identidad: enlace, reunión,
      invitados permitidos, caducidad, usos y aforo. Probado que un enlace
      inventado no deja ni una cuenta basura
- [x] Un solo código de error para "no existe" y "no vale": distinguirlos sería
      un oráculo de qué enlaces existen. Los estados de la reunión sí se dicen,
      porque quien llega pronto merece saber que llegó pronto
- [x] Sesión acotada a UNA reunión (`sessions.meeting_id`), revocable como
      cualquier otra, con el nombre saneado
- [x] **Lista blanca en una sola puerta** (`http.ts`): lo que no está, no pasa.
      Una lista negra dejaría permitida por omisión cualquier ruta futura
- [x] El id de la ruta tiene que ser el suyo: que la *forma* encaje no basta,
      y está probado contra otra reunión de la misma comunidad
- [x] Un invitado **no entra en `members`**: no aparece en ninguna lista de
      miembros y `SUBSCRIBE` lo rechaza por no serlo
- [x] Recibe lo de su propio canal por un camino explícito (`guestChannel`),
      no por la suscripción de comunidad
- [x] Permisos fijos y mínimos: ver, escribir, reaccionar, entrar, hablar y
      cámara — **en su canal y solo mientras la reunión siga abierta**. Sin
      adjuntar ficheros al disco de quien hospeda
- [x] Asistencia por tramos (hecho en V1), visible solo para quien modera
- [x] Limpieza de invitados que nunca entraron, sin tocar a quien sí estuvo ni a
      quien convirtió su paso en una cuenta de la comunidad
- [x] 16 pruebas propias, la mayoría negativas

**Desviación consciente del boceto del plan:** el token va en el **cuerpo** de
`POST /api/v1/meetings/guest`, no en la ruta `/:code/`. Una ruta acaba en los
registros de acceso de cualquier proxy y en la cabecera `Referer`; el §22 del
proyecto dice que los tokens no se registran en logs.

---

## Fase V3 — presupuesto de vídeo y grabación ✅

Documentado en [reuniones.md](reuniones.md).

- [x] Cálculo **antes** de aceptar la fuente, con participantes, fuentes en curso,
      coste por receptor, techo del anfitrión, modo y presión de la instancia
- [x] El vídeo se limita antes que el audio: bajo presión (copia, relevo) el techo
      se recorta al 60 % — una voz entrecortada es un fallo visible y una cámara
      de menos, una molestia
- [x] Prioridad: pantalla > cámara del presentador > moderador hablando > dinámicos > cola
- [x] **Ninguna reserva rompe el techo físico**: la sexta pantalla compartida
      espera igual que todo lo demás
- [x] El cliente **no declara su prioridad**: sale de su papel en la reunión y del
      tipo de fuente, los dos resueltos en el servidor
- [x] Se decide con el candidato dentro, no contra un hueco libre: una pantalla
      compartida desplaza a una cámara en vez de ponerse a la cola
- [x] Siempre cabe una fuente: una conexión mala no convierte la reunión en un teléfono
- [x] `host` y `direct` medidos y probados **por separado** — en `direct` el
      servidor no ve el bitrate real y no finge un número; solo conserva el orden
- [x] Rechazar no pone la fuente, así que `relayMedia` la descarta por
      construcción — la misma propiedad estructural que la sala de espera
- [x] Grabación **local**: el fichero vive en el equipo de quien graba. Sin mezcla
      en servidor y sin un solo byte de vídeo por esa ruta
- [x] Estados `REQUESTED · CONSENTING · RECORDING · FINALIZING · AVAILABLE · FAILED · DELETED`
      con transiciones explícitas: no se graba sin pasar por el aviso, y nada se
      marca disponible sin que alguien cierre el fichero
- [x] El aviso llega **antes**: a quien espera en la puerta se le dice que se está
      grabando antes de admitirle
- [x] Auditoría de inicio, disponible, fallo y borrado; una grabación viva al
      cerrar la reunión queda `FAILED`, nunca `AVAILABLE`
- [x] 15 pruebas propias

**Deuda consciente:** la escritura progresiva en el cliente (puente de escritorio,
File System Access API, fragmentos en IndexedDB) está diseñada en el documento y
no implementada; el servidor ya lleva el estado, el aviso y la auditoría.

---

## Fase V4 — calendario, ICS y push-to-talk ✅

Documentado en [reuniones.md](reuniones.md).

- [x] ICS con UID estable, `DTSTAMP`, `DTSTART`/`DTEND`, `SEQUENCE`, `STATUS`,
      escapado (`\` primero, luego `;` `,` y salto) y **CRLF, incluido el final**
- [x] Plegado a 75 **octetos**, contando bytes y sin partir un carácter multibyte
- [x] UTC almacenado; la zona original se guarda aparte y **no se usa para
      calcular** — una zona cambia de reglas y "18:00 en Madrid" se desplaza sola
- [x] Reprogramar sube `SEQUENCE` con el mismo UID; cancelar pone
      `STATUS:CANCELLED` en vez de quitar el evento del fichero
- [x] `GET /api/v1/calendars/:token/events.ics`, token revocable y guardado como
      hash; la agenda solo trae reuniones de comunidades donde eres miembro y
      canales que ves
- [x] Una agenda vacía sigue siendo un calendario válido
- [x] PTT con foco: el turno lo **arbitra el servidor** y se comprueba en
      `relayMedia`, donde pasa el audio — si solo se comprobara al pedirlo, quien
      no pidiera nada seguiría sonando
- [x] Tiempo máximo de turno (2 min) y límite por socket y por segundo, no por
      IP y por hora: pulsar para hablar produce decenas de mensajes legítimos
- [x] El turno se suelta al salir de la sala y al cerrar la pestaña
- [x] PTT global **fuera**, como dice el plan: `globalShortcut` de Electron no da
      ciclo de pulsación y liberación, y hacerlo bien exige un hook nativo con su
      propia revisión de permisos
- [x] 12 pruebas propias

**Concesión consciente:** el token del calendario va en la **URL**. Es la única
de todo el proyecto, y es inherente al formato: un cliente de calendario solo
sabe pedir una dirección — no puede mandar una cabecera ni un cuerpo. Se
compensa con lo que sí está en nuestra mano: es de un solo propósito, no da
sesión, se guarda hasheado y se revoca en un clic.

---

## Reglas transversales (aplican a todas las fases)

- **Migraciones**: solo aditivas, cada una arranca sobre los datos anteriores, se
  sube `PRAGMA user_version`, se prueban base vacía y base antigua.
- **Protocolo**: cada función nueva aparece como capacidad declarada en
  `CAPABILITIES`; nunca se deduce del número de versión.
- **Auditoría**: copia creada, restore inspeccionado y ejecutado, handover
  iniciado/cancelado/activado, autoridad reclamada o transferida, origen
  modificado, certificado aceptado o rechazado, reunión creada o cancelada,
  invitado admitido o expulsado, grabación iniciada o eliminada.
  **Nunca** frases, tokens ni claves privadas.
- **Límites**: cada endpoint nuevo define tamaño máximo, rate limit, timeout,
  permiso, comportamiento en mantenimiento, idempotencia y código de error estable.

## Verificación

```bash
npm test          # node-server + web + escritorio
npm run typecheck # los cuatro tsconfig
```

## Limitaciones que la interfaz debe decir (§29.3)

1. Una copia offline no se puede revocar.
2. A quien nunca vio al sucesor no se le puede avisar.
3. No hay exclusión mutua verdadera; dos escrituras divergentes no se fusionan.
4. Borrar la copia anterior es una promesa de una persona.
5. Los hashes de contraseña viajan.
6. El primer contacto es confianza ciega (TOFU).
7. Apagar el PC de golpe no avisa a nadie de forma fiable en Windows.
8. Tailscale Funnel es beta, solo TLS, puertos 443/8443/10000, y un fallo de
   certificado puede dejar la dirección inaccesible hasta 34 horas.
9. En el navegador no hay intervalo garantizado de comprobación.
10. Web Push implica al proveedor del navegador.
