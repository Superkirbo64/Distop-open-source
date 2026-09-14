/**
 * Apagar fotos, vídeos y archivos en una comunidad (punto 15 de la lista de Kirbo).
 *
 * Mismo trato que los audios: el interruptor vive en Gestionar, pero lo que
 * cuenta es que el servidor rechace el adjunto, porque esconder un botón no
 * impide subir el fichero y colgarlo del mensaje a mano.
 *
 *   node --test "media-toggles.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = mkdtempSync(join(tmpdir(), "distop-medios-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
process.env.ALLOWED_UPLOAD_TYPES = "image/png,video/mp4,application/pdf";
delete process.env.AUTH_SECRET;

const { server, shutdown } = await import("./server.ts");

let base = "";
let token = "";
let comunidad = "";
let canal = "";

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.raw ? {} : { "content-type": "application/json" }),
      authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    ...(opts.raw ? { body: opts.raw } : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  const claim = await fetch(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ display_name: "Anfitriona" }),
  }).then((r) => r.json() as Promise<{ access_token: string }>);
  token = claim.access_token;
  const community = await call("POST", "/api/v1/communities", { body: { name: "La VPS" } });
  comunidad = community.json.id as string;
  const boot = await call("GET", `/api/v1/communities/${comunidad}/bootstrap`);
  canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!.id;
});

after(async () => {
  await shutdown("prueba-medios");
  rmSync(raiz, { recursive: true, force: true });
});

const ARCHIVOS = {
  foto: { type: "image/png", name: "foto.png", data: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 0x5a)]) },
  video: { type: "video/mp4", name: "clip.mp4", data: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(256, 0x11)]) },
  pdf: { type: "application/pdf", name: "doc.pdf", data: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(256, 0x20)]) },
} as const;

async function adjuntar(tipo: keyof typeof ARCHIVOS): Promise<{ status: number; attachmentId: string }> {
  const archivo = ARCHIVOS[tipo];
  const subida = await call("POST", "/api/v1/uploads", {
    raw: archivo.data,
    headers: { "content-type": archivo.type, "x-filename": archivo.name },
  });
  assert.equal(subida.status, 200, JSON.stringify(subida.json));
  const enviado = await call("POST", `/api/v1/channels/${canal}/messages`, { body: { content: "", attachment_ids: [subida.json.id] } });
  return { status: enviado.status, attachmentId: subida.json.id as string };
}

test("de fábrica fotos, vídeos y archivos se guardan en el servidor", async () => {
  const boot = await call("GET", `/api/v1/communities/${comunidad}/bootstrap`);
  assert.equal(boot.json.community.media_images, "server");
  assert.equal(boot.json.community.media_videos, "server");
  assert.equal(boot.json.community.media_files, "server");
  for (const tipo of ["foto", "video", "pdf"] as const) assert.equal((await adjuntar(tipo)).status, 200, tipo);
});

test("cada tipo admite servidor, P2P o apagado y nunca acepta un adjunto de servidor en los otros modos", async () => {
  const apagado = await call("PATCH", `/api/v1/communities/${comunidad}`, { body: { media_videos: "off", media_files: "p2p" } });
  assert.equal(apagado.status, 200);
  assert.equal(apagado.json.media_videos, "off");
  assert.equal(apagado.json.media_files, "p2p");
  assert.equal(apagado.json.media_images, "server", "tocar dos no cambia el tercero");

  const video = await adjuntar("video");
  assert.equal(video.status, 400, "vídeo rechazado");
  assert.equal((await call("GET", `/api/v1/files/${video.attachmentId}`)).status, 404, "la subida rechazada no queda huérfana");
  assert.equal((await adjuntar("pdf")).status, 400, "archivo rechazado");
  assert.equal((await adjuntar("foto")).status, 200, "la foto sigue pasando");

  const manifiesto = await call("POST", `/api/v1/channels/${canal}/p2p-files`, { body: {
    filename: "manual.pdf",
    content_type: "application/pdf",
    size: 1234,
    content_hash: `sha256:${"a".repeat(64)}`,
  } });
  assert.equal(manifiesto.status, 200);
  assert.equal(manifiesto.json.delivery, "p2p");
  assert.equal(manifiesto.json.url, "", "la ficha no finge una descarga desde la VPS");
  const mensajeP2p = await call("POST", `/api/v1/channels/${canal}/messages`, { body: { content: "", attachment_ids: [manifiesto.json.id] } });
  assert.equal(mensajeP2p.status, 200, "la ficha P2P sí puede adjuntarse sin subir el cuerpo");
  assert.equal((await call("GET", `/api/v1/files/${manifiesto.json.id}`)).status, 409, "el servidor nunca sirve un cuerpo P2P inexistente");

  await call("PATCH", `/api/v1/communities/${comunidad}`, { body: { media_images: "off" } });
  assert.equal((await adjuntar("foto")).status, 400, "y ahora la foto tampoco");

  const texto = await call("POST", `/api/v1/channels/${canal}/messages`, { body: { content: "sin adjuntos siempre se puede" } });
  assert.equal(texto.status, 200);
});

test("un modo desconocido se rechaza en vez de quedar guardado como verdad implícita", async () => {
  const response = await call("PATCH", `/api/v1/communities/${comunidad}`, { body: { media_images: "barato" } });
  assert.equal(response.status, 400);
});

test("el cliente declara la comunidad antes de subir y el servidor corta antes de tocar disco", async () => {
  const file = ARCHIVOS.foto;
  const response = await call("POST", `/api/v1/uploads?community_id=${comunidad}`, {
    raw: file.data,
    headers: { "content-type": file.type, "x-filename": file.name },
  });
  assert.equal(response.status, 400);
});
