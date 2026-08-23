/** Identidad de la app entre instancias: cuenta normal, nunca invitado. */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-portable-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "portable-test-secret";

const { server } = await import("./server.ts");
let base = "";

before(async () => {
  if (!server.listening) await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const identity = "device_identity_1234567890";
const secret = "portable_secret_abcdefghijklmnopqrstuvwxyz_123456";

test("una invitación registra la identidad portable como cuenta y la abre sin repetir el enlace", async () => {
  const owner = await call("POST", "/api/v1/auth/register", {
    body: { username: "anfitrion", password: "contrasena-larga-portable" },
  });
  const community = await call("POST", "/api/v1/communities", {
    token: owner.json.access_token,
    body: { name: "Casa de Leo" },
  });
  const invite = await call("POST", `/api/v1/communities/${community.json.id}/invites`, {
    token: owner.json.access_token,
    body: {},
  });

  const first = await call("POST", "/api/v1/auth/portable", {
    body: {
      identity_id: identity,
      secret,
      invite_code: invite.json.code,
      username: "leo",
      display_name: "Leo",
      bio: "El mismo perfil",
    },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.user.kind, "local", "una identidad portable no se presenta como invitado");
  assert.equal(first.json.user.display_name, "Leo");

  const joined = await call("POST", `/api/v1/invites/${invite.json.code}/join`, {
    token: first.json.access_token,
  });
  assert.equal(joined.status, 200);

  const again = await call("POST", "/api/v1/auth/portable", {
    body: { identity_id: identity, secret, username: "leo", display_name: "Leo" },
  });
  assert.equal(again.status, 200, "después entra sin otra invitación");
  assert.equal(again.json.user.id, first.json.user.id);

  const list = await call("GET", "/api/v1/communities", { token: again.json.access_token });
  assert.deepEqual(list.json.map((item: { id: string }) => item.id), [community.json.id]);

  const { db } = await import("./db.ts");
  const row = db.prepare("SELECT kind FROM users WHERE id = ?").get(first.json.user.id) as { kind: string };
  assert.equal(row.kind, "portable");
});

test("el id público sin el secreto no permite suplantar ni crear otra cuenta", async () => {
  const wrong = await call("POST", "/api/v1/auth/portable", {
    body: {
      identity_id: identity,
      secret: "wrong_secret_abcdefghijklmnopqrstuvwxyz_123456789",
      invite_code: "cualquier-codigo",
      display_name: "Impostor",
    },
  });
  assert.equal(wrong.status, 401);
});

test("una cuenta existente puede vincularse y recuperarse con la identidad del dispositivo", async () => {
  const account = await call("POST", "/api/v1/auth/register", {
    body: { username: "mara", password: "contrasena-larga-mara" },
  });
  const secondId = "device_identity_second_1234567890";
  const secondSecret = "second_portable_secret_abcdefghijklmnopqrstuvwxyz";
  const linked = await call("PUT", "/api/v1/users/me/portable", {
    token: account.json.access_token,
    body: { identity_id: secondId, secret: secondSecret },
  });
  assert.equal(linked.status, 200);

  const resumed = await call("POST", "/api/v1/auth/portable", {
    body: { identity_id: secondId, secret: secondSecret, display_name: "Mara" },
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.user.id, account.json.user.id);
});
