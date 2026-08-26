/**
 * Migraciones del esquema de la instancia (§28.6).
 *
 * Viven aparte de db.ts porque importar db.ts abre la base: la herramienta de
 * restauración necesita saber qué versión de esquema entiende este programa
 * ANTES de tocar nada, y no puede pagar por preguntarlo abriendo el fichero que
 * está a punto de reemplazar.
 *
 * Cada entrada corre una vez, en orden, y sube `user_version`. Solo aditivas:
 * una migración tiene que poder arrancar sobre los datos de la anterior, y una
 * columna no se reutiliza nunca con otro significado.
 */

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT,
    kind          TEXT NOT NULL DEFAULT 'local',
    avatar_url    TEXT,
    banner_url    TEXT,
    bio           TEXT,
    pronouns      TEXT,
    accent_color  TEXT,
    locale        TEXT NOT NULL DEFAULT 'es',
    theme         TEXT NOT NULL DEFAULT 'system',
    settings      TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   TEXT NOT NULL UNIQUE,
    refresh_hash TEXT NOT NULL UNIQUE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    refresh_expires_at INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  CREATE TABLE communities (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description  TEXT,
    icon_url     TEXT,
    banner_url   TEXT,
    accent_color TEXT NOT NULL DEFAULT '#5b7cfa',
    theme        TEXT NOT NULL DEFAULT 'system',
    rules        TEXT,
    is_public    INTEGER NOT NULL DEFAULT 0,
    owner_id     TEXT NOT NULL REFERENCES users(id),
    created_at   INTEGER NOT NULL
  );

  CREATE TABLE categories (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    position     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_categories_community ON categories(community_id);

  CREATE TABLE channels (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
    name         TEXT NOT NULL,
    topic        TEXT,
    kind         TEXT NOT NULL DEFAULT 'text',
    position     INTEGER NOT NULL DEFAULT 0,
    slowmode_s   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_channels_community ON channels(community_id);

  CREATE TABLE roles (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    color        TEXT,
    permissions  TEXT NOT NULL DEFAULT '0',
    position     INTEGER NOT NULL DEFAULT 0,
    hoist        INTEGER NOT NULL DEFAULT 0,
    mentionable  INTEGER NOT NULL DEFAULT 1,
    is_default   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_roles_community ON roles(community_id);

  CREATE TABLE members (
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname      TEXT,
    joined_at     INTEGER NOT NULL,
    timeout_until INTEGER,
    banned        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (community_id, user_id)
  );
  CREATE INDEX idx_members_user ON members(user_id);

  CREATE TABLE member_roles (
    community_id TEXT NOT NULL,
    user_id      TEXT NOT NULL,
    role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (community_id, user_id, role_id),
    FOREIGN KEY (community_id, user_id) REFERENCES members(community_id, user_id) ON DELETE CASCADE
  );

  CREATE TABLE overwrites (
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    target_id   TEXT NOT NULL,
    target_type TEXT NOT NULL,
    allow       TEXT NOT NULL DEFAULT '0',
    deny        TEXT NOT NULL DEFAULT '0',
    PRIMARY KEY (channel_id, target_id)
  );

  CREATE TABLE messages (
    id           TEXT PRIMARY KEY,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    community_id TEXT NOT NULL,
    author_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    content      TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    edited_at    INTEGER,
    reply_to_id  TEXT,
    pinned       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id DESC);

  CREATE TABLE attachments (
    id           TEXT PRIMARY KEY,
    message_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
    owner_id     TEXT NOT NULL,
    filename     TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size         INTEGER NOT NULL,
    path         TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments(message_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji      TEXT NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE invites (
    code         TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    channel_id   TEXT REFERENCES channels(id) ON DELETE SET NULL,
    creator_id   TEXT NOT NULL,
    uses         INTEGER NOT NULL DEFAULT 0,
    max_uses     INTEGER,
    expires_at   INTEGER,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_invites_community ON invites(community_id);

  CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    actor_id     TEXT NOT NULL,
    action       TEXT NOT NULL,
    target_id    TEXT,
    details      TEXT NOT NULL DEFAULT '{}',
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_audit_community ON audit_log(community_id, id DESC);

  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  /* Estado de lectura y menciones.
     `last_read_id` es un id de mensaje, no una fecha: los UUIDv7 ya ordenan por
     tiempo, así que "lo que no he leído" es una comparación de texto contra el
     índice que ya existe, sin columna de fecha ni reloj de por medio. */
  `
  CREATE TABLE read_state (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );

  ALTER TABLE messages ADD COLUMN mentions_everyone INTEGER NOT NULL DEFAULT 0;
  `,

  /* Estado de presencia elegido a mano. Va en users y no en una tabla aparte
     porque acompaña a la persona entre dispositivos, igual que el idioma. */
  `
  ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'online';
  ALTER TABLE users ADD COLUMN custom_status TEXT;
  `,

  /* Emojis y stickers propios de cada comunidad (§10.3).
     El archivo se reutiliza de `attachments` con message_id NULL, así que se
     sirve por /api/v1/files/:id como cualquier otro y no hay un segundo camino
     que proteger. OJO: cuando exista la limpieza de adjuntos huérfanos tendrá
     que respetar los que estén referenciados aquí. */
  `
  CREATE TABLE emojis (
    id            TEXT PRIMARY KEY,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL DEFAULT 'emoji',
    attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    creator_id    TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX idx_emojis_name ON emojis(community_id, kind, name);
  CREATE INDEX idx_emojis_community ON emojis(community_id);
  `,

  /* Un GIF o sticker elegido de la galería ya no se descarga (§22): se reenvía
     desde la instancia cada vez que alguien lo ve, como la galería de avatares,
     para no ocupar disco del anfitrión con algo que Giphy ya aloja. `path` se
     deja vacío en ese caso — no se puede quitarle NOT NULL a una columna ya
     creada sin reconstruir la tabla, así que source_url es la que manda. */
  `
  ALTER TABLE attachments ADD COLUMN source_url TEXT;
  `,

  /* Personalización del perfil (§10.1): marco del avatar, placa del nombre,
     fuente, efectos y tema de la tarjeta.

     Una columna JSON y no ocho columnas: son ocho ajustes del MISMO adorno, se
     leen y se escriben siempre juntos, y añadir el noveno no debería costar una
     migración. Lo que impide que aquí entre basura no es el tipo de la columna
     sino toProfileStyle() del protocolo, que corre al guardar y al leer. */
  `
  ALTER TABLE users ADD COLUMN profile_style TEXT NOT NULL DEFAULT '{}';
  `,

  /* Un sonido puede llevar una cara propia: emoji o imagen subida. El audio y
     su imagen siguen perteneciendo a la misma comunidad y viven en la misma
     instancia; no se aceptan URL externas que puedan rastrear a quien abra la
     tabla de sonidos. */
  `
  ALTER TABLE emojis ADD COLUMN icon_emoji TEXT;
  ALTER TABLE emojis ADD COLUMN icon_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL;
  CREATE INDEX idx_emojis_icon_attachment ON emojis(icon_attachment_id);
  `,

  /* Historial de partidas del perfil ("jugados recientemente", §9.1). Solo
     partidas TERMINADAS: el "jugando ahora" vive en memoria (gamePresence.ts)
     y muere con la instancia, igual que las salas de voz. Aquí no entra nada
     que dure menos de un minuto, y hay un tope de filas por persona. */
  `
  CREATE TABLE game_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    game_name TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL
  );
  CREATE INDEX idx_game_sessions_user ON game_sessions(user_id, started_at DESC);
  `,

  /* Identidad del dispositivo, compartida entre instancias.
     La instancia solo guarda un hash del secreto: el identificador por si solo
     no permite suplantar a nadie. `user_id` es unico porque una cuenta local
     representa a una sola persona portable en este servidor. */
  `
  CREATE TABLE portable_identities (
    identity_id TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    secret_hash  TEXT NOT NULL,
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX idx_portable_user ON portable_identities(user_id);
  `,

  /* La autoridad del equipo es de la instancia, no de una comunidad. */
  `
  CREATE TABLE host_authority (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
    since      INTEGER NOT NULL,
    granted_by TEXT,
    reason     TEXT NOT NULL
  );

  INSERT INTO host_authority (id, user_id, since, granted_by, reason)
  SELECT 1, id, created_at, NULL, 'migration'
    FROM users
   WHERE kind = 'local'
   ORDER BY created_at
   LIMIT 1;
  `,

  /* Hash local versionado para integridad, delta y deduplicación futura. */
  `
  ALTER TABLE attachments ADD COLUMN content_hash TEXT;
  CREATE INDEX idx_attachments_missing_hash ON attachments(id)
    WHERE path <> '' AND content_hash IS NULL;
  `,

  /* Relevo planificado (C2).

     La autorizacion es de INSTANCIA, no de comunidad: una instancia aloja
     varias comunidades, y un sucesor elegido por la comunidad A heredaria
     tambien los datos de la B. Por la misma razon no es un bit de permiso. */
  `
  CREATE TABLE successors (
    id           TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    enrol_hash   TEXT NOT NULL,
    transfer_hash TEXT,
    instance_id  TEXT,
    fingerprint  TEXT,
    public_key   TEXT,
    origin       TEXT,
    max_epoch    INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    enrolled_at  INTEGER,
    last_seen    INTEGER,
    revoked_at   INTEGER
  );
  CREATE INDEX idx_successors_vivos ON successors(revoked_at, expires_at);

  CREATE TABLE handovers (
    id           TEXT PRIMARY KEY,
    successor_id TEXT NOT NULL REFERENCES successors(id) ON DELETE CASCADE,
    state        TEXT NOT NULL CHECK (state IN
                   ('PREPARING','STANDBY_SYNC','READY_TO_ACTIVATE','ACTIVATING','COMPLETED','ABORTED','FAILED')),
    unplanned    INTEGER NOT NULL DEFAULT 0 CHECK (unplanned IN (0,1)),
    reason       TEXT,
    to_epoch     INTEGER NOT NULL,
    certificate  TEXT,
    receipt      TEXT,
    bundle_hash  TEXT,
    bundle_key   TEXT,
    announced_at INTEGER,
    activates_at INTEGER NOT NULL,
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    error_code   TEXT
  );
  CREATE INDEX idx_handovers_estado ON handovers(state, started_at DESC);

  /* Un solo mandato vivo por epoca de destino. Firmar dos sucesores para N+1
     seria fabricar un fork con nuestra propia clave, y ningun cliente podria
     decidir cual de los dos es el bueno. */
  CREATE UNIQUE INDEX idx_handover_epoca_viva ON handovers(to_epoch)
    WHERE state IN ('PREPARING','STANDBY_SYNC','READY_TO_ACTIVATE','ACTIVATING');
  `,

  /* Migracion de una sola comunidad entre instancias (C3).

     `migrated_to` no borra la comunidad: la marca. Borrarla seria irreversible
     justo cuando alguien acaba de descubrir que el destino no funciona, y la
     exportacion del §21 tiene que seguir existiendo. */
  `
  ALTER TABLE communities ADD COLUMN migrated_to TEXT;

  CREATE TABLE community_migrations (
    id                   TEXT PRIMARY KEY,
    community_id         TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    state                TEXT NOT NULL CHECK (state IN
                           ('DRAFT','EXPORTING','VERIFYING','READY','ACTIVATING','COMPLETED','FAILED')),
    destination_origin   TEXT NOT NULL,
    destination_instance TEXT NOT NULL,
    snapshot_hash        TEXT,
    certificate          TEXT,
    bundle_key           TEXT,
    files                INTEGER NOT NULL DEFAULT 0,
    bytes                INTEGER NOT NULL DEFAULT 0,
    missing_files        INTEGER NOT NULL DEFAULT 0,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    error_code           TEXT
  );
  CREATE INDEX idx_migraciones_comunidad ON community_migrations(community_id, created_at DESC);
  `,

  /* Web Push opcional (A2).

     Ni el endpoint ni las claves se guardan en claro: `sealed` es AES-256-GCM
     con una clave que vive en push.key. Un endpoint es una URL capaz de
     despertar el navegador de una persona, y auth+p256dh cifran lo que se le
     manda; los tres juntos, en un app.db que alguien comparte, son el juego
     completo. Esto protege la base por su cuenta, no al que tiene el
     directorio de datos entero.

     `endpoint_hash` existe para poder deduplicar y dar de baja sin guardar la
     direccion. Es UNIQUE porque el navegador renueva la misma suscripcion y
     eso tiene que actualizar, no acumular. */
  `
  CREATE TABLE push_subscriptions (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint_hash TEXT NOT NULL UNIQUE,
    sealed        TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    last_success  INTEGER,
    failures      INTEGER NOT NULL DEFAULT 0,
    next_attempt  INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_push_usuario ON push_subscriptions(user_id);
  CREATE INDEX idx_push_reintento ON push_subscriptions(next_attempt);
  `,

  /* Reuniones (V1).

     Una reunion es un canal con kind='meeting' MAS una fila aqui. El canal
     aporta mensajes, adjuntos, permisos, overwrites, busqueda y fijados sin
     una linea de codigo nueva; esta tabla aporta lo unico que un canal no
     tiene: principio, final, quien mandaba y quien estuvo.

     Los estados y las banderas llevan CHECK y no texto libre: un estado
     invalido escrito por un bug se descubre meses despues, cuando alguien
     intenta cerrar una reunion que ya no sabe en que estado esta. */
  `
  CREATE TABLE meetings (
    id            TEXT PRIMARY KEY,
    channel_id    TEXT NOT NULL UNIQUE REFERENCES channels(id) ON DELETE CASCADE,
    community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
    title         TEXT NOT NULL,
    agenda        TEXT,
    organizer_id  TEXT NOT NULL REFERENCES users(id),
    state         TEXT NOT NULL CHECK (state IN ('DRAFT','SCHEDULED','LOBBY','LIVE','ENDED','CANCELLED')),
    starts_at     INTEGER,
    ends_at       INTEGER,
    opened_at     INTEGER,
    closed_at     INTEGER,
    lobby         INTEGER NOT NULL CHECK (lobby IN (0,1)) DEFAULT 1,
    mute_on_entry INTEGER NOT NULL CHECK (mute_on_entry IN (0,1)) DEFAULT 1,
    guests_allowed INTEGER NOT NULL CHECK (guests_allowed IN (0,1)) DEFAULT 0,
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX idx_reuniones_comunidad ON meetings(community_id, starts_at);

  /* Papeles DENTRO de la reunion, sin relacion con los roles de la comunidad:
     organizar una reunion no da poder sobre el servidor, y administrar el
     servidor no convierte a nadie en organizador en silencio. */
  CREATE TABLE meeting_roles (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('host','cohost','presenter','attendee','viewer')),
    PRIMARY KEY (meeting_id, user_id)
  );

  /* Sin esto no se puede cumplir la promesa de decir quien estuvo y cuanto.
     La clave incluye joined_at porque entrar, salir y volver son dos tramos:
     un unico left_at por persona perderia el segundo y mentiria sobre el
     primero. */
  CREATE TABLE meeting_attendance (
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,
    joined_at    INTEGER NOT NULL,
    left_at      INTEGER,
    admitted_by  TEXT,
    role_at_join TEXT NOT NULL,
    PRIMARY KEY (meeting_id, user_id, joined_at)
  );
  CREATE INDEX idx_asistencia_reunion ON meeting_attendance(meeting_id, joined_at);
  `,

  /* Invitados de reunion (V2).

     Entrar por un enlace sin instalar nada, sin crear cuenta y sin aguantar un
     boton que pide descargar la aplicacion es la ventaja real frente a las
     alternativas, y las dos piezas ya existian: canales con permisos y sesiones
     revocables.

     Lo que NO se hace: meter al invitado en `members`. Un invitado de una
     reunion no es miembro de la comunidad, y anadirlo le daria acceso a todo lo
     demas y le pondria en la lista de miembros de todo el mundo. En su lugar
     `meeting_guests` lo ata a UNA reunion, y los permisos se calculan a partir
     de ahi.

     De la invitacion solo se guarda el hash: el enlace es el secreto, y una
     base robada no debe entregar las invitaciones vivas. */
  `
  ALTER TABLE sessions ADD COLUMN meeting_id TEXT;

  CREATE TABLE meeting_invites (
    id          TEXT PRIMARY KEY,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    creator_id  TEXT NOT NULL,
    label       TEXT,
    uses        INTEGER NOT NULL DEFAULT 0,
    max_uses    INTEGER,
    expires_at  INTEGER,
    revoked_at  INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_invitaciones_reunion ON meeting_invites(meeting_id);

  CREATE TABLE meeting_guests (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    invite_id  TEXT,
    created_at INTEGER NOT NULL,
    admitted_at INTEGER
  );
  CREATE INDEX idx_invitados_reunion ON meeting_guests(meeting_id);
  `,

  /* Grabacion de reuniones (V3).

     El FICHERO no esta aqui: vive en el ordenador de quien graba. Mezclar en el
     servidor exigiria decodificar, componer y recodificar cada fotograma de
     cada persona en el PC de quien hospeda, que es justo el trabajo que este
     proyecto no le puede pedir a un ordenador domestico.

     Lo que si vive aqui es quien grabo, cuando y en que estado acabo: sin eso,
     "hubo una grabacion" seria una afirmacion sin respaldo. */
  `
  CREATE TABLE meeting_recordings (
    id          TEXT PRIMARY KEY,
    meeting_id  TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    recorder_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state       TEXT NOT NULL CHECK (state IN
                  ('REQUESTED','CONSENTING','RECORDING','FINALIZING','AVAILABLE','FAILED','DELETED')),
    started_at  INTEGER,
    ended_at    INTEGER,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX idx_grabaciones_reunion ON meeting_recordings(meeting_id, created_at DESC);
  `,
];

/** Hasta qué versión de esquema sabe leer este programa. Una copia con un
    número mayor viene de una versión más nueva y no se restaura a ciegas. */
export const SCHEMA_VERSION = MIGRATIONS.length;
