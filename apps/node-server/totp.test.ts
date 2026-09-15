/**
 * TOTP contra los vectores oficiales: si la fórmula se desvía un bit, ninguna
 * app autenticadora del mundo dará el mismo número que la instancia.
 *   node --test "totp.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { base32, deBase32, hotp, matchingStep, otpauthUri, PASO_MS } from "./totp.ts";

test("base32 casa con el RFC 4648 y vuelve a los mismos bytes", () => {
  assert.equal(base32(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(base32(Buffer.from("f")), "MY");
  assert.deepEqual(deBase32("mzxw6ytboi"), Buffer.from("foobar"));
  const bytes = Buffer.from([0, 255, 17, 128, 64, 3, 250]);
  assert.deepEqual(deBase32(base32(bytes)), bytes);
});

test("los vectores SHA-1 del RFC 6238 dan exactamente sus códigos", () => {
  const secreto = Buffer.from("12345678901234567890");
  const vectores: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [segundos, esperado] of vectores) {
    assert.equal(hotp(secreto, Math.floor(segundos / 30), 8), esperado, `T=${segundos}`);
  }
});

test("vale el código de ahora y el de al lado, nunca uno ya usado ni uno lejano", () => {
  const secretoB32 = base32(Buffer.from("12345678901234567890"));
  const ahora = 1_234_567_890_000;
  const paso = Math.floor(ahora / PASO_MS);
  const codigo = (p: number) => hotp(Buffer.from("12345678901234567890"), p);

  assert.equal(matchingStep(secretoB32, codigo(paso), ahora, -1), paso);
  assert.equal(matchingStep(secretoB32, codigo(paso - 1), ahora, -1), paso - 1, "reloj un poco atrasado");
  assert.equal(matchingStep(secretoB32, codigo(paso + 1), ahora, -1), paso + 1, "reloj un poco adelantado");
  assert.equal(matchingStep(secretoB32, codigo(paso - 3), ahora, -1), null, "un código de hace minuto y medio ya no");
  assert.equal(matchingStep(secretoB32, codigo(paso), ahora, paso), null, "el mismo código no vale dos veces");
  assert.equal(matchingStep(secretoB32, "12345", ahora, -1), null);
  assert.equal(matchingStep(secretoB32, "abcdef", ahora, -1), null);
});

test("el QR lleva el secreto, el emisor y la cuenta", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "kirbo", "Distop");
  assert.equal(uri, "otpauth://totp/Distop%3Akirbo?secret=JBSWY3DPEHPK3PXP&issuer=Distop&algorithm=SHA1&digits=6&period=30");
});
