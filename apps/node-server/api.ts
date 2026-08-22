/**
 * API REST v1 de la instancia (§18).
 * Regla sin excepciones: cada handler resuelve permisos contra la base antes de
 * leer o escribir. La validación del cliente es cortesía, esta es la que cuenta.
 */
import { randomBytes } from "node:crypto";
import { PERMISSIONS, ALL_PERMISSIONS, CUSTOM_EMOJI, EMOJI_KINDS, EMOJI_NAME, USER_STATUSES, has, toBits, toProfileStyle, uuidv7 } from "@distop/protocol";
import type { Snowflake } from "@distop/protocol";
import { config, MAX_UPLOAD_BYTES } from "./config.ts";
import { setTunnelAutostart, tunnelAutostart, publicUrl, startTunnel, stopTunnel, tunnelState } from "./tunnel.ts";
import { iceServers, relayState, setRelay, videoMode } from "./ice.ts";
import { audit, db, markCommunityRead, seedCommunity, uniqueSlug } from "./db.ts";
import {
  authenticate,
  countOwners,
  createGuest,
  createSession,
  createUser,
  findUserById,
  findUserByUsername,
  hashPassword,
  isInstanceOwner,
  revokeAllSessions,
  revokeSession,
  rotateSession,
  toPublicUser,
  toSelfUser,
  verifyPassword,
} from "./auth.ts";
import {
  categoriesOf,
  channelsOf,
  communitiesForUser,
  getChannel,
  getCommunity,
  getMember,
  getMessage,
  getRole,
  lastReadId,
  membersOf,
  messagesOf,
  rolesOf,
  unreadOf,
} from "./entities.ts";
import {
  MAX_SOUND_BYTES,
  createEmoji,
  deleteEmoji,
  deleteExpressionAttachmentsOfCommunity,
  emojisAvailableTo,
  emojisOf,
  getEmoji,
  unusableEmojis,
  validateSoundIcon,
} from "./expressions.ts";
import { canActOn, channelPermissions, communityPermissions, highestRolePosition, memberState } from "./permissions.ts";
import {
  HANDLED,
  HttpError,
  badRequest,
  conflict,
  forbidden,
  isLocalRequest,
  notFound,
  rateLimit,
  readBody,
  readJson,
  requireAuth,
  route,
  send,
  unauthorized,
  v,
  type Ctx,
} from "./http.ts";
import { instanceHealth, invalidateStorageCache, VERSION } from "./instance.ts";
import { CDN_REENVIABLE, deleteAttachmentsOf, deleteAttachmentsOwnedBy, linkAttachments, purgeChatFiles, saveRemoteAttachment, saveUpload, serveFile } from "./storage.ts";
import { disconnectSession, disconnectUser, onlineCount, onlineIn, publish, publishToChannel, publishToUser } from "./gateway.ts";
import { clearPlaying, historyOf, onGamePresenceChange, presencesIn, setPlaying, sharesGameActivity, showsGameHistory } from "./gamePresence.ts";
import { statesOfCommunity } from "./voice.ts";

/* ── guardas ───────────────────────────────────────────────────────── */

function requirePerm(communityId: Snowflake, userId: Snowflake, perm: bigint, what: string): void {
  if (!has(communityPermissions(communityId, userId), perm)) throw forbidden(`Te falta el permiso para ${what}.`);
}

function requireChannelPerm(channelId: Snowflake, userId: Snowflake, perm: bigint, what: string): void {
  if (!has(channelPermissions(channelId, userId), perm)) throw forbidden(`Te falta el permiso para ${what}.`);
}

function requireMembership(communityId: Snowflake, userId: Snowflake): void {
  const state = memberState(communityId, userId);
  if (!state.isMember || state.banned) throw notFound("Comunidad no encontrada.");
}

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const CHANNEL_NAME = /^[^\s#@][^#@]{0,63}$/;

/* ── estado de la instancia (§26) ──────────────────────────────────── */

route("GET", "/health", () => instanceHealth(onlineCount()));
route("GET", "/api/v1/health", () => instanceHealth(onlineCount()));

route("GET", "/api/v1/info", async (ctx) => ({
  name: config.instanceName,
  version: VERSION,
  registration_enabled: config.registrationEnabled,
  guest_mode_enabled: config.guestModeEnabled,
  public_discovery_enabled: config.publicDiscoveryEnabled,
  max_upload_mb: config.maxUploadMb,
  allowed_upload_types: config.allowedUploadTypes,
  /* Booleano y nunca la clave: el cliente solo necesita saber si enseñar la
     pestaña. La clave no sale de la instancia jamás (§13.3). */
  gif_enabled: config.giphyApiKey !== "",
  /** La galeria de stickers va por su cuenta: otra clave, otro servicio. */
  sticker_gallery_enabled: config.klipyApiKey !== "",
  /** Dirección por la que llega la gente de fuera; vacía = solo local (§6).
      Si hay un túnel abierto desde la app, esa manda sobre la del .env. */
  public_url: publicUrl(),
  /** Estado del túnel, para que la interfaz pueda ofrecer abrirlo o cerrarlo. */
  tunnel: { ...tunnelState(), autostart: tunnelAutostart() },
  /** Por dónde se buscan los caminos entre navegadores. Sin esto la voz solo
      funciona entre dos equipos de la misma red, y ni siquiera siempre. */
  ice_servers: await iceServers(),
  /** Si la imagen pasa por la instancia o va directa, y con qué techo de calidad (§9.5). */
  video: videoMode(),
  /** Instancia sin dueño: el cliente enseña la puesta en marcha, no el login. */
  setup_required: countOwners() === 0,
  setup_requires_code: !isLocalRequest(ctx),
  /** Cuentas sin contraseña que tienen comunidad propia: solo desde el equipo
      anfitrión, para poder volver a entrar sin adivinar el nombre (§26). */
  recoverable: isLocalRequest(ctx) ? recoverableAccounts() : [],
}));

interface RecoverableAccount {
  username: string;
  display_name: string;
  /** De quién es cada cuenta se distingue por su comunidad, no por el nombre:
      en una instancia doméstica todas se llaman parecido. */
  community: string | null;
}

function recoverableAccounts(): RecoverableAccount[] {
  return db
    .prepare(
      /* Las cuentas locales salen siempre, tengan comunidad o no: quien pone en
         marcha la instancia crea su cuenta antes que su primera comunidad, y
         exigir comunidad aqui la dejaba fuera de su propio servidor si perdia la
         sesion en ese rato: sin contrasena que escribir y sin nada que recuperar.
         Los invitados siguen pidiendo comunidad, o la pantalla de entrada acabaria
         listando a todo el que paso por aqui una vez. */
      `SELECT u.username, u.display_name,
              (SELECT name FROM communities WHERE owner_id = u.id ORDER BY created_at LIMIT 1) AS community
         FROM users u
        WHERE u.password_hash IS NULL AND (u.kind = 'local' OR community IS NOT NULL)
        ORDER BY u.created_at LIMIT 20`,
    )
    .all() as RecoverableAccount[];
}

/**
 * Volver a entrar en una cuenta sin contraseña (§26).
 * Poner en marcha la instancia no obliga a inventarse una contraseña, así que
 * existe gente sin ella: si pierde la sesión —otro navegador, secreto rotado—
 * se quedaría fuera de su propio servidor con sus comunidades dentro. Desde el
 * equipo anfitrión no hace falta más prueba que estar ahí; desde fuera, el
 * código impreso en el terminal.
 */
route("POST", "/api/v1/auth/recover", async (ctx) => {
  rateLimit(`recover:${ctx.ip}`, 10, 60 * 60_000);
  const body = await readJson(ctx);

  if (!isLocalRequest(ctx)) {
    const code = v.string(body, "setup_code", { min: 1, max: 64 });
    if (code.trim().toUpperCase() !== config.setupCode.toUpperCase())
      throw forbidden("Código incorrecto. Está impreso en el terminal de la instancia.");
  }

  const username = v.string(body, "username", { min: 1, max: 32 }).toLowerCase();
  const user = findUserByUsername(username);
  if (!user || user.password_hash) throw unauthorized("No hay ninguna cuenta sin contraseña con ese nombre.");
  return issue(user.id);
});

/**
 * Puesta en marcha de una instancia nueva (§34, §37).
 * Quien la hospeda no debería tener que crearse una cuenta y "entrar" en su
 * propio servidor: pone su nombre y ya está dentro, con la contraseña como paso
 * posterior y opcional. La ventana se cierra sola en cuanto existe una persona.
 */
route("POST", "/api/v1/auth/bootstrap", async (ctx) => {
  if (countOwners() > 0) throw conflict("Esta instancia ya tiene dueño. Entra con tu cuenta.");
  rateLimit(`bootstrap:${ctx.ip}`, 10, 60 * 60_000);

  const body = await readJson(ctx);

  // Desde el propio equipo no se pide código: quien está sentado delante de la
  // máquina ya podría leer la base de datos entera. Desde fuera sí, porque si
  // no, el primer desconocido que encuentre la URL se queda con la instancia.
  if (!isLocalRequest(ctx)) {
    const code = v.string(body, "setup_code", { min: 1, max: 64 });
    if (code.trim().toUpperCase() !== config.setupCode.toUpperCase())
      throw forbidden("Código de puesta en marcha incorrecto. Está impreso en el terminal de la instancia.");
  }

  const displayName = v.string(body, "display_name", { min: 2, max: 48 });
  const username = (v.optionalString(body, "username", { max: 32 }) || slugUsername(displayName)).toLowerCase();
  if (!USERNAME.test(username)) throw badRequest("Ese nombre de usuario no es válido.");

  const password = v.optionalString(body, "password", { max: 200 });
  if (password && password.length < 10) throw badRequest("La contraseña necesita al menos 10 caracteres.");

  const user = createUser({
    username,
    displayName,
    kind: "local",
    ...(password ? { password } : {}),
  });
  return issue(user.id);
});

/** Nombre de usuario a partir del visible; si choca o queda corto, se completa. */
function slugUsername(displayName: string): string {
  const base = displayName
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);

  let candidate = base.length >= 3 ? base : `${base}-admin`.slice(0, 32);
  while (findUserByUsername(candidate)) candidate = `${base}-${randomBytes(2).toString("hex")}`.slice(0, 32);
  return candidate;
}

/* ── autenticación (§7) ────────────────────────────────────────────── */

function issue(userId: Snowflake) {
  const session = createSession(userId);
  const user = findUserById(userId)!;
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn,
    user: toSelfUser(user),
  };
}

route("POST", "/api/v1/auth/register", async (ctx) => {
  if (!config.registrationEnabled) throw forbidden("Esta instancia tiene el registro cerrado.");
  rateLimit(`register:${ctx.ip}`, config.maxRegistrationsPerHour, 60 * 60_000);

  const body = await readJson(ctx);
  const username = v.string(body, "username", { min: 3, max: 32, pattern: USERNAME }).toLowerCase();
  const password = v.string(body, "password", { min: 10, max: 200, trim: false });
  const displayName = v.optionalString(body, "display_name", { max: 48 }) || username;

  if (findUserByUsername(username)) throw conflict("Ese nombre de usuario ya existe.");
  const user = createUser({ username, password, displayName });
  return issue(user.id);
});

route("POST", "/api/v1/auth/login", async (ctx) => {
  rateLimit(`login:${ctx.ip}`, config.maxLoginAttemptsPerQuarterHour, 15 * 60_000);

  const body = await readJson(ctx);
  const username = v.string(body, "username", { min: 1, max: 32 }).toLowerCase();
  const password = v.string(body, "password", { min: 1, max: 200, trim: false });

  const user = findUserByUsername(username);
  // Mismo mensaje en los dos fallos: no revelamos si el usuario existe.
  if (!user?.password_hash || !verifyPassword(password, user.password_hash))
    throw unauthorized("Usuario o contraseña incorrectos.");

  return issue(user.id);
});

route("POST", "/api/v1/auth/guest", async (ctx) => {
  if (!config.guestModeEnabled) throw forbidden("Esta instancia no admite invitados.");
  rateLimit(`guest:${ctx.ip}`, config.maxGuestsPerHour, 60 * 60_000);

  const body = await readJson(ctx);
  const displayName = v.string(body, "display_name", { min: 2, max: 24 });
  const user = createGuest(displayName);
  return issue(user.id);
});

