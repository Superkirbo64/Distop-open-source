/**
 * Apagado con una subida en vuelo, y lo que queda en el disco después (§28.5).
 *
 * Este es EL escenario del producto: "apago el PC" no es un caso raro, es cómo
 * termina cada día una comunidad hospedada en casa. Lo que aquí se comprueba no
 * es que el proceso muera, sino que muera sin dejar mentiras en el disco: ni un
 * archivo final sin fila, ni una fila apuntando a un archivo que no está, ni
 * medio vídeo ocupando sitio para siempre.
 *
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";

const workdir = mkdtempSync(join(tmpdir(), "distop-shutdown-"));
const uploads = join(workdir, "uploads");
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = uploads;
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { server, shutdown } = await import("./server.ts");
const { db } = await import("./db.ts");

let port = 0;
let base = "";

/* Una excepción sin dueño durante el apagado invalida todo lo demás: el proceso
   se iría con código 1 y nadie sabría por qué. Se vigila explícitamente. */
const huerfanos: unknown[] = [];
process.on("unhandledRejection", (reason) => huerfanos.push(reason));
process.on("uncaughtException", (error) => huerfanos.push(error));

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;
});

after(() => {
  rmSync(workdir, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

/** Ficheros dentro de `uploads/.incoming`, el único sitio donde puede haber
    algo a medias. */
function incoming(): string[] {
  const dir = join(uploads, ".incoming");
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Todos los ficheros finales, sin contar los temporales. */
function finales(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".incoming") continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  if (existsSync(uploads)) walk(uploads, "");
  return out;
}

/** Abre una subida cuyo cuerpo se controla desde el test, trozo a trozo. */
function subidaLenta(token: string, filename: string): {
  cuerpo: PassThrough;
  respuesta: Promise<{ status: number; error: unknown }>;
} {
  const cuerpo = new PassThrough();
  const respuesta = new Promise<{ status: number; error: unknown }>((resolve) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/api/v1/uploads",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "image/png",
          "x-filename": filename,
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, error: null }));
      },
    );
    /* Que el socket muera a media subida es el resultado correcto de un
       apagado, no un fallo del test. */
    req.on("error", (error) => resolve({ status: 0, error }));
    cuerpo.pipe(req);
  });
  return { cuerpo, respuesta };
}

let token = "";

test("una subida a medias vive en .incoming, no mezclada con los archivos buenos", async () => {
  const claim = await call("POST", "/api/v1/auth/bootstrap", { body: { display_name: "Anfitriona" } });
  assert.equal(claim.status, 200);
  token = claim.json.access_token as string;

  const { cuerpo, respuesta } = subidaLenta(token, "lenta.png");

  // Solo una parte del cuerpo; la petición se queda abierta esperando el resto.
  cuerpo.write(Buffer.alloc(64 * 1024, 7));
  await new Promise((r) => setTimeout(r, 200));

  assert.equal(incoming().length, 1, "el trozo recibido está en .incoming");
  assert.equal(finales().length, 0, "y no hay ningún archivo final a medias");

  // Termina bien: el temporal desaparece y aparece exactamente un archivo final.
  cuerpo.end(Buffer.alloc(64 * 1024, 9));
  const hecho = await respuesta;
  assert.equal(hecho.status, 200);
  assert.equal(incoming().length, 0, ".incoming queda limpio al cerrar la subida");
  assert.equal(finales().length, 1);

  const fila = db.prepare("SELECT path, size, content_hash FROM attachments").get() as {
    path: string;
    size: number;
    content_hash: string;
  };
  assert.equal(fila.size, 128 * 1024);
  assert.ok(fila.content_hash.startsWith("sha256:"), "el hash se calcula al vuelo, sin releer el fichero");
  assert.ok(existsSync(join(uploads, fila.path)), "la fila apunta a un archivo que existe");
});

test("apagar con una subida en vuelo no deja ni archivo huérfano ni fila rota", async () => {
  const { cuerpo, respuesta } = subidaLenta(token, "cortada.png");

  cuerpo.write(Buffer.alloc(64 * 1024, 3));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(incoming().length, 1, "hay una subida a medias en el disco");

  const antes = (db.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;

  // Apagado real, con el cuerpo todavía abierto.
  const apagando = shutdown("prueba");

  // Mientras se apaga, ningún cambio nuevo entra, y se dice por qué.
  const rechazado = await call("POST", "/api/v1/communities", { token, body: { name: "Tarde" } });
  assert.equal(rechazado.status, 503);
  assert.equal(rechazado.json.error.code, "INSTANCE_MAINTENANCE");
  assert.equal(rechazado.json.error.details.reason, "shutdown");

  // Leer sigue funcionando: apagarse no es cortar en seco.
  const salud = await call("GET", "/health");
  assert.equal(salud.status, 200);
  assert.equal(salud.json.status, "MAINTENANCE");

  await apagando;
  await respuesta;
  assert.deepEqual(huerfanos, [], "el apagado no produce excepciones sin dueño");

  /* El checkpoint dejó app.db autocontenido: sin esto, restaurar o copiar el
     fichero suelto se llevaría una base a la que le faltan las últimas
     escrituras, que siguen en el WAL. */
  const wal = `${process.env.DATABASE_PATH}-wal`;
  assert.ok(!existsSync(wal) || statSync(wal).size === 0, "no queda WAL pendiente junto a la base");

  /* La base se vuelve a abrir desde cero, como haría el siguiente arranque
     sobre el mismo directorio. Preguntarle a la conexión ya cerrada no probaría
     que el fichero quedó bien. */
  const reabierta = new DatabaseSync(process.env.DATABASE_PATH!);
  try {
    assert.equal(
      (reabierta.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check,
      "ok",
    );
    const despues = (reabierta.prepare("SELECT COUNT(*) AS n FROM attachments").get() as { n: number }).n;
    assert.equal(despues, antes, "una subida cortada no crea fila");
    for (const fila of reabierta.prepare("SELECT path FROM attachments WHERE path <> ''").all() as Array<{
      path: string;
    }>) {
      assert.ok(existsSync(join(uploads, fila.path)), `la fila ${fila.path} apunta a un archivo que no está`);
    }
  } finally {
    reabierta.close();
  }
  assert.equal(finales().length, 1, "no aparece ningún archivo final de más");
});

test("el arranque siguiente barre lo que quedó a medias, y solo eso", async () => {
  /* El proceso murió sin poder limpiar: se simula dejando basura en .incoming,
     que es exactamente el estado en que lo deja un corte de luz. */
  writeFileSync(join(uploads, ".incoming", "abandonada.part"), Buffer.alloc(1024, 1));
  const buenos = finales();
  assert.equal(incoming().length, 1);

  const { sweepIncoming } = await import("./storage.ts");
  assert.deepEqual(sweepIncoming(), { removed: 1, kept: 0 });
  assert.equal(incoming().length, 0, "el temporal abandonado ya no ocupa disco");
  assert.deepEqual(finales(), buenos, "y los archivos de verdad siguen todos ahí");

  // Idempotente: barrer dos veces no rompe nada ni cuenta de más.
  assert.deepEqual(sweepIncoming(), { removed: 0, kept: 0 });
});

test("apagar dos veces es apagar una vez", async () => {
  await shutdown("otra");
  await shutdown("y otra");
  assert.deepEqual(huerfanos, []);
});
