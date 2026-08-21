/**
 * Puente entre el cascarón y el cliente web (§22).
 * Superficie mínima y tipada: nada de exponer ipcRenderer entero ni require.
 * El cliente detecta que corre empaquetado por la existencia de window.distop
 * (apps/web/src/lib/instance.ts) y solo usa lo que aquí se ofrece.
 */
import { contextBridge, ipcRenderer } from "electron";

export interface HostStatus {
  state: "off" | "starting" | "on" | "error";
  url: string;
  error: string;
  log: string[];
}

const api = {
  platform: process.platform as string,

  /** Instancia local: la comunidad que vive en este equipo (§5). */
  host: {
    start: (): Promise<HostStatus> => ipcRenderer.invoke("host:start") as Promise<HostStatus>,
    stop: (): Promise<HostStatus> => ipcRenderer.invoke("host:stop") as Promise<HostStatus>,
    status: (): Promise<HostStatus> => ipcRenderer.invoke("host:status") as Promise<HostStatus>,
    onStatus: (callback: (status: HostStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: HostStatus) => callback(status);
      ipcRenderer.on("host:status", listener);
      return () => ipcRenderer.removeListener("host:status", listener);
    },
  },

  /** Juego detectado en este equipo. Solo el nombre ya casado con el catálogo. */
  games: {
    current: (): Promise<string | null> => ipcRenderer.invoke("games:current") as Promise<string | null>,
    onChange: (callback: (game: string | null) => void): (() => void) => {
      const listener = (_event: unknown, game: string | null) => callback(game);
      ipcRenderer.on("games:change", listener);
      return () => ipcRenderer.removeListener("games:change", listener);
    },
  },
};

export type DistopBridge = typeof api;

contextBridge.exposeInMainWorld("distop", api);
