/**
 * Túnel público gestionado desde la propia aplicación (§6).
 * Sin esto, abrir tu instancia al mundo exigía abrir un terminal, ejecutar
 * cloudflared a mano y copiar la dirección al fichero .env. Quien hospeda desde
 * su casa no tiene por qué pasar por ahí para invitar a alguien.
 *
 * Lo que NO hace: ejecutar órdenes arbitrarias. Solo lanza un binario conocido
 * con argumentos fijos, y solo a petición de quien puso en marcha la instancia
 * (§22, §28.5). El navegador no elige qué se ejecuta ni con qué parámetros.
 */
import { spawn, type ChildProcess } from "node:child_process";
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

export function startTunnel(): Promise<TunnelState> {
  if (state.status === "on" || state.status === "starting") return Promise.resolve(tunnelState());

  state.status = "starting";
  state.error = "";
  state.url = "";

  return new Promise((done) => {
    try {
      // Sin `shell`: con un cmd.exe por medio, matar el proceso dejaría el
      // túnel abierto por su cuenta.
      child = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${config.port}`], {
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
