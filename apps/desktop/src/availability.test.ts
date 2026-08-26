/**
 * Las reglas de la vigilancia, sin arrancar Electron.
 *   node --test "src/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import {
  CAIDA_LARGA_MS,
  CAIDA_MINIMA_MS,
  DISPERSION_MS,
  INTERVALO_LARGO_MS,
  INTERVALO_NORMAL_MS,
  SILENCIO_ENTRE_AVISOS_MS,
  applyCheck,
  canonicalJson,
  healthCounts,
  stableWatchUrl,
  verifyProof,
  type KnownIdentity,
  type SignedProof,
  type WatchTiming,
} from "./availability-policy.ts";

const AHORA = 1_756_100_000_000;
const URL_FIJA = "https://equipo.tailnet.ts.net";
const NONCE = "nonce-de-prueba";

const propia = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ajena = generateKeyPairSync("ec", { namedCurve: "P-256" });
const jwk = propia.publicKey.export({ format: "jwk" }) as JsonWebKey;
const huella = createHash("sha256").update(canonicalJson(jwk)).digest("base64url");

const conocida: KnownIdentity = {
  url: URL_FIJA,
  instance_id: "instancia-1",
  lineage_id: "linaje-1",
  epoch: 3,
  identity_fingerprint: huella,
  identity_public_key: jwk,
};

function prueba(
  cambios: Partial<SignedProof["payload"]> = {},
  opciones: { firmante?: typeof propia; declarada?: JsonWebKey } = {},
): SignedProof {
  const payload = {
    t: "DISTOP_INSTANCE_PROOF",
    instance_id: "instancia-1",
    lineage_id: "linaje-1",
    epoch: 3,
    role: "PRIMARY",
    origin: URL_FIJA,
    nonce: NONCE,
    issued_at: AHORA - 1_000,
    expires_at: AHORA + 60_000,
    ...cambios,
  };
  const firmante = opciones.firmante ?? propia;
  const public_key = opciones.declarada ?? (firmante.publicKey.export({ format: "jwk" }) as JsonWebKey);
  const signature = sign("sha256", Buffer.from(canonicalJson(payload)), {
    key: firmante.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return {
    payload,
    signature,
    public_key,
    fingerprint: createHash("sha256").update(canonicalJson(public_key)).digest("base64url"),
  };
}

const reloj = (cambios: Partial<WatchTiming> = {}): WatchTiming => ({
  failures: 0,
  offline_since: null,
  last_notification: 0,
  next_check: 0,
  ...cambios,
});

/* ── identidad ─────────────────────────────────────────────────────── */

test("una prueba firmada por la instancia fijada vale", () => {
  assert.equal(verifyProof(conocida, prueba(), NONCE, AHORA), "available");
});

test("una firma manipulada no vale", () => {
  const rota = prueba();
  rota.payload.epoch = 3;
  rota.signature = `${rota.signature.slice(0, -4)}AAAA`;
  assert.equal(verifyProof(conocida, rota, NONCE, AHORA), "unavailable");
});

test("otra clave no se cuela declarando la huella buena", () => {
  /* El atacante firma con su clave pero dice ser la fijada: la huella se
     recalcula sobre la clave que llega, así que no cuadra. */
  const suplantada = prueba({}, { firmante: ajena });
  suplantada.fingerprint = huella;
  assert.equal(verifyProof(conocida, suplantada, NONCE, AHORA), "unavailable");
});

test("una respuesta grabada no sirve para otro nonce", () => {
  assert.equal(verifyProof(conocida, prueba(), "otro-nonce", AHORA), "unavailable");
});

test("una prueba conseguida en otra dirección no vale aquí", () => {
  assert.equal(verifyProof(conocida, prueba({ origin: "https://otro.ts.net" }), NONCE, AHORA), "unavailable");
});

test("una prueba caducada no vale", () => {
  assert.equal(verifyProof(conocida, prueba({ expires_at: AHORA - 1 }), NONCE, AHORA), "unavailable");
});

test("una época menor es una copia vieja sirviendo, y nunca se acepta", () => {
  assert.equal(verifyProof(conocida, prueba({ epoch: 2 }), NONCE, AHORA), "unavailable");
});

test("una época mayor tampoco vale: sin cadena firmada no se sabe quién es", () => {
  /* Podría ser un relevo legítimo o alguien que se puso en esa dirección con un
     número más alto. Hasta C2 no hay forma de distinguirlos, así que no. */
  assert.equal(verifyProof(conocida, prueba({ epoch: 4 }), NONCE, AHORA), "unavailable");
});

test("una instancia en reserva o retirada tampoco es la que sirve", () => {
  assert.equal(verifyProof(conocida, prueba({ role: "STANDBY" }), NONCE, AHORA), "unavailable");
  assert.equal(verifyProof(conocida, prueba({ role: "SUPERSEDED" }), NONCE, AHORA), "unavailable");
});

