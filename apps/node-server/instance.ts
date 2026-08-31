/**
 * Estado observable de la instancia (§26).
 * Los fallos se nombran, no se esconden detrás de un mensaje genérico.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { PROTOCOL_VERSION } from "@distop/protocol";
import type { InstanceHealth, InstanceState } from "@distop/protocol";
import { config } from "./config.ts";
import { db, INSTANCE_ID } from "./db.ts";
import { integrityReport } from "./integrity.ts";
import { storageFreeMb, storageUsedMb } from "./storage.ts";
import { hostUserId } from "./auth.ts";

/**
 * La versión sale de package.json, no de una constante: la constante derivó dos
 * veces porque las releases suben package.json y nadie se acuerda de este
 * fichero. El respaldo existe para los empaquetados donde package.json puede no
 * viajar junto a las fuentes (el motor Node embebido en el APK), misma razón
 * que la variable WEB_DIST_PATH en server.ts.
 */
function versionDePackage(): string {
  try {
    const parsed = JSON.parse(readFileSync(join(import.meta.dirname, "package.json"), "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version !== "") return parsed.version;
  } catch {
    // Sin package.json al lado: vale el respaldo.
  }
  return "0.1.7";
}

export const VERSION = versionDePackage();
const STARTED_AT = Date.now();

let state: InstanceState = "STARTING";
export function setState(next: InstanceState): void {
  state = next;
}

let cachedStorageMb = 0;
let cachedFreeMb = 0;
let storageCheckedAt = 0;

/** La limpieza de datos deja el caché viejo un minuto: se invalida a mano. */
export function invalidateStorageCache(): void {
  storageCheckedAt = 0;
}

export function instanceHealth(onlineUsers: number): InstanceHealth {
  const now = Date.now();
  // Recorrer el árbol de uploads en cada /health castiga discos lentos (NAS, Pi).
  if (now - storageCheckedAt > 60_000) {
    cachedStorageMb = storageUsedMb();
    cachedFreeMb = storageFreeMb();
    storageCheckedAt = now;
  }

  const communities = (db.prepare("SELECT COUNT(*) AS n FROM communities").get() as { n: number }).n;
  const load = loadavg()[0] ?? 0;
  const cores = cpus().length || 1;

  return {
    status: hostUserId() === null ? "HOST_UNCLAIMED" : state,
    protocol: PROTOCOL_VERSION,
    version: VERSION,
    instance_id: INSTANCE_ID,
    instance_name: config.instanceName,
    uptime_s: Math.floor((now - STARTED_AT) / 1000),
    online_users: onlineUsers,
    communities,
    cpu_load: Math.round((load / cores) * 100) / 100,
    memory_used_mb: Math.round((totalmem() - freemem()) / 1024 / 1024),
    memory_total_mb: Math.round(totalmem() / 1024 / 1024),
    storage_used_mb: cachedStorageMb,
    storage_free_mb: cachedFreeMb,
    max_upload_mb: config.maxUploadMb,
    registration_enabled: config.registrationEnabled,
    guest_mode_enabled: config.guestModeEnabled,
    /* Nada sensible: contadores y un código de error. Ni rutas ni nombres de
       fichero, porque /health lo lee cualquiera. */
    integrity: integrityReport(),
  };
}
