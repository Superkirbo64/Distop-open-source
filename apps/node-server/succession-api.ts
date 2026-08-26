/**
 * Rutas del relevo planificado (C2).
 *
 * Dos públicos distintos y por eso dos formas de autenticar:
 *
 *   - Quien hospeda, desde su propio ordenador, autoriza sucesores, arranca el
 *     relevo, lo cancela y lo activa. Sesión + autoridad de anfitrión + local.
 *   - La máquina sucesora, que no tiene cuenta en esta instancia, se presenta
 *     con un código de un solo uso y a partir de ahí usa un testigo de
 *     transferencia. No es una sesión de usuario y no vale para nada más.
 *
 * La transferencia es **pull**: el sucesor descarga. El origen está detrás de un
 * túnel y es el único que sabemos alcanzable —es así como llegan los miembros—,
 * mientras que del sucesor no sabemos nada todavía.
 */
import { createPublicKey, randomBytes, verify, type JsonWebKey } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, uuidv7 } from "@distop/protocol";
import { config } from "./config.ts";
import { audit, db } from "./db.ts";
import { createHandoverBundle } from "./backup.ts";
import {
  HANDLED,
  badRequest,
  conflict,
  forbidden,
  isLocalRequest,
  notFound,
  rateLimit,
  readJson,
  requireAuth,
  route,
  v,
  HttpError,
  type Ctx,
} from "./http.ts";
import { isInstanceOwner } from "./auth.ts";
import {
  instanceEpoch,
  instanceFingerprint,
  instancePublicKey,
  instanceRole,
  setInstanceStanding,
  LINEAGE_ID,
} from "./identity.ts";
import { closeGateway } from "./gateway.ts";
import { pauseWrites, waitForWrites } from "./lifecycle.ts";
import {
  SuccessionError,
  activeHandover,
  authorizeSuccessor,
  currentIdentity,
  enrolSuccessor,
  findHandover,
  findSuccessor,
  listSuccessors,
  recordSuccession,
  revokeSuccessor,
  setHandoverState,
  setTransferToken,
  startHandover,
  successionRecord,
  successorByToken,
  type HandoverRow,
  type SuccessorRow,
} from "./succession.ts";

const DATA_DIR = dirname(resolve(config.databasePath));
const HANDOVER_DIR = join(DATA_DIR, "handover");

/**
 * El testigo se guarda hasheado EN LA BASE, no en un mapa en memoria.
 *
 * Un relevo de treinta gigas puede cruzar un reinicio del servidor. Con el
 * testigo solo en memoria, ese reinicio obligaría a volver a emparejarse — y el
 * código de emparejamiento es de un solo uso, así que no queda ninguno con el
 * que reintentar.
 */
function nuevoTestigo(successorId: string): string {
  const token = randomBytes(32).toString("base64url");
  setTransferToken(successorId, token);
  return token;
}

/** El sucesor que hay detrás de una cabecera `authorization`, o nada. */
function successorDe(ctx: Ctx): SuccessorRow {
  const header = ctx.req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw forbidden("Falta el testigo de transferencia.");
  const fila = successorByToken(token);
  if (!fila) throw forbidden("Ese testigo de transferencia no vale.");
  db.prepare("UPDATE successors SET last_seen = ? WHERE id = ?").run(Date.now(), fila.id);
  return fila;
}

function requireHostLocal(ctx: Ctx) {
  const auth = requireAuth(ctx);
  if (!isInstanceOwner(auth.user.id)) throw forbidden("Esto solo puede hacerlo quien hospeda la instancia.");
  if (!isLocalRequest(ctx)) throw forbidden("El relevo solo se maneja desde el propio equipo anfitrión.");
  return auth;
}

function comoJson(fila: HandoverRow) {
  return {
    id: fila.id,
    successor_id: fila.successor_id,
    state: fila.state,
    unplanned: fila.unplanned === 1,
    reason: fila.reason,
    to_epoch: fila.to_epoch,
    announced_at: fila.announced_at,
    activates_at: fila.activates_at,
    started_at: fila.started_at,
    finished_at: fila.finished_at,
    error_code: fila.error_code,
    has_receipt: fila.receipt !== null,
  };
}

function sucesorJson(fila: SuccessorRow) {
  return {
    id: fila.id,
    label: fila.label,
    /* La huella sí, la clave entera no hace falta para una lista, y el hash del
       código de emparejamiento no sale de la base jamás. */
    fingerprint: fila.fingerprint,
    instance_id: fila.instance_id,
    origin: fila.origin,
    enrolled: fila.enrolled_at !== null,
    created_at: fila.created_at,
    expires_at: fila.expires_at,
    last_seen: fila.last_seen,
    revoked: fila.revoked_at !== null,
  };
}

