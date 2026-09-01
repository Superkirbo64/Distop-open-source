/** Compatibilidad del selector local al actualizar una instancia existente. */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION } from "./migrations.ts";

const workdir = mkdtempSync(join(tmpdir(), "distop-device-profiles-"));
const databasePath = join(workdir, "test.db");

/* Base detenida justo antes de device_profiles: reproduce una actualización,
   no una instalación nueva que todavía no tiene usuarios. */
const antigua = new DatabaseSync(databasePath);
for (const migration of MIGRATIONS.slice(0, -1)) antigua.exec(migration);
antigua.prepare(
  "INSERT INTO users (id, username, display_name, kind, created_at) VALUES (?, ?, ?, 'local', ?)",
).run("host-anterior", "anfitrion", "Anfitrión", 1);
antigua.prepare(
  "INSERT INTO users (id, username, display_name, kind, created_at) VALUES (?, ?, ?, 'local', ?)",
).run("miembro-anterior", "miembro", "Miembro remoto", 2);
antigua.prepare(
  "INSERT INTO host_authority (id, user_id, since, granted_by, reason) VALUES (1, ?, ?, NULL, 'test')",
).run("host-anterior", 1);
antigua.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
antigua.close();

process.env.PORT = "0";
process.env.DATABASE_PATH = databasePath;
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { db } = await import("./db.ts");

after(() => {
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("la migración conserva al anfitrión sin convertir a los miembros en perfiles del equipo", () => {
  const profiles = db.prepare("SELECT user_id FROM device_profiles ORDER BY created_at").all() as Array<{ user_id: string }>;
  assert.deepEqual(profiles.map((profile) => profile.user_id), ["host-anterior"]);
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  assert.equal(version, SCHEMA_VERSION);
});
