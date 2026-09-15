/**
 * Códigos de 6 dígitos de una app autenticadora (TOTP, RFC 6238).
 *
 * El teléfono y la instancia calculan el mismo número por separado a partir
 * de un secreto compartido una sola vez (el QR) y de la hora: nadie le manda
 * el código al teléfono, por eso funciona en modo avión. Solo `node:crypto`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const PASO_MS = 30_000;

/** Base32 sin relleno (RFC 4648): el formato que leen Google Authenticator y compañía. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let valor = 0;
  let salida = "";
  for (const byte of bytes) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
    valor &= (1 << bits) - 1;
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

export function deBase32(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/\s+|=+$/g, "");
  let bits = 0;
  let valor = 0;
  const salida: number[] = [];
  for (const letra of limpio) {
    const indice = ALFABETO.indexOf(letra);
    if (indice < 0) throw new Error("BASE32_INVALID");
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      salida.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
    valor &= (1 << bits) - 1;
  }
  return Buffer.from(salida);
}

/** 20 bytes: el tamaño que recomienda el RFC para HMAC-SHA1. */
export function newTotpSecret(): string {
  return base32(randomBytes(20));
}

/** HOTP (RFC 4226): el código del contador `counter`. */
export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const mensaje = Buffer.alloc(8);
  mensaje.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(mensaje).digest();
  const desde = mac[mac.length - 1]! & 0x0f;
  const numero =
    ((mac[desde]! & 0x7f) << 24) | (mac[desde + 1]! << 16) | (mac[desde + 2]! << 8) | mac[desde + 3]!;
  return String(numero % 10 ** digits).padStart(digits, "0");
}

export const stepAt = (now: number): number => Math.floor(now / PASO_MS);

/**
 * El paso de 30 s con el que casa `code`, o null.
 *
 * Acepta el anterior y el siguiente porque los relojes no van clavados, y solo
 * pasos posteriores a `usedStep`: un código ya usado no vuelve a valer, aunque
 * alguien lo haya visto por encima del hombro dentro de su medio minuto.
 */
export function matchingStep(secretB32: string, code: string, now: number, usedStep: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secreto = deBase32(secretB32);
  const actual = stepAt(now);
  for (const paso of [actual - 1, actual, actual + 1]) {
    if (paso <= usedStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secreto, paso)), Buffer.from(code))) return paso;
  }
  return null;
}

/** Lo que va dentro del QR que se escanea con la app autenticadora. */
export function otpauthUri(secretB32: string, account: string, issuer: string): string {
  const etiqueta = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${etiqueta}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
