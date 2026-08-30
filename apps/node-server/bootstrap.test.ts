/**
 * Self-check de la puesta en marcha (§34, §37).
 * Quien hospeda no debe encontrarse un formulario de acceso en su propia
 * instancia — y a la vez, nadie de fuera debe poder quedársela.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-boot-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.SETUP_CODE = "CODIGO-DE-PRUEBA";

/* Copias programadas encendidas a propósito: es la situación de la nube, la
   única en la que reclamar la instancia enseña la frase de las copias. La
   primera copia real espera diez minutos y su timer va unref'd, así que aquí
   no llega a correr ninguna. */
const passphraseFile = join(workdir, "backup-passphrase");
writeFileSync(passphraseFile, "frase-de-prueba-larga\n");
process.env.BACKUP_INTERVAL_HOURS = "24";
process.env.BACKUP_PASSPHRASE_FILE = passphraseFile;

const { server } = await import("./server.ts");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

test("una instancia nueva se anuncia como pendiente de reclamar", async () => {
  const { json } = await call("GET", "/api/v1/info");
  assert.equal(json.setup_required, true);
  // La suite habla por 127.0.0.1, o sea desde el propio equipo: sin código.
  assert.equal(json.setup_requires_code, false);
});

test("un invitado que pasa por delante no te deja fuera de tu propia instancia", async () => {
  const visita = await call("POST", "/api/v1/auth/guest", { body: { display_name: "curioso" } });
  assert.equal(visita.status, 200);

  const { json } = await call("GET", "/api/v1/info");
  assert.equal(json.setup_required, true, "un invitado no es dueño: la instancia sigue sin reclamar");
});

test("quien hospeda entra sin cuenta ni contraseña, y su comunidad es suya", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Meda Goga" } });
  assert.equal(claim.status, 200, "reclamar desde el propio equipo no pide nada más");

  const token = claim.json.access_token as string;
  assert.equal(claim.json.user.kind, "local", "no es una sesión de invitado: es la dueña");
  assert.equal(claim.json.user.username, "meda-goga", "el usuario sale del nombre visible");
  assert.equal(
    claim.json.backup_passphrase,
    "frase-de-prueba-larga",
    "la frase de las copias se enseña al reclamar: en la nube el fichero solo se lee por SSH",
  );

  const community = await call("POST", "/api/v1/communities", { token, body: { name: "Mi Casa" } });
  assert.equal(community.status, 200, "sin contraseña también se pueden crear comunidades");

  const boot = await call("GET", `/api/v1/communities/${community.json.id}/bootstrap`, { token });
  const { PERMISSIONS, has, toBits } = await import("@distop/protocol");
  assert.ok(has(toBits(boot.json.permissions), PERMISSIONS.ADMINISTRATOR), "manda en su propia instancia");
});

test("sin cuenta se puede lo mismo que con cuenta", async () => {
  const invitado = await call("POST", "/api/v1/auth/guest", { body: { display_name: "kirbo" } });
  const token = invitado.json.access_token as string;
  assert.equal(invitado.json.user.kind, "guest");

  const comunidad = await call("POST", "/api/v1/communities", { token, body: { name: "La de Kirbo" } });
  assert.equal(comunidad.status, 200, "un invitado crea su comunidad igual que cualquiera");

  const boot = await call("GET", `/api/v1/communities/${comunidad.json.id}/bootstrap`, { token });
  const { PERMISSIONS, has, toBits } = await import("@distop/protocol");
  assert.ok(has(toBits(boot.json.permissions), PERMISSIONS.ADMINISTRATOR), "y la administra");

  // Ponerle contraseña no cambia nada de lo anterior: solo permite volver.
  const cuenta = await call("POST", "/api/v1/users/me/upgrade", {
    token,
    body: { username: "kirbo", password: "contrasena-larga-9" },
  });
  assert.equal(cuenta.status, 200);
  assert.equal(cuenta.json.kind, "local");
});

test("quien hospeda sin contraseña puede volver a entrar desde su equipo", async () => {
  const { json } = await call("GET", "/api/v1/info");
  const nombres = (json.recoverable as Array<{ username: string }>).map((a) => a.username);
  assert.ok(nombres.includes("meda-goga"), "sin contraseña y con comunidad propia: recuperable");
  assert.ok(!nombres.includes("kirbo"), "con contraseña ya no aparece: para eso está el login");

  const vuelta = await call("POST", "/api/v1/auth/recover", { body: { username: "meda-goga" } });
  assert.equal(vuelta.status, 200);
  assert.equal(
    vuelta.json.backup_passphrase,
    undefined,
    "volver a entrar no la reenseña: si saliera en cada sesión, robar una sesión sería robar el descifrado de todas las copias",
  );
  const suyas = await call("GET", "/api/v1/communities", { token: vuelta.json.access_token });
  assert.equal(suyas.json[0].name, "Mi Casa", "vuelve a su comunidad, no a una vacía");

  const conPass = await call("POST", "/api/v1/auth/recover", { body: { username: "kirbo" } });
  assert.equal(conPass.status, 401, "una cuenta con contraseña no se abre por esta puerta");
});

test("la ventana se cierra sola: la instancia solo se reclama una vez", async () => {
  const again = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "El Segundo" } });
  assert.equal(again.status, 409);

  const { json } = await call("GET", "/api/v1/info");
  assert.equal(json.setup_required, false);
});

test("la contraseña se pone después, sin perder la identidad ni la comunidad", async () => {
  // Se entra con la sesión que ya existe, no con contraseña: todavía no hay.
  const login = await call("POST", "/api/v1/auth/login", {
    body: { username: "meda-goga", password: "loquesea-larga" },
  });
  assert.equal(login.status, 401, "sin contraseña puesta, nadie entra con contraseña");

  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "x" } });
  assert.equal(claim.status, 409, "y la vía de reclamación sigue cerrada");
});
