/**
 * Galerías de GIF y stickers con las claves del proyecto (§12, §16.2).
 *
 * Las claves viven en las variables de entorno de este servicio y nunca salen
 * de aquí: ni en la app, ni en el repositorio, ni en el servidor de cada
 * anfitrión. Una instancia sin clave propia pregunta a este proxy, que devuelve
 * solo los seis campos que pinta el selector, no el JSON entero del tercero.
 */

export interface Gif {
  id: string;
  /** Lo que se manda al elegirlo. */
  url: string;
  /** Versión ligera para la rejilla. */
  preview: string;
  title: string;
  width: number;
  height: number;
}

export interface ExpressionKeys {
  klipy: string;
  giphy: string;
}

export type ExpressionKind = "gifs" | "stickers";

type Fetch = (url: URL, init?: RequestInit) => Promise<Response>;

/** Qué pestañas puede ofrecer una instancia que dependa de este proxy. */
export function available(keys: ExpressionKeys): { gifs: boolean; stickers: boolean } {
  return { gifs: Boolean(keys.klipy || keys.giphy), stickers: Boolean(keys.klipy) };
}

/** Klipy anida los formatos por tamaño: md para mandar, xs para la rejilla; webp antes que gif. */
export function normalizeKlipy(json: unknown): Gif[] {
  type Archivo = { url?: string; width?: number; height?: number };
  type Tamano = Partial<Record<"webp" | "gif" | "png", Archivo>>;
  const lista = (json as { data?: { data?: unknown[] } })?.data?.data;
  if (!Array.isArray(lista)) return [];
  const archivo = (t: Tamano | undefined): Archivo | undefined => t?.webp ?? t?.gif ?? t?.png;
  return lista.flatMap((raw): Gif[] => {
    const item = raw as { slug?: string; title?: string; file?: Partial<Record<"hd" | "md" | "sm" | "xs", Tamano>> };
    const grande = archivo(item.file?.md ?? item.file?.hd ?? item.file?.sm);
    const pequeno = archivo(item.file?.xs ?? item.file?.sm) ?? grande;
    if (!item.slug || !grande?.url || !pequeno?.url) return [];
    return [{
      id: item.slug,
      url: grande.url,
      preview: pequeno.url,
      title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
      width: Number(grande.width) || 0,
      height: Number(grande.height) || 0,
    }];
  });
}

export function normalizeGiphy(json: unknown): Gif[] {
  const lista = (json as { data?: unknown[] })?.data;
  if (!Array.isArray(lista)) return [];
  return lista.flatMap((raw): Gif[] => {
    const item = raw as { id?: string; title?: string; images?: Record<string, { url?: string; width?: string; height?: string }> };
    const grande = item.images?.downsized_medium ?? item.images?.original;
    const pequeno = item.images?.fixed_width_small ?? item.images?.preview_gif ?? grande;
    if (!item.id || !grande?.url || !pequeno?.url) return [];
    return [{
      id: item.id,
      url: grande.url,
      preview: pequeno.url,
      title: typeof item.title === "string" ? item.title.slice(0, 120) : "",
      width: Number(grande.width) || 0,
      height: Number(grande.height) || 0,
    }];
  });
}

/**
 * Busca (o, sin texto, trae lo que está en portada). Klipy primero —gratis y con
 * stickers transparentes—; Giphy solo para GIF y solo si no hay clave de Klipy.
 */
export async function searchExpressions(
  kind: ExpressionKind,
  query: string,
  options: { limit: number; region?: string | undefined },
  keys: ExpressionKeys,
  fetchFn: Fetch = fetch,
): Promise<Gif[]> {
  const q = query.trim().slice(0, 100);
  const limit = String(Math.min(Math.max(Math.trunc(options.limit) || 24, 1), 50));

  if (keys.klipy) {
    // La clave va en la RUTA: así lo define Klipy.
    const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(keys.klipy)}/${kind}/${q ? "search" : "trending"}`);
    url.searchParams.set("format_filter", "webp,gif");
    url.searchParams.set("content_filter", "medium");
    url.searchParams.set("per_page", limit);
    if (options.region) url.searchParams.set("locale", options.region);
    if (q) url.searchParams.set("q", q);
    return normalizeKlipy(await upstream(url, fetchFn));
  }

  if (kind === "gifs" && keys.giphy) {
    const url = new URL(`https://api.giphy.com/v1/gifs/${q ? "search" : "trending"}`);
    url.searchParams.set("api_key", keys.giphy);
    url.searchParams.set("rating", "pg-13");
    url.searchParams.set("limit", limit);
    if (q) url.searchParams.set("q", q);
    return normalizeGiphy(await upstream(url, fetchFn));
  }

  throw new Error("EXPRESSIONS_DISABLED");
}

async function upstream(url: URL, fetchFn: Fetch): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(8_000) }).catch(() => null);
  if (!response?.ok) throw new Error("EXPRESSIONS_UPSTREAM");
  return await response.json();
}
