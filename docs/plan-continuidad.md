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
| 4 | A1 final — avisos conscientes de sucesión | "Se trasladó" con respaldo criptográfico | ⬜ |
| 5 | A2 — Web Push opcional | Aviso con la aplicación cerrada | ⬜ |
| 6 | V1 — reuniones, lobby y estados | Reunión funcional | ⬜ |
| 7 | V2 — invitados, admisión y asistencia | Reunión con gente de fuera | ⬜ |
| 8 | V3 — presupuesto de vídeo y grabación | Reunión dentro de límites reales | ⬜ |
| 9 | V4 — calendario, ICS y push-to-talk | Agenda y pulido de voz | ⬜ |

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

## Fase A1 final — avisos conscientes de sucesión ⬜

- [ ] Resultados: `available_same · available_successor · unavailable · identity_conflict · membership_revoked · protocol_incompatible`
- [ ] "La comunidad volvió" solo para `available_same`
- [ ] "La comunidad se trasladó" solo con cadena de sucesión válida
- [ ] `identity_conflict` no notifica vuelta: alerta de seguridad al abrir
- [ ] `membership_revoked`: quitar vigilancia, no mostrar el nombre, limpiar caché
- [ ] `protocol_incompatible`: aviso opcional, sin mandar tokens

---

## Fase A2 — Web Push opcional ⬜

- [ ] Tabla `push_subscriptions` con endpoint y claves **cifradas en reposo**
- [ ] VAPID propio de la instancia; la privada entra en la copia C1
- [ ] RFC 8291 (ECDH P-256 + HKDF + AES-128-GCM) y RFC 8292 (JWT ES256) a mano
- [ ] Payload mínimo: ni nombre de comunidad, ni mensajes, ni usuarios, ni URL privada
- [ ] Eventos: instancia disponible, mención, reunión próxima, invitación, admisión
- [ ] 404/410 → revocar; fallos temporales → backoff; nunca bucle
- [ ] Cooldown compartido con A1; no sustituye al vigilante de escritorio

---

## Fase V1 — reuniones, lobby y estados ⬜

- [ ] Tablas `meetings`, `meeting_roles`, `meeting_attendance` con `CHECK` en estados
- [ ] Canal con `kind='meeting'`, filtrado de la barra lateral
- [ ] Estados `DRAFT · SCHEDULED · LOBBY · LIVE · ENDED · CANCELLED` con transiciones explícitas
- [ ] Permiso `MANAGE_MEETINGS`
- [ ] Roles de reunión efímeros: `host · cohost · speaker/presenter · attendee · viewer`
- [ ] La comunidad conserva poderes de seguridad, auditados
- [ ] Lobby: `VOICE_JOIN` no mete en `rooms`, así `relayMedia` descarta por construcción
- [ ] Mano levantada con cola por orden de llegada
- [ ] Eventos de gateway con revalidación de permisos en servidor
- [ ] Política si no queda ningún host

---

## Fase V2 — invitados, admisión y asistencia ⬜

- [ ] `meeting_invites` con `token_hash`, `max_uses`, `expires_at`, `revoked_at`
- [ ] `POST /api/v1/meetings/:code/guest` que valida **antes** de crear identidad
- [ ] Sesión de invitado limitada a la reunión, TTL corto, revocable, nombre saneado
- [ ] Sin enumeración de miembros fuera de la reunión
- [ ] Asistencia por eventos, no por un único `left`
- [ ] Visible solo para roles autorizados; retención definida; exportable
- [ ] Limpieza de invitados nunca admitidos

---

## Fase V3 — presupuesto de vídeo y grabación ⬜

- [ ] Cálculo antes de aceptar fuente: participantes, fuentes, bitrate, capacidad, modo, presión
- [ ] Limitar vídeo antes que audio; bajar calidad antes de desconectar
- [ ] Prioridad: pantalla > cámara del presentador > organizador hablando > dinámicos > cola
- [ ] Ninguna reserva rompe el techo físico
- [ ] El cliente no declara su propia prioridad
- [ ] Modos `host` y `direct` medidos y probados por separado
- [ ] Grabación local del cliente autorizado, sin acumular horas en RAM
- [ ] Consentimiento visible, indicador permanente, evento de auditoría
- [ ] Estados `REQUESTED · CONSENTING · RECORDING · FINALIZING · AVAILABLE · FAILED · DELETED`
- [ ] Sin mezcla en servidor

---

## Fase V4 — calendario, ICS y push-to-talk ⬜

- [ ] ICS con UID estable, DTSTAMP, DTSTART/DTEND, SEQUENCE, STATUS, escapado y CRLF
- [ ] UTC almacenado, zona original conservada para presentación
- [ ] Modificar sube SEQUENCE con el mismo UID; cancelar pone `STATUS:CANCELLED`
- [ ] `GET /api/v1/calendars/:token/events.ics` con token revocable guardado como hash
- [ ] PTT con foco: estados por participante, servidor arbitra el turno, timeout, rate limit
- [ ] PTT global queda fuera (requiere hook nativo)

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
