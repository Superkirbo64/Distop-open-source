/**
 * Galerías sin clave propia: la instancia pregunta al directorio del proyecto.
 *
 * El directorio es un servidor HTTP falso en este mismo proceso; lo que se
 * prueba es que ninguna clave hace falta en la instancia y que lo que llega
 * del directorio pasa filtrado (solo HTTPS) al cliente.
 *
 *   node --test "expressions-proxy.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pedidas: string[] = [];
let apagado = false;
const directorio = createServer((req, res) => {
  pedidas.push(req.url ?? "");
  res.setHeader("content-type", "application/json");
  if (apagado) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: "EXPRESSIONS_DISABLED" }));
    return;
  }
  res.writeHead(200);
  res.end(JSON.stringify({
    results: [
      { id: "g1", url: "https://static.klipy.com/a.webp", preview: "https://static.klipy.com/a-xs.webp", title: "Gato", width: 200, height: 180 },
      { id: "malo", url: "http://inseguro.example/a.gif", preview: "http://inseguro.example/b.gif", title: "", width: 0, height: 0 },
      { id: "tipos", url: "https://static.klipy.com/t.webp", preview: "https://static.klipy.com/t-xs.webp", title: { no: "texto" }, width: "enorme", height: -4 },
    ],
  }));
});
await new Promise<void>((resolve) => directorio.listen(0, "127.0.0.1", () => resolve()));
const puertoDirectorio = (directorio.address() as { port: number }).port;

const raiz = mkdtempSync(join(tmpdir(), "distop-galerias-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
process.env.AUTH_SECRET = "test-secret-galerias";
process.env.DIRECTORY_URL = `http://127.0.0.1:${puertoDirectorio}`;
delete process.env.GIPHY_API_KEY;
delete process.env.KLIPY_API_KEY;

const { server, shutdown } = await import("./server.ts");
let base = "";
let token = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const registro = await fetch(`${base}/api/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "galerias", password: "contrasena-larga-galerias", locale: "pt-BR" }),
  }).then((r) => r.json() as Promise<{ access_token: string }>);
  token = registro.access_token;
});

after(async () => {
  await shutdown("prueba-galerias");
  directorio.close();
  rmSync(raiz, { recursive: true, force: true });
});

const pedir = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

test("sin claves propias la instancia ofrece GIF y stickers porque hay directorio", async () => {
  const info = await fetch(`${base}/api/v1/info`).then((r) => r.json() as Promise<Record<string, unknown>>);
  assert.equal(info.gif_enabled, true);
  assert.equal(info.sticker_gallery_enabled, true);
});

test("los GIF y los stickers se piden al directorio y solo pasa lo que es HTTPS", async () => {
  const gifs = await pedir("/api/v1/gifs?q=gato&limit=10");
  assert.equal(gifs.status, 200);
  const lista = await gifs.json() as Array<{ id: string; title: string; width: number; height: number }>;
  assert.deepEqual(lista.map((g) => g.id), ["g1", "tipos"], "lo que no es HTTPS no llega al cliente");
  assert.deepEqual(lista[1], { id: "tipos", url: "https://static.klipy.com/t.webp", preview: "https://static.klipy.com/t-xs.webp", title: "", width: 0, height: 0 }, "los demás campos se normalizan y no atraviesan tipos arbitrarios");
  const pedidaGifs = new URL(pedidas.at(-1)!, "http://x");
  assert.equal(pedidaGifs.pathname, "/v1/expressions");
  assert.equal(pedidaGifs.searchParams.get("kind"), "gifs");
  assert.equal(pedidaGifs.searchParams.get("q"), "gato");
  assert.equal(pedidaGifs.searchParams.get("limit"), "10");

  const stickers = await pedir("/api/v1/stickers/gallery");
  assert.equal(stickers.status, 200);
  const pedidaStickers = new URL(pedidas.at(-1)!, "http://x");
  assert.equal(pedidaStickers.searchParams.get("kind"), "stickers");
  assert.equal(pedidaStickers.searchParams.has("q"), false, "sin texto se pide la portada");
});

test("si el directorio aún no tiene claves, la instancia lo dice con un 404, no con un fallo", async () => {
  apagado = true;
  const gifs = await pedir("/api/v1/gifs?q=hola");
  assert.equal(gifs.status, 404);
  apagado = false;
});
