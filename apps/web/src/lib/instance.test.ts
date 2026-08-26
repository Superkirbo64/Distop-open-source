/**
 * Lo que el cliente recuerda de cada instancia, y cuándo deja de recordarlo.
 *
 * Sin navegador: se le pone un `localStorage` y un `window.distop` de mentira
 * antes de importar el módulo, porque `instanceBase` se calcula al cargarlo.
 * Lo que se prueba es la frontera con el escritorio —qué vigilancias se mandan,
 * cuáles se olvidan y qué llega de vuelta cuando el vigilante ve algo raro—,
 * que es justo la parte que no se ve pulsando la interfaz.
 *
 *   node --test "src/lib/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";

const almacen = new Map<string, string>();
const olvidadas: string[] = [];
const reemplazos: Array<Array<{ url: string; name: string }>> = [];
let dispararAlerta: ((alert: unknown) => void) | null = null;

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => almacen.get(key) ?? null,
    setItem: (key: string, value: string) => void almacen.set(key, value),
    removeItem: (key: string) => void almacen.delete(key),
    clear: () => almacen.clear(),
  },
});

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    distop: {
      platform: "win32",
      availability: {
        replace: async (items: Array<{ url: string; name: string }>) => {
          reemplazos.push(items);
          return true;
        },
        status: () => {},
        forget: async (url: string) => {
          olvidadas.push(url);
          return true;
        },
        onOpen: () => () => {},
        onAlert: (callback: (alert: unknown) => void) => {
          dispararAlerta = callback;
          return () => {};
        },
      },
    },
  },
});

const { forgetInstance, knownInstances, rememberCommunities, watchAlert, clearWatchAlert } =
  await import("./instance.ts");

const CASA = "https://equipo.tailnet.ts.net";
const LIST_KEY = "distop.instances";

type Comunidad = Parameters<typeof rememberCommunities>[1][number];
const comunidad = (id: string, name: string): Comunidad =>
  ({ id, name, icon_url: null, accent_color: null }) as unknown as Comunidad;

/** Una instancia ya conocida, vigilada y con identidad fijada. */
function sembrar(communities: Array<{ id: string; name: string }>): void {
  almacen.set(
    LIST_KEY,
    JSON.stringify([
      {
        url: CASA,
        name: "La Casa",
        last_seen: Date.now(),
        watch_url: CASA,
        watch_enabled: true,
        instance_id: "instancia-1",
        lineage_id: "linaje-1",
        epoch: 3,
        identity_fingerprint: "f".repeat(43),
        identity_public_key: { kty: "EC", crv: "P-256", x: "x".repeat(43), y: "y".repeat(43) },
        communities,
      },
    ]),
  );
}

function limpiar(): void {
  almacen.clear();
  olvidadas.length = 0;
  reemplazos.length = 0;
}

test("perder la última comunidad borra el nombre, la caché y la vigilancia", () => {
  limpiar();
  sembrar([{ id: "c1", name: "La Plaza" }]);

  rememberCommunities(CASA, []);

  assert.deepEqual(knownInstances(), [], "ni el nombre ni la identidad fijada se quedan");
  assert.deepEqual(olvidadas, [CASA], "y se le dice al escritorio que la olvide, sin esperar a un replace");
});

test("una cuenta nueva sin comunidades no pierde nada: nunca tuvo nada", () => {
  limpiar();
  sembrar([]);

  rememberCommunities(CASA, []);

  assert.equal(knownInstances().length, 1, "lista vacía no es lo mismo que lista perdida");
  assert.deepEqual(olvidadas, []);
});

test("salir de una comunidad de varias no borra la instancia", () => {
  limpiar();
  sembrar([
    { id: "c1", name: "La Plaza" },
    { id: "c2", name: "El Taller" },
  ]);

  rememberCommunities(CASA, [comunidad("c2", "El Taller")]);

  const guardada = knownInstances()[0]!;
  assert.equal(guardada.communities?.length, 1);
  assert.equal(guardada.communities?.[0]?.id, "c2", "y la que ya no está deja de aparecer en la barra");
  assert.deepEqual(olvidadas, [], "sigues dentro: no hay nada que olvidar");
});

test("olvidar una instancia a mano también la quita de la vigilancia", () => {
  limpiar();
  sembrar([{ id: "c1", name: "La Plaza" }]);

  forgetInstance(CASA);

  assert.deepEqual(knownInstances(), []);
  assert.deepEqual(olvidadas, [CASA]);
});

test("lo que ve el vigilante con la app cerrada se guarda para enseñarlo al abrir", () => {
  limpiar();
  sembrar([{ id: "c1", name: "La Plaza" }]);
  assert.ok(dispararAlerta, "el cliente se suscribe a las alertas del vigilante al cargar");

  dispararAlerta!({ kind: "identity_conflict", url: CASA, fingerprint: "otra-huella" });

  const alerta = watchAlert(CASA);
  assert.equal(alerta?.kind, "identity_conflict");
  assert.equal(alerta?.detail, "otra-huella", "qué clave contestó, para poder comprobarlo por otro canal");

  /* Un conflicto visto por el vigilante es el mismo que detecta el cliente al
     conectar: se anota donde la interfaz ya lo lee, sin dos verdades. */
  const guardada = knownInstances()[0]!;
  assert.equal(guardada.conflict?.reason, "WATCH_IDENTITY_CONFLICT");
  assert.equal(guardada.conflict?.seen_fingerprint, "otra-huella");

  clearWatchAlert(CASA);
  assert.equal(watchAlert(CASA), undefined);
});

test("un protocolo incompatible se anota, pero no como conflicto de identidad", () => {
  limpiar();
  sembrar([{ id: "c1", name: "La Plaza" }]);

  dispararAlerta!({ kind: "protocol_incompatible", url: CASA, protocol: "v2" });

  assert.equal(watchAlert(CASA)?.kind, "protocol_incompatible");
  assert.equal(watchAlert(CASA)?.detail, "v2");
  assert.equal(knownInstances()[0]!.conflict, undefined, "hablar otro idioma no es suplantar a nadie");
});

test("una alerta para una dirección que no vigilamos no toca nada", () => {
  limpiar();
  sembrar([{ id: "c1", name: "La Plaza" }]);

  dispararAlerta!({ kind: "identity_conflict", url: "https://otra.ts.net", fingerprint: "x" });

  assert.equal(watchAlert(CASA), undefined);
  assert.equal(knownInstances()[0]!.conflict, undefined);
});