route("POST", "/api/v1/auth/refresh", async (ctx) => {
  const body = await readJson(ctx);
  const token = v.string(body, "refresh_token", { min: 10, max: 200, trim: false });

  const session = rotateSession(token);
  if (!session) throw unauthorized("Sesión caducada, vuelve a entrar.");

  const user = findUserById(
    (db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(session.sessionId) as { user_id: string }).user_id,
  )!;
  return {
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn,
    user: toSelfUser(user),
  };
});

route("POST", "/api/v1/auth/logout", (ctx) => {
  const header = ctx.req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7);
    const auth = authenticate(token);
    if (auth) disconnectSession(auth.sessionId);
    revokeSession(token);
  }
});

/* ── perfil (§10.1) ────────────────────────────────────────────────── */

route("GET", "/api/v1/users/me", (ctx) => requireAuth(ctx).user);

route("PATCH", "/api/v1/users/me", async (ctx) => {
  const { user } = requireAuth(ctx);
  const body = await readJson(ctx);

  const fields: Array<[string, unknown]> = [];
  const displayName = v.optionalString(body, "display_name", { max: 48 });
  if (displayName) fields.push(["display_name", displayName]);
  for (const key of ["bio", "pronouns", "avatar_url", "banner_url"] as const) {
    const value = v.optionalString(body, key, { max: key === "bio" ? 500 : 300 });
    if (value !== undefined) fields.push([key, value || null]);
  }
  const accent = v.color(body, "accent_color");
  if (accent !== undefined) fields.push(["accent_color", accent]);
  if (body.locale !== undefined) fields.push(["locale", v.oneOf(body, "locale", ["es", "pt-BR", "en"] as const)]);
  if (body.theme !== undefined) fields.push(["theme", v.oneOf(body, "theme", ["light", "dark", "system"] as const)]);
  if (body.status !== undefined) fields.push(["status", v.oneOf(body, "status", USER_STATUSES)]);
  /* Texto plano y corto. No se interpreta al pintarlo, así que no hay nada que
     sanear aquí; el límite es para que no acabe siendo una segunda biografía. */
  if (body.custom_status !== undefined) {
    const frase = v.optionalString(body, "custom_status", { max: 120 });
    fields.push(["custom_status", frase || null]);
  }
  if (body.settings !== undefined) {
    if (typeof body.settings !== "object" || body.settings === null) throw badRequest('"settings" debe ser un objeto.');
    fields.push(["settings", JSON.stringify(body.settings)]);
  }
  /* Se normaliza antes de guardar, no se valida campo a campo: toProfileStyle
     acepta cualquier cosa y devuelve algo válido, así que un id inventado se
     cae solo al valor por defecto en vez de tumbar la petición entera. Lo que
     entra en la base ya está limpio, y de ahí sale directo a una clase CSS (§22). */
  if (body.profile_style !== undefined) {
    fields.push(["profile_style", JSON.stringify(toProfileStyle(body.profile_style))]);
  }
  if (fields.length === 0) return toSelfUser(findUserById(user.id)!);

  db.prepare(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map(([, value]) => value as string | null),
    user.id,
  );

  const updated = toSelfUser(findUserById(user.id)!);

  // Apagar "compartir actividad de juego" limpia el estado vivo al momento:
  // un interruptor de privacidad que tarda en surtir efecto no es de fiar.
  if (body.settings !== undefined && !sharesGameActivity(user.id)) clearPlaying(user.id);

  for (const community of communitiesForUser(user.id)) {
    const member = getMember(community.id, user.id);
    if (member) publish(community.id, { t: "MEMBER_UPDATE", d: member });
    /* Ponerse invisible tiene que sacarte de la lista de conectados al momento.
       MEMBER_UPDATE lleva el estado elegido, pero quién figura en línea va en
       PRESENCE_UPDATE, y son dos listas distintas en el cliente. */
    if (body.status !== undefined)
      publish(community.id, { t: "PRESENCE_UPDATE", d: { community_id: community.id, online: onlineIn(community.id) } });
    /* Y lo mismo con el juego: invisible o sin compartir, la lista cambia. */
    if (body.status !== undefined || body.settings !== undefined)
      publish(community.id, { t: "GAME_PRESENCE_UPDATE", d: { community_id: community.id, presences: presencesIn(community.id) } });
  }
  return updated;
});

/* ── "jugando a…" (§9.1) ───────────────────────────────────────────────
   Lo alimenta la app de escritorio con la sesión normal del usuario. El
   servidor nunca ve la lista de procesos: llega solo el nombre del juego ya
   casado con el catálogo local del jugador. */

function announceGame(userId: Snowflake): void {
  for (const community of communitiesForUser(userId)) {
    publish(community.id, {
      t: "GAME_PRESENCE_UPDATE",
      d: { community_id: community.id, presences: presencesIn(community.id) },
    });
  }
}

// El barrido de heartbeats muertos vive en gamePresence.ts; el fan-out, aquí.
// Separado así para que gamePresence no importe gateway (ciclo de imports).
onGamePresenceChange(announceGame);

route("PUT", "/api/v1/users/me/game-presence", async (ctx) => {
  const { user } = requireAuth(ctx);
  // Con el interruptor en "no compartir" se corta en origen, no se disimula.
  if (!sharesGameActivity(user.id)) throw forbidden("La actividad de juego está desactivada en tus ajustes.");

  rateLimit(`game:${user.id}`, 30, 60_000);
  const body = await readJson(ctx);
  // Texto plano y corto, mismo trato que custom_status: no se interpreta nada.
  const gameName = v.string(body, "game_name", { max: 100 });

  if (setPlaying(user.id, gameName)) announceGame(user.id);
});

route("DELETE", "/api/v1/users/me/game-presence", (ctx) => {
  const { user } = requireAuth(ctx);
  if (clearPlaying(user.id)) announceGame(user.id);
});

route("GET", "/api/v1/users/:id/game-history", (ctx) => {
  const { user } = requireAuth(ctx);
  const targetId = ctx.params.id === "me" ? user.id : ctx.params.id!;

  // El historial se enseña entre gente que ya se ve: co-miembros de alguna
  // comunidad. Un desconocido con un id no es "gente que ya se ve".
  if (targetId !== user.id) {
    const shared = communitiesForUser(user.id).some((community) => getMember(community.id, targetId));
    if (!shared) throw notFound("No encontrado.");
    // Vacío y no 403: un "prohibido" confirmaría que hay algo que ocultar.
    if (!showsGameHistory(targetId)) return [];
  }
  return historyOf(targetId);
});

/**
 * Ponerle contraseña a una cuenta que no la tiene, sin perder id, mensajes ni
 * membresías (§7.1). Sirve para dos casos: un invitado que se queda, y quien
 * puso en marcha la instancia y ahora quiere poder entrar desde otro equipo.
 */
route("POST", "/api/v1/users/me/upgrade", async (ctx) => {
  const { user } = requireAuth(ctx);
  const current = findUserById(user.id)!;
  if (current.password_hash) throw conflict("Esta cuenta ya tiene contraseña.");

  // A quien hospeda no se le puede negar poner contraseña por tener el registro
  // cerrado: cerrar el registro es para los de fuera, no para la dueña del nodo.
  if (current.kind === "guest" && !config.registrationEnabled)
    throw forbidden("Esta instancia tiene el registro cerrado.");

  const body = await readJson(ctx);
  const username = v.string(body, "username", { min: 3, max: 32, pattern: USERNAME }).toLowerCase();
  const password = v.string(body, "password", { min: 10, max: 200, trim: false });

  const taken = findUserByUsername(username);
  if (taken && taken.id !== user.id) throw conflict("Ese nombre de usuario ya existe.");

  db.prepare("UPDATE users SET username = ?, password_hash = ?, kind = 'local' WHERE id = ?").run(
    username,
    hashPassword(password),
    user.id,
  );
  return toSelfUser(findUserById(user.id)!);
});

/**
 * Cambiar una contraseña que ya existe (§22).
 * Pide la actual —un equipo desbloqueado no debe bastar para dejar fuera a la
 * dueña— y revoca las demás sesiones: cambiarla ES la palanca ante una fuga,
 * así que dejar las sesiones viejas vivas la volvería decorativa. La sesión
 * que hizo el cambio recibe tokens nuevos y sigue dentro sin relogin.
 */
route("POST", "/api/v1/users/me/password", async (ctx) => {
  const { user } = requireAuth(ctx);
  const current = findUserById(user.id)!;
  if (!current.password_hash) throw conflict("Esta cuenta no tiene contraseña todavía. Ponla desde «convertir en cuenta permanente».");

  rateLimit(`password:${user.id}`, config.maxLoginAttemptsPerQuarterHour, 15 * 60_000);

  const body = await readJson(ctx);
  const currentPassword = v.string(body, "current_password", { min: 1, max: 200, trim: false });
  const password = v.string(body, "password", { min: 10, max: 200, trim: false });
  if (!verifyPassword(currentPassword, current.password_hash)) throw unauthorized("La contraseña actual no es correcta.");

  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(password), user.id);
  revokeAllSessions(user.id);
  // Revocar filas no basta: los sockets abiertos seguirían escuchando. Se
  // cierran todos; este dispositivo reconecta solo con los tokens nuevos.
  disconnectUser(user.id);
  return issue(user.id);
});

/**
 * Borrar la cuenta de verdad (§29.6).
 * Nada de "desactivar" ni de dejar la fila marcada: se va de la base. Las
 * comunidades que tenga en propiedad se van con ella —son suyas, y dejarlas
 * huérfanas sin nadie que las administre es peor— y sus archivos salen del disco
 * del anfitrión, no solo del índice.
 *
 * Se pide el nombre de usuario escrito a mano: es irreversible y no hay papelera.
 */
route("DELETE", "/api/v1/users/me", async (ctx) => {
  const { user, sessionId } = requireAuth(ctx);
  const body = await readJson(ctx);
  const confirm = v.string(body, "username", { min: 1, max: 32 });
  if (confirm.trim().toLowerCase() !== user.username.toLowerCase())
    throw badRequest("Escribe tu nombre de usuario exactamente para confirmar.");

  const owned = db.prepare("SELECT id FROM communities WHERE owner_id = ?").all(user.id) as { id: string }[];

  // A quien esté dentro se le avisa ANTES de que desaparezca la comunidad:
  // después ya no hay a quién publicarle.
  for (const community of owned) {
    publish(community.id, { t: "MEMBER_LEAVE", d: { community_id: community.id, user_id: user.id } });
  }

  for (const community of owned) deleteExpressionAttachmentsOfCommunity(community.id);
  deleteAttachmentsOwnedBy(user.id);
  for (const community of owned) db.prepare("DELETE FROM communities WHERE id = ?").run(community.id);

  // El resto cuelga de la fila del usuario por clave foránea: sesiones,
  // membresías, mensajes y reacciones se van en cascada con ella.
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

  revokeAllSessions(user.id);
  // Cierra también el socket abierto: si no, seguiría recibiendo eventos una
  // cuenta que ya no existe.
  disconnectSession(sessionId);
  return { deleted: true, communities: owned.length };
});

route("POST", "/api/v1/users/me/sessions/revoke-all", (ctx) => {
  const { user } = requireAuth(ctx);
  revokeAllSessions(user.id);
  // Misma razón que en el cambio de contraseña: sin cerrar los sockets, los
  // dispositivos "expulsados" seguirían recibiendo eventos en vivo.
  disconnectUser(user.id);
  return issue(user.id);
});

/* ── comunidades (§9.1) ────────────────────────────────────────────── */

route("GET", "/api/v1/communities", (ctx) => communitiesForUser(requireAuth(ctx).user.id));

route("POST", "/api/v1/communities", async (ctx) => {
  // Sin cuenta se puede lo mismo que con cuenta (§7.1): la contraseña sirve para
  // volver desde otro dispositivo, no para desbloquear funciones.
  const { user } = requireAuth(ctx);
  rateLimit(`community:${user.id}`, 5, 60 * 60_000);

  const body = await readJson(ctx);
  const name = v.string(body, "name", { min: 2, max: 64 });
  const isPublic = v.bool(body, "is_public", false);
  const accent = v.color(body, "accent_color") ?? undefined;

  const id = seedCommunity({ name, slug: uniqueSlug(name), ownerId: user.id, isPublic, accentColor: accent ?? undefined });
  return getCommunity(id);
});

