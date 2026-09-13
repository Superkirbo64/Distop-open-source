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

const { collectDirectory, directorySources, onlineOnly } = await import("./directory.ts");

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

test("sin directorio configurado solo queda la instancia activa", () => {
  const fuentes = directorySources();
  assert.equal(fuentes.length, 1);
  assert.equal(fuentes[0]!.id, "instance");
  assert.equal(fuentes[0]!.labelKey, "explore.sourceInstance");
});

test("el directorio global es otra fuente y el local puede estar apagado", () => {
  const fuentes = directorySources({ localEnabled: false, directoryUrl: "https://directory.example" });
  assert.equal(fuentes.length, 1);
  assert.equal(fuentes[0]!.id, "global");
  assert.equal(fuentes[0]!.labelKey, "explore.sourceGlobal");
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

test("Explorar solo enseña las comunidades cuyo servidor contesta, y pregunta una vez por servidor", async () => {
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://aqui.example", search: "" } });
  const preguntas: string[] = [];
  const visibles = await onlineOnly(
    [
      ficha("local", "Sin origen"),
      { ...ficha("aqui", "De esta instancia"), origin: "https://aqui.example" },
      { ...ficha("viva-1", "Viva"), origin: "https://viva.example" },
      { ...ficha("viva-2", "Viva también"), origin: "https://viva.example/" },
      { ...ficha("apagada", "Apagada"), origin: "https://apagada.example" },
      // La instancia activa servida en localhost anuncia la dirección de su túnel.
      { ...ficha("mia-por-tunel", "Mía por túnel"), origin: "https://mi-tunel.example", instance_id: "yo" },
    ],
    "yo",
    async (origin) => {
      preguntas.push(origin);
      return origin === "https://viva.example";
    },
  );
  assert.deepEqual(visibles.map((c) => c.id), ["local", "aqui", "viva-1", "viva-2", "mia-por-tunel"], "la apagada no se enseña; la propia sí, aunque anuncie otra dirección");
  assert.deepEqual(preguntas.sort(), ["https://apagada.example", "https://viva.example"], "ni la propia ni un servidor repetido se sondean dos veces");
});

/* ── Explorar en la app instalada (Android/escritorio) ───────────────────
   Lo que pidió la revisión: el objetivo elegido en Explorar se guarda ANTES de
   cambiar de instancia, sobrevive a un fallo de conexión y solo se consume
   cuando el servidor confirma la entrada. */

const PENDIENTE = "distop.pendingPublicJoin";
const respuesta = (cuerpo: unknown, status = 200) => new Response(JSON.stringify(cuerpo), { status });
const destino = { ...ficha("c-remota", "La Remota"), origin: "https://otra.example", instance_id: "inst-1", join_policy: "open" as const };

function empaquetada(fetchFalso: typeof fetch): { recargas: Array<string | null> } {
  const estado = { recargas: [] as Array<string | null> };
  Object.assign(globalThis.window as object, { Capacitor: { isNativePlatform: () => true } });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: "capacitor://localhost", search: "", reload: () => estado.recargas.push(almacen.get(PENDIENTE) ?? null) },
  });
  globalThis.fetch = fetchFalso;
  return estado;
}

test("empaquetada: guarda comunidad y política antes de cambiar de instancia", async () => {
  almacen.clear();
  const { enterDirectoryCommunity } = await import("./directory.ts");
  const estado = empaquetada(async () => respuesta({ instance_id: "inst-1", name: "Otra", version: "0.1.11" }));
  assert.equal(await enterDirectoryCommunity(destino), "switching");
  assert.equal(estado.recargas.length, 1, "cambia de instancia con una recarga");
  assert.deepEqual(JSON.parse(estado.recargas[0]!), { communityId: "c-remota", policy: "open" }, "el objetivo ya estaba guardado al recargar");
});

test("empaquetada: un fallo de conexión no pierde el objetivo", async () => {
  almacen.clear();
  const { enterDirectoryCommunity } = await import("./directory.ts");
  let llamadas = 0;
  const estado = empaquetada(async () => {
    llamadas++;
    if (llamadas === 1) return respuesta({ instance_id: "inst-1", name: "Otra", version: "0.1.11" });
    throw new TypeError("Failed to fetch");
  });
  assert.equal(await enterDirectoryCommunity(destino), "unreachable");
  assert.equal(estado.recargas.length, 0, "sin conexión no se cambia de instancia");
  assert.deepEqual(JSON.parse(almacen.get(PENDIENTE)!), { communityId: "c-remota", policy: "open" });
});

test("el objetivo solo se consume cuando el servidor confirma la entrada", async () => {
  almacen.clear();
  almacen.set(PENDIENTE, JSON.stringify({ communityId: "c-remota", policy: "request" }));
  const { completePendingPublicJoin } = await import("./directory.ts");
  const pedidas: string[] = [];

  empaquetada(async (url) => { pedidas.push(String(url)); throw new TypeError("Failed to fetch"); });
  await assert.rejects(completePendingPublicJoin(""));
  assert.ok(almacen.has(PENDIENTE), "un corte de red lo conserva");

  empaquetada(async (url) => { pedidas.push(String(url)); return respuesta({ error: { code: "INTERNAL", message: "x", status: 500 } }, 500); });
  await assert.rejects(completePendingPublicJoin(""));
  assert.ok(almacen.has(PENDIENTE), "un rechazo del servidor también lo conserva");

  empaquetada(async (url) => { pedidas.push(String(url)); return respuesta({}); });
  assert.deepEqual(await completePendingPublicJoin(""), {});
  assert.equal(almacen.has(PENDIENTE), false, "confirmado, se consume");
  assert.ok(pedidas.every((url) => url.endsWith("/api/v1/public-communities/c-remota/requests")), "respeta la política guardada");

  assert.equal(await completePendingPublicJoin(""), null, "sin objetivo no pide nada");
});
