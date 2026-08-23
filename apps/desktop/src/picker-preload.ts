/**
 * Puente de la ventana selectora de pantalla (§15). Superficie de dos
 * funciones, nada más: elegir una fuente o cancelar.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("picker", {
  choose: (sourceId: string, audio: boolean): void => ipcRenderer.send("picker-choose", sourceId, audio),
  cancel: (): void => ipcRenderer.send("picker-cancel"),
});
