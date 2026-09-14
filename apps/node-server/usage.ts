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

export function recordTraffic(kind: "file" | "relay", bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
  const day = new Date().toISOString().slice(0, 10);
  const column = kind === "file" ? "file_bytes" : "relay_bytes";
  db.prepare(
    `INSERT INTO instance_daily_usage (day, ${column}) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
  ).run(day, bytes);
}

export function serverUsage() {
  const storage = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN content_type LIKE 'image/%' THEN size ELSE 0 END), 0) image_bytes,
       COALESCE(SUM(CASE WHEN content_type LIKE 'video/%' THEN size ELSE 0 END), 0) video_bytes,
       COALESCE(SUM(CASE WHEN content_type LIKE 'audio/%' THEN size ELSE 0 END), 0) audio_bytes,
       COALESCE(SUM(CASE WHEN content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'video/%' AND content_type NOT LIKE 'audio/%' THEN size ELSE 0 END), 0) file_bytes
     FROM attachments WHERE delivery = 'server'`,
  ).get() as Record<string, number>;
  const days = db.prepare(
    "SELECT day, file_bytes, relay_bytes FROM instance_daily_usage ORDER BY day DESC LIMIT 7",
  ).all() as Array<{ day: string; file_bytes: number; relay_bytes: number }>;
  const sevenDayBytes = days.reduce((sum, row) => sum + row.file_bytes + row.relay_bytes, 0);
  return {
    storage,
    traffic_days: days.reverse(),
    projection_30d_bytes: Math.round(sevenDayBytes / Math.max(days.length, 1) * 30),
  };
}
