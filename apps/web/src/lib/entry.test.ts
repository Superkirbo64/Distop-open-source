/**
 * La primera pantalla de la entrada: un solo orden para todos los casos.
 *
 *   node --test "src/lib/*.test.ts"
 */
import test from "node:test";
import assert from "node:assert/strict";
import { entryMode } from "./entry.ts";

test("con perfiles del equipo o del dispositivo, primero se elige quién entra", () => {
  assert.equal(entryMode({ localAccounts: 2, hasDeviceProfile: false, registrationEnabled: true }), "profiles");
  assert.equal(entryMode({ localAccounts: 0, hasDeviceProfile: true, registrationEnabled: false }), "profiles");
});

test("sin perfiles y con registro abierto, alta directa", () => {
  assert.equal(entryMode({ localAccounts: 0, hasDeviceProfile: false, registrationEnabled: true }), "register");
});

test("sin perfiles y con registro cerrado, entrar con otra cuenta: nunca un alta que va a fallar", () => {
  assert.equal(entryMode({ localAccounts: 0, hasDeviceProfile: false, registrationEnabled: false }), "login");
});
