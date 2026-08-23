/**
 * Qué webs viven dentro del cascarón y hasta dónde pueden navegar (§22).
 * Aparte para poder probarlo sin arrancar Electron, igual que game-detection.
 */

export type TabId = "distop" | "whatsapp" | "telegram";
export type GuestId = Exclude<TabId, "distop">;

export interface Guest {
  url: string;
  /** Sesión propia: ni cookies ni almacenamiento compartidos con Distop ni entre ellas. */
  partition: string;
  /** Dominios donde el huésped navega dentro de la app; lo demás sale al navegador. */
  hosts: string[];
}

export const GUESTS: Record<GuestId, Guest> = {
  whatsapp: {
    url: "https://web.whatsapp.com/",
    partition: "persist:whatsapp",
    hosts: ["whatsapp.com", "whatsapp.net"],
  },
  telegram: {
    url: "https://web.telegram.org/k/",
    partition: "persist:telegram",
    hosts: ["telegram.org"],
  },
};

export function isTabId(value: unknown): value is TabId {
  return value === "distop" || value === "whatsapp" || value === "telegram";
}

/**
 * Un huésped solo navega por lo suyo y siempre por HTTPS. Un enlace a otro
 * sitio no se abre aquí dentro: se manda al navegador del sistema.
 */
export function allowed(guest: Guest, url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // Comparar por sufijo con el punto delante: "notwhatsapp.com" no cuela.
  return guest.hosts.some((host) => parsed.hostname === host || parsed.hostname.endsWith("." + host));
}
