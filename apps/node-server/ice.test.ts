/**
 * TURN con credenciales efímeras (use-auth-secret): el acuñado, sus ramas y
 * que el secreto no se asome jamás por la API.
 *   node --test ice.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-ice-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
delete process.env.ICE_SERVERS;
delete process.env.TURN_URL;
delete process.env.TURN_SECRET;

const { server } = await import("./server.ts");
const { iceServers, relayState, setRelay, turnRestCredentials, videoMode, voiceMode } = await import("./ice.ts");

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
});

after(async () => {
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("el acuñado sigue el convenio REST de coturn, byte a byte", () => {
  /* Vector fijado a mano. Si esta aserción se rompe, no es "un refactor": es
     que el algoritmo dejó de ser el que coturn verifica (base64 → hex, SHA-1 →
     SHA-256, orden del usuario...) y ninguna llamada volvería a relevar. */
  const creds = turnRestCredentials("north", { nowMs: 1_600_000_000_000 - 86_400_000, ttlS: 86_400 });
  assert.equal(creds.username, "1600000000:distop");
  assert.equal(creds.credential, "WTCdxvRG3cYLCdxA25er4xEg3ZE=");
});

test("el usuario lleva la caducidad delante y dura un día completo", () => {
  const antes = Math.floor(Date.now() / 1000);
  const { username } = turnRestCredentials("un-secreto-cualquiera-largo");
  assert.match(username, /^\d{10}:distop$/);
  const caducidad = Number.parseInt(username.split(":")[0]!, 10);
  assert.ok(caducidad >= antes + 86_400 - 5, "caduca en ~24 h, no antes");
  assert.ok(caducidad <= Math.floor(Date.now() / 1000) + 86_400 + 5, "y no después");
});

test("una instancia nueva usa voz, cámara y pantalla P2P por defecto", () => {
  assert.equal(voiceMode().mode, "direct");
  assert.equal(videoMode().mode, "direct");
});

test("custom con secreto reparte credenciales efímeras y nunca el secreto", async () => {
  await setRelay({ mode: "custom", url: "turn:turn.example.org:3478", secret: "secreto-de-prueba-largo" });

  const servers = await iceServers();
  const turn = servers.find((s) => String(s.urls).startsWith("turn:"));
  assert.ok(turn, "hay una entrada TURN");
  assert.match(turn.username ?? "", /^\d{10}:distop$/);
  assert.ok((turn.credential ?? "").length > 0, "con contraseña derivada");

  /* Dos visitas seguidas: cada una recibe un día entero por delante. */
  const otra = await iceServers();
  const expiry = (s: typeof turn) => Number.parseInt((s?.username ?? "0:").split(":")[0]!, 10);
  const suelo = Math.floor(Date.now() / 1000) + 86_400 - 5;
  assert.ok(expiry(turn) >= suelo && expiry(otra.find((s) => String(s.urls).startsWith("turn:"))!) >= suelo);

  const estado = relayState();
  assert.ok(!("secret" in estado), "el estado del panel no lleva el secreto");
  assert.equal(estado.ephemeral, true, "pero sí dice que las credenciales rotan solas");
});

test("un secreto corto se rechaza antes de guardarse", async () => {
  await assert.rejects(
    setRelay({ mode: "custom", url: "turn:turn.example.org:3478", secret: "corto" }),
    /16 caracteres/,
  );
});

test("custom sin secreto ni credenciales se queda en STUN, no en un TURN de mentira", async () => {
  await setRelay({ mode: "custom", url: "turn:turn.example.org:3478", secret: "", username: "", credential: "" });
  const servers = await iceServers();
  assert.ok(servers.every((s) => !String(s.urls).startsWith("turn")), "ninguna entrada TURN sin credenciales");
  assert.ok(servers.some((s) => String(s.urls).includes("stun:")), "STUN sigue ahí");
  assert.equal(relayState().ephemeral, false);
});

test("TURN_URL sin TURN_SECRET mata el arranque, no una llamada a medias", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const configUrl = pathToFileURL(join(import.meta.dirname, "config.ts")).href;

  assert.throws(() => {
    execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(configUrl)})`], {
      env: {
        ...process.env,
        DATABASE_PATH: join(workdir, "boot.db"),
        TURN_URL: "turn:solo.example.org:3478",
        TURN_SECRET: "",
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  }, /TURN_SECRET/);
});
