/**
 * Estado observable de la instancia (§26).
 * Los fallos se nombran, no se esconden detrás de un mensaje genérico.
 */
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { PROTOCOL_VERSION } from "@distop/protocol";
import type { InstanceHealth, InstanceState } from "@distop/protocol";
import { config } from "./config.ts";
import { db, INSTANCE_ID } from "./db.ts";
import { storageUsedMb } from "./storage.ts";

export const VERSION = "0.1.0";
const STARTED_AT = Date.now();

let state: InstanceState = "STARTING";
export function setState(next: InstanceState): void {
  state = next;
}

let cachedStorageMb = 0;
let storageCheckedAt = 0;

export function instanceHealth(onlineUsers: number): InstanceHealth {
  const now = Date.now();
  // Recorrer el árbol de uploads en cada /health castiga discos lentos (NAS, Pi).
  if (now - storageCheckedAt > 60_000) {
    cachedStorageMb = storageUsedMb();
    storageCheckedAt = now;
  }

  const communities = (db.prepare("SELECT COUNT(*) AS n FROM communities").get() as { n: number }).n;
  const load = loadavg()[0] ?? 0;
  const cores = cpus().length || 1;

  return {
    status: state,
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
    max_upload_mb: config.maxUploadMb,
    registration_enabled: config.registrationEnabled,
    guest_mode_enabled: config.guestModeEnabled,
  };
}
