/**
 * API REST v1 de la instancia (§18).
 * Regla sin excepciones: cada handler resuelve permisos contra la base antes de
 * leer o escribir. La validación del cliente es cortesía, esta es la que cuenta.
 */
import { randomBytes } from "node:crypto";
import { PERMISSIONS, ALL_PERMISSIONS, has, toBits, uuidv7 } from "@distop/protocol";
import type { Snowflake } from "@distop/protocol";
import { config, MAX_UPLOAD_BYTES } from "./config.ts";
import { publicUrl, startTunnel, stopTunnel, tunnelState } from "./tunnel.ts";
import { iceServers, relayState, setRelay, videoMode } from "./ice.ts";
import { audit, db, seedCommunity, uniqueSlug } from "./db.ts";
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
  membersOf,
  messagesOf,
  rolesOf,
} from "./entities.ts";
import { canActOn, channelPermissions, communityPermissions, highestRolePosition, memberState } from "./permissions.ts";
import {
  HANDLED,
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
import { instanceHealth, VERSION } from "./instance.ts";
import { deleteAttachmentsOf, deleteAttachmentsOwnedBy, linkAttachments, saveUpload, serveFile } from "./storage.ts";
import { disconnectSession, onlineCount, onlineIn, publish, publishToChannel, publishToUser } from "./gateway.ts";
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
  /** Dirección por la que llega la gente de fuera; vacía = solo local (§6).
      Si hay un túnel abierto desde la app, esa manda sobre la del .env. */
  public_url: publicUrl(),
  /** Estado del túnel, para que la interfaz pueda ofrecer abrirlo o cerrarlo. */
  tunnel: tunnelState(),
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
  community: string;
}

function recoverableAccounts(): RecoverableAccount[] {
  return db
    .prepare(
      `SELECT u.username, u.display_name,
              (SELECT name FROM communities WHERE owner_id = u.id ORDER BY created_at LIMIT 1) AS community
         FROM users u
        WHERE u.password_hash IS NULL AND community IS NOT NULL
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
  if (body.settings !== undefined) {
    if (typeof body.settings !== "object" || body.settings === null) throw badRequest('"settings" debe ser un objeto.');
    fields.push(["settings", JSON.stringify(body.settings)]);
  }
  if (fields.length === 0) return toSelfUser(findUserById(user.id)!);

  db.prepare(`UPDATE users SET ${fields.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...fields.map(([, value]) => value as string | null),
    user.id,
  );

  const updated = toSelfUser(findUserById(user.id)!);
  for (const community of communitiesForUser(user.id)) {
    const member = getMember(community.id, user.id);
    if (member) publish(community.id, { t: "MEMBER_UPDATE", d: member });
  }
  return updated;
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
    permissions: communityPermissions(communityId, user.id).toString(),
    channel_permissions: channelPerms,
    voice_states: statesOfCommunity(communityId),
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

  const id = uuidv7();
  db.prepare(
    `INSERT INTO messages (id, channel_id, community_id, author_id, content, created_at, reply_to_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, channel.id, channel.community_id, user.id, content, Date.now(), replyTo);
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
function requireHost(ctx: Ctx): void {
  const { user } = requireAuth(ctx);
  if (!isInstanceOwner(user.id)) throw forbidden("Esto solo puede hacerlo quien hospeda la instancia.");
}

route("GET", "/api/v1/instance/tunnel", (ctx) => {
  requireHost(ctx);
  return tunnelState();
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
    ...text("url"),
    ...text("username"),
    ...text("credential"),
    ...text("keyId"),
    ...text("apiToken"),
    ...text("appName"),
    ...text("apiKey"),
  } as Parameters<typeof setRelay>[0]);
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
