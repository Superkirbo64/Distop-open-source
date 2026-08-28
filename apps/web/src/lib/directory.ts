/**
 * De dónde salen las comunidades de "Explorar" (§19).
 *
 * Hoy la única fuente es el descubrimiento de la instancia activa
 * (`GET /api/v1/discovery`), pero la costura está hecha para federar: el día
 * que exista el directorio global (docs/planes/n2-directorio-publico.md) se
 * registra aquí como segunda fuente y la vista no cambia. Por eso la
 * agregación usa `Promise.allSettled`: una fuente caída no puede tumbar la
 * lista de las demás.
 */
import { api } from "./api.ts";
import type { MessageKey } from "../i18n.ts";

/** Una ficha del directorio, tal como la devuelve el descubrimiento. */
export interface DirectoryCommunity {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon_url: string | null;
  banner_url: string | null;
  accent_color: string | null;
  members: number;
  /** De qué nodo viene la ficha. Ausente = la instancia activa. */
  origin?: string;
}

/** Un lugar al que preguntar por comunidades públicas. */
export interface DirectorySource {
  id: string;
  /** Clave de traducción, no texto: el nombre de la fuente se pinta en la vista. */
  labelKey: MessageKey;
  list: () => Promise<DirectoryCommunity[]>;
}

export interface DirectoryFailure {
  source: string;
  error: unknown;
}

export interface DirectoryListing {
  communities: DirectoryCommunity[];
  failures: DirectoryFailure[];
}

const instanceSource: DirectorySource = {
  id: "instance",
  labelKey: "explore.sourceInstance",
  list: () => api<DirectoryCommunity[]>("GET", "/api/v1/discovery"),
};

/**
 * Las fuentes vigentes, en el orden en que se preguntan. v1: solo la instancia.
 * Es una función y no una constante para que las fuentes futuras puedan
 * depender de configuración viva (qué directorio global usar, si alguno).
 */
export function directorySources(): DirectorySource[] {
  return [instanceSource];
}

/**
 * Pregunta a todas las fuentes y junta lo que contesten. Los fallos no se
 * tragan: vuelven con nombre para que la vista pueda decir qué fuente falló
 * en vez de enseñar una lista misteriosamente corta (§26).
 */
export async function collectDirectory(sources: DirectorySource[]): Promise<DirectoryListing> {
  const settled = await Promise.allSettled(sources.map((source) => source.list()));
  const communities: DirectoryCommunity[] = [];
  const failures: DirectoryFailure[] = [];
  settled.forEach((result, index) => {
    const source = sources[index]!;
    if (result.status === "fulfilled") communities.push(...result.value);
    else failures.push({ source: source.id, error: result.reason });
  });
  return { communities, failures };
}