test("una prueba ausente o vacía no rompe nada", () => {
  assert.equal(verifyProof(conocida, null, NONCE, AHORA), "unavailable");
  assert.equal(verifyProof(conocida, {} as SignedProof, NONCE, AHORA), "unavailable");
});

/* ── qué cuenta como disponible ────────────────────────────────────── */

test("arrancando o en mantenimiento todavía no es estar disponible", () => {
  assert.equal(healthCounts("ONLINE"), true);
  assert.equal(healthCounts("DEGRADED"), true);
  for (const estado of ["STARTING", "MAINTENANCE", "UPDATING", "OFFLINE", "", undefined]) {
    assert.equal(healthCounts(estado), false, `${String(estado)} no debería contar`);
  }
});

test("solo se vigilan direcciones que puedan volver a ser la misma", () => {
  assert.equal(stableWatchUrl(URL_FIJA), URL_FIJA);
  assert.equal(stableWatchUrl(`${URL_FIJA}/`), URL_FIJA);
  assert.equal(stableWatchUrl("http://equipo.tailnet.ts.net"), null, "sin TLS no");
  assert.equal(stableWatchUrl("https://algo.trycloudflare.com"), null, "el túnel rápido estrena URL cada vez");
  assert.equal(stableWatchUrl("https://equipo.ts.net/ruta"), null);
  assert.equal(stableWatchUrl("https://u:p@equipo.ts.net"), null);
  assert.equal(stableWatchUrl("no es una url"), null);
});

/* ── ruido ─────────────────────────────────────────────────────────── */

test("dos fallos cortos no producen un aviso falso", () => {
  let timing = reloj();
  timing = applyCheck(timing, "unavailable", AHORA).timing;
  timing = applyCheck(timing, "unavailable", AHORA + 20_000).timing;
  assert.equal(timing.failures, 2);

  /* Volvió a los 40 segundos: fue un reinicio, no una ausencia. */
  const vuelta = applyCheck(timing, "available", AHORA + 40_000);
  assert.equal(vuelta.notify, null);
  assert.equal(vuelta.timing.failures, 0);
  assert.equal(vuelta.timing.offline_since, null);
});

test("una ausencia de verdad avisa exactamente una vez", () => {
  let timing = reloj();
  timing = applyCheck(timing, "unavailable", AHORA).timing;
  timing = applyCheck(timing, "unavailable", AHORA + 60_000).timing;

  const vuelta = applyCheck(timing, "available", AHORA + CAIDA_MINIMA_MS + 1_000);
  assert.equal(vuelta.notify, "back");

  /* Si la conexión oscila, el segundo regreso ya no vuelve a avisar. */
  let siguiente = applyCheck(vuelta.timing, "unavailable", AHORA + 200_000).timing;
  siguiente = applyCheck(siguiente, "unavailable", AHORA + 260_000).timing;
  const rebote = applyCheck(siguiente, "available", AHORA + 400_000);
  assert.equal(rebote.notify, null, "dentro del silencio no se repite");

  const mucho = applyCheck(siguiente, "available", AHORA + SILENCIO_ENTRE_AVISOS_MS + 400_000);
  assert.equal(mucho.notify, "back", "pasada la media hora sí vuelve a avisar");
});

test("una vuelta que nadie echó de menos no es noticia", () => {
  const resultado = applyCheck(reloj(), "available", AHORA);
  assert.equal(resultado.notify, null, "sin ausencia previa no hay nada que anunciar");
  assert.equal(resultado.timing.next_check, AHORA + INTERVALO_NORMAL_MS);
});

test("tras un buen rato caída se espacia el sondeo", () => {
  const reciente = applyCheck(reloj({ failures: 1, offline_since: AHORA - 60_000 }), "unavailable", AHORA);
  assert.equal(reciente.timing.next_check, AHORA + INTERVALO_NORMAL_MS);

  const larga = applyCheck(reloj({ failures: 20, offline_since: AHORA - CAIDA_LARGA_MS }), "unavailable", AHORA);
  assert.equal(larga.timing.next_check, AHORA + INTERVALO_LARGO_MS, "una comunidad apagada días no recibe 4.000 sondeos");
});

test("la dispersión reparte a diez clientes y nunca se sale de su tope", () => {
  const momentos = Array.from({ length: 10 }, (_, i) =>
    applyCheck(reloj(), "unavailable", AHORA, i * 1_700).timing.next_check,
  );
  assert.equal(new Set(momentos).size, 10, "diez clientes no consultan a la vez");
  for (const momento of momentos) {
    assert.ok(momento >= AHORA + INTERVALO_NORMAL_MS);
    assert.ok(momento <= AHORA + INTERVALO_NORMAL_MS + DISPERSION_MS);
  }
  const desbordada = applyCheck(reloj(), "unavailable", AHORA, 999_999).timing.next_check;
  assert.equal(desbordada, AHORA + INTERVALO_NORMAL_MS + DISPERSION_MS);
});
