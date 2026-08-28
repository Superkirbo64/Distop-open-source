/**
 * Copias programadas: que la copia salga cifrada con la frase del fichero, que
 * la poda respete lo recién hecho y que ninguna condición rara tire el proceso.
 *   node --test backup-scheduler.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workdir = mkdtempSync(join(tmpdir(), "distop-copias-"));
const FRASE = "frase-de-copia-de-prueba";
/* Con salto de línea final a propósito: así es como queda un fichero escrito
   con echo o un editor, y la prueba de abajo demuestra que el recorte casa con
   lo que restore.ts espera en DISTOP_BACKUP_PASSPHRASE. */
writeFileSync(join(workdir, "backup.pass"), `${FRASE}\n`);

process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";
process.env.BACKUP_INTERVAL_HOURS = "24";
process.env.BACKUP_PASSPHRASE_FILE = join(workdir, "backup.pass");
process.env.BACKUP_KEEP = "2";

const { server } = await import("./server.ts");
const { pruneBackups, runScheduledBackup, schedulerPause } = await import("./backup-scheduler.ts");
const { BACKUP_DIR } = await import("./backup.ts");
const { config } = await import("./config.ts");

before(async () => {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  /* El trabajo de integridad comparte disco con las copias; quieto en las pruebas. */
  const { stopIntegrityWork } = await import("./integrity.ts");
  await stopIntegrityWork();
});

after(async () => {
  server.close();
  const { db } = await import("./db.ts");
  db.close();
  rmSync(workdir, { recursive: true, force: true });
});

test("la copia programada sale cifrada con la frase del fichero, sin el salto de línea", async () => {
  const result = await runScheduledBackup();
  assert.equal(result.outcome, "done");
  assert.ok(result.filename, "con nombre de fichero");
  const ruta = join(BACKUP_DIR, result.filename!);
  assert.ok(existsSync(ruta));

  /* Abrirla con la frase SIN newline es la prueba de que el recorte del fichero
     casa byte a byte con lo que pedirá DISTOP_BACKUP_PASSPHRASE al restaurar. */
  const { inspectBackup } = await import("./restore.ts");
  const report = await inspectBackup(ruta, FRASE);
  assert.ok(report, "se deja inspeccionar con esa frase exacta");
});

test("la poda deja las N más recientes y no toca los .partial", async () => {
  const vieja = (nombre: string, horas: number) => {
    const ruta = join(BACKUP_DIR, nombre);
    writeFileSync(ruta, "no es una copia de verdad");
    const t = new Date(Date.now() - horas * 3_600_000);
    utimesSync(ruta, t, t);
  };
  vieja("distop-vieja-1.distop-backup", 72);
  vieja("distop-vieja-2.distop-backup", 48);
  writeFileSync(join(BACKUP_DIR, "a-medias.partial"), "en vuelo");

  /* En el directorio hay 3 copias: la real del test anterior (la más nueva) y
     las dos viejas. Conservar 2 = borrar solo la más vieja. */
  const borradas = pruneBackups(2);
  assert.deepEqual(borradas, ["distop-vieja-1.distop-backup"]);
  assert.ok(existsSync(join(BACKUP_DIR, "distop-vieja-2.distop-backup")), "la segunda más reciente sobrevive");
  assert.ok(existsSync(join(BACKUP_DIR, "a-medias.partial")), "lo que está a medias no se toca");
});

test("con mantenimiento en curso se aplaza, no se pelea", async () => {
  const { pauseWrites } = await import("./lifecycle.ts");
  const soltar = pauseWrites("restore");
  try {
    assert.equal(schedulerPause(), "paused_maintenance");
    assert.equal((await runScheduledBackup()).outcome, "deferred");
  } finally {
    soltar();
  }
  assert.equal(schedulerPause(), null, "y al soltar puede volver a correr");
});

test("un fallo de la copia se cuenta, no se lanza", async () => {
  const cfg = config as { backupPassphrase: string };
  const original = cfg.backupPassphrase;
  cfg.backupPassphrase = "corta";
  try {
    const result = await runScheduledBackup();
    assert.equal(result.outcome, "failed");
  } finally {
    cfg.backupPassphrase = original;
  }
});

test("frase ausente o débil mata el arranque, no la primera copia", async () => {
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const configUrl = pathToFileURL(join(import.meta.dirname, "config.ts")).href;

  const boot = (extra: Record<string, string>) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(configUrl)})`], {
      env: { ...process.env, DATABASE_PATH: join(workdir, "boot.db"), ...extra },
      encoding: "utf8",
      stdio: "pipe",
    });

  assert.throws(() => boot({ BACKUP_PASSPHRASE_FILE: join(workdir, "no-existe.pass") }), /BACKUP_PASSPHRASE_FILE/);

  writeFileSync(join(workdir, "debil.pass"), "corta\n");
  assert.throws(() => boot({ BACKUP_PASSPHRASE_FILE: join(workdir, "debil.pass") }), /12 caracteres/);

  /* Y sin programar, ninguna de las dos cosas importa: apagado es apagado. */
  const salida = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const {config} = await import(${JSON.stringify(configUrl)}); console.log(config.backupIntervalHours);`],
    {
      env: { ...process.env, DATABASE_PATH: join(workdir, "boot2.db"), BACKUP_INTERVAL_HOURS: "", BACKUP_PASSPHRASE_FILE: "" },
      encoding: "utf8",
      stdio: "pipe",
    },
  );
  assert.equal(salida.trim(), "0", "apagadas de fábrica");
});