function comoHttp(error: unknown): never {
  if (error instanceof SuccessionError) {
    const estado = error.code === "HANDOVER_IN_PROGRESS" ? 409 : 400;
    throw new HttpError(estado, error.code, error.message);
  }
  throw error;
}

/* ── lado del anfitrión ───────────────────────────────────────────────── */

route("GET", "/api/v1/instance/successors", (ctx) => {
  requireHostLocal(ctx);
  return listSuccessors().map(sucesorJson);
});

route("POST", "/api/v1/instance/successors", async (ctx) => {
  const auth = requireHostLocal(ctx);
  /* Diez y no cinco: quien prepara dos o tres equipos de golpe llega a cinco
     sin hacer nada raro. La defensa de verdad es que esta ruta exige
     autoridad de anfitrión Y petición local; el límite es profundidad. */
  rateLimit(`successor:${auth.user.id}`, 10, 60_000);
  const body = await readJson(ctx);
  const label = v.string(body, "label", { min: 1, max: 80 });

  const { row, code } = authorizeSuccessor({ label, createdBy: auth.user.id });
  for (const comunidad of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
    audit(comunidad.id, auth.user.id, "INSTANCE_SUCCESSOR_AUTHORIZED", row.id, { label });
  }
  /* El código se enseña una sola vez. Volver a mostrarlo obligaría a guardarlo
     en claro, y la base acaba dentro de una copia de seguridad. */
  return { ...sucesorJson(row), enrol_code: code, enrol_code_shown_once: true };
});

route("DELETE", "/api/v1/instance/successors/:id", (ctx) => {
  const auth = requireHostLocal(ctx);
  const fila = findSuccessor(ctx.params.id ?? "");
  if (!fila) throw notFound("Ese sucesor no existe.");
  revokeSuccessor(fila.id);
  for (const comunidad of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
    audit(comunidad.id, auth.user.id, "INSTANCE_SUCCESSOR_REVOKED", fila.id, { label: fila.label });
  }
  return { ok: true };
});

route("GET", "/api/v1/instance/handover", (ctx) => {
  requireHostLocal(ctx);
  const fila = activeHandover();
  return fila ? comoJson(fila) : { state: "NONE" };
});

route("POST", "/api/v1/instance/handover", async (ctx) => {
  const auth = requireHostLocal(ctx);
/* Arrancar y cancelar un relevo es un ciclo normal —se prepara, se ve que
     falta algo, se rehace— y cinco intentos por minuto se agotan solos. Como en
     la ruta de sucesores, lo que protege de verdad es exigir anfitrión + local. */
  rateLimit(`handover:${auth.user.id}`, 10, 60_000);
  const body = await readJson(ctx);
  const successorId = v.string(body, "successor_id", { min: 1, max: 64 });
  const unplanned = v.bool(body, "unplanned", false);
  const reason = v.optionalString(body, "reason", { max: 400 }) ?? null;

  if (unplanned && body.confirm !== true) {
    /* Saltarse el aviso de 24 h es una decisión, no un descuido: se pide en voz
       alta y queda escrito que no hubo aviso. */
    throw badRequest("Un relevo de emergencia se salta el aviso de 24 h: confírmalo con confirm=true.");
  }

  let resultado;
  try {
    resultado = startHandover({ successorId, actorId: auth.user.id, unplanned, reason });
  } catch (error) {
    comoHttp(error);
  }

  /* El bundle se prepara ya: si el equipo de origen muere mañana, lo que falta
     es activar, no copiar.

     Se cifra con una clave PROPIA del relevo, no con el testigo de acceso. Son
     dos cosas distintas y mezclarlas se paga: el testigo autentica peticiones y
     se puede rotar; la clave descifra un fichero que ya está escrito. Y sobre
     todo, el testigo se emite al emparejarse —antes de que este relevo exista—,
     así que reutilizarlo aquí obligaría a reemparejar en cada intento. */
  const sucesor = findSuccessor(successorId)!;
  const bundleKey = randomBytes(32).toString("base64url");
  db.prepare("UPDATE handovers SET bundle_key = ? WHERE id = ?").run(bundleKey, resultado.handover.id);
  bundles.set(sucesor.id, { ready: null, error: null });
  prepararBundle(resultado.handover.id, sucesor.id, bundleKey);

  return { ...comoJson(resultado.handover), certificate: resultado.cert };
});

