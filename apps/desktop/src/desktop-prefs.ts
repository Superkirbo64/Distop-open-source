/**
 * Preferencias del cascarón (§15): qué aplicaciones integradas existen y si se
 * vigila qué juego está abierto. Viven en un JSON de userData —no en el
 * localStorage del cliente— porque el proceso principal las necesita antes de
 * que el renderer arranque: la franja pinta sus pestañas al crearse la ventana
 * y es main quien tiene la última palabra sobre shell:switch.
 */
import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopPrefs {
  whatsapp: boolean;
  telegram: boolean;
  gameWatch: boolean;
}

const DEFAULTS: DesktopPrefs = { whatsapp: true, telegram: true, gameWatch: true };

function prefsPath(): string {
  return join(app.getPath("userData"), "desktop-prefs.json");
}

/** Ausente o corrupto = valores de fábrica; solo se aceptan booleanos. */
export function loadDesktopPrefs(): DesktopPrefs {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(prefsPath(), "utf8")) as Record<string, unknown>;
  } catch {
    // Primera ejecución o JSON a medio editar: fábrica.
  }
  const pick = (key: keyof DesktopPrefs): boolean =>
    typeof raw[key] === "boolean" ? (raw[key] as boolean) : DEFAULTS[key];
  return { whatsapp: pick("whatsapp"), telegram: pick("telegram"), gameWatch: pick("gameWatch") };
}

export function saveDesktopPrefs(prefs: DesktopPrefs): void {
  try {
    writeFileSync(prefsPath(), `${JSON.stringify(prefs, null, 2)}\n`);
  } catch {
    // Sin permisos de escritura, la preferencia vive lo que dure el proceso.
  }
}
