/**
 * Autenticador de quien hospeda, contra el servidor de verdad.
 *
 * La suite habla por 127.0.0.1, así que para ella todo es "desde el propio
 * equipo". Una petición con X-Forwarded-For cuenta como llegada de fuera
 * (http.ts:isLocalRequest), que es lo que ve una VPS detrás de su Funnel.
 *   node --test "mfa.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-mfa-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-mfa-no-usar";
process.env.SETUP_CODE = "CODIGO-MFA";
process.env.DIRECTORY_URL = "";
// El autenticador solo se ofrece en VPS.
process.env.DEPLOYMENT_PROFILE = "vps_cloud";

const { server } = await import("./server.ts");
const { deBase32, hotp, stepAt } = await import("./totp.ts");
const { createSshRecoveryCode } = await import("./mfa.ts");
const { resetRateLimits } = await import("./http.ts");

let base = "";
let hostId = "";
let hostToken = "";
let secret = "";
let recoveryCodes: string[] = [];
let refreshFromRemote = "";
const PASSWORD = "contrasena-larga-de-kirbo";

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

async function call(method: string, path: string, opts: { token?: string; body?: unknown; remote?: boolean } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.remote ? { "x-forwarded-for": "203.0.113.7" } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}

const codeAt = (step: number) => hotp(deBase32(secret), step);
const login = (remote: boolean) => call("POST", "/api/v1/auth/login", { remote, body: { username: "kirbo", password: PASSWORD } });

test("sin autenticador, quien hospeda entra desde fuera con su contraseña como siempre", async () => {
  resetRateLimits();
  const boot = await call("POST", "/api/v1/auth/bootstrap", {
    body: { display_name: "Kirbo", username: "kirbo", password: PASSWORD },
  });
  assert.equal(boot.status, 200, JSON.stringify(boot.json));
  hostId = boot.json.user.id;
  hostToken = boot.json.access_token;
  const claim = await call("POST", "/api/v1/instance/host/claim", { token: hostToken });
  assert.ok([200, 409].includes(claim.status), JSON.stringify(claim.json));

  const fuera = await login(true);
  assert.equal(fuera.status, 200);
  assert.ok(fuera.json.access_token);
  assert.equal(fuera.json.mfa_required, undefined);
  refreshFromRemote = fuera.json.access_token;
});

test("el QR solo cuenta confirmado con un código real, y cierra las demás sesiones", async () => {
  resetRateLimits();
  const setup = await call("POST", "/api/v1/instance/mfa/setup", { token: hostToken });
  assert.equal(setup.status, 200);
  secret = setup.json.secret;
  assert.match(setup.json.otpauth_uri, new RegExp(`secret=${secret}`));
  assert.equal((await call("GET", "/api/v1/instance/mfa", { token: hostToken })).json.enabled, false, "sin confirmar todavía no manda");

  const mal = await call("POST", "/api/v1/instance/mfa/confirm", { token: hostToken, body: { code: codeAt(stepAt(Date.now()) - 10) } });
  assert.equal(mal.status, 400);

  const bien = await call("POST", "/api/v1/instance/mfa/confirm", { token: hostToken, body: { code: codeAt(stepAt(Date.now())) } });
  assert.equal(bien.status, 200, JSON.stringify(bien.json));
  recoveryCodes = bien.json.recovery_codes;
  assert.equal(recoveryCodes.length, 8);

  const estado = await call("GET", "/api/v1/instance/mfa", { token: hostToken });
  assert.deepEqual(estado.json, { available: true, enabled: true, recovery_codes_left: 8 });
  const vieja = await call("GET", "/api/v1/instance/mfa", { token: refreshFromRemote });
  assert.equal(vieja.status, 401, "la sesión abierta desde fuera antes de activarlo se cierra");
});

test("desde fuera pide el código, desde el propio equipo no, y un código no vale dos veces", async () => {
  resetRateLimits();
  const local = await login(false);
  assert.ok(local.json.access_token, "sentado en el equipo no se pide");

  const paso1 = await login(true);
  assert.equal(paso1.status, 200);
  assert.equal(paso1.json.mfa_required, true);
  assert.equal(paso1.json.access_token, undefined, "sin código no hay sesión");

  const mal = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: paso1.json.mfa_token, code: codeAt(stepAt(Date.now()) - 10) } });
  assert.equal(mal.status, 401);

  const codigo = codeAt(stepAt(Date.now()) + 1);
  const bien = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: paso1.json.mfa_token, code: codigo } });
  assert.equal(bien.status, 200, JSON.stringify(bien.json));
  assert.ok(bien.json.access_token);
  refreshFromRemote = bien.json.refresh_token;

  const otraVez = await login(true);
  const repetido = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: otraVez.json.mfa_token, code: codigo } });
  assert.equal(repetido.status, 401, "el mismo código visto por encima del hombro ya no sirve");
});

test("renovar la sesión no vuelve a pedir el código: una vez por dispositivo", async () => {
  const renovada = await call("POST", "/api/v1/auth/refresh", { remote: true, body: { refresh_token: refreshFromRemote } });
  assert.equal(renovada.status, 200);
  assert.ok(renovada.json.access_token);
});

test("un código de respaldo sirve una sola vez", async () => {
  resetRateLimits();
  const uno = await login(true);
  const usado = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: uno.json.mfa_token, code: recoveryCodes[0] } });
  assert.equal(usado.status, 200);

  const dos = await login(true);
  const repetido = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: dos.json.mfa_token, code: recoveryCodes[0] } });
  assert.equal(repetido.status, 401);
  assert.equal((await call("GET", "/api/v1/instance/mfa", { token: hostToken })).json.recovery_codes_left, 7);
});

test("quien prueba códigos a ciegas choca con el límite", async () => {
  resetRateLimits();
  const reto = await login(true);
  for (let i = 0; i < 5; i++) {
    const intento = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: reto.json.mfa_token, code: "000000" } });
    assert.equal(intento.status, 401);
  }
  const sexto = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: reto.json.mfa_token, code: "000000" } });
  assert.equal(sexto.status, 429);
});

test("el código de SSH borra el autenticador, deja entrar y caduca con un uso", async () => {
  resetRateLimits();
  const ssh = createSshRecoveryCode(hostId);
  assert.ok(ssh);

  const reto = await login(true);
  const dentro = await call("POST", "/api/v1/auth/mfa", { body: { mfa_token: reto.json.mfa_token, code: ssh } });
  assert.equal(dentro.status, 200, JSON.stringify(dentro.json));
  assert.equal(dentro.json.mfa_reset, true);

  hostToken = dentro.json.access_token;
  assert.equal((await call("GET", "/api/v1/instance/mfa", { token: hostToken })).json.enabled, false);
  const sinCodigo = await login(true);
  assert.ok(sinCodigo.json.access_token, "sin autenticador vuelve a bastar la contraseña hasta configurar otro");
});
