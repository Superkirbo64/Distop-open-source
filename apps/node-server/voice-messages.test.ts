/**
 * Suspender los audios en una comunidad.
 *
 * El interruptor vive en Gestionar, pero la comprobación que cuenta es esta:
 * esconder el botón del micrófono no impide que alguien suba el fichero y lo
 * adjunte a mano. Si el servidor no dijera que no, el ajuste sería decorativo.
 *
 *   node --test "voice-messages.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const raiz = mkdtempSync(join(tmpdir(), "distop-audios-"));
mkdirSync(raiz, { recursive: true });
process.env.PORT = "0";
process.env.DATABASE_PATH = join(raiz, "app.db");
process.env.DEFAULT_STORAGE_PATH = join(raiz, "uploads");
/* Simula una lista privada y deliberadamente mínima. Los contenedores que
   produce la grabadora tienen que seguir funcionando sin exigir que cada
   anfitrión edite su entorno al actualizar Distop. */
process.env.ALLOWED_UPLOAD_TYPES = "image/png";
delete process.env.AUTH_SECRET;

const { server, shutdown } = await import("./server.ts");

let base = "";
let token = "";
let comunidad = "";
let canal = "";

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  token = claim.json.access_token as string;
  const community = await call("POST", "/api/v1/communities", { token, body: { name: "La Casa" } });
  comunidad = community.json.id as string;
  const boot = await call("GET", `/api/v1/communities/${comunidad}/bootstrap`, { token });
  canal = (boot.json.channels as Array<{ id: string; kind: string }>).find((c) => c.kind === "text")!.id;
});

after(async () => {
  /* `server.close()` no suelta SQLite. En Windows eso deja app.db bloqueado y
     convierte una suite verde en EPERM al borrar el temporal. */
  await shutdown("prueba-audios");
  rmSync(raiz, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.raw ? {} : { "content-type": "application/json" }),
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    ...(opts.raw ? { body: opts.raw } : opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Un adjunto de audio recién subido, listo para colgar de un mensaje. */
async function subirAudio(): Promise<string> {
  const subida = await call("POST", "/api/v1/uploads", {
    token,
    raw: Buffer.alloc(512, 0x1a),
    headers: { "content-type": "audio/webm", "x-filename": "nota.webm" },
  });
  assert.equal(subida.status, 200, JSON.stringify(subida.json));
  return subida.json.id as string;
}

test("de fábrica una comunidad acepta audios", async () => {
  const audioId = await subirAudio();
  const enviado = await call("POST", `/api/v1/channels/${canal}/messages`, {
    token,
    body: { content: "", attachment_ids: [audioId] },
  });
  assert.equal(enviado.status, 200, JSON.stringify(enviado.json));

  /* No basta con que el mensaje acepte el adjunto: <audio> tiene que poder
     cargarlo dentro del chat sin que el servidor fuerce una descarga. */
  const reproducible = await fetch(`${base}/api/v1/files/${audioId}`);
  assert.equal(reproducible.status, 200);
  assert.equal(reproducible.headers.get("content-type"), "audio/webm");
  assert.match(reproducible.headers.get("content-disposition") ?? "", /^inline;/);
});

test("con los audios suspendidos el servidor rechaza el adjunto, no solo la interfaz", async () => {
  const apagado = await call("PATCH", `/api/v1/communities/${comunidad}`, { token, body: { voice_messages: false } });
  assert.equal(apagado.status, 200);
  assert.equal(apagado.json.voice_messages, false);

  const enviado = await call("POST", `/api/v1/channels/${canal}/messages`, {
    token,
    body: { content: "", attachment_ids: [await subirAudio()] },
  });
  assert.equal(enviado.status, 400, JSON.stringify(enviado.json));

  // Ni siquiera el anfitrión se lo salta: no es un permiso, es un ajuste de la
  // comunidad. Y lo que no es audio sigue pasando.
  const imagen = await call("POST", "/api/v1/uploads", {
    token,
    raw: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(512, 0x5a)]),
    headers: { "content-type": "image/png", "x-filename": "foto.png" },
  });
  const conFoto = await call("POST", `/api/v1/channels/${canal}/messages`, {
    token,
    body: { content: "", attachment_ids: [imagen.json.id] },
  });
  assert.equal(conFoto.status, 200, JSON.stringify(conFoto.json));
});

test("volver a encenderlo devuelve los audios", async () => {
  const encendido = await call("PATCH", `/api/v1/communities/${comunidad}`, { token, body: { voice_messages: true } });
  assert.equal(encendido.json.voice_messages, true);
  const enviado = await call("POST", `/api/v1/channels/${canal}/messages`, {
    token,
    body: { content: "", attachment_ids: [await subirAudio()] },
  });
  assert.equal(enviado.status, 200, JSON.stringify(enviado.json));
});