route("GET", "/api/v1/communities/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  requireMembership(ctx.params.id!, user.id);
  return getCommunity(ctx.params.id!);
});

/** Todo lo que el cliente necesita para pintar una comunidad, en una petición. */
route("GET", "/api/v1/communities/:id/bootstrap", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);

  const visible = channelsOf(communityId).filter((channel) =>
    has(channelPermissions(channel.id, user.id), PERMISSIONS.VIEW_CHANNEL),
  );

  // Permisos ya resueltos por canal: sin esto el cliente no puede saber que un
  // canal es de solo lectura y ofrecería escribir en él para nada.
  const channelPerms: Record<string, string> = {};
  for (const channel of visible) channelPerms[channel.id] = channelPermissions(channel.id, user.id).toString();

  return {
    community: getCommunity(communityId),
    categories: categoriesOf(communityId),
    channels: visible,
    roles: rolesOf(communityId),
    members: membersOf(communityId),
    online: onlineIn(communityId),
    game_presences: presencesIn(communityId),
    permissions: communityPermissions(communityId, user.id).toString(),
    channel_permissions: channelPerms,
    voice_states: statesOfCommunity(communityId),
    emojis: emojisOf(communityId),
    unread: unreadOf(user.id, communityId, visible.map((channel) => channel.id)),
    // Hasta dónde había leído en cada canal: es la línea de "mensajes nuevos".
    read_state: Object.fromEntries(
      visible.map((channel) => [channel.id, lastReadId(user.id, channel.id)]).filter(([, id]) => id !== null),
    ),
  };
});

route("PATCH", "/api/v1/communities/:id", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_COMMUNITY, "editar la comunidad");

  const body = await readJson(ctx);
  const fields: Array<[string, unknown]> = [];
  const name = v.optionalString(body, "name", { max: 64 });
  if (name) fields.push(["name", name]);
  for (const key of ["description", "icon_url", "banner_url", "rules"] as const) {
    const value = v.optionalString(body, key, { max: key === "rules" ? 4000 : 500 });
    if (value !== undefined) fields.push([key, value || null]);
  }
  const accent = v.color(body, "accent_color");
  if (accent) fields.push(["accent_color", accent]);
  if (body.theme !== undefined) fields.push(["theme", v.oneOf(body, "theme", ["light", "dark", "system"] as const)]);
  if (body.is_public !== undefined) fields.push(["is_public", v.bool(body, "is_public", false) ? 1 : 0]);
  if (fields.length === 0) return getCommunity(communityId);

  db.prepare(`UPDATE communities SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map(([, value]) => value as string | number | null),
    communityId,
  );

  const updated = getCommunity(communityId)!;
  audit(communityId, user.id, "COMMUNITY_UPDATE", communityId, { fields: fields.map(([k]) => k) });
  publish(communityId, { t: "COMMUNITY_UPDATE", d: updated });
  return updated;
});

route("DELETE", "/api/v1/communities/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  // Membresía antes que propiedad: para quien no está dentro, la comunidad no
  // existe. Responder 403 le confirmaría que el identificador es real.
  requireMembership(ctx.params.id!, user.id);
  const community = getCommunity(ctx.params.id!);
  if (!community) throw notFound("Comunidad no encontrada.");
  if (community.owner_id !== user.id) throw forbidden("Solo quien creó la comunidad puede eliminarla.");

  deleteExpressionAttachmentsOfCommunity(community.id);
  db.prepare("DELETE FROM communities WHERE id = ?").run(community.id);
  publish(community.id, { t: "MEMBER_LEAVE", d: { community_id: community.id, user_id: user.id } });
});

route("POST", "/api/v1/communities/:id/leave", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  const community = getCommunity(communityId);
  if (!community) throw notFound("Comunidad no encontrada.");
  if (community.owner_id === user.id) throw conflict("Transfiere o elimina la comunidad antes de salir.");

  db.prepare("DELETE FROM members WHERE community_id = ? AND user_id = ?").run(communityId, user.id);
  publish(communityId, { t: "MEMBER_LEAVE", d: { community_id: communityId, user_id: user.id } });
});

route("GET", "/api/v1/discovery", (ctx) => {
  if (!config.publicDiscoveryEnabled) return [];
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.slug, c.description, c.icon_url, c.banner_url, c.accent_color,
              (SELECT COUNT(*) FROM members m WHERE m.community_id = c.id AND m.banned = 0) AS members
       FROM communities c WHERE c.is_public = 1 ORDER BY members DESC LIMIT 50`,
    )
    .all() as unknown[];
  return rows;
});

/* ── categorías y canales (§9.2) ───────────────────────────────────── */

route("POST", "/api/v1/communities/:id/categories", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_CHANNELS, "crear categorías");

  const body = await readJson(ctx);
  const name = v.string(body, "name", { min: 1, max: 64 });
  const position = v.int(body, "position", { min: 0, max: 1000, fallback: categoriesOf(communityId).length });

  const id = uuidv7();
  db.prepare("INSERT INTO categories (id, community_id, name, position) VALUES (?, ?, ?, ?)").run(
    id,
    communityId,
    name,
    position,
  );
  audit(communityId, user.id, "CATEGORY_CREATE", id, { name });
  publish(communityId, { t: "CATEGORY_UPDATE", d: { community_id: communityId, categories: categoriesOf(communityId) } });
  return categoriesOf(communityId).find((c) => c.id === id);
});

route("PATCH", "/api/v1/categories/:id", async (ctx) => {
  const { user } = requireAuth(ctx);
  const row = db.prepare("SELECT community_id FROM categories WHERE id = ?").get(ctx.params.id!) as
    | { community_id: string }
    | undefined;
  if (!row) throw notFound("Categoría no encontrada.");
  requirePerm(row.community_id, user.id, PERMISSIONS.MANAGE_CHANNELS, "editar categorías");

  const body = await readJson(ctx);
  const name = v.optionalString(body, "name", { max: 64 });
  if (name) db.prepare("UPDATE categories SET name = ? WHERE id = ?").run(name, ctx.params.id!);
  if (body.position !== undefined)
    db.prepare("UPDATE categories SET position = ? WHERE id = ?").run(
      v.int(body, "position", { min: 0, max: 1000 }),
      ctx.params.id!,
    );

  publish(row.community_id, {
    t: "CATEGORY_UPDATE",
    d: { community_id: row.community_id, categories: categoriesOf(row.community_id) },
  });
  return categoriesOf(row.community_id);
});

route("DELETE", "/api/v1/categories/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  const row = db.prepare("SELECT community_id FROM categories WHERE id = ?").get(ctx.params.id!) as
    | { community_id: string }
    | undefined;
  if (!row) throw notFound("Categoría no encontrada.");
  requirePerm(row.community_id, user.id, PERMISSIONS.MANAGE_CHANNELS, "eliminar categorías");

  db.prepare("DELETE FROM categories WHERE id = ?").run(ctx.params.id!);
  audit(row.community_id, user.id, "CATEGORY_DELETE", ctx.params.id!, {});
  publish(row.community_id, {
    t: "CATEGORY_UPDATE",
    d: { community_id: row.community_id, categories: categoriesOf(row.community_id) },
  });
});

route("POST", "/api/v1/communities/:id/channels", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_CHANNELS, "crear canales");

  const body = await readJson(ctx);
  const name = v.string(body, "name", { min: 1, max: 64, pattern: CHANNEL_NAME });
  const kind = v.oneOf(body, "kind", ["text", "voice", "announcement"] as const, "text");
  const categoryId = v.optionalString(body, "category_id", { max: 64 }) ?? null;
  const topic = v.optionalString(body, "topic", { max: 500 }) ?? null;

  if (categoryId && !db.prepare("SELECT 1 FROM categories WHERE id = ? AND community_id = ?").get(categoryId, communityId))
    throw badRequest("Esa categoría no pertenece a la comunidad.");

  const id = uuidv7();
  db.prepare(
    `INSERT INTO channels (id, community_id, category_id, name, topic, kind, position, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, communityId, categoryId, name, topic, kind, channelsOf(communityId).length, Date.now());

  const channel = getChannel(id)!;
  audit(communityId, user.id, "CHANNEL_CREATE", id, { name, kind });
  publish(communityId, { t: "CHANNEL_CREATE", d: channel });
  return channel;
});

route("PATCH", "/api/v1/channels/:id", async (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requirePerm(channel.community_id, user.id, PERMISSIONS.MANAGE_CHANNELS, "editar canales");

  const body = await readJson(ctx);
  const fields: Array<[string, unknown]> = [];
  const name = v.optionalString(body, "name", { max: 64, pattern: CHANNEL_NAME });
  if (name) fields.push(["name", name]);
  const topic = v.optionalString(body, "topic", { max: 500 });
  if (topic !== undefined) fields.push(["topic", topic || null]);
  if (body.category_id !== undefined) fields.push(["category_id", v.optionalString(body, "category_id", { max: 64 }) || null]);
  if (body.position !== undefined) fields.push(["position", v.int(body, "position", { min: 0, max: 1000 })]);
  if (body.slowmode_s !== undefined) fields.push(["slowmode_s", v.int(body, "slowmode_s", { min: 0, max: 21600 })]);
  if (fields.length === 0) return channel;

  db.prepare(`UPDATE channels SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map(([, value]) => value as string | number | null),
    channel.id,
  );

  const updated = getChannel(channel.id)!;
  audit(channel.community_id, user.id, "CHANNEL_UPDATE", channel.id, { fields: fields.map(([k]) => k) });
  publish(channel.community_id, { t: "CHANNEL_UPDATE", d: updated });
  return updated;
});

route("DELETE", "/api/v1/channels/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requirePerm(channel.community_id, user.id, PERMISSIONS.MANAGE_CHANNELS, "eliminar canales");

  db.prepare("DELETE FROM channels WHERE id = ?").run(channel.id);
  audit(channel.community_id, user.id, "CHANNEL_DELETE", channel.id, { name: channel.name });
  publish(channel.community_id, { t: "CHANNEL_DELETE", d: { id: channel.id, community_id: channel.community_id } });
});

/** Overwrites por canal: el mecanismo de canales privados (§11). */
route("PUT", "/api/v1/channels/:id/permissions/:targetId", async (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requirePerm(channel.community_id, user.id, PERMISSIONS.MANAGE_ROLES, "cambiar permisos del canal");

  const body = await readJson(ctx);
  const targetType = v.oneOf(body, "target_type", ["role", "member"] as const);
  const allow = toBits(v.string(body, "allow", { min: 1, max: 30, pattern: /^\d+$/ })) & ALL_PERMISSIONS;
  const deny = toBits(v.string(body, "deny", { min: 1, max: 30, pattern: /^\d+$/ })) & ALL_PERMISSIONS;

  db.prepare(
    `INSERT INTO overwrites (channel_id, target_id, target_type, allow, deny) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny, target_type = excluded.target_type`,
  ).run(channel.id, ctx.params.targetId!, targetType, allow.toString(), deny.toString());

  audit(channel.community_id, user.id, "CHANNEL_PERMISSIONS", channel.id, { target: ctx.params.targetId });
  publish(channel.community_id, { t: "CHANNEL_UPDATE", d: getChannel(channel.id)! });
  return { channel_id: channel.id, target_id: ctx.params.targetId, allow: allow.toString(), deny: deny.toString() };
});

route("DELETE", "/api/v1/channels/:id/permissions/:targetId", (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requirePerm(channel.community_id, user.id, PERMISSIONS.MANAGE_ROLES, "cambiar permisos del canal");

  db.prepare("DELETE FROM overwrites WHERE channel_id = ? AND target_id = ?").run(channel.id, ctx.params.targetId!);
  publish(channel.community_id, { t: "CHANNEL_UPDATE", d: getChannel(channel.id)! });
});

route("GET", "/api/v1/channels/:id/permissions", (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requireMembership(channel.community_id, user.id);
  return db.prepare("SELECT * FROM overwrites WHERE channel_id = ?").all(channel.id);
});

/* ── mensajes (§9.2) ───────────────────────────────────────────────── */

