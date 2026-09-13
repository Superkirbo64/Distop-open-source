/**
 * Qué cuenta como «estar sentado delante del ordenador» (§22, §26).
 *
 * Es la comprobación que decide si se puede reclamar una instancia o volver a
 * entrar sin contraseña, así que equivocarse aquí regala el servidor de alguien.
 * Antes bastaba con que hubiera un túnel abierto para que nadie fuese local, y
 * eso dejaba a quien hospeda fuera de su propia casa. Ahora se distingue por las
 * marcas que el borde de Cloudflare pone en lo que reenvía, y esta suite existe
 * para que esa distinción no se rompa en silencio.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-local-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.SETUP_CODE = "CODIGO-DE-PRUEBA";

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

/** `headers` simula de dónde llega la petición, igual que haría el agente del túnel. */
async function info(headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/v1/info`, { headers });
  return (await res.json()) as { setup_requires_code: boolean; recoverable: unknown[]; local_accounts: unknown[] };
}

test("desde el propio equipo no se pide código", async () => {
  const { setup_requires_code } = await info();
  assert.equal(setup_requires_code, false);
});

test("lo que llega reenviado por el túnel NO es local", async () => {
  // Cloudflare pone estas marcas y quien viene de internet no puede quitarlas.
  for (const marca of ["cf-ray", "cf-connecting-ip", "cf-visitor", "x-forwarded-for"]) {
    const { setup_requires_code } = await info({ [marca]: "prueba" });
    assert.equal(setup_requires_code, true, `con ${marca} la petición viene de fuera`);
  }
});

test("una cuenta sin contraseña no se ofrece a quien llega por el túnel", async () => {
  const claim = await fetch(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Kirbo" }),
  });
  assert.equal(claim.status, 200);

  const dentro = await info();
  assert.equal(dentro.recoverable.length, 1, "delante del ordenador sí se ofrece");
  assert.equal(dentro.local_accounts.length, 1, "el selector enseña los perfiles del propio equipo");

  const fuera = await info({ "cf-ray": "prueba" });
  assert.equal(fuera.recoverable.length, 0, "por el túnel no se enseña a nadie a quien suplantar");
  assert.equal(fuera.local_accounts.length, 0, "por el túnel tampoco se filtran los perfiles locales");
});

test("el selector distingue perfiles creados aquí de miembros registrados por el túnel", async () => {
  const remoto = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "prueba" },
    body: JSON.stringify({ username: "miembro-remoto", display_name: "Kirbo", password: "clave-remota-larga" }),
  });
  assert.equal(remoto.status, 200);

  const local = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "perfil-local", display_name: "Meda", password: "clave-local-muy-larga" }),
  });
  assert.equal(local.status, 200);
  const sesion = (await local.json()) as { access_token: string };

  const avatar = await fetch(`${base}/api/v1/users/me`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${sesion.access_token}` },
    body: JSON.stringify({ avatar_url: "https://rastreador.example/avatar.png" }),
  });
  assert.equal(avatar.status, 200);

  const perfiles = (await info()).local_accounts as Array<{ username: string; avatar_url: string | null }>;
  assert.ok(perfiles.some((perfil) => perfil.username === "kirbo"), "se conserva la cuenta anfitriona");
  assert.ok(perfiles.some((perfil) => perfil.username === "perfil-local"), "un registro local sí crea perfil");
  assert.ok(!perfiles.some((perfil) => perfil.username === "miembro-remoto"), "un miembro remoto no aparece");
  assert.equal(
    perfiles.find((perfil) => perfil.username === "perfil-local")?.avatar_url,
    null,
    "el login no carga avatares externos",
  );

  const entradaLocal = await fetch(`${base}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "miembro-remoto", password: "clave-remota-larga" }),
  });
  assert.equal(entradaLocal.status, 200);
  const despues = (await info()).local_accounts as Array<{ username: string }>;
  assert.ok(
    despues.some((perfil) => perfil.username === "miembro-remoto"),
    "una entrada presencial válida convierte esa cuenta existente en perfil del equipo",
  );
});

test("recuperar por el túnel exige el código, y uno falso no vale", async () => {
  const sinCodigo = await fetch(`${base}/api/v1/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "prueba" },
    body: JSON.stringify({ username: "kirbo" }),
  });
  assert.notEqual(sinCodigo.status, 200, "sin código, desde fuera no se entra");

  const codigoMalo = await fetch(`${base}/api/v1/auth/recover`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-ray": "prueba" },
    body: JSON.stringify({ username: "kirbo", setup_code: "NO-ES-EL-CODIGO" }),
  });
  assert.notEqual(codigoMalo.status, 200, "un código inventado tampoco");
});
