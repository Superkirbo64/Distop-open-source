/**
 * "Hospedar aquí" (§4.2, §5): la instancia node-server corriendo en ESTE equipo.
 *
 * Es la secuencia de scripts/host.mjs sin la parte de instalar ni compilar
 * —todo viene ya dentro del paquete— y con el runtime de la propia app:
 * Electron 40 embebe Node 24, que ejecuta los .ts del servidor tal cual
 * (type stripping) y trae node:sqlite. La cuenta y los datos viven literalmente
 * en este ordenador: userData/instance/data (§7.2, §21).
 */
import { app, utilityProcess, type UtilityProcess } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { instanceDataPath, serverPath } from "./paths";
import { freePort } from "./port";

export type HostState = "off" | "starting" | "on" | "error";

export interface HostStatus {
  state: HostState;
  url: string;
  error: string;
  /** Últimas líneas del servidor, para que un fallo no sea un misterio (§26). */
  log: string[];
}

// El 5000 es solo la preferencia, nunca un requisito: en un equipo cualquiera
// ya puede estar ocupado (otro servidor de desarrollo, un servicio de Windows)
// y eso no puede impedir hospedar. Si está tomado, el sistema da otro libre.
const PREFERRED_PORT = 5000;
const HOST_ADDRESS = "0.0.0.0";

let child: UtilityProcess | null = null;
let url = "";
let state: HostState = "off";
let lastError = "";
const log: string[] = [];
const listeners = new Set<(status: HostStatus) => void>();

export function hostStatus(): HostStatus {
  return { state, url: state === "on" ? url : "", error: lastError, log: log.slice(-40) };
}

export function onHostStatus(listener: (status: HostStatus) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setState(next: HostState, error = ""): void {
  state = next;
  lastError = error;
  const status = hostStatus();
  for (const listener of listeners) listener(status);
}

function remember(line: string): void {
  for (const piece of line.split("\n")) {
    const text = piece.trimEnd();
    if (text) log.push(text);
  }
  if (log.length > 200) log.splice(0, log.length - 200);
}

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child) return false;
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Aún arrancando: se reintenta hasta el plazo.
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

export async function startHost(): Promise<HostStatus> {
  if (state === "on" || state === "starting") return hostStatus();

  setState("starting");
  const dataDir = join(instanceDataPath(), "data");
  mkdirSync(dataDir, { recursive: true });

  let port: number;
  try {
    port = await freePort(PREFERRED_PORT, HOST_ADDRESS);
  } catch (err) {
    setState("error", err instanceof Error ? err.message : String(err));
    return hostStatus();
  }
  url = `http://127.0.0.1:${port}`;

  const server = serverPath();
  const proc = utilityProcess.fork(join(server, "server.ts"), [], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "distop-instance",
    env: {
      ...process.env,
      PORT: String(port),
      HOST: HOST_ADDRESS,
      DATABASE_PATH: join(dataDir, "app.db"),
      DEFAULT_STORAGE_PATH: join(dataDir, "uploads"),
    },
  });
  child = proc;

  proc.stdout?.on("data", (chunk: Buffer) => remember(chunk.toString("utf8")));
  proc.stderr?.on("data", (chunk: Buffer) => remember(chunk.toString("utf8")));
  proc.on("exit", (code) => {
    if (child !== proc) return;
    child = null;
    // Salir sin que nadie lo pidiera es un fallo, y el porqué está en el log.
    if (state !== "off") setState("error", `La instancia terminó con código ${code}.`);
  });

  const healthy = await waitForHealth(30_000);
  if (!healthy) {
    proc.kill();
    child = null;
    setState("error", "La instancia no respondió a /health en 30 segundos.");
    return hostStatus();
  }

  setState("on");
  return hostStatus();
}

let stopping: Promise<HostStatus> | null = null;

export function stopHost(): Promise<HostStatus> {
  if (stopping) return stopping;
  const proc = child;
  if (!proc) {
    setState("off");
    return Promise.resolve(hostStatus());
  }

  setState("off");
  stopping = (async () => {
    const exited = new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()));
    try {
      proc.postMessage({ type: "DISTOP_SHUTDOWN" });
    } catch {
      // Un proceso que murio entre ambas lineas ya no necesita aviso.
    }
    /* 3,2 s contra los 2,5 s que la instancia se da para cortar subidas en
       vuelo (server.ts): el margen tiene que ser mayor que el suyo, o matariamos
       el proceso justo mientras cierra la base. Los dos numeros van juntos. */
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 3_200))]);
    if (child === proc) {
      proc.kill();
      await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 500))]);
    }
    if (child === proc) child = null;
    return hostStatus();
  })().finally(() => { stopping = null; });
  return stopping;
}

// Antes de cerrar Electron se da al hijo su ventana real de checkpoint.
let quittingAfterHost = false;
app.on("before-quit", (event) => {
  if (!child || quittingAfterHost) return;
  event.preventDefault();
  quittingAfterHost = true;
  void stopHost().finally(() => app.quit());
});
