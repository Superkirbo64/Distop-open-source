import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

test("el reloj UUIDv7 sobrevive restauracion con reloj atrasado y reinicios", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "distop-uuid-clock-"));
  const database = join(workdir, "app.db");
  const env = {
    ...process.env,
    DATABASE_PATH: database,
    DEFAULT_STORAGE_PATH: join(workdir, "uploads"),
    AUTH_SECRET: "uuid-clock-test-secret",
  };
  const child = async (username: string, future = false): Promise<string> => {
    const source = `
      const { db, closeDatabase } = await import('./db.ts');
      const { seedUuidClock, uuidv7 } = await import('@distop/protocol');
      if (${future}) seedUuidClock(Date.now() + 24 * 60 * 60 * 1000);
      const id = uuidv7();
      db.prepare('INSERT INTO users (id, username, display_name, created_at) VALUES (?, ?, ?, ?)').run(id, '${username}', '${username}', Date.now());
      closeDatabase();
      console.log(id);
    `;
    const result = await run(process.execPath, ["--input-type=module", "--eval", source], { cwd: import.meta.dirname, env });
    return result.stdout.trim().split(/\r?\n/).at(-1)!;
  };

  try {
    const restored = await child("future", true);
    const firstRestart = await child("restart-one");
    const secondRestart = await child("restart-two");
    assert.ok(firstRestart > restored, "el primer reinicio conserva el orden textual");
    assert.ok(secondRestart > firstRestart, "el segundo reinicio tambien avanza");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});