route("DELETE", "/api/v1/instance/handover", (ctx) => {
  const auth = requireHostLocal(ctx);
  const fila = activeHandover();
  if (!fila) throw notFound("No hay ningún relevo en marcha.");
  /* Cancelar durante el corte SÍ vale, y es importante que valga: si el sucesor
     no aparece, la alternativa sería una comunidad congelada para siempre. Solo
     deja de valer cuando ya se cambió el papel, y entonces el estado ya no está
     entre los vivos. */
  soltarCongelacion?.();
  soltarCongelacion = null;
  setHandoverState(fila.id, "ABORTED", "CANCELLED_BY_HOST");
  void limpiarBundle(fila.id);
  for (const comunidad of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
    audit(comunidad.id, auth.user.id, "INSTANCE_HANDOVER_CANCELLED", fila.id, {});
  }
  /* Cancelar antes de activar no toca la época: la línea sigue exactamente
     donde estaba y ningún cliente tiene que enterarse de nada. */
  return { ...comoJson(findHandover(fila.id)!), epoch: instanceEpoch() };
});

/**
 * El corte. A partir de aquí esta instancia deja de mandar.
 *
 * Orden: congelar → esperar a los que estaban escribiendo → exigir el recibo
 * firmado del sucesor → dejar constancia de a quién pasó la línea → cambiar el
 * papel → cerrar el gateway. Nunca hay un intervalo con dos PRIMARY aceptando
 * cambios, porque el papel cambia después de congelar y antes de soltar.
 */
/**
 * El corte, en dos tiempos y no en uno.
 *
 * La copia grande se hizo al empezar el relevo, y entre eso y este momento la
 * comunidad ha seguido hablando: con un aviso de 24 h, un corte instantáneo
 * perdería un día entero de conversación sin que nadie se diera cuenta hasta
 * mucho después. Así que activar congela las escrituras, saca una copia final
 * —ya pequeña, es un rato de mensajes— y NO se retira hasta que el sucesor
 * confirma que también tiene esa.
 *
 * Mientras dura, la instancia sigue leyéndose y devuelve 503 a los cambios, con
 * su motivo. Si el sucesor no aparece, se cancela y todo vuelve a la normalidad
 * sin haber tocado la época.
 */
route("POST", "/api/v1/instance/handover/activate", async (ctx) => {
  requireHostLocal(ctx);
  const fila = activeHandover();
  if (!fila) throw notFound("No hay ningún relevo en marcha.");
  if (fila.state === "ACTIVATING") throw conflict("El corte ya está en marcha, esperando al sucesor.");
  if (fila.state !== "READY_TO_ACTIVATE") {
    throw conflict(
      fila.receipt === null
        ? "El sucesor todavía no ha confirmado que tiene la copia entera."
        : `El relevo está en ${fila.state}.`,
    );
  }
  if (Date.now() < fila.activates_at) {
    throw conflict("Todavía no ha pasado la ventana de aviso que se anunció a los miembros.");
  }

  const sucesor = findSuccessor(fila.successor_id);
  if (!sucesor) throw conflict("El sucesor de este relevo ya no existe.");
  if (!fila.certificate) throw conflict("Este relevo no tiene certificado; no se puede activar.");

  soltarCongelacion = pauseWrites("handover");
  setHandoverState(fila.id, "ACTIVATING");
  await waitForWrites();

  /* Copia final con todo congelado: a partir de aquí nadie escribe, así que lo
     que se lleve el sucesor es exactamente el estado con el que se retira A. */
  const bundleKey = randomBytes(32).toString("base64url");
  db.prepare("UPDATE handovers SET bundle_key = ?, receipt = NULL, bundle_hash = NULL WHERE id = ?").run(bundleKey, fila.id);
  bundles.set(sucesor.id, { ready: null, error: null });
  await limpiarBundle(fila.id);
  prepararBundle(fila.id, sucesor.id, bundleKey, false);

  return {
    ...comoJson(findHandover(fila.id)!),
    role: instanceRole(),
    waiting_for: "final_receipt",
    successor: { origin: sucesor.origin, instance_id: sucesor.instance_id },
  };
});

