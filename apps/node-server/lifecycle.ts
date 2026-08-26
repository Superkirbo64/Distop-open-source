/**
 * Coordinacion del apagado y de las operaciones exclusivas, sin crear ciclos
 * entre API y servidor.
 *
 * Dos relojes distintos y a proposito: `activeRequests` cuenta TODO lo que
 * entro (SQLite no puede cerrarse mientras un handler siga leyendo) y
 * `activeWrites` cuenta solo lo que muta. Una copia de seguridad que esperase
 * a que termine la descarga de un video de 2 GB no seria una pausa breve, seria
 * un cuelgue; y cerrar la base con una lectura a medias seria un error real.
 */

/** Por que no se aceptan escrituras. `shutdown` es definitivo; el resto, no. */
export type WriteFreeze = "shutdown" | "backup" | "restore" | "handover";

let freeze: WriteFreeze | null = null;
let shutdownHandler: ((reason: string) => void) | null = null;
let activeRequests = 0;
let activeWrites = 0;
const idleWaiters = new Set<() => void>();
const writeWaiters = new Set<() => void>();

export function writesAccepted(): boolean {
  return freeze === null;
}

export function freezeReason(): WriteFreeze | null {
  return freeze;
}

/** Cierre en marcha: sin vuelta atras y por encima de cualquier otra pausa. */
export function freezeWrites(): void {
  freeze = "shutdown";
}

/**
 * Congela las escrituras mientras dura una operacion exclusiva y devuelve como
 * deshacerlo. Si ya hay otra en curso lanza: dos copias simultaneas del mismo
 * directorio no son dos copias, son una corrupta.
 *
 * El apagado nunca se descongela: si entra mientras la operacion corre, soltar
 * la pausa no reabre nada.
 */
export function pauseWrites(kind: Exclude<WriteFreeze, "shutdown">): () => void {
  if (freeze !== null) throw new Error(`WRITES_ALREADY_FROZEN:${freeze}`);
  freeze = kind;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (freeze === kind) freeze = null;
  };
}

/**
 * Mantiene SQLite abierto hasta que el ultimo handler que ya habia entrado
 * termine. El cierre del socket no basta: Node no espera la Promise devuelta
 * por un callback async de createServer.
 */
export function beginRequest(mutating: boolean): () => void {
  activeRequests++;
  if (mutating) activeWrites++;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    activeRequests--;
    if (mutating && --activeWrites === 0) {
      for (const resolve of writeWaiters) resolve();
      writeWaiters.clear();
    }
    if (activeRequests !== 0) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
}

export function activeRequestCount(): number {
  return activeRequests;
}

export function waitForRequests(): Promise<void> {
  if (activeRequests === 0) return Promise.resolve();
  return new Promise((resolve) => idleWaiters.add(resolve));
}

/**
 * Espera a que salgan los handlers que estaban mutando, con tope.
 *
 * El tope no relaja nada: la copia de SQLite es consistente por si sola, y una
 * fila solo existe cuando su fichero ya esta en disco (storage.ts), asi que una
 * subida que cruce el limite deja como mucho un fichero de mas — basura
 * inofensiva — nunca una fila sin fichero.
 */
export function waitForWrites(timeoutMs = 5_000): Promise<void> {
  if (activeWrites === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      writeWaiters.delete(done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref();
    writeWaiters.add(done);
  });
}

export function registerShutdownHandler(handler: (reason: string) => void): void {
  shutdownHandler = handler;
}

export function requestShutdown(reason: string): void {
  shutdownHandler?.(reason);
}
