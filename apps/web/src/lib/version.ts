/**
 * Aviso de versión nueva (§28.6).
 * Una pestaña abierta sigue ejecutando el código con el que se cargó, para
 * siempre. Tras actualizar la instancia, quien no cierre la pestaña se queda con
 * la versión vieja y ve fallos ya corregidos —o peor, habla un protocolo que ya
 * no coincide con el del resto— sin ninguna pista de que eso está pasando.
 *
 * La comprobación no necesita un endpoint nuevo: el index.html de una compilación
 * nueva apunta a un fichero de JavaScript con otro nombre. Si el que anuncia el
 * servidor no es el que estoy ejecutando, hay versión nueva.
 */

import { isPackaged } from "./instance.ts";

type Listener = (stale: boolean) => void;

const listeners = new Set<Listener>();
let stale = false;

/** El script que cargó ESTA pestaña, tal cual lo resolvió el navegador. */
function runningScript(): string {
  const own = document.querySelector<HTMLScriptElement>('script[type="module"][src]');
  return own ? new URL(own.src, location.origin).pathname : "";
}

async function check(): Promise<void> {
  if (stale) return;
  try {
    const html = await fetch("/index.html", { cache: "no-store" }).then((r) => r.text());
    const served = /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1];
    if (!served) return;

    if (new URL(served, location.origin).pathname !== runningScript()) {
      stale = true;
      for (const listener of listeners) listener(true);
    }
  } catch {
    // Instancia caída o sin red: no es asunto de esta comprobación.
  }
}

export function onStaleBuild(listener: Listener): () => void {
  listeners.add(listener);
  listener(stale);
  return () => listeners.delete(listener);
}

export function watchBuild(): void {
  // En desarrollo el módulo lo sirve Vite con recarga en caliente: aquí sobra.
  if (!import.meta.env.PROD) return;
  // Empaquetado, el bundle no lo sirve la instancia: recargar no traería nada
  // nuevo. De avisar de versiones se encarga el actualizador de la propia app.
  if (isPackaged()) return;

  void check();
  // Al volver a la pestaña es cuando más probable es haber quedado atrás, y no
  // cuesta nada; el intervalo cubre a quien la deja abierta días.
  window.addEventListener("focus", () => void check());
  setInterval(() => void check(), 5 * 60_000);
}
