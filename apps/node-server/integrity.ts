/**
 * Trabajo de integridad en segundo plano y su progreso publicado (§26).
 *
 * Completar los hashes de los adjuntos viejos puede durar horas en el disco de
 * un portátil. Dos exigencias, y las dos son de producto, no de ingeniería:
 *
 *   1. Se aparta. Mientras haya gente en una llamada, mientras se esté copiando
 *      o restaurando, o mientras el disco vaya justo, no compite por el disco.
 *   2. Se ve. Sin progreso publicado, quien hospeda no distingue "va por la
 *      mitad" de "lleva parado desde el martes" — y una copia de seguridad
 *      hecha a ciegas hereda esa duda.
 *
 * El scheduler vive aquí y no en storage.ts a propósito: para saber si hay una
 * llamada hay que preguntar a voice.ts, y voice.ts llega a storage.ts pasando
 * por entities.ts. Meter la decisión dentro de storage cerraría ese círculo.
 */
import type { AttachmentHashProgress, BackfillState, InstanceIntegrity } from "@distop/protocol";
import { freezeReason } from "./lifecycle.ts";
import {
  backfillAttachmentHashes,
  pendingHashCount,
  storageFreeMbOrNull,
  type AttachmentHashBackfillResult,
  type BackfillErrorCode,
} from "./storage.ts";
import { callParticipants } from "./voice.ts";

/** Filas por tanda. Suficiente para avanzar, corto para soltar el hilo a menudo. */
const LOTE = 25;
/** Respiro entre tandas mientras hay trabajo. */
const PASO_MS = 1_000;
/** Cuánto se espera antes de volver a mirar si la razón de la pausa sigue ahí. */
const REVISION_PAUSA_MS = 30_000;
/** Por debajo de esto el disco va justo y el trabajo de fondo se retira. */
const DISCO_MINIMO_MB = 256;

type PausedState = Extract<BackfillState, `paused_${string}`>;

let started = false;
let stopped = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let task: Promise<void> | null = null;

let scanned = 0;
let updated = 0;
let failed = 0;
let lastError: BackfillErrorCode = "";

/**
 * Por qué el trabajo de fondo está parado, o `null` si puede correr.
 *
 * Sobre "una llamada activa **y** pocos recursos": medir "pocos recursos" de
 * forma portable no se puede. `loadavg()` devuelve ceros en Windows, que es
 * justo la plataforma donde más gente va a hospedar esto, así que decidir con
 * él sería decidir con un número inventado. Se pausa con cualquier llamada: un
 * hash que llega diez minutos tarde no lo nota nadie, una voz entrecortada sí.
 */
export function backfillPause(): PausedState | null {
  if (freezeReason() !== null) return "paused_maintenance";
  if (callParticipants() > 0) return "paused_call";
  const free = storageFreeMbOrNull();
  /* `null` es "el sistema de ficheros no contesta", no "no queda nada". Tratar
     una cosa por la otra dejaría el trabajo pausado para siempre en cualquier
     montaje que no sepa responder a statfs. */
  if (free !== null && free < DISCO_MINIMO_MB) return "paused_disk_pressure";
  return null;
}

function schedule(delayMs: number): void {
  if (stopped || timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    task = step().finally(() => {
      task = null;
    });
  }, delayMs);
  timer.unref();
}

/**
 * Una tanda con su contabilidad. El scheduler la llama en bucle; separada
 * porque los contadores viven aquí, y una tanda que avanza el disco sin
 * actualizarlos dejaría el informe publicado diciendo otra cosa.
 */
export async function runIntegrityBatch(): Promise<AttachmentHashBackfillResult> {
  running = true;
  try {
    const result = await backfillAttachmentHashes(LOTE);
    scanned += result.scanned;
    updated += result.updated;
    failed += result.failed;
    if (result.last_error !== "") lastError = result.last_error;
    return result;
  } finally {
    running = false;
  }
}

async function step(): Promise<void> {
  if (stopped) return;

  if (backfillPause() !== null) {
    schedule(REVISION_PAUSA_MS);
    return;
  }

  try {
    if (!(await runIntegrityBatch()).done) schedule(PASO_MS);
  } catch {
    /* Un fallo de la tanda entera (la base cerrándose bajo los pies durante el
       apagado, por ejemplo) no reprograma: parar es lo correcto, y el estado
       se verá como `degraded` si quedaba trabajo. */
  }
}

export function startIntegrityWork(): void {
  if (started) return;
  started = true;
  stopped = false;
  // Un cuarto de segundo: que el arranque no compita con las primeras peticiones.
  schedule(250);
}

/** Deja el trabajo quieto y espera a que la tanda en vuelo abandone de verdad,
    para que nadie esté leyendo un fichero cuando se cierre la base. */
export async function stopIntegrityWork(): Promise<void> {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (task) await task.catch(() => {});
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * El estado se deduce de los hechos, en este orden: si hay una tanda en curso,
 * si queda algo por hacer, y si hay una razón para no estar haciéndolo.
 *
 * Antes preguntaba primero por el temporizador, y eso ataba lo que se publica a
 * un detalle interno: con el trabajo pausado pero sin nada reprogramado todavía
 * decía `degraded` —"hay fotos que no puedo leer"— cuando la verdad era
 * "estoy esperando a que cuelguen". Dos frases muy distintas para quien mira.
 */
function state(pending: number): BackfillState {
  if (!started) return "idle";
  if (running) return "running";
  if (pending === 0) return "complete";
  const pause = backfillPause();
  if (pause !== null) return pause;
  /* Queda trabajo, nada lo impide y aun así no hay nada programado: son los
     adjuntos que no se pudieron leer. Eso es `degraded`, no `complete`, y la
     diferencia es lo que alguien necesita saber antes de fiarse de una copia. */
  return timer !== null ? "running" : "degraded";
}

/**
 * El pendiente se cuenta cada vez, sin caché.
 *
 * Hubo una caché de cinco segundos aquí y contaba una mentira barata: tras una
 * restauración —justo cuando alguien mira este número para decidir si fiarse de
 * sus datos— publicaba el pendiente de antes. El índice parcial de la migración
 * 12 contiene solo las filas sin hash, así que cuando no queda trabajo contar es
 * gratis, y cuando queda, contar es exactamente lo que se está preguntando.
 */
export function attachmentHashProgress(): AttachmentHashProgress {
  const pending = pendingHashCount();
  return { state: state(pending), scanned, updated, failed, remaining: pending, last_error: lastError };
}

export function integrityReport(): InstanceIntegrity {
  return { attachment_hashes: attachmentHashProgress() };
}
