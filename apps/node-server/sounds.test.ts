/**
 * Sonidos de la comunidad (§10.3): lo que se sube tiene que ser audio de verdad.
 *
 *   node --test "*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// storage.ts arrastra config: se le da un directorio de usar y tirar.
const workdir = mkdtempSync(join(tmpdir(), "distop-sounds-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { hasAudioSignature } = await import("./storage.ts");

test("un MIME de audio no basta: el contenido debe tener su firma", () => {
  assert.equal(hasAudioSignature("audio/mpeg", Buffer.from([0x49, 0x44, 0x33, 4])), true);
  assert.equal(hasAudioSignature("audio/mpeg", Buffer.from("texto renombrado.mp3")), false);
  assert.equal(hasAudioSignature("audio/ogg", Buffer.from("OggScontenido")), true);
  assert.equal(hasAudioSignature("audio/ogg", Buffer.from("no es ogg")), false);
  assert.equal(hasAudioSignature("audio/wav", Buffer.from("RIFFxxxxWAVEfmt ")), true);
});
