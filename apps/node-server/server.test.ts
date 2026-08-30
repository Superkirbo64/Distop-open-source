/**
 * Self-check de la instancia: el camino real de una comunidad de principio a fin
 * más las dos piezas donde un fallo silencioso sería grave (permisos y jerarquía).
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-test-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.PUBLIC_DISCOVERY_ENABLED = "true";

const { server } = await import("./server.ts");
const { PERMISSIONS, has, toBits, uuidv7 } = await import("@distop/protocol");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.close();
  // Windows no borra el directorio mientras SQLite mantenga abiertos los ficheros WAL.
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test("health reporta el estado real de la instancia", async () => {
  const { status, json } = await call("GET", "/health");
  assert.equal(status, 200);
  assert.equal(json.status, "HOST_UNCLAIMED");
  assert.equal(json.protocol, "v1");
});

test("registro, comunidad, canal y mensaje: el camino completo", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "ana", password: "contrasena-larga-1" },
  });
  assert.equal(owner.status, 200);
  const token = owner.json.access_token as string;

  const community = await call("POST", "/api/v1/communities", { token, body: { name: "Mi Comunidad" } });
  assert.equal(community.status, 200);
  assert.equal(community.json.slug, "mi-comunidad");

  const boot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  assert.equal(boot.json.channels.length, 3, "la comunidad nace con general, anuncios y voz");
  assert.ok(has(toBits(boot.json.permissions), PERMISSIONS.ADMINISTRATOR), "quien crea es administrador");

  const channel = boot.json.channels.find((c: any) => c.name === "general");
  const sent = await call("POST", `/api/v1/channels/${channel.id}/messages`, { token, body: { content: "hola" } });
  assert.equal(sent.status, 200);

  const history = await call("GET", `/api/v1/channels/${channel.id}/messages`, { token });
  assert.equal(history.json.length, 1);
  assert.equal(history.json[0].content, "hola");

  // La exportación es la garantía anti-lock-in (§21): tiene que traer los mensajes.
  const dump = await call("GET", `/api/v1/communities/${community.json.id}/export`, { token });
  assert.equal(dump.json.manifest.format, "distop-community-export");
  assert.equal(dump.json.messages.general.length, 1);
});

test("un extraño no ve la comunidad y un invitado sí puede entrar por enlace", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "beto", password: "contrasena-larga-2" },
  });
  const ownerToken = owner.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token: ownerToken, body: { name: "Privada" } });

  const stranger = await call("POST", "/api/v1/auth/guest", { body: { display_name: "curioso" } });
  const strangerToken = stranger.json.access_token as string;

  const denied = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token: strangerToken });
  assert.equal(denied.status, 404, "sin membresía la comunidad ni siquiera existe");

  const invite = await call("POST", `/api/v1/communities/${community.json.id}/invites`, {
    token: ownerToken,
    body: { max_uses: 1 },
  });
  const joined = await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: strangerToken });
  assert.equal(joined.status, 200);

  const allowed = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token: strangerToken });
  assert.equal(allowed.status, 200);
  assert.ok(!has(toBits(allowed.json.permissions), PERMISSIONS.MANAGE_CHANNELS), "un miembro nuevo no administra");

  // La invitación era de un solo uso.
  const second = await call("POST", "/api/v1/auth/guest", { body: { display_name: "tarde" } });
  const rejected = await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: second.json.access_token });
  assert.equal(rejected.status, 404);
});

test("visibilidad y entrada son políticas separadas", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "directorio-owner", password: "contrasena-larga-directorio" },
  });
  const ownerToken = owner.json.access_token as string;

  const open = await call("POST", "/api/v1/communities", {
    token: ownerToken,
    body: { name: "Plaza abierta", visibility: "public", join_policy: "open" },
  });
  assert.equal(open.json.visibility, "public");
  assert.equal(open.json.join_policy, "open");

  const visitor = await call("POST", "/api/v1/auth/guest", { body: { display_name: "visitante-directo" } });
  const joined = await call("POST", `/api/v1/public-communities/${open.json.id}/join`, { token: visitor.json.access_token });
  assert.equal(joined.status, 200, "una comunidad abierta no fabrica una invitación escondida");

  const guarded = await call("POST", "/api/v1/communities", {
    token: ownerToken,
    body: { name: "Plaza moderada", visibility: "public", join_policy: "request" },
  });
  const applicant = await call("POST", "/api/v1/auth/guest", { body: { display_name: "solicitante" } });
  const requested = await call("POST", `/api/v1/public-communities/${guarded.json.id}/requests`, {
    token: applicant.json.access_token,
    body: { message: "Me gustaría entrar" },
  });
  assert.equal(requested.status, 200);
  assert.equal(requested.json.state, "pending");

  const pending = await call("GET", `/api/v1/communities/${guarded.json.id}/join-requests`, { token: ownerToken });
  assert.equal(pending.json.length, 1);
  const approved = await call("POST", `/api/v1/join-requests/${pending.json[0].id}/approve`, { token: ownerToken });
  assert.equal(approved.json.state, "approved");
  const visible = await call("GET", `/api/v1/communities/${guarded.json.id}/bootstrap`, { token: applicant.json.access_token });
  assert.equal(visible.status, 200, "aprobar la solicitud crea una membresía real");

  const discovery = await call("GET", "/api/v1/discovery");
  const profile = discovery.json.find((item: any) => item.id === guarded.json.id);
  assert.equal(profile.join_policy, "request");
  assert.equal(typeof profile.fingerprint, "string");
});

test("nadie puede concederse permisos que no tiene", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "carla", password: "contrasena-larga-3" },
  });
  const ownerToken = owner.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token: ownerToken, body: { name: "Jerarquia" } });
  const communityId = community.json.id as string;

  // Rol de moderación que puede gestionar roles pero no ser administrador.
  const modRole = await call("POST", `/api/v1/communities/${communityId}/roles`, {
    token: ownerToken,
    body: { name: "Mods", permissions: PERMISSIONS.MANAGE_ROLES.toString(), position: 10 },
  });
  assert.equal(modRole.status, 200);

  const mod = await call("POST", "/api/v1/auth/register", {
    body: { username: "dario", password: "contrasena-larga-4" },
  });
  const modToken = mod.json.access_token as string;
  const invite = await call("POST", `/api/v1/communities/${communityId}/invites`, { token: ownerToken, body: {} });
  await call("POST", `/api/v1/invites/${invite.json.code}/join`, { token: modToken });
  await call("PATCH", `/api/v1/communities/${communityId}/members/${mod.json.user.id}`, {
    token: ownerToken,
    body: { role_ids: [modRole.json.id] },
  });

  const escalation = await call("POST", `/api/v1/communities/${communityId}/roles`, {
    token: modToken,
    body: { name: "Trampa", permissions: PERMISSIONS.ADMINISTRATOR.toString() },
  });
  assert.equal(escalation.status, 403, "un moderador no puede fabricar un rol de administrador");
});

test("eliminar la cuenta la borra de verdad, con sus comunidades y sus archivos", async () => {
  const cuenta = await call("POST", "/api/v1/auth/register", {
    body: { username: "efimera", password: "contrasena-larga-7" },
  });
  const token = cuenta.json.access_token as string;
  const userId = cuenta.json.user.id as string;

  const comunidad = await call("POST", "/api/v1/communities", { token, body: { name: "De paso" } });
  const boot = await call("GET", `/api/v1/communities/${comunidad.json.id}/bootstrap`, { token });
  const canal = boot.json.channels.find((c: any) => c.kind === "text");
  await call("POST", `/api/v1/channels/${canal.id}/messages`, { token, body: { content: "hola" } });

  // Escribir mal el nombre no borra nada: es la red de seguridad del diálogo.
  const flojo = await call("DELETE", "/api/v1/users/me", { token, body: { username: "otra-cosa" } });
  assert.equal(flojo.status, 400, "sin confirmar el nombre exacto no se borra");

  const borrado = await call("DELETE", "/api/v1/users/me", { token, body: { username: "efimera" } });
  assert.equal(borrado.status, 200);
  assert.equal(borrado.json.communities, 1, "se lleva la comunidad que era suya");

  const { db } = await import("./db.ts");
  const quedaUsuario = db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
  assert.equal(quedaUsuario, undefined, "la fila del usuario ya no está");

  const quedanMensajes = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE author_id = ?").get(userId) as { n: number };
  assert.equal(quedanMensajes.n, 0, "ni sus mensajes");

  const quedanSesiones = db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").get(userId) as { n: number };
  assert.equal(quedanSesiones.n, 0, "ni sus sesiones");

  const conElToken = await call("GET", "/api/v1/users/me", { token });
  assert.equal(conElToken.status, 401, "y el token que tenía deja de valer");
});

test("el secreto de sesiones se crea solo y sobrevive al reinicio", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const { existsSync, readFileSync, statSync } = await import("node:fs");

  const dir = mkdtempSync(join(tmpdir(), "distop-secreto-"));
  const configUrl = pathToFileURL(join(import.meta.dirname, "config.ts")).href;

  // Cada lectura es un proceso nuevo: es la única forma de comprobar de verdad
  // que el secreto sobrevive a un reinicio y no vive solo en memoria.
  const arrancar = () =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `import {config} from ${JSON.stringify(configUrl)}; console.log(config.authSecret);`], {
      env: { ...process.env, AUTH_SECRET: "", DATABASE_PATH: join(dir, "app.db") },
      encoding: "utf8",
    }).trim();

  const primero = arrancar();
  const segundo = arrancar();

  assert.equal(primero, segundo, "dos arranques comparten secreto: nadie se queda deslogueado al reiniciar");
  assert.ok(primero.length >= 32, "y es largo de verdad");

  const fichero = join(dir, "secret.key");
  assert.ok(existsSync(fichero), "vive junto a la base, no en el .env");
  assert.equal(readFileSync(fichero, "utf8").trim(), primero);

  // En Windows los bits POSIX no significan nada; donde sí, solo el dueño.
  if (process.platform !== "win32") {
    assert.equal(statSync(fichero).mode & 0o077, 0, "ni el grupo ni el resto pueden leerlo");
  }

  rmSync(dir, { recursive: true, force: true });
});

test("el túnel se maneja desde el equipo anfitrión, no por cualquier admin remoto", async () => {
  // La primera cuenta local de la base es quien puso en marcha la instancia; el
  // resto, por muchos permisos que tengan en su comunidad, no maneja su máquina.
  const forastero = await call("POST", "/api/v1/auth/register", {
    body: { username: "forastero", password: "contrasena-larga-9" },
  });
  const suya = await call("POST", "/api/v1/communities", {
    token: forastero.json.access_token,
    body: { name: "La mía" },
  });
  assert.equal(suya.status, 200, "es administrador de su propia comunidad");

  const local = await call("GET", "/api/v1/instance/tunnel", { token: forastero.json.access_token });
  assert.equal(local.status, 200, "desde el PC anfitrión sí puede manejar el servicio de ese PC");

  const mirar = await call("GET", "/api/v1/instance/tunnel", {
    token: forastero.json.access_token,
    headers: { "cf-ray": "peticion-remota" },
  });
  assert.equal(mirar.status, 403, "desde internet no puede ni mirar el estado del túnel");

  const abrir = await call("POST", "/api/v1/instance/tunnel", {
    token: forastero.json.access_token,
    headers: { "cf-ray": "peticion-remota" },
  });
  assert.equal(abrir.status, 403, "ni abrirlo remotamente");

  const sinSesion = await call("POST", "/api/v1/instance/tunnel");
  assert.equal(sinSesion.status, 401, "y sin sesión, ni eso");

  const relevo = await call("GET", "/api/v1/instance/relay", { token: forastero.json.access_token });
  assert.equal(relevo.status, 403, "ni decidir por dónde pasa la voz de la instancia");
});


test("el desafio firma nonce, origen, linaje y epoca con la identidad publicada", async () => {
  const info = await call("GET", "/api/v1/info");
  const nonce = "nonce_de_prueba_abcdefghijklmnop";
  const challenge = await call("POST", "/api/v1/instance/challenge", { body: { nonce, origin: "https://atacante.example" } });
  assert.equal(challenge.status, 200);
  assert.equal(challenge.json.payload.nonce, nonce);
  assert.equal(challenge.json.payload.origin, base);
  assert.equal(challenge.json.payload.lineage_id, info.json.lineage_id);
  assert.equal(challenge.json.payload.epoch, info.json.epoch);
  assert.equal(challenge.json.fingerprint, info.json.identity.fingerprint);
  const { verifyInstanceProof } = await import("./identity.ts");
  assert.equal(verifyInstanceProof(challenge.json), true);
  challenge.json.payload.origin = "https://suplantacion.example";
  assert.equal(verifyInstanceProof(challenge.json), false, "alterar un campo invalida la firma");
});
test("la instancia publica su id y solo fija una dirección que vuelve al mismo servidor", async () => {
  const login = await call("POST", "/api/v1/auth/login", {
    body: { username: "ana", password: "contrasena-larga-1" },
  });
  const info = await call("GET", "/api/v1/info");
  assert.equal(typeof info.json.instance_id, "string");

  const { setTunnelAutostart } = await import("./tunnel.ts");
  setTunnelAutostart(false);
  const fixed = await call("PUT", "/api/v1/instance/public-url", {
    token: login.json.access_token,
    body: { url: base },
  });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.json.ok, true);
  assert.equal(fixed.json.public_url, base);

  const invalid = await call("PUT", "/api/v1/instance/public-url", {
    token: login.json.access_token,
    body: { url: "ftp://no-es-publicable.example" },
  });
  assert.equal(invalid.json.ok, false);

  const cleared = await call("PUT", "/api/v1/instance/public-url", {
    token: login.json.access_token,
    body: { url: "" },
  });
  assert.equal(cleared.json.ok, true);
  assert.equal(cleared.json.public_url, "");
  setTunnelAutostart(true);
});

test("el relevo de voz se configura desde la aplicación y no acepta un valor que no relevaría", async () => {
  const { setRelay, relayState, iceServers } = await import("./ice.ts");
  const urls = async () =>
    (await iceServers()).flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls])) as string[];

  // De fábrica, solo conexión directa: no hay ningún TURN público sin cuenta que
  // funcione, y dejar uno muerto apuntado falla igual pero parece configurado.
  assert.equal(relayState().mode, "direct");
  assert.ok(!(await urls()).some((u) => u.startsWith("turn:")), "nada sale de los aparatos si nadie lo pidió");
  assert.ok((await urls()).some((u) => u.startsWith("stun:")), "pero la dirección pública sí se descubre");

  await assert.rejects(
    () => setRelay({ mode: "custom", url: "stun:no-vale.example:3478" }),
    "un STUN donde hace falta un TURN no cuela",
  );
  await assert.rejects(() => setRelay({ mode: "cloudflare" }), "ni Cloudflare sin credenciales");
  await assert.rejects(() => setRelay({ mode: "metered" }), "ni Metered sin credenciales");
  assert.equal(relayState().mode, "direct", "y nada de eso llegó a guardarse");

  await setRelay({ mode: "custom", url: "turn:mio.example:3478", username: "yo", credential: "clave" });
  assert.ok((await urls()).includes("turn:mio.example:3478"), "el TURN propio sí entra");
  assert.equal(relayState().username, "yo", "la interfaz recupera el usuario");
  assert.ok(!("credential" in relayState()), "pero la contraseña no se devuelve jamás");
  assert.ok(!("apiToken" in relayState()), "ni el token de Cloudflare");
  assert.ok(!("apiKey" in relayState()), "ni la clave de Metered");

  await setRelay({ mode: "direct" });
});

test("publicar la instancia deja de tratar a nadie como local", async () => {
  /* El agujero: cloudflared se conecta desde 127.0.0.1, así que TODA petición que
     llega por el túnel parece venir del propio equipo. Con eso, /auth/recover
     entregaba una sesión de quien hospeda —sin contraseña ni código— a cualquiera
     que tuviera la URL, y /info le regalaba antes la lista de nombres. */
  const { startTunnel, stopTunnel } = await import("./tunnel.ts");

  const antes = await call("GET", "/api/v1/info");
  assert.equal(antes.json.setup_requires_code, false, "sin publicar, desde el propio equipo no se pide código");
  assert.ok(Array.isArray(antes.json.recoverable), "y se ven las cuentas recuperables");

  // Se finge una dirección pública sin levantar cloudflared: es el mismo estado.
  const { config } = await import("./config.ts");
  const original = config.publicUrl;
  (config as { publicUrl: string }).publicUrl = "https://ejemplo.trycloudflare.com";
  try {
    const durante = await call("GET", "/api/v1/info");
    assert.equal(durante.json.setup_requires_code, true, "publicada, la reclamación sí pide código");
    assert.deepEqual(durante.json.recoverable, [], "y no se filtra ningún nombre de cuenta");

    const robo = await call("POST", "/api/v1/auth/recover", { body: { username: "ada" } });
    assert.ok(!robo.json.access_token, "ni se entrega una sesión sin el código de la instancia");
    assert.ok(robo.status >= 400, `debería rechazarse, devolvió ${robo.status}`);

    const conCodigo = await call("POST", "/api/v1/auth/recover", {
      body: { username: "ada", setup_code: "no-es-el-codigo" },
    });
    assert.equal(conCodigo.status, 403, "y un código inventado tampoco vale");
  } finally {
    (config as { publicUrl: string }).publicUrl = original;
    stopTunnel();
    void startTunnel;
  }
});

