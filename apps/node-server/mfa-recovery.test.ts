/**
 * El comando de recuperación por SSH, como proceso aparte contra una base
 * propia: tiene que terminar solo (nada colgado al importar) y decir la verdad
 * en los tres casos.
 *   node --test "mfa-recovery.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function entorno(databasePath: string) {
  return {
    ...process.env,
    DATABASE_PATH: databasePath,
    DEFAULT_STORAGE_PATH: join(databasePath, "..", "uploads"),
    AUTH_SECRET: "test-secret-recuperacion",
    DIRECTORY_URL: "",
  };
}

const opciones = (databasePath: string) => ({
  cwd: import.meta.dirname,
  encoding: "utf8" as const,
  timeout: 60_000,
  env: entorno(databasePath),
});

const ejecutar = (databasePath: string) => spawnSync(process.execPath, ["mfa-recovery.ts"], opciones(databasePath));

/** Código suelto dentro de la misma base, en otro proceso, como haría la instancia. */
const preparar = (databasePath: string, codigo: string) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", codigo], opciones(databasePath));

test("sin anfitrión, sin autenticador y con autenticador: termina solo y lo dice", () => {
  const dir = mkdtempSync(join(tmpdir(), "distop-mfa-cli-"));
  const databasePath = join(dir, "app.db");
  try {
    const vacia = ejecutar(databasePath);
    assert.equal(vacia.error, undefined, "no debe colgarse");
    assert.equal(vacia.status, 1);
    assert.match(vacia.stderr, /todavía no tiene quien la administre/);

    const anfitrion = preparar(
      databasePath,
      `const { createUser, setHostUser } = await import("./auth.ts");
       const { db } = await import("./db.ts");
       const u = createUser({ username: "kirbo", displayName: "Kirbo", password: "contrasena-larga-kirbo" });
       setHostUser(u.id, "local-claim", null);
       db.close();`,
    );
    assert.equal(anfitrion.status, 0, anfitrion.stderr);

    const sinAutenticador = ejecutar(databasePath);
    assert.equal(sinAutenticador.status, 1);
    assert.match(sinAutenticador.stderr, /no tiene el autenticador activado/);

    const activar = preparar(
      databasePath,
      `const { hostUserId } = await import("./auth.ts");
       const { db } = await import("./db.ts");
       const { startMfaSetup, confirmMfaSetup } = await import("./mfa.ts");
       const { hotp, deBase32, stepAt } = await import("./totp.ts");
       const id = hostUserId();
       const { secret } = startMfaSetup(id, "kirbo");
       const ok = confirmMfaSetup(id, hotp(deBase32(secret), stepAt(Date.now())));
       db.close();
       process.exit(ok ? 0 : 3);`,
    );
    assert.equal(activar.status, 0, activar.stderr);

    const conAutenticador = ejecutar(databasePath);
    assert.equal(conAutenticador.status, 0, conAutenticador.stderr);
    assert.match(conAutenticador.stdout, /Código de recuperación: [0-9A-F]{16}\n/);
    assert.match(conAutenticador.stdout, /10 minutos y una sola vez/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