route("GET", "/api/v1/channels/:id/messages", (ctx) => {
  const { user } = requireAuth(ctx);
  const channelId = ctx.params.id!;
  requireChannelPerm(channelId, user.id, PERMISSIONS.READ_HISTORY, "leer el historial");

  const before = ctx.url.searchParams.get("before") ?? undefined;
  const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 50) || 50, 100);
  return messagesOf(channelId, { before, limit });
});

route("POST", "/api/v1/channels/:id/messages", async (ctx) => {
  const { user } = requireAuth(ctx);
  const channel = getChannel(ctx.params.id!);
  if (!channel) throw notFound("Canal no encontrado.");
  requireChannelPerm(channel.id, user.id, PERMISSIONS.SEND_MESSAGES, "escribir aquí");
  rateLimit(`msg:${user.id}`, 20, 10_000);

  if (channel.slowmode_s > 0 && !has(channelPermissions(channel.id, user.id), PERMISSIONS.MANAGE_MESSAGES)) {
    const last = db
      .prepare("SELECT created_at FROM messages WHERE channel_id = ? AND author_id = ? ORDER BY id DESC LIMIT 1")
      .get(channel.id, user.id) as { created_at: number } | undefined;
    const waited = Date.now() - (last?.created_at ?? 0);
    if (waited < channel.slowmode_s * 1000)
      throw badRequest(`Modo lento activo: espera ${Math.ceil((channel.slowmode_s * 1000 - waited) / 1000)} s.`);
  }

  const body = await readJson(ctx);
  const attachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids.filter((id): id is string => typeof id === "string").slice(0, 10)
    : [];
  const content = attachmentIds.length > 0 ? v.optionalString(body, "content", { max: 4000 }) ?? "" : v.string(body, "content", { max: 4000 });
  const replyTo = v.optionalString(body, "reply_to_id", { max: 64 }) ?? null;

  if (attachmentIds.length > 0) requireChannelPerm(channel.id, user.id, PERMISSIONS.ATTACH_FILES, "adjuntar archivos");
  if (replyTo && !db.prepare("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?").get(replyTo, channel.id))
    throw badRequest("El mensaje al que respondes no está en este canal.");

  /* Emojis propios: dos comprobaciones distintas y las dos hacen falta.
     El permiso dice si en ESTE canal se pueden usar; `unusableEmojis` dice si
     los que ha puesto existen y salen de una comunidad suya. Lo segundo no es
     un permiso configurable: es lo que impide referenciar el emoji de una
     comunidad privada ajena y que la instancia lo sirva igualmente. */
  if (CUSTOM_EMOJI.test(content)) {
    CUSTOM_EMOJI.lastIndex = 0; // el flag /g deja el índice donde paró
    requireChannelPerm(channel.id, user.id, PERMISSIONS.USE_CUSTOM_EMOJIS, "usar emojis personalizados");
    const malos = unusableEmojis(content, user.id);
    if (malos.length > 0)
      throw badRequest(`No puedes usar estos emojis: ${malos.map((n) => `:${n}:`).join(", ")}.`, { emojis: malos });
  }

  /* "@everyone" avisa a toda la comunidad, así que es un permiso (§11). Sin él no
     se rechaza el mensaje —prohibir escribir dos palabras sería absurdo—: se
     guarda como texto normal y no interrumpe a nadie. Se decide aquí y se
     archiva, porque editar el mensaje después no debe convertirlo en un aviso. */
  const mentionsEveryone =
    /(^|\s)@(everyone|todos)\b/.test(content) &&
    has(channelPermissions(channel.id, user.id), PERMISSIONS.MENTION_EVERYONE);

  const id = uuidv7();
  db.prepare(
    `INSERT INTO messages (id, channel_id, community_id, author_id, content, created_at, reply_to_id, mentions_everyone)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channel.id, channel.community_id, user.id, content, Date.now(), replyTo, mentionsEveryone ? 1 : 0);
  linkAttachments(id, attachmentIds, user.id);

  const message = getMessage(id)!;
  publishToChannel(channel.community_id, channel.id, { t: "MESSAGE_CREATE", d: message });
  return message;
});

route("PATCH", "/api/v1/messages/:id", async (ctx) => {
  const { user } = requireAuth(ctx);
  const message = getMessage(ctx.params.id!);
  if (!message) throw notFound("Mensaje no encontrado.");
  if (message.author_id !== user.id) throw forbidden("Solo puedes editar tus propios mensajes.");

  const body = await readJson(ctx);
  const content = v.string(body, "content", { min: 1, max: 4000 });
  db.prepare("UPDATE messages SET content = ?, edited_at = ? WHERE id = ?").run(content, Date.now(), message.id);

  const updated = getMessage(message.id)!;
  publishToChannel(message.community_id, message.channel_id, { t: "MESSAGE_UPDATE", d: updated });
  return updated;
});

route("DELETE", "/api/v1/messages/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  const message = getMessage(ctx.params.id!);
  if (!message) throw notFound("Mensaje no encontrado.");

  const isAuthor = message.author_id === user.id;
  if (!isAuthor) requireChannelPerm(message.channel_id, user.id, PERMISSIONS.MANAGE_MESSAGES, "borrar mensajes ajenos");

  deleteAttachmentsOf(message.id);
  db.prepare("DELETE FROM messages WHERE id = ?").run(message.id);
  if (!isAuthor) audit(message.community_id, user.id, "MESSAGE_DELETE", message.id, { author_id: message.author_id });

  publishToChannel(message.community_id, message.channel_id, {
    t: "MESSAGE_DELETE",
    d: { id: message.id, channel_id: message.channel_id },
  });
});

route("POST", "/api/v1/messages/:id/pin", async (ctx) => {
  const { user } = requireAuth(ctx);
  const message = getMessage(ctx.params.id!);
  if (!message) throw notFound("Mensaje no encontrado.");
  requireChannelPerm(message.channel_id, user.id, PERMISSIONS.MANAGE_MESSAGES, "fijar mensajes");

  const body = await readJson(ctx);
  const pinned = v.bool(body, "pinned", !message.pinned);
  db.prepare("UPDATE messages SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, message.id);

  const updated = getMessage(message.id)!;
  publishToChannel(message.community_id, message.channel_id, { t: "MESSAGE_UPDATE", d: updated });
  return updated;
});

route("GET", "/api/v1/channels/:id/pins", (ctx) => {
  const { user } = requireAuth(ctx);
  requireChannelPerm(ctx.params.id!, user.id, PERMISSIONS.READ_HISTORY, "leer el historial");
  const rows = db.prepare("SELECT id FROM messages WHERE channel_id = ? AND pinned = 1 ORDER BY id DESC").all(
    ctx.params.id!,
  ) as { id: string }[];
  return rows.map((r) => getMessage(r.id)).filter(Boolean);
});

/**
 * Marcar hasta dónde he leído en un canal.
 *
 * Lo manda el cliente con el id del último mensaje que tiene a la vista, y
 * nunca retrocede: si otra pestaña ya leyó más allá, un mensaje que llega tarde
 * desde esta no puede volver a marcar como nuevo lo ya leído.
 */
route("POST", "/api/v1/channels/:id/read", async (ctx) => {
  const { user } = requireAuth(ctx);
  const channelId = ctx.params.id!;
  requireChannelPerm(channelId, user.id, PERMISSIONS.READ_HISTORY, "leer el historial");

  const body = await readJson(ctx);
  const messageId = v.string(body, "message_id", { max: 64 });

  const current = lastReadId(user.id, channelId);
  const furthest = current && current > messageId ? current : messageId;

  db.prepare(
    `INSERT INTO read_state (user_id, channel_id, last_read_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, updated_at = excluded.updated_at`,
  ).run(user.id, channelId, furthest, Date.now());

  // A las demás sesiones: leer en el móvil apaga el aviso del escritorio.
  publishToUser(user.id, { t: "READ_UPDATE", d: { channel_id: channelId, last_read_id: furthest } });
  return { channel_id: channelId, last_read_id: furthest };
});

route("GET", "/api/v1/channels/:id/search", (ctx) => {
  const { user } = requireAuth(ctx);
  requireChannelPerm(ctx.params.id!, user.id, PERMISSIONS.READ_HISTORY, "buscar en el historial");

  const q = (ctx.url.searchParams.get("q") ?? "").trim();
  if (q.length < 2) return [];
  // ponytail: LIKE alcanza para un canal; si el historial crece, FTS5 sin tocar la API.
  const rows = db
    .prepare("SELECT id FROM messages WHERE channel_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 50")
    .all(ctx.params.id!, `%${q.replace(/[%_\\]/g, "\\$&")}%`) as { id: string }[];
  return rows.map((r) => getMessage(r.id)).filter(Boolean);
});

route("POST", "/api/v1/messages/:id/reactions", async (ctx) => {
  const { user } = requireAuth(ctx);
  const message = getMessage(ctx.params.id!);
  if (!message) throw notFound("Mensaje no encontrado.");
  requireChannelPerm(message.channel_id, user.id, PERMISSIONS.ADD_REACTIONS, "reaccionar");
  rateLimit(`react:${user.id}`, 30, 10_000);

  const body = await readJson(ctx);
  const emoji = v.string(body, "emoji", { min: 1, max: 16 });
  db.prepare("INSERT OR IGNORE INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)").run(
    message.id,
    user.id,
    emoji,
  );

  const updated = getMessage(message.id)!;
  publishToChannel(message.community_id, message.channel_id, {
    t: "REACTION_UPDATE",
    d: { message_id: message.id, channel_id: message.channel_id, reactions: updated.reactions },
  });
  return updated.reactions;
});

route("DELETE", "/api/v1/messages/:id/reactions", (ctx) => {
  const { user } = requireAuth(ctx);
  const message = getMessage(ctx.params.id!);
  if (!message) throw notFound("Mensaje no encontrado.");

  const emoji = ctx.url.searchParams.get("emoji");
  if (!emoji) throw badRequest("Falta el parámetro emoji.");
  db.prepare("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?").run(message.id, user.id, emoji);

  const updated = getMessage(message.id)!;
  publishToChannel(message.community_id, message.channel_id, {
    t: "REACTION_UPDATE",
    d: { message_id: message.id, channel_id: message.channel_id, reactions: updated.reactions },
  });
  return updated.reactions;
});

/* ── roles (§11) ───────────────────────────────────────────────────── */

route("GET", "/api/v1/communities/:id/roles", (ctx) => {
  const { user } = requireAuth(ctx);
  requireMembership(ctx.params.id!, user.id);
  return rolesOf(ctx.params.id!);
});

route("POST", "/api/v1/communities/:id/roles", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_ROLES, "crear roles");

  const body = await readJson(ctx);
  const name = v.string(body, "name", { min: 1, max: 48 });
  const color = v.color(body, "color") ?? null;
  const ceiling = highestRolePosition(communityId, user.id);
  const position = Math.min(v.int(body, "position", { min: 0, max: 1000, fallback: 1 }), Math.max(ceiling - 1, 0));
  const permissions = grantablePermissions(communityId, user.id, body);

  const id = uuidv7();
  db.prepare(
    "INSERT INTO roles (id, community_id, name, color, permissions, position, hoist, mentionable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, communityId, name, color, permissions.toString(), position, v.bool(body, "hoist", false) ? 1 : 0, v.bool(body, "mentionable", true) ? 1 : 0);

  const role = getRole(id)!;
  audit(communityId, user.id, "ROLE_CREATE", id, { name });
  publish(communityId, { t: "ROLE_UPDATE", d: role });
  return role;
});

/** Nadie puede otorgar un permiso que no tiene: cierra la escalada de privilegios. */
function grantablePermissions(communityId: Snowflake, userId: Snowflake, body: Record<string, unknown>): bigint {
  const requested = body.permissions === undefined ? 0n : toBits(v.string(body, "permissions", { min: 1, max: 30, pattern: /^\d+$/ }));
  const own = communityPermissions(communityId, userId);
  if (has(own, PERMISSIONS.ADMINISTRATOR)) return requested & ALL_PERMISSIONS;
  const excess = requested & ~own;
  if (excess !== 0n) throw forbidden("No puedes conceder permisos que tú no tienes.");
  return requested & ALL_PERMISSIONS;
}

route("PATCH", "/api/v1/roles/:id", async (ctx) => {
  const { user } = requireAuth(ctx);
  const role = getRole(ctx.params.id!);
  if (!role) throw notFound("Rol no encontrado.");
  requirePerm(role.community_id, user.id, PERMISSIONS.MANAGE_ROLES, "editar roles");
  if (role.position >= highestRolePosition(role.community_id, user.id))
    throw forbidden("No puedes editar un rol igual o superior al tuyo.");

  const body = await readJson(ctx);
  const fields: Array<[string, unknown]> = [];
  const name = v.optionalString(body, "name", { max: 48 });
  if (name && !role.is_default) fields.push(["name", name]);
  const color = v.color(body, "color");
  if (color !== undefined) fields.push(["color", color]);
  if (body.permissions !== undefined) fields.push(["permissions", grantablePermissions(role.community_id, user.id, body).toString()]);
  if (body.hoist !== undefined) fields.push(["hoist", v.bool(body, "hoist", false) ? 1 : 0]);
  if (body.mentionable !== undefined) fields.push(["mentionable", v.bool(body, "mentionable", true) ? 1 : 0]);
  if (body.position !== undefined && !role.is_default)
    fields.push([
      "position",
      Math.min(v.int(body, "position", { min: 0, max: 1000 }), Math.max(highestRolePosition(role.community_id, user.id) - 1, 0)),
    ]);
  if (fields.length === 0) return role;

  db.prepare(`UPDATE roles SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map(([, value]) => value as string | number | null),
    role.id,
  );

  const updated = getRole(role.id)!;
  audit(role.community_id, user.id, "ROLE_UPDATE", role.id, { fields: fields.map(([k]) => k) });
  publish(role.community_id, { t: "ROLE_UPDATE", d: updated });
  return updated;
});

route("DELETE", "/api/v1/roles/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  const role = getRole(ctx.params.id!);
  if (!role) throw notFound("Rol no encontrado.");
  if (role.is_default) throw conflict("El rol base no se puede eliminar.");
  requirePerm(role.community_id, user.id, PERMISSIONS.MANAGE_ROLES, "eliminar roles");
  if (role.position >= highestRolePosition(role.community_id, user.id))
    throw forbidden("No puedes eliminar un rol igual o superior al tuyo.");

  db.prepare("DELETE FROM roles WHERE id = ?").run(role.id);
  audit(role.community_id, user.id, "ROLE_DELETE", role.id, { name: role.name });
  publish(role.community_id, { t: "ROLE_DELETE", d: { id: role.id, community_id: role.community_id } });
});

