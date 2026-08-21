/**
 * App Android (§14, §15): el MISMO cliente web de apps/web, empaquetado.
 * Es cliente puro — en Android no hay Node, así que no puede hospedar una
 * instancia (§29.3); arranca en la pantalla "Conectar a instancia" y habla con
 * el nodo que la persona elija, con su sesión guardada en el dispositivo.
 *
 * La voz exige WebCodecs + MediaStreamTrackProcessor en el System WebView
 * (≥94, se actualiza por Play Store). Si el WebView es más viejo, el cliente
 * lo dice y el resto funciona igual (relay.ts `supported()`).
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.distop.app",
  appName: "Distop",
  webDir: "../web/dist",
};

export default config;
