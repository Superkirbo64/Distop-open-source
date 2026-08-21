/**
 * La lista blanca de la galeria de sonidos (§22).
 *
 * Es lo unico que separa "bajame el mp3 que elegi" de un SSRF: la ruta de
 * importar hace un fetch con la URL que manda el cliente. Si este patron se
 * afloja, esa ruta se convierte en un proxy hacia la red interna del anfitrion
 * —169.254.169.254, localhost, el router— firmado por el propio servidor.
 *
 *   node --test "*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// api.ts arrastra config y base de datos: se le da un directorio de usar y tirar.
const workdir = mkdtempSync(join(tmpdir(), "distop-sounds-"));
process.env.PORT = "0";
process.env.DATABASE_PATH = join(workdir, "test.db");
process.env.DEFAULT_STORAGE_PATH = join(workdir, "uploads");
process.env.AUTH_SECRET = "test-secret-no-usar-en-produccion";

const { MYINSTANTS_MEDIA } = await import("./api.ts");
const { hasAudioSignature } = await import("./storage.ts");

test("pasan las URL reales del catalogo", () => {
  for (const url of [
    "https://www.myinstants.com/media/sounds/vine-boom.mp3",
    "https://myinstants.com/media/sounds/vine-boom.mp3", // sin www
    "https://www.myinstants.com/media/sounds/risada_carlos_alberto_mp3cut.mp3",
    "https://www.myinstants.com/media/sounds/gato-riendo_6bOc2ur.mp3",
    "https://www.myinstants.com/media/sounds/evillaugh.swf.mp3", // punto por dentro
  ]) {
    assert.equal(MYINSTANTS_MEDIA.test(url), true, url);
  }
});

test("no pasa nada que apunte a otro sitio", () => {
  for (const url of [
    "http://www.myinstants.com/media/sounds/a.mp3", // sin TLS
    "https://evil.com/media/sounds/a.mp3",
    "https://myinstants.com.evil.com/media/sounds/a.mp3", // sufijo pegado
    "https://evil.com/?x=https://www.myinstants.com/media/sounds/a.mp3",
    "https://www.myinstants.com/media/sounds/../../../etc/passwd.mp3",
    "https://www.myinstants.com/media/sounds/a.mp3?next=http://169.254.169.254/", // metadatos de la nube
    "https://user@www.myinstants.com/media/sounds/a.mp3", // el host real es otro
    "http://127.0.0.1/media/sounds/a.mp3",
    "https://www.myinstants.com/media/sounds/a.exe",
    "https://www.myinstants.com/admin/secret.mp3", // fuera de /media/sounds/
  ]) {
    assert.equal(MYINSTANTS_MEDIA.test(url), false, url);
  }
});

test("un MIME de audio no basta: el contenido debe tener su firma", () => {
  assert.equal(hasAudioSignature("audio/mpeg", Buffer.from([0x49, 0x44, 0x33, 4])), true);
  assert.equal(hasAudioSignature("audio/mpeg", Buffer.from("texto renombrado.mp3")), false);
  assert.equal(hasAudioSignature("audio/ogg", Buffer.from("OggScontenido")), true);
  assert.equal(hasAudioSignature("audio/ogg", Buffer.from("no es ogg")), false);
  assert.equal(hasAudioSignature("audio/wav", Buffer.from("RIFFxxxxWAVEfmt ")), true);
});
