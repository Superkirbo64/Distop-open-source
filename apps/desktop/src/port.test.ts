/** Elegir puerto no puede fallar porque el preferido esté ocupado (§26). */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { after, test } from "node:test";
import { freePort } from "./port.ts";

const ADDRESS = "127.0.0.1";
const opened: Server[] = [];

/** Ocupa un puerto de verdad y devuelve cuál, para poder disputárselo. */
function occupy(): Promise<number> {
  return new Promise((done) => {
    const server = createServer();
    opened.push(server);
    server.listen(0, ADDRESS, () => {
      const bound = server.address();
      done(typeof bound === "object" && bound ? bound.port : 0);
    });
  });
}

after(() => {
  for (const server of opened) server.close();
});

test("con el preferido libre, se usa el preferido", async () => {
  const free = await occupy();
  await new Promise<void>((done) => opened.pop()?.close(() => done()));

  assert.equal(await freePort(free, ADDRESS), free);
});

test("con el preferido ocupado, se cede a otro en vez de fallar", async () => {
  const taken = await occupy();

  const chosen = await freePort(taken, ADDRESS);
  assert.notEqual(chosen, taken);
  assert.ok(chosen > 0);
});

test("el puerto devuelto se puede usar de verdad", async () => {
  const taken = await occupy();
  const chosen = await freePort(taken, ADDRESS);

  await new Promise<void>((done, fail) => {
    const server = createServer();
    opened.push(server);
    server.once("error", fail);
    server.listen(chosen, ADDRESS, () => done());
  });
});
