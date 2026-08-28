/**
 * La costura de "Explorar": juntar fuentes sin que una caída tumbe al resto.
 *
 * Sin navegador: `localStorage` y `window` de mentira ANTES de importar,
 * porque directory.ts importa api.ts → instance.ts, que calcula la instancia
 * activa al cargarse (mismo patrón que instance.test.ts).
 *
 *   node --test "src/lib/*.test.ts"
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
// Solo el tipo: se borra al compilar, así que no ejecuta nada antes de los fakes.
import type { DirectoryCommunity } from "./directory.ts";

const almacen = new Map<string, string>();

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => almacen.get(key) ?? null,
    setItem: (key: string, value: string) => void almacen.set(key, value),
    removeItem: (key: string) => void almacen.delete(key),
    clear: () => almacen.clear(),
  },
});

// Un `window` vacío basta: instance.ts solo mira `window.distop` con `?.`.
Object.defineProperty(globalThis, "window", { configurable: true, value: {} });

const { collectDirectory, directorySources } = await import("./directory.ts");

const ficha = (id: string, name: string): DirectoryCommunity => ({
  id,
  name,
  slug: id,
  description: null,
  icon_url: null,
  banner_url: null,
  accent_color: "#4059e0",
  members: 3,
});

test("v1 tiene una sola fuente: la instancia activa", () => {
  const fuentes = directorySources();
  assert.equal(fuentes.length, 1);
  assert.equal(fuentes[0]!.id, "instance");
  assert.equal(fuentes[0]!.labelKey, "explore.sourceInstance");
});

test("junta lo de todas las fuentes en su orden", async () => {
  const listado = await collectDirectory([
    { id: "a", labelKey: "explore.sourceInstance", list: async () => [ficha("c1", "La Plaza")] },
    { id: "b", labelKey: "explore.sourceInstance", list: async () => [ficha("c2", "El Taller")] },
  ]);
  assert.deepEqual(
    listado.communities.map((c) => c.id),
    ["c1", "c2"],
  );
  assert.deepEqual(listado.failures, []);
});

test("una fuente caída no tumba a las demás, pero queda dicha con nombre", async () => {
  const fallo = new Error("sin red");
  const listado = await collectDirectory([
    { id: "muerta", labelKey: "explore.sourceInstance", list: () => Promise.reject(fallo) },
    { id: "viva", labelKey: "explore.sourceInstance", list: async () => [ficha("c1", "La Plaza")] },
  ]);
  assert.equal(listado.communities.length, 1);
  assert.deepEqual(listado.failures, [{ source: "muerta", error: fallo }]);
});

test("sin fuentes no hay lista ni fallos, y no lanza", async () => {
  assert.deepEqual(await collectDirectory([]), { communities: [], failures: [] });
});
