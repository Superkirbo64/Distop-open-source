/**
 * El vigilante entero, contra un servidor de verdad.
 *
 * availability.test.ts prueba las reglas sueltas; esto prueba que enganchan:
 * dos fallos, una ausencia larga, la instancia que vuelve, la prueba firmada
 * pedida de verdad por la red, exactamente un aviso, la dirección correcta al
 * pulsarlo, y ni un aviso más dentro del silencio. Desde A1 final también los
 * dos caminos de una sucesión: el sucesor que contesta en la misma dirección y
 * la máquina retirada que solo sabe decir a dónde se fue.
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
import {
  MAX_AVAILABILITY_WATCHES,
  createAvailabilityWatcher,
  type AvailabilityWatchInput,
  type WatchAlert,
  type WatchNotice,
} from "./availability-watcher.ts";

const ORIGEN = "https://equipo.tailnet.ts.net";
const DESTINO = "https://el-portatil-de-ana.tailnet.ts.net";
const INSTANCIA = "instancia-de-prueba";
const SUCESORA = "instancia-sucesora";
const LINAJE = "linaje-de-prueba";
const EPOCA = 3;

const claves = generateKeyPairSync("ec", { namedCurve: "P-256" });
const impostor = generateKeyPairSync("ec", { namedCurve: "P-256" });
const heredera = generateKeyPairSync("ec", { namedCurve: "P-256" });

const huellaDe = (jwk: unknown): string => createHash("sha256").update(canonicalJson(jwk)).digest("base64url");
const jwkDe = (par: typeof claves): JsonWebKey => par.publicKey.export({ format: "jwk" }) as JsonWebKey;

const jwk = jwkDe(claves);
const huella = huellaDe(jwk);
const jwkHeredera = jwkDe(heredera);
const huellaHeredera = huellaDe(jwkHeredera);

/* ── la instancia de mentira, que responde como la de verdad ─────────── */

let server: Server;
let puerto = 0;
/** Apagada: deja de contestar, como un PC que se durmió. */
let viva = true;

/**
 * Qué está pasando ahora mismo en esa dirección.
 *
 * - `normal`      la de siempre, firmando con su clave.
 * - `impostor`    otra clave declarando la huella buena.
 * - `fork`        otra clave honesta con la misma época: dos que parecen la misma.
 * - `sucesora`    la máquina nueva, con la cadena que lo demuestra.
 * - `sin_cadena`  la máquina nueva… sin nada que lo demuestre.
 * - `retirada`    la vieja: ya no firma, pero dice a dónde se fue la línea.
 * - `mal_destino` la vieja, apuntando a una dirección que nadie firmó.
 * - `protocolo`   habla otra versión.
 */
type Modo = "normal" | "impostor" | "fork" | "sucesora" | "sin_cadena" | "retirada" | "mal_destino" | "protocolo";
let modo: Modo = "normal";
const peticiones: string[] = [];

let ahora = 1_756_100_000_000;

/** El certificado que ata la clave fijada con la de la máquina nueva. */
function certificado(): unknown {
  const payload = {
    t: "DISTOP_SUCCESSION_CERT",
    version: 1,
    lineage_id: LINAJE,
    from_instance_id: INSTANCIA,
    from_epoch: EPOCA,
    from_fingerprint: huella,
    to_instance_id: SUCESORA,
    to_epoch: EPOCA + 1,
    to_fingerprint: huellaHeredera,
    to_public_key: jwkHeredera,
    allowed_origins: [DESTINO],
    issued_at: ahora - 10_000,
    not_before: ahora - 10_000,
    expires_at: ahora + 30 * 86_400_000,
    handover_id: "relevo-de-prueba",
  };
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), {
      key: claves.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
    signer_public_key: jwk,
    signer_fingerprint: huella,
  };
}

function firmar(nonce: string): unknown {
  const sucede = modo === "sucesora" || modo === "sin_cadena";
  const payload = {
    t: "DISTOP_INSTANCE_PROOF",
    instance_id: sucede ? SUCESORA : INSTANCIA,
    lineage_id: LINAJE,
    epoch: sucede ? EPOCA + 1 : EPOCA,
    role: "PRIMARY",
    origin: ORIGEN,
    nonce,
    issued_at: ahora - 500,
    expires_at: ahora + 60_000,
    protocol: "v1",
  };
  const par = modo === "impostor" || modo === "fork" ? impostor : sucede ? heredera : claves;
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), {
      key: par.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
    public_key: jwkDe(par),
    /* El impostor declara la huella buena: es lo que haría de verdad, y es
       exactamente lo que no se le puede permitir que cuele. El fork, en cambio,
       es honesto sobre su clave — y por eso es el caso difícil. */
    fingerprint: modo === "impostor" ? huella : huellaDe(jwkDe(par)),
  };
}

