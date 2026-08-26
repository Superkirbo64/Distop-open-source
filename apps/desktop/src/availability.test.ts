/**
 * Las reglas de la vigilancia, sin arrancar Electron.
 *   node --test "src/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type JsonWebKey } from "node:crypto";
import type { SuccessionCert } from "@distop/protocol";
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
  pinnedRef,
  protocolMismatch,
  provenOrigin,
  stableWatchUrl,
  verifyChain,
  verifyProof,
  type KnownIdentity,
  type SignedProof,
  type WatchTiming,
} from "./availability-policy.ts";

const AHORA = 1_756_100_000_000;
const URL_FIJA = "https://equipo.tailnet.ts.net";
const URL_NUEVA = "https://el-portatil-de-ana.tailnet.ts.net";
const NONCE = "nonce-de-prueba";

const propia = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ajena = generateKeyPairSync("ec", { namedCurve: "P-256" });
const sucesora = generateKeyPairSync("ec", { namedCurve: "P-256" });

const huellaDe = (jwk: unknown): string => createHash("sha256").update(canonicalJson(jwk)).digest("base64url");
const jwkDe = (par: typeof propia): JsonWebKey => par.publicKey.export({ format: "jwk" }) as JsonWebKey;

const jwk = jwkDe(propia);
const huella = huellaDe(jwk);
const jwkSucesora = jwkDe(sucesora);
const huellaSucesora = huellaDe(jwkSucesora);

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
  const public_key = opciones.declarada ?? jwkDe(firmante);
  const signature = sign("sha256", Buffer.from(canonicalJson(payload)), {
    key: firmante.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return { payload, signature, public_key, fingerprint: huellaDe(public_key) };
}

/** Un eslabón de sucesión, firmado como lo firma el servidor. */
function certificar(opciones: {
  firmante?: typeof propia;
  lineage_id?: string;
  from_instance_id?: string;
  from_epoch?: number;
  from_fingerprint?: string;
  to_instance_id?: string;
  to_epoch?: number;
  to_fingerprint?: string;
  to_public_key?: JsonWebKey;
  allowed_origins?: string[];
  not_before?: number;
  expires_at?: number;
} = {}): SuccessionCert {
  const firmante = opciones.firmante ?? propia;
  const signer_public_key = jwkDe(firmante);
  const payload = {
    t: "DISTOP_SUCCESSION_CERT" as const,
    version: 1 as const,
    lineage_id: opciones.lineage_id ?? "linaje-1",
    from_instance_id: opciones.from_instance_id ?? "instancia-1",
    from_epoch: opciones.from_epoch ?? 3,
    from_fingerprint: opciones.from_fingerprint ?? huella,
    to_instance_id: opciones.to_instance_id ?? "instancia-2",
    to_epoch: opciones.to_epoch ?? 4,
    to_fingerprint: opciones.to_fingerprint ?? huellaSucesora,
    to_public_key: (opciones.to_public_key ?? jwkSucesora) as Record<string, unknown>,
    allowed_origins: opciones.allowed_origins ?? [URL_NUEVA],
    issued_at: AHORA - 10_000,
    not_before: opciones.not_before ?? AHORA - 10_000,
    expires_at: opciones.expires_at ?? AHORA + 86_400_000,
    handover_id: "relevo-1",
  };
  return {
    payload,
    signature: sign("sha256", Buffer.from(canonicalJson(payload)), {
      key: firmante.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url"),
    signer_public_key: signer_public_key as Record<string, unknown>,
    signer_fingerprint: huellaDe(signer_public_key),
  };
}

const reloj = (cambios: Partial<WatchTiming> = {}): WatchTiming => ({
  failures: 0,
  offline_since: null,
  last_notification: 0,
  next_check: 0,
  moved_origin: null,
  blocked: false,
  last_outcome: null,
  ...cambios,
});

/* ── identidad ─────────────────────────────────────────────────────── */

test("una prueba firmada por la instancia fijada vale", () => {
  assert.equal(verifyProof(conocida, prueba(), NONCE, AHORA), "available_same");
});

test("una firma manipulada no vale", () => {
  const rota = prueba();
  rota.payload.epoch = 3;
  rota.signature = `${rota.signature.slice(0, -4)}AAAA`;
  assert.equal(verifyProof(conocida, rota, NONCE, AHORA), "unavailable");
});

test("otra clave no se cuela declarando la huella buena", () => {
  /* El atacante firma con su clave pero dice ser la fijada: la huella se
     recalcula sobre la clave que llega, así que no cuadra. Y ni siquiera llega
     a contarse como conflicto: mentir sobre tu propia huella es basura, no una
     afirmación que merezca una alarma. */
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

test("otro linaje es otra comunidad, no un impostor", () => {
  assert.equal(verifyProof(conocida, prueba({ lineage_id: "otro-linaje" }), NONCE, AHORA), "unavailable");
});

test("una instancia en reserva o retirada tampoco es la que sirve", () => {
  assert.equal(verifyProof(conocida, prueba({ role: "STANDBY" }), NONCE, AHORA), "unavailable");
  assert.equal(verifyProof(conocida, prueba({ role: "SUPERSEDED" }), NONCE, AHORA), "unavailable");
});

test("una prueba ausente o vacía no rompe nada", () => {
  assert.equal(verifyProof(conocida, null, NONCE, AHORA), "unavailable");
  assert.equal(verifyProof(conocida, {} as SignedProof, NONCE, AHORA), "unavailable");
});

/* ── lo que A1 final añade: sucesión, fork y protocolo ──────────────── */

test("una época mayor es una afirmación, no todavía una mudanza", () => {
  /* Firma bien y dice continuar la línea. Hasta que enseñe la cadena no es
     "se trasladó": es alguien pidiendo que le creas. */
  const alegada = prueba({ epoch: 4, instance_id: "instancia-2" }, { firmante: sucesora });
  assert.equal(verifyProof(conocida, alegada, NONCE, AHORA), "successor_claimed");
});

test("misma época y otra clave es un fork, y eso es una alarma", () => {
  /* Las dos parecen legítimas desde fuera y las dos firman de verdad. Elegir
     una sería entregarle la sesión a quien quizá no es. */
  assert.equal(verifyProof(conocida, prueba({}, { firmante: ajena }), NONCE, AHORA), "identity_conflict");
});

test("otra versión de protocolo se distingue de un impostor", () => {
  const otra = prueba({ protocol: "v2" });
  assert.equal(verifyProof(conocida, otra, NONCE, AHORA), "protocol_incompatible");
  assert.equal(verifyProof(conocida, prueba({ protocol: "v1" }), NONCE, AHORA), "available_same");
  assert.equal(protocolMismatch(undefined), false, "no decir la versión no es decir una mala");
  assert.equal(protocolMismatch(""), false);
});

test("una cadena de un eslabón lleva de la clave fijada a la del sucesor", () => {
  const resultado = verifyChain(pinnedRef(conocida), [certificar()], AHORA);
  assert.ok(resultado);
  assert.equal(resultado.final.epoch, 4);
  assert.equal(resultado.final.instance_id, "instancia-2");
  assert.equal(resultado.final.fingerprint, huellaSucesora);
  assert.deepEqual(resultado.origins, [URL_NUEVA]);
});

test("dos eslabones encadenan; uno que no arranca donde acaba el anterior, no", () => {
  const segundo = certificar({
    firmante: sucesora,
    from_instance_id: "instancia-2",
    from_epoch: 4,
    from_fingerprint: huellaSucesora,
    to_instance_id: "instancia-3",
    to_epoch: 5,
    to_fingerprint: huellaDe(jwkDe(ajena)),
    to_public_key: jwkDe(ajena),
  });
  const buena = verifyChain(pinnedRef(conocida), [certificar(), segundo], AHORA);
  assert.equal(buena?.final.epoch, 5);
  assert.equal(buena?.final.instance_id, "instancia-3");

  /* El mismo segundo eslabón, solo, no vale: no lo firma quien tenías fijado. */
  assert.equal(verifyChain(pinnedRef(conocida), [segundo], AHORA), null);
});

test("una cadena que salta, repite o retrocede la época no vale", () => {
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ to_epoch: 7 })], AHORA), null, "saltar");
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ to_epoch: 3 })], AHORA), null, "repetir");
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ to_epoch: 2 })], AHORA), null, "retroceder");
});

