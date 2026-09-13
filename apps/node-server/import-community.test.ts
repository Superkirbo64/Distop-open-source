import assert from "node:assert/strict";
import test from "node:test";
import { parseImportCommunityArgs } from "./import-community.ts";

test("la entrada de importación exige rutas explícitas y confirmación", () => {
  assert.deepEqual(
    parseImportCommunityArgs([
      "--bundle", "community.distop-backup",
      "--certificate", "certificate.json",
      "--target", "./data",
      "--confirm-stopped",
    ]),
    {
      bundle: "community.distop-backup",
      certificate: "certificate.json",
      target: "./data",
      confirmStopped: true,
      help: false,
    },
  );
});

test("una opción desconocida no se ignora en silencio", () => {
  assert.throws(() => parseImportCommunityArgs(["--replace"]), /Opción desconocida/);
});

test("una opción con valor ausente se rechaza", () => {
  assert.throws(() => parseImportCommunityArgs(["--bundle"]), /Falta el valor/);
  assert.throws(() => parseImportCommunityArgs(["--bundle", "--target", "data"]), /Falta el valor/);
});

