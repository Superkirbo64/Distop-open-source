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

const { canCreateCommunity, forgetInstance, knownInstances, railCommunities, rememberCommunities, watchAlert, clearWatchAlert } =
  await import("./instance.ts");

const CASA = "https://equipo.tailnet.ts.net";
const LIST_KEY = "distop.instances";

test("en el PC siempre se ofrece Crear: va a su propio servidor, no al conectado", () => {
  // Aquí `window.distop` existe (es el PC). Aunque el servidor conectado diga que no.
  assert.equal(canCreateCommunity({ can_create_communities: false }), true);
  assert.equal(canCreateCommunity(null), true);
});

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

test("los iconos de la barra no cambian de sitio al cambiar de servidor", () => {
  limpiar();
  const VPS = "https://vps.tailnet.ts.net";
  sembrar([{ id: "c1", name: "La Plaza" }]);
  rememberCommunities(VPS, [comunidad("v1", "La VPS")]);
  const orden = (base: string, vivas: Comunidad[]) =>
    railCommunities(knownInstances(), base, vivas).map(({ community }) => community.id);

  assert.deepEqual(orden(VPS, [comunidad("v1", "La VPS")]), ["c1", "v1"], "el servidor nuevo va al final");
  rememberCommunities(CASA, [comunidad("c1", "La Plaza")]);
  assert.deepEqual(orden(CASA, [comunidad("c1", "La Plaza")]), ["c1", "v1"], "volver a usar uno no lo adelanta");
  rememberCommunities(VPS, [comunidad("v1", "La VPS")]);
  assert.deepEqual(orden(VPS, [comunidad("v1", "La VPS")]), ["c1", "v1"]);
  assert.deepEqual(
    railCommunities(knownInstances(), "https://nueva.ts.net", [comunidad("n1", "Nueva")]).map(({ community }) => community.id),
    ["n1", "c1", "v1"],
    "solo va delante un servidor activo que la lista todavía no conoce",
  );
});

test("con 20 servidores, el nuevo saca al menos usado y nadie más se mueve", () => {
  limpiar();
  const urls = Array.from({ length: 20 }, (_, i) => `https://s${i}.ts.net`);
  almacen.set(
    LIST_KEY,
    JSON.stringify(urls.map((url, i) => ({ url, name: url, last_seen: i === 0 ? 9_000 : i === 7 ? 1 : 1_000 + i }))),
  );

  rememberCommunities("https://s12.ts.net", [comunidad("x", "X")]);
  assert.deepEqual(knownInstances().map((known) => known.url), urls, "actualizar una existente conserva su índice");

  rememberCommunities("https://nueva.ts.net", [comunidad("n", "N")]);
  const despues = knownInstances().map((known) => known.url);
  assert.equal(despues.length, 20);
  assert.ok(!despues.includes("https://s7.ts.net"), "sale la intermedia menos usada");
  assert.equal(despues[0], "https://s0.ts.net", "la primera, que era la más reciente, se queda");
  assert.deepEqual(despues.slice(0, -1), urls.filter((url) => url !== "https://s7.ts.net"), "el resto conserva su orden");
  assert.equal(despues.at(-1), "https://nueva.ts.net", "la nueva va al final");
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

test("una invitación abierta sin sesión sobrevive a entrar o crear perfil y solo se olvida al confirmarla", async () => {
  limpiar();
  const { storePendingInvite, peekPendingInvite, clearPendingInvite } = await import("./instance.ts");
  storePendingInvite("abc123");
  assert.equal(peekPendingInvite(), "abc123");
  assert.equal(peekPendingInvite(), "abc123", "mirarla para volver a /invite no la consume");
  clearPendingInvite("otra");
  assert.equal(peekPendingInvite(), "abc123", "confirmar otra invitación no borra esta");
  clearPendingInvite("abc123");
  assert.equal(peekPendingInvite(), null, "confirmada, se olvida");
});