/** Se llama cuando el sucesor confirma la copia final: entonces sí, retirada. */
async function completarRelevo(fila: HandoverRow, sucesor: SuccessorRow): Promise<void> {
  const cert = JSON.parse(fila.certificate ?? "null") as ReturnType<typeof startHandover>["cert"] | null;
  if (!cert) throw conflict("Este relevo no tiene certificado; no se puede completar.");

  recordSuccession(cert, sucesor.origin);
  setInstanceStanding({ role: "SUPERSEDED" });
  setHandoverState(fila.id, "COMPLETED");
  for (const comunidad of db.prepare("SELECT id FROM communities").all() as Array<{ id: string }>) {
    audit(comunidad.id, sucesor.created_by ?? "sistema", "INSTANCE_HANDOVER_COMPLETED", fila.id, {
      successor: sucesor.label,
      to_epoch: fila.to_epoch,
      origin: sucesor.origin,
    });
  }
  /* Los clientes conectados se enteran ahora, no cuando lo intenten: 1001 es
     "me voy", y al reconectar recibirán el 410 con la dirección nueva. */
  await closeGateway(1001, "relevo completado");
  /* La congelación se suelta porque ya no hace falta: a partir de aquí lo que
     bloquea todo es el papel SUPERSEDED, que además dice a dónde ir. */
  soltarCongelacion?.();
  soltarCongelacion = null;
  await limpiarBundle(fila.id);
}

/* ── lado del sucesor ─────────────────────────────────────────────────── */

interface EstadoBundle {
  ready: string | null;
  error: string | null;
}
const bundles = new Map<string, EstadoBundle>();

/** Cómo soltar la congelación del corte, mientras dure. */
let soltarCongelacion: (() => void) | null = null;

function prepararBundle(handoverId: string, successorId: string, bundleKey: string, marcarSync = true): void {
  const arranque = setTimeout(() => {
    void (async () => {
      const filename = `bundle-${handoverId}.distop-backup`;
      try {
        await createHandoverBundle({ passphrase: bundleKey, directory: HANDOVER_DIR, filename });
        bundles.set(successorId, { ready: join(HANDOVER_DIR, filename), error: null });
        if (marcarSync) setHandoverState(handoverId, "STANDBY_SYNC");
      } catch (error) {
        bundles.set(successorId, { ready: null, error: error instanceof Error ? error.message : "BUNDLE_FAILED" });
        setHandoverState(handoverId, "FAILED", "BUNDLE_FAILED");
      }
    })();
  }, 0);
  arranque.unref();
}

async function limpiarBundle(handoverId: string): Promise<void> {
  await rm(join(HANDOVER_DIR, `bundle-${handoverId}.distop-backup`), { force: true }).catch(() => {});
}

route("POST", "/api/v1/succession/enrol", async (ctx) => {
  /* Sin sesión: la máquina sucesora no tiene cuenta aquí. Lo que la autoriza es
     un código de un solo uso que alguien le dio en persona o por teléfono. */
  rateLimit(`enrol:${ctx.ip}`, 10, 60_000);
  const body = await readJson(ctx);
  const code = v.string(body, "code", { min: 8, max: 64 });
  const instanceId = v.string(body, "instance_id", { min: 8, max: 64 });
  const origin = v.string(body, "origin", { min: 4, max: 300 });
  const publicKey = body.public_key;
  if (!publicKey || typeof publicKey !== "object" || Array.isArray(publicKey)) {
    throw badRequest("Falta la clave pública del sucesor.");
  }

  let fila: SuccessorRow;
  try {
    fila = enrolSuccessor({ code, instanceId, publicKey: publicKey as JsonWebKey, origin });
  } catch (error) {
    comoHttp(error);
  }

  const token = nuevoTestigo(fila.id);

  return {
    successor_id: fila.id,
    transfer_token: token,
    lineage_id: LINEAGE_ID,
    predecessor: currentIdentity(),
  };
});

