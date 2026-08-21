import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { watchGameActivity } from "./lib/gameActivity.ts";
// Tipografías autoalojadas (§8): cero peticiones a Google en cada carga.
// Mismo enfoque Fontsource que apps/marketing; los .woff2 salen del bundle.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dentro de la app de escritorio, el "jugando a…" detectado se reporta a la
// instancia con la sesión de siempre. En el navegador no hace nada (§9.1).
watchGameActivity();

// PWA (§14): solo en producción, para que el service worker no sirva
// versiones cacheadas del cascarón durante el desarrollo.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
