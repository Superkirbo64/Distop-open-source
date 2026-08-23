/** Lógica pura de detección; separada de Electron para poder probarla. */

/** Primer campo de cada línea del CSV de tasklist: el nombre del ejecutable. */
export function parseTasklist(csv: string): Set<string> {
  const processes = new Set<string>();
  for (const line of csv.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim());
    if (match?.[1]) processes.add(match[1].toLowerCase());
  }
  return processes;
}

/**
 * El catálogo ya viene normalizado a minúsculas. Si el juego actual sigue
 * abierto se conserva para que arrancar un segundo juego no haga parpadear la
 * presencia; si no, gana el primer ejecutable del catálogo que esté vivo.
 */
export function detectGame(
  running: ReadonlySet<string>,
  catalog: ReadonlyMap<string, string>,
  current: string | null,
): string | null {
  if (current) {
    for (const [exe, name] of catalog) {
      if (name === current && running.has(exe)) return current;
    }
  }

  for (const [exe, name] of catalog) {
    if (running.has(exe)) return name;
  }
  return null;
}

/* ── Steam ─────────────────────────────────────────────────────────────
   Un catálogo de ejecutables solo reconoce lo que alguien puso en la lista, y
   por eso abrir un juego cualquiera de Steam no encendía nada. Steam ya lleva la
   cuenta él mismo: mientras hay una partida abierta escribe el appid en
   HKCU\Software\Valve\Steam\RunningAppID, y el nombre en Apps\<appid>\Name.
   Leer esos dos valores reconoce toda la biblioteca sin mantener lista alguna, y
   con el nombre que usa el propio Steam. Sigue sin salir de esta máquina nada
   más que ese nombre (§8, §22). */

/**
 * Quién gana cuando hay más de una pista. Vive aquí, separado de `scan()`, para
 * que el orden sea comprobable: es justo lo que estaba mal y no lo enseñaba nada.
 *
 * Steam va primero porque lo suyo es un hecho —él mismo apunta qué partida tiene
 * abierta— y el catálogo es una conjetura por el nombre del ejecutable, con
 * nombres tan genéricos como `launcher.exe` dentro. Al revés, cualquier programa
 * del equipo llamado así tapaba a Steam para siempre.
 */
export function pickGame(steam: string | null, fromCatalog: string | null): string | null {
  return steam ?? fromCatalog;
}

/** El valor de un REG_DWORD dentro de la salida de `reg query`. */
export function parseRegDword(out: string): number | null {
  const match = /REG_DWORD\s+0x([0-9a-f]+)/i.exec(out);
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 16);
  return Number.isSafeInteger(value) ? value : null;
}

/** El valor de un REG_SZ dentro de la salida de `reg query`, que puede llevar espacios. */
export function parseRegString(out: string): string | null {
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/.exec(out);
  const value = match?.[1]?.trim();
  return value ? value.slice(0, 100) : null;
}

/* ── Epic ──────────────────────────────────────────────────────────────
   Epic no apunta en ningún sitio qué partida está abierta, así que aquí no hay
   atajo como el de Steam y sigue haciendo falta mirar los procesos. Lo que sí
   deja es un manifiesto por juego instalado con su nombre y su carpeta, y de ahí
   sale la lista de ejecutables sola: el catálogo se escribe él, en vez de a
   mano. */

/** Nombre y carpeta de un manifiesto `.item` de Epic, o null si no sirve. */
export function parseEpicManifest(raw: string): { name: string; install: string; exe: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // manifiesto a medio escribir mientras Epic instala algo
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { DisplayName, InstallLocation, LaunchExecutable } = parsed as Record<string, unknown>;
  if (typeof DisplayName !== "string" || typeof InstallLocation !== "string") return null;
  const name = DisplayName.trim().slice(0, 100);
  const install = InstallLocation.trim();
  if (!name || !install) return null;
  // LaunchExecutable llega como ruta relativa ("Binaries/Win64/Launcher.exe"):
  // aquí solo interesa el nombre, que es lo que devuelve tasklist.
  const exe = typeof LaunchExecutable === "string" ? (/[^\\/]+$/.exec(LaunchExecutable.trim())?.[0] ?? "") : "";
  return { name, install, exe: exe.toLowerCase() };
}
