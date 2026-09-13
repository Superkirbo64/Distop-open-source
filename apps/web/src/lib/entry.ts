/**
 * Qué enseña primero la carcasa de entrada (la misma en navegador, PC y teléfono).
 *
 * Con perfiles de este equipo o la identidad del dispositivo: elegir quién entra.
 * Sin ninguno: dar de alta directamente si el servidor lo permite; si tiene el
 * registro cerrado, entrar con otra cuenta. Nunca un formulario que va a fallar.
 */
export type EntryMode = "profiles" | "login" | "register";

export function entryMode(opts: { localAccounts: number; hasDeviceProfile: boolean; registrationEnabled: boolean }): EntryMode {
  if (opts.localAccounts > 0 || opts.hasDeviceProfile) return "profiles";
  return opts.registrationEnabled ? "register" : "login";
}
