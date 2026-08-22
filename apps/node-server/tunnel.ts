/**
 * Túnel público gestionado desde la propia aplicación (§6).
 * Sin esto, abrir tu servidor al mundo exigía abrir un terminal, ejecutar
 * cloudflared a mano y copiar la dirección al fichero .env. Quien hospeda desde
 * su casa no tiene por qué pasar por ahí para invitar a alguien.
 *
 * Y tampoco tiene por qué INSTALAR nada: si cloudflared no está en el equipo,
 * se descarga aquí solo, una única vez, desde las releases oficiales de
 * Cloudflare en GitHub (URL fija, https, sin terceros), y queda junto a los
 * datos de la instancia. Pedirle a alguien "instálalo del site de Cloudflare"
 * era mandar a la persona a hacer el trabajo de la aplicación.
 *
 * Lo que NO hace: ejecutar órdenes arbitrarias. Solo lanza un binario conocido
 * con argumentos fijos, y solo a petición de quien puso en marcha la instancia
 * (§22, §28.5). El navegador no elige qué se ejecuta ni con qué parámetros.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { meta, setMeta } from "./db.ts";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gunzipSync } from "node:zlib";
import { config } from "./config.ts";

export type TunnelStatus = "off" | "starting" | "on" | "error";

interface TunnelState {
  status: TunnelStatus;
  url: string;
  /** Motivo del último fallo, para poder enseñarlo en vez de un genérico. */
  error: string;
}

const state: TunnelState = { status: "off", url: "", error: "" };
let child: ChildProcess | null = null;

/** La dirección aparece en el banner que cloudflared escribe por su salida. */
const ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export function tunnelState(): TunnelState {
  return { ...state };
}

/**
 * Dirección pública efectiva: manda el túnel vivo sobre PUBLIC_URL.
 * Así las invitaciones salen con la dirección buena sin reiniciar la instancia,
 * que es justo lo que obligaba a editar el .env a mano.
 */
export function publicUrl(): string {
  return state.status === "on" && state.url ? state.url : config.publicUrl;
}

/* ── conseguir cloudflared sin pedirle nada a nadie ─────────────────── */

