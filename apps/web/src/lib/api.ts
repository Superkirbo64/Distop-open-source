/**
 * Cliente de la API de la instancia.
 * Guarda los tokens, renueva el de acceso en cuanto caduca y reintenta la
 * petición una sola vez: la sesión se cae sola solo cuando el refresh muere.
 */
import type { ApiError } from "@distop/protocol";
import { absolutizeUrls, apiUrl, relativizeUrls, sessionKey } from "./instance.ts";

/* Por instancia: la sesión de tu nodo y la del nodo de un amigo no se pisan. */
const STORAGE_KEY = sessionKey();

export interface Tokens {
  access_token: string;
  refresh_token: string;
}

export class RequestError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | undefined;

  constructor(error: ApiError) {
    super(error.message);
    this.status = error.status;
    this.code = error.code;
    this.details = error.details;
  }
}

let tokens: Tokens | null = readStored();
const listeners = new Set<(tokens: Tokens | null) => void>();

function readStored(): Tokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Tokens) : null;
  } catch {
    return null;
  }
}

export function getTokens(): Tokens | null {
  return tokens;
}

export function setTokens(next: Tokens | null): void {
  tokens = next;
  if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  else localStorage.removeItem(STORAGE_KEY);
  for (const listener of listeners) listener(next);
}

export function onTokensChanged(listener: (tokens: Tokens | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* Una sola renovación en vuelo: si tres peticiones caducan a la vez, esperan
   al mismo refresh en lugar de rotar el token tres veces y anularse entre sí. */
let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch(apiUrl("/api/v1/auth/refresh"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: tokens!.refresh_token }),
      });
      if (!res.ok) {
        setTokens(null);
        return false;
      }
      const data = (await res.json()) as Tokens;
      setTokens({ access_token: data.access_token, refresh_token: data.refresh_token });
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null; // no es JSON: no viene de la instancia
  }

  if (!res.ok) {
    const error = (body as { error?: ApiError } | null)?.error;
    // Sin error tipado, la respuesta no la escribió la instancia: la firma un
    // proxy, un túnel o un portal cautivo por el camino. Decirlo así importa,
    // porque "Internal Server Error" manda a depurar el sitio equivocado (§26).
    throw new RequestError(
      error ?? {
        code: "INSTANCE_UNREACHABLE",
        message: res.statusText || "sin respuesta de la instancia",
        status: res.status,
        requestId: "",
        timestamp: new Date().toISOString(),
      },
    );
  }
  // Empaquetado, las rutas de media de la instancia se vuelven absolutas aquí,
  // en la única puerta de entrada, y no en cada <img> del árbol.
  return absolutizeUrls(body) as T;
}

export async function api<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  // El espejo de absolutizeUrls: lo que se guarda en la instancia vuelve a ser
  // ruta relativa, no una URL absoluta que caduca cuando el túnel cambia.
  const payload = body === undefined ? undefined : relativizeUrls(structuredClone(body));
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      headers: {
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
        ...(tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
  } catch {
    throw new RequestError({
      code: "NETWORK",
      message: "network",
      status: 0,
      requestId: "",
      timestamp: new Date().toISOString(),
    });
  }

  if (res.status === 401 && retry && tokens && (await refresh())) return api<T>(method, path, body, false);
  return parse<T>(res);
}

export async function upload(file: File): Promise<{ id: string; url: string; filename: string; size: number; content_type: string }> {
  const res = await fetch(apiUrl("/api/v1/uploads"), {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      "x-filename": encodeURIComponent(file.name),
      ...(tokens ? { authorization: `Bearer ${tokens.access_token}` } : {}),
    },
    body: file,
  });
  return parse(res);
}

/** Descarga que respeta la sesión: el export no es una URL pública. */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(apiUrl(path), { headers: tokens ? { authorization: `Bearer ${tokens.access_token}` } : {} });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