/* ── miembros y moderación (§23) ───────────────────────────────────── */

route("GET", "/api/v1/communities/:id/members", (ctx) => {
  const { user } = requireAuth(ctx);
  requireMembership(ctx.params.id!, user.id);
  return membersOf(ctx.params.id!);
});

route("PATCH", "/api/v1/communities/:id/members/:userId", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  const targetId = ctx.params.userId!;
  requireMembership(communityId, user.id);
  if (!getMember(communityId, targetId)) throw notFound("Ese miembro no está en la comunidad.");

  const body = await readJson(ctx);
  const isSelf = targetId === user.id;

  if (body.nickname !== undefined) {
    if (!isSelf) requirePerm(communityId, user.id, PERMISSIONS.MANAGE_MEMBERS, "cambiar apodos");
    db.prepare("UPDATE members SET nickname = ? WHERE community_id = ? AND user_id = ?").run(
      v.optionalString(body, "nickname", { max: 48 }) || null,
      communityId,
      targetId,
    );
  }

  if (body.role_ids !== undefined) {
    requirePerm(communityId, user.id, PERMISSIONS.MANAGE_ROLES, "asignar roles");
    if (!canActOn(communityId, user.id, targetId)) throw forbidden("Ese miembro está por encima de ti en la jerarquía.");
    if (!Array.isArray(body.role_ids)) throw badRequest('"role_ids" debe ser una lista.');

    const ceiling = highestRolePosition(communityId, user.id);
    const ids = body.role_ids.filter((id): id is string => typeof id === "string");
    for (const roleId of ids) {
      const role = getRole(roleId);
      if (!role || role.community_id !== communityId) throw badRequest("Rol inexistente en esta comunidad.");
      if (role.position >= ceiling) throw forbidden(`No puedes asignar el rol "${role.name}".`);
    }
    db.prepare("DELETE FROM member_roles WHERE community_id = ? AND user_id = ?").run(communityId, targetId);
    const add = db.prepare("INSERT OR IGNORE INTO member_roles (community_id, user_id, role_id) VALUES (?, ?, ?)");
    for (const roleId of ids) add.run(communityId, targetId, roleId);
    audit(communityId, user.id, "MEMBER_ROLES", targetId, { role_ids: ids });
  }

  if (body.timeout_until !== undefined) {
    requirePerm(communityId, user.id, PERMISSIONS.TIMEOUT_MEMBERS, "silenciar miembros");
    if (!canActOn(communityId, user.id, targetId)) throw forbidden("Ese miembro está por encima de ti en la jerarquía.");
    const until = body.timeout_until === null ? null : v.int(body, "timeout_until", { min: 0 });
    db.prepare("UPDATE members SET timeout_until = ? WHERE community_id = ? AND user_id = ?").run(until, communityId, targetId);
    audit(communityId, user.id, "MEMBER_TIMEOUT", targetId, { until });
  }

  if (body.banned !== undefined) {
    requirePerm(communityId, user.id, PERMISSIONS.BAN_MEMBERS, "banear miembros");
    if (!canActOn(communityId, user.id, targetId)) throw forbidden("Ese miembro está por encima de ti en la jerarquía.");
    const banned = v.bool(body, "banned", false);
    db.prepare("UPDATE members SET banned = ? WHERE community_id = ? AND user_id = ?").run(banned ? 1 : 0, communityId, targetId);
    audit(communityId, user.id, banned ? "MEMBER_BAN" : "MEMBER_UNBAN", targetId, {});
    if (banned) publishToUser(targetId, { t: "MEMBER_LEAVE", d: { community_id: communityId, user_id: targetId } });
  }

  const member = getMember(communityId, targetId)!;
  publish(communityId, { t: "MEMBER_UPDATE", d: member });
  return member;
});

route("DELETE", "/api/v1/communities/:id/members/:userId", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  const targetId = ctx.params.userId!;
  requirePerm(communityId, user.id, PERMISSIONS.KICK_MEMBERS, "expulsar miembros");
  if (!canActOn(communityId, user.id, targetId)) throw forbidden("Ese miembro está por encima de ti en la jerarquía.");

  db.prepare("DELETE FROM members WHERE community_id = ? AND user_id = ?").run(communityId, targetId);
  audit(communityId, user.id, "MEMBER_KICK", targetId, {});
  publish(communityId, { t: "MEMBER_LEAVE", d: { community_id: communityId, user_id: targetId } });
  publishToUser(targetId, { t: "MEMBER_LEAVE", d: { community_id: communityId, user_id: targetId } });
});

route("GET", "/api/v1/communities/:id/audit", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requirePerm(communityId, user.id, PERMISSIONS.VIEW_AUDIT_LOG, "ver el registro de auditoría");

  const rows = db.prepare("SELECT * FROM audit_log WHERE community_id = ? ORDER BY id DESC LIMIT 100").all(communityId) as {
    id: string;
    community_id: string;
    actor_id: string;
    action: string;
    target_id: string | null;
    details: string;
    created_at: number;
  }[];

  return rows.map((row) => ({ ...row, details: JSON.parse(row.details) as Record<string, unknown> }));
});

/* ── invitaciones (§5) ─────────────────────────────────────────────── */

/* ── emojis y stickers propios (§10.3) ─────────────────────────────── */

route("GET", "/api/v1/communities/:id/emojis", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  return emojisOf(communityId);
});

/**
 * Todo lo que esta persona puede usar, de todas sus comunidades a la vez.
 * El selector necesita esto de una sola petición: pedir comunidad por comunidad
 * al abrir el panel deja la interfaz parpadeando mientras van llegando.
 */
route("GET", "/api/v1/expressions", (ctx) => {
  const { user } = requireAuth(ctx);
  return emojisAvailableTo(user.id);
});

route("POST", "/api/v1/communities/:id/emojis", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_COMMUNITY, "añadir emojis o stickers");

  const body = await readJson(ctx);
  const kind = v.oneOf(body, "kind", EMOJI_KINDS, "emoji");
  const emoji = createEmoji({
    communityId,
    name: v.string(body, "name", { max: 32 }),
    kind,
    attachmentId: v.string(body, "attachment_id", { max: 64 }),
    iconEmoji: v.optionalString(body, "icon_emoji", { max: 16 }),
    iconAttachmentId: v.optionalString(body, "icon_attachment_id", { max: 64 }),
    creatorId: user.id,
  });

  audit(communityId, user.id, "EMOJI_CREATE", emoji.id, { name: emoji.name, kind: emoji.kind });
  publish(communityId, { t: "EMOJI_UPDATE", d: { community_id: communityId, emojis: emojisOf(communityId) } });
  return emoji;
});

route("DELETE", "/api/v1/emojis/:id", (ctx) => {
  const { user } = requireAuth(ctx);
  const emoji = getEmoji(ctx.params.id!);
  if (!emoji) throw notFound("No encontrado.");
  requirePerm(emoji.community_id, user.id, PERMISSIONS.MANAGE_COMMUNITY, "quitar emojis o stickers");

  deleteEmoji(emoji.id);
  audit(emoji.community_id, user.id, "EMOJI_DELETE", emoji.id, { name: emoji.name, kind: emoji.kind });
  publish(emoji.community_id, {
    t: "EMOJI_UPDATE",
    d: { community_id: emoji.community_id, emojis: emojisOf(emoji.community_id) },
  });
  return { deleted: true };
});

/* ── importar stickers de Telegram (§10.3) ─────────────────────────────
   Un paquete de Telegram se convierte en stickers PROPIOS de la comunidad:
   se reutiliza createEmoji tal cual, así que se pintan, se borran y se listan
   exactamente igual que uno subido a mano. Nada de un sistema paralelo.

   MVP solo estáticos (WEBP): los animados de Telegram son .tgs, un Lottie
   comprimido con gzip que aquí no se decodifica todavía — se filtran en la
   propia lista para no dejar elegir uno que luego el servidor rechazaría.
   ponytail: animados y de vídeo quedan fuera; el mismo lottie-web que ya
   pinta los emoji animados (AnimatedEmoji.tsx) serviría para los .tgs el día
   que haga falta. */

interface TelegramSticker {
  file_id: string;
  emoji: string;
  static: boolean;
}

function requireTelegram(): string {
  if (!config.telegramBotToken) throw notFound("Esta instancia no tiene activada la importación de Telegram.");
  return config.telegramBotToken;
}

/** `getFile` + descarga: dos peticiones a Telegram, porque el enlace final lleva el token. */
async function telegramFile(fileId: string): Promise<{ data: Buffer; contentType: string }> {
  const token = requireTelegram();
  const corte = AbortSignal.timeout(8000);

  const meta = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`, {
    signal: corte,
  })
    .then((res) => res.json())
    .catch(() => null);
  const path = (meta as { result?: { file_path?: string } } | null)?.result?.file_path;
  if (!path) throw new HttpError(502, "UPSTREAM_ERROR", "Telegram no encontró ese sticker.");

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${path}`, { signal: corte }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "No se pudo traer el sticker.");

  return { data: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "application/octet-stream" };
}

