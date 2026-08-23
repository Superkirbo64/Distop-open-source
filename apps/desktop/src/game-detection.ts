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
