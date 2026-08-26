/**
 * El vigilante entero, contra un servidor de verdad.
 *
 * availability.test.ts prueba las reglas sueltas; esto prueba que enganchan:
 * dos fallos, una ausencia larga, la instancia que vuelve, la prueba firmada
 * pedida de verdad por la red, exactamente un aviso, la dirección correcta al
 * pulsarlo, y ni un aviso más dentro del silencio.
 *
 * Sobre TLS: la vigilancia solo acepta direcciones https —eso lo comprueba
 * `stableWatchUrl`— pero el servidor de este archivo habla http en 127.0.0.1 y
 * el `fetch` inyectado traduce el origen fijado a él. Verificar certificados es
 * trabajo de Node, no nuestro, y montar una CA de prueba no probaría nada de
 * este código. Lo que sí se comprueba aquí es lo que sí es nuestro: que se pide
 * el nonce, que no se siguen redirecciones y que la firma manda.
 *
 *   node --test "src/*.test.ts"
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "./availability-policy.ts";
import { MAX_AVAILABILITY_WATCHES, createAvailabilityWatcher, type AvailabilityWatchInput } from "./availability-watcher.ts";

const ORIGEN = "https://equipo.tailnet.ts.net";
const INSTANCIA = "instancia-de-prueba";
const LINAJE = "linaje-de-prueba";
const EPOCA = 3;

const claves = generateKeyPairSync("ec", { namedCurve: "P-256" });
const impostor = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = claves.publicKey.export({ format: "jwk" }) as JsonWebKey;
const huella = createHash("sha256").update(canonicalJson(jwk)).digest("base64url");

/* ── la instancia de mentira, que responde como la de verdad ─────────── */

let server: Server;
let puerto = 0;
/** Apagada: deja de contestar, como un PC que se durmió. */
let viva = true;
/** Firma con otra clave: el impostor que se pone en la misma dirección. */
let suplanta = false;
const peticiones: string[] = [];

let ahora = 1_756_100_000_000;

function firmar(nonce: string): unknown {
  const payload = {
    t: "DISTOP_INSTANCE_PROOF",
    instance_id: INSTANCIA,
    lineage_id: LINAJE,
    epoch: EPOCA,
    role: "PRIMARY",
    origin: ORIGEN,
    nonce,
    issued_at: ahora - 500,
    expires_at: ahora + 60_000,
    protocol: "v1",
  };
  const par = suplanta ? impostor : claves;
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), {
      key: par.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
    public_key: par.publicKey.export({ format: "jwk" }) as JsonWebKey,
    /* El impostor declara la huella buena: es lo que haría de verdad, y es
       exactamente lo que no se le puede permitir que cuele. */
    fingerprint: huella,
  };
}

