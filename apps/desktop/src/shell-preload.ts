/**
 * Puente de la franja de aplicaciones (§15).
 * Superficie mínima: pedir el cambio de aplicación y saber qué pestañas
 * existen. El proceso principal valida todo antes de hacer caso (apps-policy
 * y las preferencias del cascarón).
 */
import { contextBridge, ipcRenderer } from "electron";

export interface ShellTabs {
  whatsapp: boolean;
  telegram: boolean;
}

contextBridge.exposeInMainWorld("distopShell", {
  switch: (id: string): void => ipcRenderer.send("shell:switch", id),
  tabs: (): Promise<ShellTabs> => ipcRenderer.invoke("shell:tabs") as Promise<ShellTabs>,
  onTabs: (callback: (tabs: ShellTabs) => void): void => {
    ipcRenderer.on("shell:tabs", (_event, tabs: ShellTabs) => callback(tabs));
  },
});
