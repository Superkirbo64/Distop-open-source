import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERMISSIONS } from "@distop/protocol";

const workdir = mkdtempSync(join(tmpdir(), "distop-create-permission-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-create-permission";

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

async function call(method: string, path: string, token?: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

test("solo quien hospeda puede crear comunidades y la capacidad lo anuncia", async () => {
  const owner = await call("POST", "/api/v1/auth/register", undefined, {
    username: "host-owner", password: "contrasena-larga-owner",
  });
  const normal = await call("POST", "/api/v1/auth/register", undefined, {
    username: "normal-user", password: "contrasena-larga-normal",
  });
  assert.equal(owner.json.user.can_create_communities, true);
  assert.equal(normal.json.user.can_create_communities, false);

  const community = await call("POST", "/api/v1/communities", owner.json.access_token, { name: "Del anfitrion" });
  assert.equal(community.status, 200);

  const beforeDenied = await call("GET", "/api/v1/communities", normal.json.access_token);
  const denied = await call("POST", "/api/v1/communities", normal.json.access_token, { name: "No permitida" });
  const afterDenied = await call("GET", "/api/v1/communities", normal.json.access_token);
  assert.equal(denied.status, 403);
  assert.equal(afterDenied.json.length, beforeDenied.json.length, "un rechazo no crea ninguna fila");

  const invite = await call("POST", `/api/v1/communities/${community.json.id}/invites`, owner.json.access_token, {});
  await call("POST", `/api/v1/invites/${invite.json.code}/join`, normal.json.access_token);
  const adminRole = await call("POST", `/api/v1/communities/${community.json.id}/roles`, owner.json.access_token, {
    name: "Admin auxiliar", permissions: PERMISSIONS.ADMINISTRATOR.toString(), position: 1,
  });
  const promoted = await call("PATCH", `/api/v1/communities/${community.json.id}/members/${normal.json.user.id}`, owner.json.access_token, {
    role_ids: [adminRole.json.id],
  });
  assert.equal(promoted.status, 200);
  assert.deepEqual(promoted.json.role_ids, [adminRole.json.id]);
  const adminDenied = await call("POST", "/api/v1/communities", normal.json.access_token, { name: "Tampoco permitida" });
  assert.equal(adminDenied.status, 403, "administrar una comunidad no da autoridad sobre la instancia");

  const meOwner = await call("GET", "/api/v1/users/me", owner.json.access_token);
  const meNormal = await call("GET", "/api/v1/users/me", normal.json.access_token);
  assert.equal(meOwner.json.can_create_communities, true);
  assert.equal(meNormal.json.can_create_communities, false);
});