route("GET", "/api/v1/stickers", async (ctx) => {
  const { user } = requireAuth(ctx);
  const token = requireTelegram();
  rateLimit(`stickers:${user.id}`, 20, 60_000);

  // Solo lo que Telegram admite como nombre de paquete: letras, números y "_".
  const pack = ctx.url.searchParams.get("pack")?.trim() ?? "";
  if (!/^[a-zA-Z0-9_]{1,64}$/.test(pack)) throw badRequest("Nombre de paquete no válido.");

  const res = await fetch(`https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(pack)}`, {
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const json = (await res?.json().catch(() => null)) as
    | { ok?: boolean; result?: { title?: string; stickers?: unknown[] } }
    | null;
  if (!res?.ok || !json?.ok || !json.result) throw notFound("No se encontró ese paquete de stickers.");

  const stickers: TelegramSticker[] = (json.result.stickers ?? []).flatMap((raw): TelegramSticker[] => {
    const item = raw as { file_id?: string; emoji?: string; is_animated?: boolean; is_video?: boolean };
    if (!item.file_id) return [];
    return [{ file_id: item.file_id, emoji: item.emoji ?? "", static: !item.is_animated && !item.is_video }];
  });

  return { title: json.result.title ?? pack, stickers };
});

/** Igual que /api/v1/avatars/image: sin sesión, porque va en un `<img src>`. */
route("GET", "/api/v1/stickers/image", async (ctx) => {
  rateLimit(`stickerimg:${ctx.ip}`, 120, 60_000);

  const fileId = ctx.url.searchParams.get("id") ?? "";
  if (!/^[\w-]{1,200}$/.test(fileId)) throw badRequest("Sticker no válido.");

  const { data, contentType } = await telegramFile(fileId);
  if (!contentType.startsWith("image/")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Ese sticker no es una imagen estática.");

  ctx.res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  ctx.res.end(data);
  return HANDLED;
});

/* ── traer un sonido de la galeria (§10.3) ─────────────────────────────
   Aqui es donde por fin se baja algo, y solo lo que alguien eligio: la rejilla
   de /api/v1/sounds no gasta ni un byte de disco. El mp3 pasa a ser de la
   comunidad —igual que un sticker de Telegram— asi que si MyInstants cierra
   manana el sonido sigue sonando (§21).

   No se usa saveRemoteAttachment (reenviar en cada escucha) sino saveUpload
   (bajar una vez): un sonido de tabla se dispara muchisimas mas veces que un
   sticker se mira, y son ~100 KB. Reenviarlo seria pagar la descarga entera
   cada vez que alguien pulsa el boton. */

async function readSoundBody(response: Response): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_SOUND_BYTES) {
      await reader.cancel();
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", "El sonido pasa del límite de 5 MB.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

route("POST", "/api/v1/communities/:id/emojis/import-sound", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_COMMUNITY, "añadir sonidos");
  rateLimit(`soundimport:${user.id}`, 30, 60_000);

  const body = await readJson(ctx);
  const origen = v.string(body, "url", { max: 300 });
  const name = v.string(body, "name", { max: 32 });
  const iconEmoji = v.optionalString(body, "icon_emoji", { max: 16 });
  const iconAttachmentId = v.optionalString(body, "icon_attachment_id", { max: 64 });

  // El icono se valida antes de descargar el MP3: una elección inválida no debe
  // dejar un audio huérfano ocupando el disco de quien hospeda.
  validateSoundIcon({ iconEmoji, iconAttachmentId, creatorId: user.id });

  // El nombre se valida ANTES de bajar: si no, un nombre invalido deja el
  // archivo ya escrito en disco y createEmoji reventando despues.
  if (!EMOJI_NAME.test(name))
    throw badRequest("El nombre admite letras, números y guion bajo, entre 2 y 32 caracteres.", { field: "name" });
  if (!MYINSTANTS_MEDIA.test(origen)) throw badRequest("Ese sonido no viene de la galería.");

  const res = await fetch(origen, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "No se pudo traer el sonido.");

  // Antes de leer el cuerpo: lo que se anuncia grande no se llega a cargar en memoria.
  const anunciado = Number(res.headers.get("content-length") ?? 0);
  if (anunciado > MAX_SOUND_BYTES)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "El sonido pasa del límite de 5 MB.");

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (!contentType.startsWith("audio/"))
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Eso no es un archivo de audio.");

  const data = await readSoundBody(res);
  if (data.length === 0) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "El sonido está vacío.");

  const attachment = saveUpload({ ownerId: user.id, filename: `${name}.mp3`, contentType, data });
  const emoji = createEmoji({
    communityId,
    name,
    kind: "sound",
    attachmentId: attachment.id,
    iconEmoji,
    iconAttachmentId,
    creatorId: user.id,
  });

  audit(communityId, user.id, "EMOJI_CREATE", emoji.id, { name: emoji.name, kind: emoji.kind, source: "myinstants" });
  publish(communityId, { t: "EMOJI_UPDATE", d: { community_id: communityId, emojis: emojisOf(communityId) } });
  return emoji;
});

route("POST", "/api/v1/communities/:id/emojis/import-telegram", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_COMMUNITY, "añadir emojis o stickers");
  rateLimit(`stickerimport:${user.id}`, 30, 60_000);

  const body = await readJson(ctx);
  const fileId = v.string(body, "file_id", { max: 200 });
  const name = v.string(body, "name", { max: 32 });

  const { data, contentType } = await telegramFile(fileId);
  if (data.length > MAX_UPLOAD_BYTES)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `El sticker pasa del límite de ${config.maxUploadMb} MB de esta instancia.`);

  const attachment = saveUpload({ ownerId: user.id, filename: "sticker.webp", contentType, data });
  const emoji = createEmoji({ communityId, name, kind: "sticker", attachmentId: attachment.id, creatorId: user.id });

  audit(communityId, user.id, "EMOJI_CREATE", emoji.id, { name: emoji.name, kind: emoji.kind, source: "telegram" });
  publish(communityId, { t: "EMOJI_UPDATE", d: { community_id: communityId, emojis: emojisOf(communityId) } });
  return emoji;
});

/* ── buscador de GIF (§12) ─────────────────────────────────────────────
   La instancia hace de intermediaria: el navegador de cada miembro nunca habla
   con Giphy, así que ni su IP ni lo que escribe salen de aquí. Y la respuesta se
   recorta a lo que hace falta para pintar una rejilla, en vez de devolver el
   JSON entero de un tercero a un cliente que solo necesita cuatro campos. */

interface Gif {
  id: string;
  /** Lo que se manda al enviarlo: el archivo, no la página de Giphy. */
  url: string;
  /** Versión ligera para la rejilla; cargar 30 GIF a tamaño completo no. */
  preview: string;
  title: string;
  width: number;
  height: number;
}

/** `recurso` es "gifs" o "stickers": mismo endpoint de Giphy, mismo formato de
 *  respuesta, así que es la única diferencia entre buscar uno u otro. */
async function askGiphy(recurso: "gifs" | "stickers", path: string, params: Record<string, string>): Promise<Gif[]> {
  if (!config.giphyApiKey) throw notFound("Esta instancia no tiene el buscador de GIF activado.");

  const url = new URL(`https://api.giphy.com/v1/${recurso}/${path}`);
  url.searchParams.set("api_key", config.giphyApiKey);
  url.searchParams.set("rating", "pg-13");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Un tercero lento no puede dejar colgada una petición de la instancia.
  const corte = AbortSignal.timeout(8000);
  const res = await fetch(url, { signal: corte }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "Giphy no respondió. Prueba otra vez en un momento.");

  const json = (await res.json()) as { data?: unknown[] };
  const lista = Array.isArray(json.data) ? json.data : [];

  return lista.flatMap((raw): Gif[] => {
    const item = raw as {
      id?: string;
      title?: string;
      images?: Record<string, { url?: string; width?: string; height?: string }>;
    };
    const grande = item.images?.downsized_medium ?? item.images?.original;
    const pequeno = item.images?.fixed_width_small ?? item.images?.preview_gif ?? grande;
    if (!item.id || !grande?.url || !pequeno?.url) return [];
    return [
      {
        id: item.id,
        url: grande.url,
        preview: pequeno.url,
        title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
        width: Number(grande.width) || 0,
        height: Number(grande.height) || 0,
      },
    ];
  });
}

route("GET", "/api/v1/gifs", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`gif:${user.id}`, 30, 60_000);

  const consulta = ctx.url.searchParams.get("q")?.trim() ?? "";
  const limite = String(Math.min(Number(ctx.url.searchParams.get("limit") ?? 24) || 24, 40));

  if (config.klipyApiKey) {
    const region = /-([A-Za-z]{2})$/.exec(user.locale)?.[1]?.toLowerCase();
    const comun = { per_page: limite, ...(region ? { locale: region } : {}) };
    return consulta
      ? askKlipy("gifs", "search", { ...comun, q: consulta.slice(0, 100) })
      : askKlipy("gifs", "trending", comun);
  }

  // Sin texto se enseña lo que hay en portada, no una rejilla vacía.
  return consulta
    ? askGiphy("gifs", "search", { q: consulta.slice(0, 100), limit: limite })
    : askGiphy("gifs", "trending", { limit: limite });
});

/**
 * Galería de stickers (§10.3, §12), buscable como la de fondos o avatares —
 * no un paquete concreto por nombre, sino "escribo y aparecen". Giphy tiene su
 * propio catálogo de stickers (PNG/GIF con fondo transparente) detrás del
 * mismo endpoint y la misma clave que ya usa el buscador de GIF: no hace falta
 * ni una cuenta ni una clave nueva, es literalmente el mismo askGiphy con
 * "stickers" en vez de "gifs".
 *
 * Al enviarlo se guarda igual que un GIF (/api/v1/gifs/save ya solo exige que
 * la URL sea del CDN de Giphy, y este catálogo vive en el mismo CDN).
 */
/**
 * Galeria de stickers, contra Klipy.
 *
 * Klipy y no Giphy: es gratis, esta pensado para stickers y devuelve PNG y WebP
 * con transparencia, que es lo que distingue un sticker de un GIF cuadrado con
 * fondo. Se queda en su propia funcion en vez de reusar askGiphy porque la
 * respuesta no se parece en nada — la de Klipy anida los formatos por tamano.
 *
 * Formato de la respuesta (docs.klipy.com/stickers-api):
 *   { result, data: { data: [ { slug, title, file: { hd|md|sm|xs: { webp|png|gif: { url, width, height } } } } ] } }
 *
 * Se piden webp y gif y nada mas: el mp4/webm no sirve para pegarlo en un
 * mensaje, y pedir menos formatos baja mucho el tamano de la respuesta.
 */
