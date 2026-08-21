/**
 * El servidor de la comunidad DENTRO del APK de Android (§5, §29.3).
 *
 * Sin Termux y sin instalar nada: el APK lleva un motor Node embebido
 * (Capacitor-NodeJS → nodejs-mobile) que ejecuta el mismo node-server del
 * repo, transpilado y con SQLite en WASM (scripts/stage-server.mjs). Los datos
 * viven en el almacenamiento privado y persistente de la app.
 *
 * Honestidad por delante: el motor embebido es Node 18 (el único que existe
 * para Android; docs/decisions.md) y la comunidad está en línea mientras la
 * app viva — un servicio en primer plano con su aviso evita que Android la
 * duerma, pero cerrar la app del todo la apaga.
 *
 * En el navegador y en Electron este módulo no hace nada: isNativePlatform()
 * es false y ningún método toca el puente.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

export const PHONE_INSTANCE_URL = "http://127.0.0.1:5000";

interface NodeEnginePlugin {
  start(options?: Record<string, unknown>): Promise<void>;
}

interface HostServicePlugin {
  enable(): Promise<void>;
  disable(): Promise<void>;
}

/** ¿Esta app puede hospedar en el propio teléfono? (solo el APK Android) */
export function phoneCanHost(): boolean {
  return Capacitor.isNativePlatform();
}

async function probe(timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`${PHONE_INSTANCE_URL}/api/v1/info`, { signal: AbortSignal.timeout(timeoutMs) });
    const info = (await res.json()) as { name?: string };
    return res.ok && typeof info.name === "string";
  } catch {
    return false;
  }
}

/** ¿Ya hay un servidor respondiendo en el teléfono? */
export function phoneServerAlive(): Promise<boolean> {
  return probe(2000);
}

/**
 * Enciende el motor embebido y espera a que el servidor responda.
 * start() con el motor ya vivo lanza error: se ignora, porque "ya estaba
 * encendido" es exactamente lo que queríamos conseguir.
 */
export async function startPhoneServer(): Promise<boolean> {
  if (!phoneCanHost()) return false;

  try {
    await registerPlugin<NodeEnginePlugin>("CapacitorNodeJS").start({});
  } catch {
    // Ya arrancado (el runtime móvil no se reinicia) o arrancando: se sondea.
  }

  // El primer arranque copia el proyecto Node y abre la base: dar margen real.
  for (let intento = 0; intento < 60; intento++) {
    if (await probe(1500)) {
      // Con el servidor vivo, el aviso fijo evita que Android duerma la app.
      void registerPlugin<HostServicePlugin>("DistopHost").enable().catch(() => {});
      return true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}