async function levantar(): Promise<void> {
  server = createServer((req, res) => {
    peticiones.push(`${req.method} ${req.url}`);
    if (!viva) {
      res.socket?.destroy();
      return;
    }
    const responder = (body: unknown): void => {
      const texto = JSON.stringify(body);
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(texto) });
      res.end(texto);
    };
    if (req.url === "/health") {
      responder({ status: "ONLINE", instance_id: INSTANCIA });
      return;
    }
    if (req.url === "/api/v1/instance/challenge") {
      let crudo = "";
      req.on("data", (trozo: Buffer) => (crudo += trozo));
      req.on("end", () => responder(firmar((JSON.parse(crudo) as { nonce: string }).nonce)));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  puerto = typeof address === "object" && address ? address.port : 0;
}

/** Traduce el origen fijado al servidor local y, de paso, anota cómo se piden
    las cosas: sin seguir redirecciones y con tope de tiempo. */
const opcionesVistas: RequestInit[] = [];
const fetchLocal = ((entrada: unknown, opciones: RequestInit = {}) => {
  opcionesVistas.push(opciones);
  return globalThis.fetch(String(entrada).replace(ORIGEN, `http://127.0.0.1:${puerto}`), opciones);
}) as typeof globalThis.fetch;

/* ── el aparato de la prueba ────────────────────────────────────────── */

const workdir = mkdtempSync(join(tmpdir(), "distop-watch-"));
const statePath = join(workdir, "availability-watch.json");
const avisos: Array<{ body: string; url: string }> = [];

const vigilante = () =>
  createAvailabilityWatcher({
    statePath,
    now: () => ahora,
    fetch: fetchLocal,
    notify: (body, url) => avisos.push({ body, url }),
  });

const vigilancia: AvailabilityWatchInput = {
  url: ORIGEN,
  name: "La Casa",
  instance_id: INSTANCIA,
  lineage_id: LINAJE,
  epoch: EPOCA,
  identity_fingerprint: huella,
  identity_public_key: jwk,
  enabled: true,
  connected: false,
};

/** Deja pasar el tiempo suficiente para que toque otro sondeo. */
async function sondear(watcher: ReturnType<typeof vigilante>, veces = 1): Promise<void> {
  for (let i = 0; i < veces; i++) {
    ahora += 61_000 + 15_000;
    await watcher.tick();
  }
}

before(levantar);

after(() => {
  server.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("una ausencia real produce exactamente un aviso, y ninguno más dentro del silencio", async () => {
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  // 1. Viva y recién vista: nadie ha echado nada de menos, así que no se avisa.
  await watcher.tick();
  assert.deepEqual(avisos, []);
  assert.ok(peticiones.includes("POST /api/v1/instance/challenge"), "la prueba firmada se pide de verdad");
  assert.equal(opcionesVistas[0]?.redirect, "manual", "una redirección no puede desviar el sondeo");
  assert.ok(opcionesVistas[0]?.signal, "y hay tope de tiempo");

  // 2. Se apaga el equipo: dos fallos seguidos, separados en el tiempo.
  viva = false;
  await sondear(watcher, 2);
  assert.deepEqual(avisos, [], "estar caída no se anuncia: lo que se anuncia es volver");

  // 3. Vuelve, pasada de sobra la caída mínima de 90 s.
  viva = true;
  await sondear(watcher);
  assert.equal(avisos.length, 1, "un solo aviso");
  assert.match(avisos[0]!.body, /La Casa/);
  assert.equal(avisos[0]!.url, ORIGEN, "y al pulsarlo lleva a la dirección fijada, no a otra");

  // 4. La conexión parpadea otra vez dentro de la media hora: no se repite.
  viva = false;
  await sondear(watcher, 2);
  viva = true;
  await sondear(watcher);
  assert.equal(avisos.length, 1, "dentro del silencio no aparece un segundo aviso");

  watcher.stop();
});

test("un impostor en la misma dirección no consigue que se avise de nada", async () => {
  avisos.length = 0;
  // Muy por delante del último aviso: el silencio de media hora ya no tapa nada.
  ahora += 60 * 60_000;
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  // Ausencia real primero, para que un aviso fuera posible si la firma colara.
  viva = false;
  await sondear(watcher, 2);

  viva = true;
  suplanta = true;
  await sondear(watcher);
  assert.deepEqual(avisos, [], "responder en la dirección buena no basta: hay que firmar con la clave buena");

  // Con la clave de verdad, el mismo momento sí avisa: la diferencia era la firma.
  suplanta = false;
  await sondear(watcher);
  assert.equal(avisos.length, 1);

  watcher.stop();
});

test("un WebSocket que dice estar conectado no produce avisos por sí solo", async () => {
  avisos.length = 0;
  ahora += 60 * 60_000;
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  viva = false;
  await sondear(watcher, 2);

  // El gateway dice "ya estoy dentro" mientras la instancia sigue sin contestar.
  ahora += 61_000;
  watcher.setConnection(ORIGEN, true);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(avisos, [], "la pista del socket no sustituye a la prueba firmada");

  watcher.stop();
});

test("el estado sobrevive a cerrar y volver a abrir la aplicación", async () => {
  avisos.length = 0;
  ahora += 60 * 60_000;
  viva = false;

  const primero = vigilante();
  primero.replace([vigilancia]);
  await sondear(primero, 2);
  primero.stop();

  const guardado = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ failures: number; url: string }>;
  assert.equal(guardado.length, 1);
  assert.ok(guardado[0]!.failures >= 2, "los fallos acumulados se escriben en disco");
  assert.equal(guardado[0]!.url, ORIGEN);

  /* Se reabre la aplicación: la ausencia contada antes sigue valiendo, así que
     la vuelta se anuncia sin tener que volver a fallar dos veces. */
  const segundo = vigilante();
  segundo.start();
  viva = true;
  await sondear(segundo);
  assert.equal(avisos.length, 1, "la aplicación recuerda que la comunidad estaba caída");
  segundo.stop();
});

test("la frontera limita, deduplica y descarta vigilancias mal formadas", () => {
  const watcher = vigilante();
  const many = Array.from({ length: MAX_AVAILABILITY_WATCHES + 15 }, (_, index) => ({
    ...vigilancia,
    url: `https://equipo-${index}.ts.net`,
  }));
  watcher.replace([
    { ...vigilancia, url: "https://127.0.0.1", identity_fingerprint: "falsa" },
    { ...vigilancia, url: "https://coordenada-invalida.ts.net", identity_public_key: { ...jwk, x: "x" } },
    { ...many[0]!, identity_public_key: { ...jwk, d: "no-debe-persistirse" } },
    ...many.slice(1),
    { ...vigilancia, url: many[0]!.url },
  ]);
  const saved = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ url: string; identity_public_key: JsonWebKey }>;
  assert.equal(saved.length, MAX_AVAILABILITY_WATCHES);
  assert.equal(new Set(saved.map((item) => item.url)).size, MAX_AVAILABILITY_WATCHES);
  assert.ok(saved.every((item) => item.url.endsWith(".ts.net")));
  assert.deepEqual(Object.keys(saved[0]!.identity_public_key).sort(), ["crv", "kty", "x", "y"]);
  watcher.stop();
});