const BIN_DIR = join(dirname(resolve(config.databasePath)), "bin");
const LOCAL_BIN = join(BIN_DIR, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

/** URL oficial y fija por plataforma. Fuera de esta lista no se descarga nada. */
function downloadTarget(): { url: string; tgz: boolean } | null {
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download";
  const { platform, arch } = process;
  if (platform === "win32" && arch === "x64") return { url: `${base}/cloudflared-windows-amd64.exe`, tgz: false };
  if (platform === "linux" && arch === "x64") return { url: `${base}/cloudflared-linux-amd64`, tgz: false };
  if (platform === "linux" && arch === "arm64") return { url: `${base}/cloudflared-linux-arm64`, tgz: false };
  if (platform === "darwin") return { url: `${base}/cloudflared-darwin-${arch === "arm64" ? "arm64" : "amd64"}.tgz`, tgz: true };
  return null;
}

/** El .tgz de macOS trae un único fichero; esto lo saca sin dependencias. */
function untarSingle(tgz: Buffer): Buffer | null {
  const tar = gunzipSync(tgz);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = tar.subarray(offset, offset + 100).toString("utf8").replace(/\0.*$/s, "");
    if (!name) break;
    const size = Number.parseInt(tar.subarray(offset + 124, offset + 136).toString("utf8").trim(), 8);
    if (!Number.isFinite(size)) break;
    if (name.endsWith("cloudflared")) return Buffer.from(tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return null;
}

/**
 * Orden de búsqueda: lo que ya haya en el PATH (respeta instalaciones del
 * sistema, y en Termux es la única variante que funciona), luego lo que ya
 * descargamos antes, y solo entonces se baja. Devuelve la orden a ejecutar,
 * o null si en esta plataforma no hay build y tampoco está instalado.
 */
async function ensureCloudflared(): Promise<string | null> {
  try {
    if (spawnSync("cloudflared", ["--version"], { stdio: "ignore", timeout: 5000 }).status === 0) return "cloudflared";
  } catch {
    // Sin binario en el PATH: lo normal en un equipo recién estrenado.
  }
  if (existsSync(LOCAL_BIN)) return LOCAL_BIN;

  const target = downloadTarget();
  if (!target) return null;

  try {
    mkdirSync(BIN_DIR, { recursive: true });
    const res = await fetch(target.url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
    if (!res.ok || !res.body) return null;

    const partial = `${LOCAL_BIN}.part`;
    if (target.tgz) {
      const inner = untarSingle(Buffer.from(await res.arrayBuffer()));
      if (!inner) return null;
      writeFileSync(partial, inner);
    } else {
      await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    }
    if (process.platform !== "win32") chmodSync(partial, 0o755);
    renameSync(partial, LOCAL_BIN);
    return LOCAL_BIN;
  } catch {
    return null; // sin red o descarga cortada: se reintenta la próxima vez
  }
}

export async function startTunnel(): Promise<TunnelState> {
  if (state.status === "on" || state.status === "starting") return tunnelState();

  state.status = "starting";
  state.error = "";
  state.url = "";

  // Puede tardar: la primera vez descarga el binario (~60 MB, una única vez).
  const bin = await ensureCloudflared();
  if (!bin) {
    finish("no-cloudflared");
    return tunnelState();
  }

  return new Promise((done) => {
    try {
      // Sin `shell`: con un cmd.exe por medio, matar el proceso dejaría el
      // túnel abierto por su cuenta.
      child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${config.port}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish("no-cloudflared");
      done(tunnelState());
      return;
    }

    const timer = setTimeout(() => finish("timeout"), 45_000);

    const read = (chunk: unknown) => {
      const found = ADDRESS.exec(String(chunk));
      if (!found) return;
      clearTimeout(timer);
      state.status = "on";
      state.url = found[0];
      done(tunnelState());
    };

    child.stdout?.on("data", read);
    child.stderr?.on("data", read);

    child.on("error", () => {
      clearTimeout(timer);
      finish("no-cloudflared");
      done(tunnelState());
    });

    child.on("exit", () => {
      clearTimeout(timer);
      // Si ya estaba en marcha, esto es un cierre; si no, es que no arrancó.
      if (state.status === "starting") finish("crashed");
      else finish("");
      done(tunnelState());
    });
  });
}

export function stopTunnel(): TunnelState {
  child?.kill();
  child = null;
  finish("");
  return tunnelState();
}

function finish(error: string): void {
  state.status = error ? "error" : "off";
  state.error = error;
  state.url = "";
}

/** El túnel muere con la instancia: no dejamos un proceso suelto por ahí. */
for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
  process.on(signal, () => {
    child?.kill();
  });
}

/* ── abrirlo solo ────────────────────────────────────────────────────── */

const CLAVE_AUTO = "tunnel.autostart";

/** ¿Debe publicarse la instancia sola al arrancar? Por defecto sí. */
export function tunnelAutostart(): boolean {
  return meta(CLAVE_AUTO, () => "1") === "1";
}

export function setTunnelAutostart(on: boolean): void {
  setMeta(CLAVE_AUTO, on ? "1" : "0");
}

/**
 * Abrir el enlace público sin que nadie lo pida (§5, §6).
 *
 * Quien hospeda no tiene por qué saber que existe un túnel: lo que quiere es
 * una dirección que pasarle a sus amigos. Así que se abre solo al arrancar y
 * la invitación ya nace pública.
 *
 * Dos condiciones, y las dos importan:
 *  - Solo si la instancia ya tiene dueño. Una recién instalada no se publica
 *    antes de que alguien la reclame, o el primer desconocido que encuentre la
 *    dirección se la queda.
 *  - Solo si nadie lo ha apagado en los ajustes.
 *
 * Que falle no es motivo para no arrancar: la instancia sigue sirviendo en
 * local y la interfaz enseña el error.
 */
export async function autostartTunnel(hayDueno: boolean): Promise<void> {
  if (!hayDueno || !tunnelAutostart() || config.publicUrl) return;
  try {
    await startTunnel();
  } catch (err) {
    state.error = err instanceof Error ? err.message : String(err);
    state.status = "error";
  }
}