test("una cadena de otro linaje, caducada o aún no válida no vale", () => {
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ lineage_id: "otro" })], AHORA), null);
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ expires_at: AHORA - 1 })], AHORA), null);
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ not_before: AHORA + 60_000 })], AHORA), null);
});

test("una cadena firmada por quien no es el predecesor no vale", () => {
  /* Certificado impecable, firmado por alguien que no es la clave fijada. Es el
     ataque entero en una línea: sin este control basta con tener una clave. */
  assert.equal(verifyChain(pinnedRef(conocida), [certificar({ firmante: ajena })], AHORA), null);
});

test("una firma rota en la cadena tira la cadena entera", () => {
  const cert = certificar();
  cert.signature = `${cert.signature.slice(0, -4)}AAAA`;
  assert.equal(verifyChain(pinnedRef(conocida), [cert], AHORA), null);
});

test("una cadena vacía, larguísima o que no es una lista no vale", () => {
  assert.equal(verifyChain(pinnedRef(conocida), [], AHORA), null);
  assert.equal(verifyChain(pinnedRef(conocida), null, AHORA), null);
  assert.equal(verifyChain(pinnedRef(conocida), Array.from({ length: 17 }, () => certificar()), AHORA), null);
});

test("el destino de una mudanza sale del certificado, no del cuerpo", () => {
  const cadena = verifyChain(pinnedRef(conocida), [certificar()], AHORA)!;
  assert.equal(provenOrigin(URL_NUEVA, cadena), URL_NUEVA);
  assert.equal(provenOrigin(`${URL_NUEVA}/`, cadena), URL_NUEVA, "la barra final es la misma dirección");
  assert.equal(provenOrigin("https://el-sitio-del-atacante.example", cadena), null, "no firmado, no se va");
  assert.equal(provenOrigin("http://el-portatil-de-ana.tailnet.ts.net", cadena), null, "sin TLS no");
  assert.equal(provenOrigin(null, cadena), null);

  const sinOrigenes = verifyChain(pinnedRef(conocida), [certificar({ allowed_origins: [] })], AHORA)!;
  assert.equal(provenOrigin(URL_NUEVA, sinOrigenes), null, "un sucesor que no declaró dirección no redirige");
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
  const vuelta = applyCheck(timing, "available_same", AHORA + 40_000);
  assert.equal(vuelta.notify, null);
  assert.equal(vuelta.timing.failures, 0);
  assert.equal(vuelta.timing.offline_since, null);
});

