/**
 * Self-check del aforo de las salas de voz.
 *
 * Sin SFU, cada voz se copia una vez por cada oyente: la subida del anfitrión
 * crece con n×(n−1) y pasado cierto punto se entrecorta para TODOS. El tope
 * existe por eso, no por un plan de pago.
 *
 * Lo que se comprueba aquí es lo que no se ve mirando el código: que rechazar a
 * quien no cabe no le cuelgue la llamada que YA tenía, y que una pestaña nueva
 * de alguien que está dentro no cuente como una persona más.
 *   node --test "*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-aforo-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
/* Dos para que quepa la prueba entera en una pantalla. La aritmética es la
   misma con dos que con veinticinco; lo que se prueba es el borde. */
process.env.MAX_VOICE_PARTICIPANTS = "2";

const { server } = await import("./server.ts");

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
});

after(async () => {
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("una sala llena rechaza sin desconectar a nadie de la suya", async () => {
  const voice = await import("./voice.ts");
  const { db, seedCommunity } = await import("./db.ts");
  const { uuidv7 } = await import("@distop/protocol");

  const ahora = Date.now();
  const [ana, bea, carla] = [uuidv7(), uuidv7(), uuidv7()];
  for (const [id, nombre] of [
    [ana, "ana"],
    [bea, "bea"],
    [carla, "carla"],
  ] as const) {
    db.prepare("INSERT INTO users (id, username, display_name, kind, created_at) VALUES (?, ?, ?, 'local', ?)").run(
      id,
      nombre,
      nombre,
      ahora,
    );
  }

  const communityId = seedCommunity({ name: "Aforo", slug: `aforo-${ahora}`, ownerId: ana, isPublic: false });
  for (const id of [bea, carla]) {
    db.prepare("INSERT INTO members (community_id, user_id, joined_at) VALUES (?, ?, ?)").run(communityId, id, ahora);
  }

  const sala1 = (db.prepare("SELECT id FROM channels WHERE community_id = ? AND kind = 'voice'").get(communityId) as {
    id: string;
  }).id;
  const sala2 = uuidv7();
  db.prepare(
    "INSERT INTO channels (id, community_id, name, kind, position, created_at) VALUES (?, ?, 'otra', 'voice', 9, ?)",
  ).run(sala2, communityId, ahora);

  // Carla está hablando tranquilamente en la segunda sala.
  assert.ok(voice.join(sala2, carla), "carla entra en su sala");

  // Y la primera se llena.
  assert.ok(voice.join(sala1, ana), "ana entra");
  assert.ok(voice.join(sala1, bea), "bea entra");

  /* Carla intenta cambiarse y no cabe. Lo que importa NO es solo que se le diga
     que no: es que siga donde estaba. Si el aforo se comprobara después de
     sacarla de la sala anterior —que es el orden natural al escribirlo— se
     quedaría sin ninguna de las dos, y desde fuera parecería que la llamada se
     cayó sola. */
  assert.equal(voice.join(sala1, carla), "full", "no cabe, y se dice por su nombre");
  assert.equal(voice.channelOf(carla), sala2, "y sigue en la llamada que ya tenía");
  assert.equal(voice.peersOf(sala1).length, 2, "la sala llena no admitió a nadie más");

  /* Abrir otra pestaña estando dentro no es una persona más. Rechazarla dejaría
     al resto de la sala hablándole al navegador anterior, que ya no existe. */
  assert.ok(voice.join(sala1, ana), "una pestaña nueva de quien ya está dentro pasa");
  assert.equal(voice.peersOf(sala1).length, 2, "y no infla el aforo");

  // Al salir alguien, el sitio queda libre de verdad.
  assert.ok(voice.leave(sala1, bea), "bea se va");
  assert.ok(voice.join(sala1, carla), "ahora carla sí entra");
  assert.equal(voice.channelOf(carla), sala1, "y cambió de sala");
});
