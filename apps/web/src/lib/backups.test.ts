/**
 * El estado de copias que pinta "Tu servidor": programación en dos estados y
 * lista ordenada por fecha, pase lo que pase con el orden del transporte.
 *
 *   node --test "src/lib/*.test.ts"
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { describeSchedule, sortBackupFiles, type BackupFile } from "./backups.ts";

test("programación encendida: cada N horas, conserva K, y cuándo fue la última", () => {
  assert.deepEqual(
    describeSchedule({ enabled: true, interval_hours: 24, keep: 7, last: 1_700_000_000_000 }),
    { kind: "on", hours: 24, keep: 7, last: 1_700_000_000_000 },
  );
});

test("encendida pero sin copia todavía: last viaja como null, no como 0", () => {
  assert.deepEqual(describeSchedule({ enabled: true, interval_hours: 6, keep: 3, last: null }), {
    kind: "on",
    hours: 6,
    keep: 3,
    last: null,
  });
});

test("apagada es apagada, venga como venga", () => {
  assert.deepEqual(describeSchedule({ enabled: false, interval_hours: 24, keep: 7, last: null }), { kind: "off" });
  /* Cinturón y tirantes: un intervalo de 0 jamás puede pintarse como "cada 0 h",
     ni aunque un servidor viejo mandara enabled desincronizado. */
  assert.deepEqual(describeSchedule({ enabled: true, interval_hours: 0, keep: 7, last: null }), { kind: "off" });
});

test("la lista sale de la más nueva a la más vieja y no toca la original", () => {
  const original: BackupFile[] = [
    { filename: "vieja.distop-backup", size: 10, created_at: 100 },
    { filename: "nueva.distop-backup", size: 30, created_at: 300 },
    { filename: "media.distop-backup", size: 20, created_at: 200 },
  ];
  const copia = [...original];

  assert.deepEqual(
    sortBackupFiles(original).map((f) => f.filename),
    ["nueva.distop-backup", "media.distop-backup", "vieja.distop-backup"],
  );
  assert.deepEqual(original, copia, "ordenar es leer, no mutar el estado de quien llama");
});

test("sin copias, lista vacía sin sorpresas", () => {
  assert.deepEqual(sortBackupFiles([]), []);
});