test("una ausencia de verdad avisa exactamente una vez", () => {
  let timing = reloj();
  timing = applyCheck(timing, "unavailable", AHORA).timing;
  timing = applyCheck(timing, "unavailable", AHORA + 60_000).timing;

  const vuelta = applyCheck(timing, "available_same", AHORA + CAIDA_MINIMA_MS + 1_000);
  assert.deepEqual(vuelta.notify, { kind: "back" });

  /* Si la conexión oscila, el segundo regreso ya no vuelve a avisar. */
  let siguiente = applyCheck(vuelta.timing, "unavailable", AHORA + 200_000).timing;
  siguiente = applyCheck(siguiente, "unavailable", AHORA + 260_000).timing;
  const rebote = applyCheck(siguiente, "available_same", AHORA + 400_000);
  assert.equal(rebote.notify, null, "dentro del silencio no se repite");

  const mucho = applyCheck(siguiente, "available_same", AHORA + SILENCIO_ENTRE_AVISOS_MS + 400_000);
  assert.deepEqual(mucho.notify, { kind: "back" }, "pasada la media hora sí vuelve a avisar");
});

test("una vuelta que nadie echó de menos no es noticia", () => {
  const resultado = applyCheck(reloj(), "available_same", AHORA);
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

/* ── los resultados nuevos, en el reloj ─────────────────────────────── */

test("una mudanza demostrada se anuncia una vez por destino", () => {
  /* Sin ausencia previa: una mudanza es noticia aunque la comunidad nunca
     pareciera caída, porque la dirección a la que ir cambió. */
  const primera = applyCheck(reloj(), "available_successor", AHORA, 0, URL_NUEVA);
  assert.deepEqual(primera.notify, { kind: "moved", origin: URL_NUEVA });
  assert.equal(primera.timing.moved_origin, URL_NUEVA);
  assert.equal(primera.timing.next_check, AHORA + INTERVALO_LARGO_MS);

  const repetida = applyCheck(primera.timing, "available_successor", AHORA + 600_000, 0, URL_NUEVA);
  assert.equal(repetida.notify, null, "el mismo traslado no se cuenta cada cinco minutos");

  const otroDestino = applyCheck(primera.timing, "available_successor", AHORA + 600_000, 0, "https://tercera.ts.net");
  assert.deepEqual(otroDestino.notify, { kind: "moved", origin: "https://tercera.ts.net" }, "otro destino sí");
});

test("si vuelve la de siempre, la mudanza anunciada deja de valer", () => {
  const mudada = applyCheck(reloj(), "available_successor", AHORA, 0, URL_NUEVA).timing;
  assert.equal(mudada.moved_origin, URL_NUEVA);
  const vuelve = applyCheck(mudada, "available_same", AHORA + 60_000);
  assert.equal(vuelve.timing.moved_origin, null);
});

test("un conflicto de identidad no avisa de nada y detiene el sondeo", () => {
  const conflicto = applyCheck(reloj({ failures: 2, offline_since: AHORA - 200_000 }), "identity_conflict", AHORA);
  assert.equal(conflicto.notify, null, "no se anuncia una vuelta que no se puede demostrar");
  assert.equal(conflicto.timing.blocked, true, "y se deja de llamar a esa puerta");
  assert.equal(conflicto.timing.next_check, AHORA + INTERVALO_LARGO_MS);
});

test("perder la membresía quita la vigilancia, sin avisos", () => {
  const fuera = applyCheck(reloj(), "membership_revoked", AHORA);
  assert.equal(fuera.notify, null);
  assert.equal(fuera.timing.blocked, true);
});

test("un protocolo incompatible no es una ausencia", () => {
  const otra = applyCheck(reloj(), "protocol_incompatible", AHORA);
  assert.equal(otra.notify, null);
  assert.equal(otra.timing.offline_since, null, "contesta: no está caída, es que no nos entendemos");
  assert.equal(otra.timing.blocked, false, "y se vuelve a mirar por si la actualizan");
  assert.equal(otra.timing.next_check, AHORA + INTERVALO_LARGO_MS);
});
