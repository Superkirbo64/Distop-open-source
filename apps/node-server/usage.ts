import { db, meta, setMeta } from "./db.ts";

export type DeploymentProfile = "personal_pc" | "vps_cloud";

export function deploymentProfile(): DeploymentProfile {
  return meta("deployment_profile", () => process.env.DEPLOYMENT_PROFILE === "vps_cloud" ? "vps_cloud" : "personal_pc") === "vps_cloud"
    ? "vps_cloud"
    : "personal_pc";
}

export function setDeploymentProfile(profile: DeploymentProfile): void {
  setMeta("deployment_profile", profile);
}

let pendingFileBytes = 0;
let pendingRelayBytes = 0;

export function recordTraffic(kind: "file" | "relay", bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
  if (kind === "file") pendingFileBytes += bytes;
  else pendingRelayBytes += bytes;
}

export function flushTraffic(): void {
  if (pendingFileBytes === 0 && pendingRelayBytes === 0) return;
  const fileBytes = pendingFileBytes;
  const relayBytes = pendingRelayBytes;
  pendingFileBytes = 0;
  pendingRelayBytes = 0;
  const day = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO instance_daily_usage (day, file_bytes, relay_bytes) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET
       file_bytes = file_bytes + excluded.file_bytes,
       relay_bytes = relay_bytes + excluded.relay_bytes`,
  ).run(day, fileBytes, relayBytes);
}

setInterval(flushTraffic, 10_000).unref();

export function serverUsage() {
  flushTraffic();
  const storage = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN content_type LIKE 'image/%' THEN size ELSE 0 END), 0) image_bytes,
       COALESCE(SUM(CASE WHEN content_type LIKE 'video/%' THEN size ELSE 0 END), 0) video_bytes,
       COALESCE(SUM(CASE WHEN content_type LIKE 'audio/%' THEN size ELSE 0 END), 0) audio_bytes,
       COALESCE(SUM(CASE WHEN content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'video/%' AND content_type NOT LIKE 'audio/%' THEN size ELSE 0 END), 0) file_bytes
     FROM attachments WHERE delivery = 'server'`,
  ).get() as Record<string, number>;
  const days = db.prepare(
    "SELECT day, file_bytes, relay_bytes FROM instance_daily_usage WHERE day >= date('now', '-6 days') ORDER BY day",
  ).all() as Array<{ day: string; file_bytes: number; relay_bytes: number }>;
  const sevenDayBytes = days.reduce((sum, row) => sum + row.file_bytes + row.relay_bytes, 0);
  return {
    storage,
    traffic_days: days,
    projection_30d_bytes: Math.round(sevenDayBytes / 7 * 30),
  };
}