async function askKlipy(recurso: "gifs" | "stickers", path: "trending" | "search", params: Record<string, string>): Promise<Gif[]> {
  if (!config.klipyApiKey) throw notFound(`Esta instancia no tiene la galeria de ${recurso} activada.`);

  // La clave va en la RUTA, no en la query: asi lo define Klipy.
  const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(config.klipyApiKey)}/${recurso}/${path}`);
  url.searchParams.set("format_filter", "webp,gif");
  url.searchParams.set("content_filter", "medium");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "Klipy no respondio. Prueba otra vez en un momento.");

  interface Archivo {
    url?: string;
    width?: number;
    height?: number;
  }
  type Tamano = Partial<Record<"webp" | "gif" | "png", Archivo>>;
  const json = (await res.json()) as { data?: { data?: unknown[] } };
  const lista = Array.isArray(json.data?.data) ? json.data.data : [];

  return lista.flatMap((raw): Gif[] => {
    const item = raw as { slug?: string; title?: string; file?: Partial<Record<"hd" | "md" | "sm" | "xs", Tamano>> };
    // md para mandar y xs para la rejilla; si falta uno, se cae al siguiente.
    const grande = elArchivo(item.file?.md ?? item.file?.hd ?? item.file?.sm);
    const pequeno = elArchivo(item.file?.xs ?? item.file?.sm) ?? grande;
    if (!item.slug || !grande?.url || !pequeno?.url) return [];
    return [
      {
        id: item.slug,
        url: grande.url,
        preview: pequeno.url,
        title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
        width: Number(grande.width) || 0,
        height: Number(grande.height) || 0,
      },
    ];
  });

  /** webp primero: pesa la mitad que el gif y conserva la transparencia. */
  function elArchivo(t: Tamano | undefined): Archivo | undefined {
    return t?.webp ?? t?.gif ?? t?.png;
  }
}

route("GET", "/api/v1/stickers/gallery", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`stickergallery:${user.id}`, 30, 60_000);

  const consulta = ctx.url.searchParams.get("q")?.trim() ?? "";
  const porPagina = String(Math.min(Number(ctx.url.searchParams.get("limit") ?? 24) || 24, 50));

  /* Klipy pide un PAIS (ISO 3166: br, us, ru), no un idioma, asi que solo se
     manda cuando el idioma de la persona lleva region: "pt-BR" da "br", pero
     "en" no es ningun pais y "es" seria decirle "España" a un mexicano. Sin
     este parametro Klipy decide por su cuenta, que acierta mas que adivinar. */
  const region = /-([A-Za-z]{2})$/.exec(user.locale)?.[1]?.toLowerCase();
  const comun = { per_page: porPagina, ...(region ? { locale: region } : {}) };

  return consulta ? askKlipy("stickers", "search", { ...comun, q: consulta.slice(0, 100) }) : askKlipy("stickers", "trending", comun);
});

/* ── buscador de fondos (§10.2) ────────────────────────────────────────
   Mismo trato que los GIF: proxy en la instancia. Aquí además es obligatorio,
   porque wallhaven.cc no manda cabeceras CORS y desde el navegador la petición
   ni llega a salir. Se devuelven cuatro campos, no el JSON entero de un tercero. */

interface Wallpaper {
  id: string;
  /** Resolución completa: lo que se pone de fondo al elegirlo. */
  url: string;
  /** Miniatura para la rejilla; cargar 24 imágenes de 4K no es una rejilla. */
  preview: string;
  resolution: string;
}

route("GET", "/api/v1/wallpapers", async (ctx) => {
  const { user } = requireAuth(ctx);
  // ponytail: por usuario. Wallhaven corta a 45/min para toda la instancia, así
  // que con muchos buscando a la vez el techo lo pone él; se verá como 502.
  rateLimit(`wallpaper:${user.id}`, 20, 60_000);

  const consulta = ctx.url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  const pagina = Math.min(Math.max(Number(ctx.url.searchParams.get("page") ?? 1) || 1, 1), 20);

  const url = new URL("https://wallhaven.cc/api/v1/search");
  url.searchParams.set("q", consulta);
  url.searchParams.set("purity", "100"); // solo SFW, y por eso la clave sobra
  url.searchParams.set("categories", "111");
  url.searchParams.set("atleast", "1920x1080"); // es un fondo, no una miniatura
  url.searchParams.set("sorting", consulta ? "relevance" : "toplist");
  url.searchParams.set("page", String(pagina));
  if (config.wallhavenApiKey) url.searchParams.set("apikey", config.wallhavenApiKey);

  const corte = AbortSignal.timeout(8000);
  const res = await fetch(url, { signal: corte }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "Wallhaven no respondió. Prueba otra vez en un momento.");

  const json = (await res.json()) as { data?: unknown[] };
  const lista = Array.isArray(json.data) ? json.data : [];

  return lista.flatMap((raw): Wallpaper[] => {
    const item = raw as { id?: string; path?: string; resolution?: string; thumbs?: { small?: string } };
    if (!item.id || !item.path || !item.thumbs?.small) return [];
    return [{ id: item.id, url: item.path, preview: item.thumbs.small, resolution: item.resolution ?? "" }];
  });
});

/* ── galeria de sonidos (§10.3) ────────────────────────────────────────
   Mismo trato que los fondos, y el proxy vuelve a ser obligatorio: la API de
   MyInstants no manda cabeceras CORS. Es API propia del sitio, publica y sin
   clave — no hay nada que configurar para que funcione en cualquier instancia.

   Solo se BUSCA aqui. El mp3 no se toca hasta que alguien elige uno, y
   entonces baja ese y solo ese (/emojis/import-sound). Una rejilla de 20
   resultados no puede costarle 20 descargas al disco del anfitrion.

   OJO: el catalogo lo suben usuarios y no tiene filtro de contenido, al
   contrario que Wallhaven con `purity`. Quien administra la comunidad es quien
   decide que sonido entra, que es justo lo que pide el flujo de abajo. */

interface GallerySound {
  /** El slug de MyInstants: identifica la fila en la rejilla. */
  id: string;
  name: string;
  /** mp3 directo, para escucharlo antes de decidir y para bajarlo al elegir. */
  url: string;
}

/** De donde se acepta bajar un sonido. Sin esta lista la ruta de importar seria
    un SSRF de manual: "bajame esta URL" apuntando a la red interna (§22).
    El `(?!.*\.\.)` deja pasar nombres con punto —los hay, `evillaugh.swf.mp3`—
    sin dejar pasar un `..` que se saliera de /media/sounds/. */
export const MYINSTANTS_MEDIA = /^https:\/\/(?:www\.)?myinstants\.com\/media\/sounds\/(?!.*\.\.)[\w.-]+\.mp3$/;

route("GET", "/api/v1/sounds", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`sounds:${user.id}`, 20, 60_000);

  const consulta = ctx.url.searchParams.get("q")?.trim().slice(0, 100) ?? "";
  // MyInstants sirve de 10 en 10 y no admite page_size, asi que el "ver mas"
  // de la rejilla se traduce en pedir la pagina siguiente.
  const pagina = Math.min(Math.max(Number(ctx.url.searchParams.get("page") ?? 1) || 1, 1), 50);

  const url = new URL("https://www.myinstants.com/api/v1/instants/");
  // Sin `name` devuelve los mas sonados, que es mejor primera pantalla que un vacio.
  if (consulta) url.searchParams.set("name", consulta);
  url.searchParams.set("page", String(pagina));

  const res = await fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "MyInstants no respondió. Prueba otra vez en un momento.");

  const json = (await res.json().catch(() => null)) as { results?: unknown[] } | null;
  const lista = Array.isArray(json?.results) ? json.results : [];

  return lista.flatMap((raw): GallerySound[] => {
    const item = raw as { name?: string; slug?: string; sound?: string };
    // El mismo filtro que la ruta de importar: lo que no se podria bajar no se enseña.
    if (!item.slug || !item.name || !item.sound || !MYINSTANTS_MEDIA.test(item.sound)) return [];
    return [{ id: item.slug, name: item.name, url: item.sound }];
  });
});

/* ── galeria de avatares y banners (§10.1) ──────────────────────────────
   Mismo patrón que los GIF y los fondos, y aquí el proxy no es opcional por dos
   razones: nekos.best exige una cabecera User-Agent propia, y `User-Agent` es
   una de las cabeceras que el navegador PROHÍBE fijar desde JavaScript. Sin
   instancia por delante, la petición no se puede hacer.

   La imagen se guarda como enlace, igual que un fondo. Quien la quiera para
   siempre la baja y la sube: entonces vive en el disco del anfitrión. */

interface Pfp {
  id: string;
  url: string;
  /** No hay miniatura aparte: los ficheros ya son pequeños (200-500 px). */
  preview: string;
  /** De dónde sale, para poder dar crédito. */
  source: string;
  animated: boolean;
}

/** Se aprende una vez al arrancar y se reutiliza: no cambia entre peticiones. */
let categorias: { name: string; animated: boolean }[] | null = null;

async function nekos(path: string): Promise<unknown> {
  const res = await fetch(`https://nekos.best/api/v2/${path}`, {
    headers: { "user-agent": `Distop/${VERSION} (plataforma comunitaria open source)` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!res?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "La galería no respondió. Prueba otra vez en un momento.");
  return res.json();
}

route("GET", "/api/v1/avatars/categories", async (ctx) => {
  requireAuth(ctx);
  if (!categorias) {
    const raw = (await nekos("endpoints")) as Record<string, { format?: string }>;
    categorias = Object.entries(raw)
      .map(([name, meta]) => ({ name, animated: meta.format === "gif" }))
      // Las animadas primero: son las que en otras plataformas se cobran.
      .sort((a, b) => Number(b.animated) - Number(a.animated) || a.name.localeCompare(b.name));
  }
  return categorias;
});

/**
 * Los bytes de la imagen también pasan por aquí, no solo el JSON.
 *
 * No es por privacidad: nekos.best responde 403 a cualquier User-Agent de
 * navegador. Comprobado. Así que un <img src="https://nekos.best/..."> sale
 * roto siempre, y la única forma de pintar la rejilla es que la instancia baje
 * la imagen con su propia cabecera y la reenvíe.
 *
 * Por eso lo que se guarda en avatar_url es esta ruta y no la de nekos.best:
 * si guardáramos la original, el avatar se vería roto para toda la comunidad.
 *
 * ponytail: reenvía en vez de guardar en disco. Menos código y la cache del
 * navegador se lo come; si un día molesta depender de que nekos.best siga en
 * pie, esto pasa a bajarlo una vez y guardarlo como adjunto.
 */
const GALERIA = "nekos.best";

route("GET", "/api/v1/avatars/image", async (ctx) => {
  /* Sin sesión, igual que /files/:id: un <img src> no manda la cabecera de
     autorización, así que exigirla dejaba la rejilla entera en blanco. Lo que
     sustituye a la sesión es el límite por IP: esto solo alcanza un host, pero
     sigue siendo ancho de banda de quien hospeda. */
  rateLimit(`pfpimg:${ctx.ip}`, 120, 60_000);

  /* Protección SSRF (§22): el host va comparado entero contra una constante, no
     con endsWith ni includes. `nekos.best.atacante.com` pasaría un endsWith. */
  let origen: URL;
  try {
    origen = new URL(ctx.url.searchParams.get("u") ?? "");
  } catch {
    throw badRequest("Enlace no válido.");
  }
  if (origen.protocol !== "https:" || origen.hostname !== GALERIA) throw badRequest("Ese enlace no es de la galería.");

  const res = await fetch(origen, {
    headers: { "user-agent": `Distop/${VERSION} (plataforma comunitaria open source)` },
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  const tipo = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !tipo.startsWith("image/")) throw new HttpError(502, "UPSTREAM_ERROR", "La imagen no se pudo traer.");

  ctx.res.writeHead(200, {
    "content-type": tipo,
    // Inmutable de verdad: cada imagen de la galería tiene su propio UUID.
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
  });
  ctx.res.end(Buffer.from(await res.arrayBuffer()));
  return HANDLED;
});

route("GET", "/api/v1/avatars", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`pfp:${user.id}`, 20, 60_000);

  // Solo letras: la categoría entra en la ruta de un tercero, y cualquier otra
  // cosa sería dejar que el cliente componga la URL que pedimos.
  const categoria = (ctx.url.searchParams.get("category") ?? "neko").toLowerCase();
  if (!/^[a-z]{1,20}$/.test(categoria)) throw badRequest("Categoría no válida.");

  const cantidad = Math.min(Math.max(Number(ctx.url.searchParams.get("amount") ?? 12) || 12, 1), 20);
  const json = (await nekos(`${categoria}?amount=${cantidad}`)) as { results?: unknown[] };
  const lista = Array.isArray(json.results) ? json.results : [];

  return lista.flatMap((raw): Pfp[] => {
    const item = raw as { url?: string; anime_name?: string; artist_name?: string };
    if (!item.url) return [];
    const porLaInstancia = `/api/v1/avatars/image?u=${encodeURIComponent(item.url)}`;
    return [
      {
        id: item.url,
        url: porLaInstancia,
        preview: porLaInstancia,
        source: item.anime_name ?? item.artist_name ?? "",
        animated: item.url.endsWith(".gif"),
      },
    ];
  });
});

/**
 * Enviar un GIF o sticker de la galería no lo descarga ni lo guarda: queda
 * como un adjunto que la instancia reenvía cada vez que alguien lo ve (§22),
 * igual que la galería de avatares.
 *
 * Enlazarlo tal cual convertiría cada mensaje en una baliza: cada persona que
 * abra el canal, hoy y dentro de un año, le pediría el archivo a Giphy y le
 * entregaría su IP. Descargarlo entero costaría disco del anfitrión para
 * siempre por algo que Giphy ya aloja. Esto es el punto medio: solo se pide la
 * cabecera para saber tipo y tamaño, nunca el archivo completo, y cada vista
 * futura vuelve a pasar por aquí — nunca por el navegador de quien lee.
 *
 * El precio de no guardarlo: si Giphy borra ese contenido, el mensaje queda
 * roto para siempre. Eso no pasa con un archivo subido a mano (§29.3).
 */
