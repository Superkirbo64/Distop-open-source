/**
 * Importar un servidor de Discord por la API (docs/importacion-discord.md).
 *
 * Discord es un servidor HTTP falso local: DISCORD_API_BASE existe justo para
 * esto. Lo que se prueba es el contrato de las rutas — token en el cuerpo,
 * comunidad creada de verdad, informe honesto, duplicado rechazado — no el
 * detalle del mapeo, que vive en discord-import.ts.
 *
 *   node --test discord-import.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-discord-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const GUILD_ID = "123456789012345678";
const BOT_TOKEN = "token-de-bot-falso-suficientemente-largo";

/* El Discord de mentira: lo justo para que la previa y el import respondan. */
const fakeDiscord = createServer((req, res) => {
  const url = req.url ?? "";
  if (req.headers.authorization !== `Bot ${BOT_TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" }).end("{}");
    return;
  }
  const reply = (body: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (url.startsWith(`/guilds/${GUILD_ID}?`)) {
    reply({ id: GUILD_ID, name: "La Guarida", description: "un rincón", icon: null, approximate_member_count: 3 });
  } else if (url === `/guilds/${GUILD_ID}/channels`) {
    reply([
      { id: "1", type: 4, name: "General", position: 0 },
      { id: "2", type: 0, name: "charla", position: 1, parent_id: "1" },
      { id: "3", type: 2, name: "voz", position: 2, parent_id: "1" },
    ]);
  } else if (url === `/guilds/${GUILD_ID}/roles`) {
    reply([{ id: GUILD_ID, name: "@everyone", color: 0, position: 0, permissions: "1024", hoist: false, mentionable: false }]);
  } else if (url === `/guilds/${GUILD_ID}/emojis`) {
    reply([]);
  } else if (url.startsWith(`/guilds/${GUILD_ID}/members`)) {
    reply([{ user: { id: "42", username: "invitada", global_name: "Invitada" }, nick: null, roles: [], joined_at: null }]);
  } else if (url.startsWith("/channels/2/messages")) {
    reply([{ id: "900", channel_id: "2", author: { id: "42", username: "invitada" }, content: "hola desde discord", timestamp: "2026-08-01T12:00:00Z", attachments: [] }]);
  } else if (url.startsWith("/channels/3/messages")) {
    // El canal de voz también tiene chat en Discord; aquí, vacío.
    reply([]);
  } else {
    res.writeHead(404, { "content-type": "application/json" }).end("{}");
  }
});
await new Promise<void>((r) => fakeDiscord.listen(0, "127.0.0.1", r));
const discordPort = (fakeDiscord.address() as { port: number }).port;
process.env.DISCORD_API_BASE = `http://127.0.0.1:${discordPort}`;

const { server } = await import("./server.ts");

let base = "";
let token = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const res = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Kirbo" } });
  token = res.json.access_token;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  fakeDiscord.close();
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

test("sin sesión no hay ni vista previa: el token no se enseña a cualquiera", async () => {
  const res = await call("POST", "/api/v1/import/discord/preview", { body: { token: BOT_TOKEN, guild_id: GUILD_ID } });
  assert.equal(res.status, 401);
});

test("la vista previa cuenta lo que hay sin crear nada", async () => {
  const res = await call("POST", "/api/v1/import/discord/preview", {
    token,
    body: { token: BOT_TOKEN, guild_id: GUILD_ID },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.guild.name, "La Guarida");
  assert.equal(res.json.counts.channels, 2, "charla y voz; la categoría no es un canal");
  assert.equal(res.json.counts.categories, 1);

  const communities = await call("GET", "/api/v1/communities", { token });
  assert.equal(communities.json.length, 0, "mirar no importa: ninguna comunidad nueva");
});

test("un token que Discord rechaza vuelve como error tipado, nunca como 500", async () => {
  const res = await call("POST", "/api/v1/import/discord/preview", {
    token,
    body: { token: "token-invalido-pero-con-longitud-valida", guild_id: GUILD_ID },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, "DISCORD_BAD_TOKEN");
});

test("el import crea la comunidad con canales, historial y perfiles archivados", async () => {
  const res = await call("POST", "/api/v1/import/discord", {
    token,
    body: { token: BOT_TOKEN, guild_id: GUILD_ID, history_limit: 100, import_members: true },
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.channels, 2);
  assert.equal(res.json.categories, 1);
  assert.equal(res.json.messages, 1);
  assert.equal(res.json.imported_profiles, 1);

  const communities = await call("GET", "/api/v1/communities", { token });
  assert.equal(communities.json.length, 1);
  assert.equal(communities.json[0].name, "La Guarida");

  const boot = await call("GET", `/api/v1/communities/${res.json.community_id}/bootstrap`, { token });
  assert.equal(boot.status, 200, "quien importó entra a su comunidad sin más pasos");
  const texto = boot.json.channels.find((c: { kind: string }) => c.kind === "text");
  const mensajes = await call("GET", `/api/v1/channels/${texto.id}/messages`, { token });
  assert.equal(mensajes.json.messages?.length ?? mensajes.json.length, 1, "el historial importado se lee como cualquier otro");
});

test("el mismo servidor no se importa dos veces", async () => {
  const res = await call("POST", "/api/v1/import/discord", {
    token,
    body: { token: BOT_TOKEN, guild_id: GUILD_ID },
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, "DISCORD_ALREADY_IMPORTED");
});
