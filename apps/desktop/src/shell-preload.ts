/**
 * Puente de la franja de aplicaciones (§15).
 * Una sola función y nada más: pedir el cambio de aplicación. El proceso
 * principal valida el identificador antes de hacerle caso (apps-policy).
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("distopShell", {
  switch: (id: string): void => ipcRenderer.send("shell:switch", id),
});