route("GET", "/api/v1/succession/state", (ctx) => {
  const sucesor = successorDe(ctx);
  const relevo = db
    .prepare("SELECT * FROM handovers WHERE successor_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(sucesor.id) as HandoverRow | undefined;
  const estado = bundles.get(sucesor.id);
  const listo = Boolean(estado?.ready && existsSync(estado.ready));
  return {
    handover: relevo ? comoJson(relevo) : { state: "NONE" },
    certificate: relevo?.certificate ? (JSON.parse(relevo.certificate) as unknown) : null,
    bundle: {
      ready: listo,
      size: listo ? statSync(estado!.ready!).size : 0,
      error: estado?.error ?? null,
      /* La clave del bundle solo sale por aquí: canal autenticado, nunca en una
         URL ni en un log. Sin ella, el fichero descargado es ruido. */
      key: listo ? relevo?.bundle_key ?? null : null,
    },
    predecessor: currentIdentity(),
  };
});

/**
 * Descarga del bundle, con rangos.
 *
 * Reanudable a propósito: quien recibe una comunidad entera por una conexión
 * doméstica no puede permitirse que un corte a los treinta gigas signifique
 * empezar de cero. La integridad no depende del transporte —el bundle va
 * cifrado y autenticado por bloques—, así que un rango mal pedido produce un
 * fichero que no descifra, nunca uno que parece bueno.
 */
route("GET", "/api/v1/succession/bundle", (ctx) => {
  const sucesor = successorDe(ctx);
  const estado = bundles.get(sucesor.id);
  if (!estado?.ready || !existsSync(estado.ready)) {
    throw new HttpError(409, "BUNDLE_NOT_READY", "La copia del relevo todavía se está preparando.");
  }

  const total = statSync(estado.ready).size;
  const rango = String(ctx.req.headers.range ?? "");
  let desde = 0;
  let hasta = total - 1;
  if (rango.startsWith("bytes=")) {
    const [a, b] = rango.slice(6).split("-");
    const inicio = Number.parseInt(a ?? "", 10);
    const fin = Number.parseInt(b ?? "", 10);
    if (Number.isSafeInteger(inicio) && inicio >= 0) desde = inicio;
    if (Number.isSafeInteger(fin) && fin >= desde) hasta = Math.min(fin, total - 1);
    if (desde >= total) {
      ctx.res.writeHead(416, { "content-range": `bytes */${total}` });
      ctx.res.end();
      return HANDLED;
    }
  }

  const parcial = desde > 0 || hasta < total - 1;
  ctx.res.writeHead(parcial ? 206 : 200, {
    "content-type": "application/octet-stream",
    "content-length": String(hasta - desde + 1),
    "accept-ranges": "bytes",
    ...(parcial ? { "content-range": `bytes ${desde}-${hasta}/${total}` } : {}),
    "cache-control": "no-store",
  });
  createReadStream(estado.ready, { start: desde, end: hasta }).pipe(ctx.res);
  return HANDLED;
});

/**
 * El sucesor confirma que tiene la copia entera y verificada.
 *
 * El recibo va firmado con SU clave, la misma que quedó autorizada en el
 * certificado: sin eso, cualquiera con el testigo podría decir "ya está" y
 * empujar al anfitrión a retirarse sin que nadie tenga los datos.
 */
route("POST", "/api/v1/succession/receipt", async (ctx) => {
  const sucesor = successorDe(ctx);
  const body = await readJson(ctx);
  const relevo = db
    .prepare("SELECT * FROM handovers WHERE successor_id = ? ORDER BY started_at DESC LIMIT 1")
    .get(sucesor.id) as HandoverRow | undefined;
  if (!relevo || relevo.state === "COMPLETED" || relevo.state === "ABORTED") {
    throw conflict("No hay ningún relevo esperando confirmación.");
  }

  const bundleHash = v.string(body, "bundle_sha256", { min: 64, max: 64, pattern: /^[0-9a-f]{64}$/ });
  const firma = v.string(body, "signature", { min: 16, max: 500 });
  const payload = { t: "DISTOP_HANDOVER_RECEIPT", handover_id: relevo.id, bundle_sha256: bundleHash };

  let valida = false;
  try {
    valida = verify(
      "sha256",
      Buffer.from(canonicalJson(payload)),
      {
        key: createPublicKey({ key: JSON.parse(sucesor.public_key ?? "{}") as JsonWebKey, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      },
      Buffer.from(firma, "base64url"),
    );
  } catch {
    valida = false;
  }
  if (!valida) throw forbidden("Ese recibo no está firmado por la clave del sucesor.");

  const cortando = relevo.state === "ACTIVATING";
  db.prepare("UPDATE handovers SET receipt = ?, bundle_hash = ? WHERE id = ?").run(
    JSON.stringify({ payload, signature: firma }),
    bundleHash,
    relevo.id,
  );
  if (!cortando) setHandoverState(relevo.id, "READY_TO_ACTIVATE");
  else await completarRelevo(findHandover(relevo.id)!, sucesor);

  return { ...comoJson(findHandover(relevo.id)!), activates_at: relevo.activates_at, completed: cortando };
});

/** La cadena, para quien tenga fijada esta instancia y necesite seguirla. */
route("GET", "/api/v1/succession/chain", () => {
  const registro = successionRecord();
  return {
    lineage_id: LINEAGE_ID,
    identity: { epoch: instanceEpoch(), fingerprint: instanceFingerprint(), public_key: instancePublicKey() },
    superseded: registro !== null,
    successor_origin: registro?.origin ?? null,
    chain: registro ? [registro.certificate] : [],
  };
});

export { HANDOVER_DIR };
