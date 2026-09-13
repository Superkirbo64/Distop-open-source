import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { detectLocale } from "./i18n.ts";
import { watchGameActivity } from "./lib/gameActivity.ts";
import { watchVoiceOverlay } from "./lib/voiceOverlay.ts";
// Tipografías autoalojadas (§8): cero peticiones a Google en cada carga.
// Mismo enfoque Fontsource que apps/marketing; los .woff2 salen del bundle.
import "@fontsource-variable/bricolage-grotesque";
import "@fontsource-variable/inter";
import "@fontsource/press-start-2p";
import "@fontsource/silkscreen";
import "./styles.css";

/* Las WebView de Android anteriores a Chrome 103 no traen AbortSignal.timeout:
   cada fetch con plazo (Explorar, entrar a una comunidad) fallaba antes de salir
   y el teléfono decía "algo falló". Un único respaldo aquí cubre todas las llamadas. */
if (typeof AbortSignal.timeout !== "function") {
  AbortSignal.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Tiempo de espera agotado", "TimeoutError")), ms);
    return controller.signal;
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dentro de la app de escritorio, el "jugando a…" detectado se reporta a la
// instancia con la sesión de siempre. En el navegador no hace nada (§9.1).
watchGameActivity();
watchVoiceOverlay();

// PWA (§14): solo en producción, para que el service worker no sirva
// versiones cacheadas del cascarón durante el desarrollo.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    /* El idioma va en la URL: cuando llega un aviso de Web Push puede no haber
       ninguna pestaña abierta a la que preguntárselo, y el service worker no
       ve localStorage. Registrar con otro idioma reemplaza el registro
       anterior para el mismo ámbito, así que cambiar de idioma no acumula. */
    void navigator.serviceWorker.register(`/sw.js?lang=${encodeURIComponent(detectLocale())}`);
  });
}
