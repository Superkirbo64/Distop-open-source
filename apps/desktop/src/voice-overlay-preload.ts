import { contextBridge, ipcRenderer } from "electron";
import type { VoiceOverlayState } from "./voice-overlay";

contextBridge.exposeInMainWorld("voiceOverlay", {
  onState(callback: (state: VoiceOverlayState) => void): void {
    ipcRenderer.on("voice-overlay:state", (_event, state: VoiceOverlayState) => callback(state));
  },
});