route("POST", "/api/v1/gifs/save", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`gifsave:${user.id}`, 20, 60_000);
  // Sin ninguna galeria configurada no hay de donde sacar una de estas URL, asi
  // que aceptarlas solo seria regalar ancho de banda del anfitrion.
  if (!config.giphyApiKey && !config.klipyApiKey)
    throw notFound("Esta instancia no tiene ninguna galeria activada.");

  const body = await readJson(ctx);
  const origen = v.string(body, "url", { max: 500 });

  // Misma lista blanca con la que despues se reenvia el archivo. Sin ella esto
  // seria un SSRF de manual, capaz de traerse cualquier URL interna que alcance
  // el anfitrion (§22).
  let destino: URL;
  try {
    destino = new URL(origen);
  } catch {
    throw badRequest("Dirección no válida.");
  }
  if (destino.protocol !== "https:" || !CDN_REENVIABLE.test(destino.hostname))
    throw badRequest("Solo se aceptan archivos de las galerias de la instancia.");

  const head = await fetch(destino, { method: "HEAD", signal: AbortSignal.timeout(8000) }).catch(() => null);
  if (!head?.ok) throw new HttpError(502, "UPSTREAM_ERROR", "No se pudo comprobar el archivo.");

  const tipo = head.headers.get("content-type")?.split(";")[0]?.trim() ?? "image/gif";
  const tamano = Number(head.headers.get("content-length")) || 0;
  if (tamano > MAX_UPLOAD_BYTES)
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", `El GIF pasa del límite de ${config.maxUploadMb} MB de esta instancia.`);

  /* El nombre sale del tipo real y no siempre "gif.gif": un sticker de Klipy es
     un webp, y un adjunto llamado .gif que no lo es confunde al descargarlo. */
  const extension = tipo === "image/webp" ? "webp" : tipo === "image/png" ? "png" : "gif";
  return saveRemoteAttachment({
    ownerId: user.id,
    filename: `sticker.${extension}`,
    contentType: tipo,
    size: tamano,
    sourceUrl: origen,
  });
});

route("POST", "/api/v1/communities/:id/invites", async (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requireMembership(communityId, user.id);
  requirePerm(communityId, user.id, PERMISSIONS.CREATE_INVITE, "crear invitaciones");

  const body = await readJson(ctx);
  const maxUses = body.max_uses === null || body.max_uses === undefined ? null : v.int(body, "max_uses", { min: 1, max: 10000 });
  const ttlS = body.expires_in_s === null || body.expires_in_s === undefined ? null : v.int(body, "expires_in_s", { min: 60, max: 60 * 60 * 24 * 90 });
  const channelId = v.optionalString(body, "channel_id", { max: 64 }) ?? null;

  const code = randomBytes(6).toString("base64url");
  db.prepare(
    "INSERT INTO invites (code, community_id, channel_id, creator_id, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(code, communityId, channelId, user.id, maxUses, ttlS ? Date.now() + ttlS * 1000 : null, Date.now());

  audit(communityId, user.id, "INVITE_CREATE", code, { max_uses: maxUses });
  return db.prepare("SELECT * FROM invites WHERE code = ?").get(code);
});

route("GET", "/api/v1/communities/:id/invites", (ctx) => {
  const { user } = requireAuth(ctx);
  requirePerm(ctx.params.id!, user.id, PERMISSIONS.MANAGE_INVITES, "ver las invitaciones");
  return db.prepare("SELECT * FROM invites WHERE community_id = ? ORDER BY created_at DESC").all(ctx.params.id!);
});

route("DELETE", "/api/v1/invites/:code", (ctx) => {
  const { user } = requireAuth(ctx);
  const invite = db.prepare("SELECT * FROM invites WHERE code = ?").get(ctx.params.code!) as
    | { community_id: string; creator_id: string }
    | undefined;
  if (!invite) throw notFound("Invitación no encontrada.");
  if (invite.creator_id !== user.id) requirePerm(invite.community_id, user.id, PERMISSIONS.MANAGE_INVITES, "borrar invitaciones");

  db.prepare("DELETE FROM invites WHERE code = ?").run(ctx.params.code!);
  audit(invite.community_id, user.id, "INVITE_DELETE", ctx.params.code!, {});
});

interface InviteRow {
  code: string;
  community_id: string;
  channel_id: string | null;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
}

function liveInvite(code: string): InviteRow {
  const invite = db.prepare("SELECT * FROM invites WHERE code = ?").get(code) as InviteRow | undefined;
  if (!invite) throw notFound("Esa invitación no existe o fue revocada.");
  if (invite.expires_at !== null && invite.expires_at < Date.now()) throw notFound("Esa invitación caducó.");
  if (invite.max_uses !== null && invite.uses >= invite.max_uses) throw notFound("Esa invitación agotó sus usos.");
  return invite;
}

/** Pública a propósito: hay que poder ver a qué te invitan antes de entrar. */
route("GET", "/api/v1/invites/:code", (ctx) => {
  const invite = liveInvite(ctx.params.code!);
  const community = getCommunity(invite.community_id)!;
  const members = (
    db.prepare("SELECT COUNT(*) AS n FROM members WHERE community_id = ? AND banned = 0").get(invite.community_id) as {
      n: number;
    }
  ).n;

  return {
    code: invite.code,
    community: {
      id: community.id,
      name: community.name,
      slug: community.slug,
      description: community.description,
      icon_url: community.icon_url,
      banner_url: community.banner_url,
      accent_color: community.accent_color,
    },
    members,
    online: onlineIn(community.id).length,
    guest_mode_enabled: config.guestModeEnabled,
  };
});

route("POST", "/api/v1/invites/:code/join", (ctx) => {
  const { user } = requireAuth(ctx);
  const invite = liveInvite(ctx.params.code!);
  rateLimit(`join:${user.id}`, 20, 60 * 60_000);

  const existing = memberState(invite.community_id, user.id);
  if (existing.banned) throw forbidden("Tienes el acceso bloqueado en esta comunidad.");

  if (!existing.isMember) {
    db.prepare("INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)").run(
      invite.community_id,
      user.id,
      Date.now(),
    );
    db.prepare("UPDATE invites SET uses = uses + 1 WHERE code = ?").run(invite.code);
    markCommunityRead(user.id, invite.community_id);
    audit(invite.community_id, user.id, "MEMBER_JOIN", user.id, { invite: invite.code });
    publish(invite.community_id, { t: "MEMBER_JOIN", d: getMember(invite.community_id, user.id)! });
  }

  return { community: getCommunity(invite.community_id), channel_id: invite.channel_id };
});

/* ── abrir la instancia al mundo (§6) ──────────────────────────────── */

/**
 * Solo quien puso en marcha la instancia. No es un permiso de comunidad: esto
 * arranca un proceso en el ordenador anfitrión, y administrar una comunidad no
 * da derecho sobre la máquina de quien la hospeda.
 */
function requireHost(ctx: Ctx): ReturnType<typeof requireAuth> {
  const auth = requireAuth(ctx);
  if (!isInstanceOwner(auth.user.id)) throw forbidden("Esto solo puede hacerlo quien hospeda la instancia.");
  return auth;
}

route("GET", "/api/v1/instance/tunnel", (ctx) => {
  requireHost(ctx);
  return { ...tunnelState(), autostart: tunnelAutostart() };
});

route("POST", "/api/v1/instance/tunnel", async (ctx) => {
  requireHost(ctx);
  rateLimit(`tunnel:${ctx.ip}`, 5, 60_000);
  return startTunnel();
});

route("DELETE", "/api/v1/instance/tunnel", (ctx) => {
  requireHost(ctx);
  return stopTunnel();
});

/* Que el enlace publico se abra solo al arrancar es decision de quien hospeda:
   comodo por defecto, pero su ordenador queda accesible desde internet mientras
   la aplicacion este abierta, y eso tiene que poder apagarse. */
route("PUT", "/api/v1/instance/tunnel/autostart", async (ctx) => {
  requireHost(ctx);
  const body = await readJson(ctx);
  setTunnelAutostart(v.bool(body, "enabled", true));
  return { enabled: tunnelAutostart() };
});

/* Relevo de voz: quién puede reenviar el audio y el vídeo cuando dos redes no
   se dejan conectar en directo. Decisión de quien hospeda, desde la aplicación. */
route("GET", "/api/v1/instance/relay", (ctx) => {
  requireHost(ctx);
  return relayState();
});

route("PUT", "/api/v1/instance/relay", async (ctx) => {
  requireHost(ctx);
  const body = await readJson(ctx);
  const text = (key: string): Record<string, string> =>
    typeof body[key] === "string" ? { [key]: (body[key] as string).trim() } : {};
  return setRelay({
    ...text("mode"),
    /* Sin estas tres, el selector de Ajustes guardaba en el vacío: el cliente
       las mandaba, aquí se filtraban, y setRelay persistía lo de siempre. */
    ...text("video"),
    ...text("quality"),
    ...text("priority"),
    ...text("url"),
    ...text("username"),
    ...text("credential"),
    ...text("keyId"),
    ...text("apiToken"),
    ...text("appName"),
    ...text("apiKey"),
  } as Parameters<typeof setRelay>[0]);
});

/**
 * Vaciar el historial de la instancia entera (§28.4).
 * Se van los mensajes y sus archivos —fotos, GIF, adjuntos— de TODAS las
 * comunidades. Se quedan las comunidades, sus miembros, roles, canales,
 * emojis, avatares y fondos: es una limpieza de disco, no un cierre.
 * Solo quien hospeda: el disco que se llena es el suyo.
 */
route("POST", "/api/v1/instance/purge", (ctx) => {
  const { user } = requireHost(ctx);

  const messages = (db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
  // Primero los ficheros (las filas de adjuntos dicen dónde están), después las
  // filas de mensajes: reacciones y adjuntos restantes caen por CASCADE.
  const { files, mb } = purgeChatFiles();
  db.prepare("DELETE FROM messages").run();
  invalidateStorageCache();

  const communities = db.prepare("SELECT id FROM communities").all() as { id: string }[];
  for (const community of communities) {
    // Que conste en la auditoría de CADA comunidad: su historial desapareció y
    // sus miembros tienen derecho a ver quién y cuándo.
    audit(community.id, user.id, "instance.purge", null, { messages, files, mb });
    // Sin este aviso, los demás clientes enseñarían una conversación que ya no
    // existe hasta la próxima recarga.
    publish(community.id, { t: "MESSAGES_PURGED", d: { community_id: community.id } });
  }

  return { messages, files, mb };
});

/* ── adjuntos (§28.3) ──────────────────────────────────────────────── */

route("POST", "/api/v1/uploads", async (ctx) => {
  const { user } = requireAuth(ctx);
  rateLimit(`upload:${user.id}`, 30, 60_000);

  const contentType = (ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim();
  const filename = decodeURIComponent(String(ctx.req.headers["x-filename"] ?? "archivo"));
  if (!contentType) throw badRequest("Falta la cabecera content-type.");

  const data = await readBody(ctx.req, MAX_UPLOAD_BYTES);
  if (data.length === 0) throw badRequest("El archivo está vacío.");
  return saveUpload({ ownerId: user.id, filename, contentType, data });
});

route("GET", "/api/v1/files/:id", (ctx) => serveFile(ctx, ctx.params.id!));

/* ── portabilidad (§21) ────────────────────────────────────────────── */

route("GET", "/api/v1/communities/:id/export", (ctx) => {
  const { user } = requireAuth(ctx);
  const communityId = ctx.params.id!;
  requirePerm(communityId, user.id, PERMISSIONS.MANAGE_COMMUNITY, "exportar la comunidad");

  const community = getCommunity(communityId)!;
  const channels = channelsOf(communityId);
  const messages: Record<string, unknown[]> = {};
  for (const channel of channels) {
    messages[channel.name] = db
      .prepare("SELECT * FROM messages WHERE channel_id = ? ORDER BY id ASC")
      .all(channel.id) as unknown[];
  }

  const bundle = {
    manifest: {
      format: "distop-community-export",
      format_version: 1,
      protocol: "v1",
      exported_at: new Date().toISOString(),
      instance: config.instanceName,
    },
    community,
    categories: categoriesOf(communityId),
    channels,
    roles: rolesOf(communityId),
    members: membersOf(communityId, true),
    invites: db.prepare("SELECT * FROM invites WHERE community_id = ?").all(communityId),
    audit_log: db.prepare("SELECT * FROM audit_log WHERE community_id = ?").all(communityId),
    messages,
    attachments: db
      .prepare(
        `SELECT a.id, a.filename, a.content_type, a.size, a.message_id FROM attachments a
         JOIN messages m ON m.id = a.message_id WHERE m.community_id = ?`,
      )
      .all(communityId),
  };

  audit(communityId, user.id, "COMMUNITY_EXPORT", communityId, {});
  send(ctx, 200, bundle, {
    "content-disposition": `attachment; filename="${community.slug}-export.json"`,
  });
  return HANDLED;
});