async function levantar(): Promise<void> {
  server = createServer((req, res) => {
    peticiones.push(`${req.method} ${req.url}`);
    if (!viva) {
      res.socket?.destroy();
      return;
    }
    const responder = (body: unknown, status = 200): void => {
      const texto = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(texto) });
      res.end(texto);
    };
    if (req.url === "/health") {
      responder({
        status: "ONLINE",
        protocol: modo === "protocolo" ? "v2" : "v1",
        instance_id: modo === "sucesora" || modo === "sin_cadena" ? SUCESORA : INSTANCIA,
      });
      return;
    }
    if (req.url === "/api/v1/instance/challenge") {
      /* Una instancia retirada ya no firma nada: la ruta está cerrada. */
      if (modo === "retirada" || modo === "mal_destino") {
        responder({ error: { code: "INSTANCE_SUPERSEDED" } }, 410);
        return;
      }
      let crudo = "";
      req.on("data", (trozo: Buffer) => (crudo += trozo));
      req.on("end", () => responder(firmar((JSON.parse(crudo) as { nonce: string }).nonce)));
      return;
    }
    if (req.url === "/api/v1/succession/chain") {
      const retirada = modo === "retirada" || modo === "mal_destino";
      responder({
        lineage_id: LINAJE,
        instance_id: retirada ? INSTANCIA : SUCESORA,
        inbound_chain: modo === "sucesora" ? [certificado()] : [],
        superseded: retirada,
        successor_origin: modo === "mal_destino" ? "https://el-sitio-del-atacante.example" : DESTINO,
        chain: retirada ? [certificado()] : [],
      });
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
const avisos: WatchNotice[] = [];
const alertas: WatchAlert[] = [];

const vigilante = () =>
  createAvailabilityWatcher({
    statePath,
    now: () => ahora,
    fetch: fetchLocal,
    notify: (notice) => avisos.push(notice),
    alert: (alert) => alertas.push(alert),
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
async function sondear(watcher: ReturnType<typeof vigilante>, veces = 1, saltoMs = 61_000 + 15_000): Promise<void> {
  for (let i = 0; i < veces; i++) {
    ahora += saltoMs;
    await watcher.tick();
  }
}

/** Los resultados que se espacian a cinco minutos necesitan más margen. */
const sondearLargo = (watcher: ReturnType<typeof vigilante>, veces = 1) =>
  sondear(watcher, veces, 5 * 60_000 + 20_000);

/** Empezar de cero: sin avisos, sin alertas y fuera del silencio anterior. */
function limpiar(): void {
  avisos.length = 0;
  alertas.length = 0;
  ahora += 60 * 60_000;
  modo = "normal";
  viva = true;
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
  assert.equal(avisos[0]!.kind, "back");
  assert.equal(avisos[0]!.name, "La Casa");
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
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  // Ausencia real primero, para que un aviso fuera posible si la firma colara.
  viva = false;
  await sondear(watcher, 2);

  viva = true;
  modo = "impostor";
  await sondear(watcher);
  assert.deepEqual(avisos, [], "responder en la dirección buena no basta: hay que firmar con la clave buena");

  // Con la clave de verdad, el mismo momento sí avisa: la diferencia era la firma.
  modo = "normal";
  await sondear(watcher);
  assert.equal(avisos.length, 1);

  watcher.stop();
});

test("un WebSocket que dice estar conectado no produce avisos por sí solo", async () => {
  limpiar();
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
  limpiar();
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

/* ── sucesión: los dos caminos por los que se descubre una mudanza ──── */

test("el sucesor contesta en la misma dirección y lo demuestra: se trasladó, no volvió", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  modo = "sucesora";
  await sondear(watcher);

  assert.equal(avisos.length, 1, "una mudanza es noticia aunque nadie la echara de menos");
  assert.equal(avisos[0]!.kind, "moved", "la palabra importa: cambió de máquina, no volvió la de siempre");
  assert.equal(avisos[0]!.kind === "moved" && avisos[0]!.origin, ORIGEN);
  assert.deepEqual(alertas, [], "un relevo demostrado no es un problema de seguridad");

  // Y no se repite cada cinco minutos: es un hecho, no una novedad.
  await sondearLargo(watcher);
  assert.equal(avisos.length, 1);
  watcher.stop();
});

test("la máquina retirada dice a dónde se fue la línea, y la firma lo respalda", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  modo = "retirada";
  await sondear(watcher);

  assert.equal(avisos.length, 1);
  assert.equal(avisos[0]!.kind, "moved");
  assert.equal(
    avisos[0]!.kind === "moved" && avisos[0]!.origin,
    DESTINO,
    "y lleva a la dirección nueva, no a la que ya no sirve",
  );
  assert.deepEqual(alertas, []);
  watcher.stop();
});

test("un destino que no está en el certificado no se ofrece a nadie", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  /* La cadena es buena —la firmó la clave fijada— pero el campo que dice a
     dónde ir no está firmado por nadie. Es exactamente el sitio por donde se
     envenenaría una redirección. */
  modo = "mal_destino";
  await sondear(watcher);
  assert.deepEqual(avisos, [], "cadena válida y destino sin firmar: no se manda a nadie");
  watcher.stop();
});

test("afirmar ser la continuación sin cadena es un conflicto, y detiene el sondeo", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  modo = "sin_cadena";
  await sondear(watcher);
  assert.deepEqual(avisos, [], "nadie se entera de una mudanza que no se demostró");
  assert.deepEqual(
    alertas,
    [{ kind: "identity_conflict", url: ORIGEN, fingerprint: huellaHeredera }],
    "pero sí se guarda para contarlo al abrir, con la clave que contestó",
  );

  // Bloqueada: no se sigue llamando a una puerta que ya dio esa respuesta.
  const antes = peticiones.length;
  await sondearLargo(watcher, 2);
  assert.equal(peticiones.length, antes, "un conflicto lo desbloquea una persona, no un temporizador");
  assert.equal(alertas.length, 1, "y la alerta no se repite en bucle");
  watcher.stop();
});

test("dos instancias con la misma época y claves distintas: fork, y ninguna gana", async () => {
  limpiar();
  const watcher = vigilante();
  /* Fijar de nuevo desbloquea lo anterior: la interfaz llegó con una identidad,
     y bloquear por un conflicto viejo sería desautorizar a quien ya decidió. */
  watcher.replace([vigilancia]);

  modo = "fork";
  await sondear(watcher);
  assert.deepEqual(avisos, []);
  assert.deepEqual(alertas, [{ kind: "identity_conflict", url: ORIGEN, fingerprint: huellaDe(jwkDe(impostor)) }]);
  watcher.stop();
});

test("una instancia que habla otro protocolo no es una impostora ni una ausencia", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);

  modo = "protocolo";
  await sondear(watcher);
  assert.deepEqual(avisos, [], "no se anuncia como vuelta algo con lo que no podemos hablar");
  assert.deepEqual(alertas, [{ kind: "protocol_incompatible", url: ORIGEN, protocol: "v2" }]);

  const guardado = JSON.parse(readFileSync(statePath, "utf8")) as Array<{ offline_since: number | null; blocked: boolean }>;
  assert.equal(guardado[0]!.offline_since, null, "contesta: no está caída");
  assert.equal(guardado[0]!.blocked, false, "y se sigue mirando por si su anfitrión la actualiza");

  // Se actualiza y vuelve a hablar nuestro idioma: se recupera sola.
  modo = "normal";
  await sondearLargo(watcher);
  assert.equal(alertas.length, 1, "y no se alerta dos veces del mismo problema");
  watcher.stop();
});

/* ── membresía revocada ─────────────────────────────────────────────── */

test("perder la membresía borra la vigilancia y el nombre guardado", async () => {
  limpiar();
  const watcher = vigilante();
  watcher.replace([vigilancia]);
  await watcher.tick();

  assert.equal(watcher.forget(ORIGEN), true);
  const guardado = JSON.parse(readFileSync(statePath, "utf8")) as unknown[];
  assert.deepEqual(guardado, [], "ni la dirección ni el nombre de una comunidad de la que te echaron");

  const antes = peticiones.length;
  await sondear(watcher, 2);
  assert.equal(peticiones.length, antes, "y deja de sondearse en el acto");

  assert.equal(watcher.forget(ORIGEN), false, "olvidar lo ya olvidado no es un error, es un no");
  assert.equal(watcher.forget("no es una url"), false);
  watcher.stop();
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
