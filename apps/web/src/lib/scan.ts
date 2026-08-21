/**
 * Buscar instancias Distop en la red local (§5, §26).
 *
 * Para quien tiene su instancia en el PC de casa, teclear una dirección IP es
 * una barrera absurda: la app puede encontrarla sola. Un WebView no puede
 * hacer mDNS, así que se hace lo simple que funciona: probar /api/v1/info en
 * los rangos privados típicos de los routers domésticos, puerto 5000.
 *
 * Solo corre EMPAQUETADA (Electron/Android): en la web normal la página viene
 * de un https y el navegador bloquea las peticiones http a la red local.
 * Nada de lo que se encuentra sale del dispositivo: es tu red mirándose a sí
 * misma.
 */

export interface FoundInstance {
  url: string;
  name: string;
  version: string;
}

/* Los /24 con los que vienen los routers de casa (incluidos los habituales en
   Brasil e Hispanoamérica). Ampliable; cada rango son 254 sondas de ~1 s. */
const RANGES = ["192.168.1.", "192.168.0.", "192.168.15.", "192.168.100.", "10.0.0."];
const PORT = 5000;
const CONCURRENCY = 50;
const PROBE_TIMEOUT_MS = 1500;

export interface Scan {
  cancel: () => void;
  done: Promise<void>;
}

export function scanLan(
  onFound: (instance: FoundInstance) => void,
  onProgress?: (done: number, total: number) => void,
): Scan {
  const targets: string[] = [];
  for (const range of RANGES) for (let host = 1; host <= 254; host++) targets.push(`http://${range}${host}:${PORT}`);

  let cancelled = false;
  let finished = 0;
  let cursor = 0;

  async function probe(url: string): Promise<void> {
    try {
      const res = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      const info = (await res.json()) as { name?: string; version?: string };
      if (res.ok && typeof info.name === "string" && typeof info.version === "string") {
        onFound({ url, name: info.name, version: info.version });
      }
    } catch {
      // Nadie en esa IP: es el caso normal 250 veces por rango.
    }
  }

  async function worker(): Promise<void> {
    while (!cancelled && cursor < targets.length) {
      const url = targets[cursor++]!;
      await probe(url);
      finished++;
      onProgress?.(finished, targets.length);
    }
  }

  const done = Promise.all(Array.from({ length: CONCURRENCY }, worker)).then(() => undefined);
  return { cancel: () => (cancelled = true), done };
}
