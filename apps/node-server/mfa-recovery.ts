/**
 * Recuperar el acceso de quien hospeda cuando perdió el teléfono y los códigos
 * de respaldo (plan-acceso-admin, fase B).
 *
 * Se ejecuta en la máquina, no por HTTP: en la VPS lo lanza
 * `sudo distop-admin-recovery` con `docker exec`. Quien puede ejecutarlo ya
 * manda en la máquina y podría leer la base entera, así que no abre nada nuevo.
 *
 * Imprime un código de un solo uso que vale 10 minutos. Al usarlo en la app,
 * el autenticador se borra y hay que configurar uno nuevo.
 *   node mfa-recovery.ts
 */
import { hostUserId } from "./auth.ts";
import { db } from "./db.ts";
import { createSshRecoveryCode } from "./mfa.ts";

const anfitrion = hostUserId();
const codigo = anfitrion ? createSshRecoveryCode(anfitrion) : null;
db.close();

if (!anfitrion) {
  console.error("Esta instancia todavía no tiene quien la administre: no hay nada que recuperar.");
  process.exit(1);
}
if (!codigo) {
  console.error("Quien hospeda no tiene el autenticador activado: entra con usuario y contraseña.");
  process.exit(1);
}

console.log(`Código de recuperación: ${codigo}`);
console.log("Vale 10 minutos y una sola vez. Escríbelo en la app donde pide el código de 6 dígitos.");
console.log("Al usarlo se borra el autenticador: configura uno nuevo en «Tu servidor».");
process.exit(0);
