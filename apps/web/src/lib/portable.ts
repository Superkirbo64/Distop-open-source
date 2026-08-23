/**
 * Identidad privada de esta instalación de la app.
 *
 * No es una cuenta central: el id y el secreto viven únicamente en este
 * dispositivo. Cada servidor guarda solo un hash del secreto y crea su propia
 * fila de usuario, pero para la persona se ve y se comporta como un único
 * perfil que viaja con ella.
 */
import type { SelfUser } from "@distop/protocol";
import { api, upload } from "./api.ts";
import { clientOrigin } from "./instance.ts";

const KEY = "distop.portableIdentity";
const MEDIA_DB = "distop-portable-profile";
const MEDIA_STORE = "media";

export interface PortableIdentity {
  identity_id: string;
  secret: string;
  profile: Pick<
    SelfUser,
    | "username"
    | "display_name"
    | "avatar_url"
    | "banner_url"
    | "bio"
    | "pronouns"
    | "accent_color"
    | "profile_style"
  >;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function portableIdentity(): PortableIdentity | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as PortableIdentity;
    if (!value?.identity_id || !value.secret || !value.profile?.display_name) return null;
    return value;
  } catch {
    return null;
  }
}

function profileOf(user: SelfUser): PortableIdentity["profile"] {
  return {
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    banner_url: user.banner_url,
    bio: user.bio,
    pronouns: user.pronouns,
    accent_color: user.accent_color,
    profile_style: user.profile_style,
  };
}

function mediaDatabase(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in globalThis)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(MEDIA_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(MEDIA_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function rememberMedia(key: "avatar" | "banner", url: string | null): Promise<void> {
  if (!url) return;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return;
    const blob = await response.blob();
    // El perfil no debe convertir la base local del navegador en una copia de
    // archivos enormes. Cinco MB bastan de sobra para avatar y banner normales.
    if (!blob.type.startsWith("image/") || blob.size > 5 * 1024 * 1024) return;
    const database = await mediaDatabase();
    if (!database) return;
    await new Promise<void>((resolve) => {
      const transaction = database.transaction(MEDIA_STORE, "readwrite");
      transaction.objectStore(MEDIA_STORE).put(blob, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
    database.close();
  } catch {
    // Si la imagen ya no responde, el resto del perfil sigue viajando.
  }
}

async function savedMedia(key: "avatar" | "banner"): Promise<Blob | null> {
  const database = await mediaDatabase();
  if (!database) return null;
  return new Promise((resolve) => {
    const transaction = database.transaction(MEDIA_STORE, "readonly");
    const request = transaction.objectStore(MEDIA_STORE).get(key);
    request.onsuccess = () => {
      const value = request.result;
      resolve(value instanceof Blob ? value : null);
      database.close();
    };
    request.onerror = () => {
      resolve(null);
      database.close();
    };
  });
}

/** Se ejecuta antes de salir de la instancia actual hacia una invitación. */
export async function ensurePortableIdentity(user: SelfUser): Promise<PortableIdentity> {
  const previous = portableIdentity();
  const identity: PortableIdentity = previous
    ? { ...previous, profile: profileOf(user) }
    : { identity_id: crypto.randomUUID(), secret: randomSecret(), profile: profileOf(user) };
  localStorage.setItem(KEY, JSON.stringify(identity));
  await api("PUT", "/api/v1/users/me/portable", {
    identity_id: identity.identity_id,
    secret: identity.secret,
  });
  // Se copian antes de cambiar de servidor. Después el origen podría estar
  // apagado y el avatar quedaría como un enlace roto en la comunidad amiga.
  await Promise.all([rememberMedia("avatar", user.avatar_url), rememberMedia("banner", user.banner_url)]);
  return identity;
}

export function portableAuthPayload(inviteCode?: string | null): Record<string, unknown> | null {
  const identity = portableIdentity();
  if (!identity) return null;
  return {
    identity_id: identity.identity_id,
    secret: identity.secret,
    ...identity.profile,
    ...(inviteCode ? { invite_code: inviteCode } : {}),
  };
}

/** Copia las imágenes guardadas al servidor recién abierto, una sola vez. */
export async function syncPortableMedia(user: SelfUser): Promise<SelfUser> {
  const origin = clientOrigin().replace(/\/$/, "");
  const patch: Record<string, string> = {};
  for (const [key, field] of [
    ["avatar", "avatar_url"],
    ["banner", "banner_url"],
  ] as const) {
    const current = user[field];
    if (!current || current.startsWith(`${origin}/`) || current.startsWith("/")) continue;
    const blob = await savedMedia(key);
    if (!blob) continue;
    try {
      const extension = blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      const attachment = await upload(new File([blob], `${key}.${extension}`, { type: blob.type }));
      patch[field] = attachment.url;
    } catch {
      // Un servidor puede imponer un límite menor o rechazar el formato. El
      // perfil textual sigue funcionando y se conserva la URL anterior.
    }
  }
  return Object.keys(patch).length ? api<SelfUser>("PATCH", "/api/v1/users/me", patch) : user;
}
