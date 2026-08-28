/**
 * NodeInfo 2.1: JSON de verdad para las máquinas, shell del SPA para las
 * personas, y ninguna de las dos cosas donde va la otra.
 *   node --test nodeinfo.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-nodeinfo-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.PUBLIC_DISCOVERY_ENABLED = "true";

/* Un cliente web de mentira: sin él no habría fallback SPA que esquivar, y la
   prueba clave es justamente que /.well-known/ NO recibe este HTML. */
const dist = join(workdir, "web-dist");
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "index.html"), "<!doctype html><title>shell</title>");
process.env.WEB_DIST_PATH = dist;

const { server } = await import("./server.ts");
const { config } = await import("./config.ts");

let base = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

after(async () => {
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("el descubrimiento apunta al documento y el documento dice quiénes somos", async () => {
  const puerta = await fetch(`${base}/.well-known/nodeinfo`);
  assert.equal(puerta.status, 200);
  assert.match(puerta.headers.get("content-type") ?? "", /application\/json/);
  const links = (await puerta.json()) as { links: Array<{ rel: string; href: string }> };
  assert.equal(links.links[0]?.rel, "http://nodeinfo.diaspora.software/ns/schema/2.1");
  assert.ok(links.links[0]?.href.endsWith("/nodeinfo/2.1"));
  assert.ok(links.links[0]?.href.startsWith(base), "la base sale del propio socket cuando no hay PUBLIC_URL");

  const doc = await fetch(`${base}/nodeinfo/2.1`);
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get("content-type") ?? "", /profile="http:\/\/nodeinfo\.diaspora\.software/);
  const body = (await doc.json()) as {
    software: { name: string; version: string };
    openRegistrations: boolean;
    usage: { users: Record<string, unknown> };
    metadata: { distop: { info: string; discovery: string } };
  };
  assert.equal(body.software.name, "distop");
  assert.equal(body.openRegistrations, true);
  assert.deepEqual(body.usage.users, {}, "sin conteos privados de miembros");
  assert.ok(body.metadata.distop.info.endsWith("/api/v1/info"));

  const info = await fetch(`${base}/api/v1/info`);
  const infoBody = (await info.json()) as { version: string; capabilities: string[] };
  assert.equal(body.software.version, infoBody.version, "una sola fuente de versión");
  assert.ok(infoBody.capabilities.includes("nodeinfo_v1"));
});

test("sin descubrimiento público, NodeInfo no existe", async () => {
  const cfg = config as { publicDiscoveryEnabled: boolean };
  cfg.publicDiscoveryEnabled = false;
  try {
    assert.equal((await fetch(`${base}/.well-known/nodeinfo`)).status, 404);
    assert.equal((await fetch(`${base}/nodeinfo/2.1`)).status, 404);
  } finally {
    cfg.publicDiscoveryEnabled = true;
  }
});

test("el shell del SPA sigue en su sitio y no invade lo de las máquinas", async () => {
  const spa = await fetch(`${base}/cualquier/ruta/del/cliente`);
  assert.equal(spa.status, 200);
  assert.match(spa.headers.get("content-type") ?? "", /text\/html/);

  /* Una ruta well-known que no existe es un 404 de verdad, no el shell. */
  const desconocida = await fetch(`${base}/.well-known/no-existe`);
  assert.equal(desconocida.status, 404);
  assert.match(desconocida.headers.get("content-type") ?? "", /application\/json/);
});