test("los clientes empaquetados pasan el CORS y un origen ajeno no", async () => {
  // La app de escritorio y la de Android no las sirve la instancia: llegan con
  // su propio origen fijo y toda instancia debe aceptarlas sin configurar nada.
  for (const origin of ["app://distop", "capacitor://localhost", "https://localhost"]) {
    const res = await fetch(`${base}/api/v1/info`, { headers: { origin } });
    assert.equal(res.headers.get("access-control-allow-origin"), origin, `${origin} debe estar admitido`);
  }

  const ajeno = await fetch(`${base}/api/v1/info`, { headers: { origin: "https://ajeno.example" } });
  assert.equal(ajeno.headers.get("access-control-allow-origin"), null, "una web cualquiera no lee la API desde el navegador");

  // El preflight tiene que admitir TODOS los verbos de la API. PUT faltó una
  // vez y solo se notó cross-origin: same-origin no hace preflight.
  const preflight = await fetch(`${base}/api/v1/users/me/game-presence`, {
    method: "OPTIONS",
    headers: { origin: "app://distop", "access-control-request-method": "PUT" },
  });
  for (const verbo of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
    assert.ok(preflight.headers.get("access-control-allow-methods")?.includes(verbo), `falta ${verbo} en el preflight`);
  }
});


test("la autoridad explicita no vuelve por accidente a la cuenta mas antigua", async () => {
  const { createUser, hostUserId, isInstanceOwner, setHostUser } = await import("./auth.ts");
  const { db } = await import("./db.ts");
  const original = hostUserId();
  assert.ok(original);
  const successor = createUser({ username: "successor-test", displayName: "Successor", password: "clave-larga-successor" });
  setHostUser(successor.id, "transfer-test", original);
  assert.equal(hostUserId(), successor.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(successor.id);
  assert.equal(hostUserId(), null, "ON DELETE deja autoridad vacia");
  assert.equal(isInstanceOwner(original!), false, "no reaparece el usuario antiguo por fallback");
  setHostUser(original!, "recovery-test", null);
});

test("la autoridad se transfiere por la API solo a una cuenta recuperable", async () => {
  const { createSession, createUser, hostUserId, setHostUser } = await import("./auth.ts");
  const original = hostUserId();
  assert.ok(original);
  const session = createSession(original!);
  const withoutPassword = createUser({ username: "transfer-no-password", displayName: "Sin clave" });
  const rejected = await call("POST", "/api/v1/instance/host/transfer", {
    token: session.accessToken,
    body: { user_id: withoutPassword.id },
  });
  assert.equal(rejected.status, 400);
  assert.equal(hostUserId(), original);

  const successor = createUser({
    username: "transfer-with-password",
    displayName: "Con clave",
    password: "clave-larga-para-transferir",
  });
  const transferred = await call("POST", "/api/v1/instance/host/transfer", {
    token: session.accessToken,
    body: { user_id: successor.id },
  });
  assert.equal(transferred.status, 200);
  assert.equal(transferred.json.host_user_id, successor.id);
  assert.equal(hostUserId(), successor.id);

  const repeated = await call("POST", "/api/v1/instance/host/transfer", {
    token: session.accessToken,
    body: { user_id: original },
  });
  assert.equal(repeated.status, 403, "la cuenta anterior pierde la autoridad en el acto");
  setHostUser(original!, "test-recovery", successor.id);
});

test("una instancia sin dueño se recupera desde el equipo, y solo una vez", async () => {
  const { createSession, createUser, hostUserId, setHostUser } = await import("./auth.ts");
  const original = hostUserId();
  assert.ok(original);

  /* El anfitrión borró su cuenta: ON DELETE deja la fila con user_id vacío, y
     eso dejaba /instance/relay, /purge y /shutdown cerrados a todo el mundo
     para siempre, sin ninguna forma de volver atrás. */
  setHostUser(null, "test-vaciado", null);
  assert.equal(hostUserId(), null);

  const guest = await call("POST", "/api/v1/auth/guest", { body: { display_name: "De paso" } });
  assert.equal(guest.status, 200);
  const ajeno = await call("POST", "/api/v1/instance/host/claim", { token: guest.json.access_token });
  assert.equal(ajeno.status, 403, "una cuenta de invitado no se queda con el ordenador");
  assert.equal(hostUserId(), null);

  const vecino = createUser({ username: "claim-test", displayName: "Vecino" });
  const sesion = createSession(vecino.id);
  const reclamo = await call("POST", "/api/v1/instance/host/claim", { token: sesion.accessToken });
  assert.equal(reclamo.status, 200);
  assert.equal(reclamo.json.host_user_id, vecino.id);
  assert.equal(hostUserId(), vecino.id, "sin contraseña: estar delante del equipo es el listón con el que se arrancó");

  const repetido = await call("POST", "/api/v1/instance/host/claim", { token: sesion.accessToken });
  assert.equal(repetido.status, 409, "con dueño puesto, la reclamación deja de estar abierta");

  setHostUser(original!, "recovery-test", null);
});
test("uuidv7 ordena por tiempo de creación", () => {
  const ids = Array.from({ length: 50 }, uuidv7);
  assert.deepEqual([...ids].sort(), ids, "el orden lexicográfico coincide con el de creación");
});
test("el backfill avanza aunque el primer archivo haya desaparecido", async () => {
  const { db } = await import("./db.ts");
  const { backfillAttachmentHashes } = await import("./storage.ts");
  const uploads = join(workdir, "uploads");
  mkdirSync(uploads, { recursive: true });
  writeFileSync(join(uploads, "segundo.bin"), "contenido-verificable");

  const missingId = uuidv7();
  const validId = uuidv7();
  const insert = db.prepare(
    "INSERT INTO attachments (id, message_id, owner_id, filename, content_type, size, path, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)",
  );
  const now = Date.now();
  insert.run(missingId, missingId, "missing.bin", "application/octet-stream", 1, "missing.bin", now);
  insert.run(validId, validId, "segundo.bin", "application/octet-stream", 21, "segundo.bin", now + 1);

  // El que falta no se salta en silencio: se cuenta y se nombra con un código.
  assert.deepEqual(await backfillAttachmentHashes(1), {
    scanned: 1,
    updated: 0,
    failed: 1,
    done: false,
    last_error: "MISSING_FILE",
  });
  // Y el siguiente se completa igual: uno roto no bloquea a los que vienen detrás.
  assert.deepEqual(await backfillAttachmentHashes(1), {
    scanned: 1,
    updated: 1,
    failed: 0,
    done: false,
    last_error: "",
  });
  assert.deepEqual(await backfillAttachmentHashes(1), {
    scanned: 0,
    updated: 0,
    failed: 0,
    done: true,
    last_error: "",
  });
  const row = db.prepare("SELECT content_hash FROM attachments WHERE id = ?").get(validId) as { content_hash: string };
  assert.match(row.content_hash, /^sha256:[0-9a-f]{64}$/);
});
