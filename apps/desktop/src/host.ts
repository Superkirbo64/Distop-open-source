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

export type HostState = "off" | "starting" | "on" | "error";

export interface HostStatus {
  state: HostState;
  url: string;
  error: string;
  /** Últimas líneas del servidor, para que un fallo no sea un misterio (§26). */
  log: string[];
}

const PORT = 5000;
const URL_LOCAL = `http://127.0.0.1:${PORT}`;

let child: UtilityProcess | null = null;
let state: HostState = "off";
let lastError = "";
const log: string[] = [];
const listeners = new Set<(status: HostStatus) => void>();

export function hostStatus(): HostStatus {
  return { state, url: state === "on" ? URL_LOCAL : "", error: lastError, log: log.slice(-40) };
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
      const res = await fetch(`${URL_LOCAL}/health`, { signal: AbortSignal.timeout(2000) });
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

  const server = serverPath();
  const proc = utilityProcess.fork(join(server, "server.ts"), [], {
    cwd: server,
    stdio: ["ignore", "pipe", "pipe"],
    serviceName: "distop-instance",
    env: {
      ...process.env,
      PORT: String(PORT),
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

export function stopHost(): HostStatus {
  const proc = child;
  child = null;
  setState("off");
  proc?.kill();
  return hostStatus();
}

// La instancia es un hijo del proceso principal: si la app muere, muere con
// ella. Apagar el equipo apaga la comunidad, y la interfaz ya lo cuenta (§28.1).
app.on("before-quit", () => {
  stopHost();
});
