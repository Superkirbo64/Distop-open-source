/**
 * Web Push desde el lado del navegador (A2).
 *
 * Sirve para una cosa que ninguna otra pieza da: recibir un aviso con la
 * aplicación **cerrada**. El vigilante de la bandeja del escritorio necesita
 * que Distop esté abierto en algún sitio; esto no.
 *
 * Es opcional a propósito y lo pide la persona, no la instancia. Y antes de
 * pedirlo hay que decir la parte incómoda: aunque el contenido va cifrado de
 * extremo a extremo y no lleva ni nombres ni texto, **el proveedor de push del
 * navegador ve el momento, la frecuencia y el tamaño** de cada aviso. Eso es
 * inherente a Web Push y no hay forma de evitarlo.
 */
import { api } from "./api.ts";
import { isPackaged } from "./instance.ts";

/**
 * En la aplicación empaquetada esto no existe y no puede existir: Electron no
 * trae servicio de push y el origen es `app://distop`. Ahí el aviso lo da el
 * vigilante de la bandeja, que además no depende de ningún tercero.
 */
export function pushSupported(): boolean {
  return (
    !isPackaged() &&
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function toBase64Url(buffer: ArrayBuffer | null): string {
  if (!buffer) return "";
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function registro(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

export interface PushState {
  supported: boolean;
  /** La instancia puede mandarlos: tiene dirección pública o contacto. */
  available: boolean;
  enabled: boolean;
  permission: NotificationPermission | "unsupported";
}

export async function pushState(): Promise<PushState> {
  const base: PushState = {
    supported: pushSupported(),
    available: false,
    enabled: false,
    permission: typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  };
  if (!base.supported) return base;

  const reg = await registro();
  base.enabled = Boolean(await reg?.pushManager.getSubscription());
  try {
    base.available = (await api<{ available: boolean }>("GET", "/api/v1/push/key")).available;
  } catch {
    /* La instancia no lo ofrece o no responde: se enseña apagado, no roto. */
  }
  return base;
}

export type PushFailure = "unsupported" | "unavailable" | "denied" | "failed";

/**
 * Activa los avisos. Devuelve `null` si salió bien, o por qué no salió.
 *
 * El permiso se pide **aquí y no al abrir la aplicación**: un navegador que
 * recibe la petición de permiso nada más cargar la enseña fuera de contexto, y
 * mucha gente la deniega para siempre por reflejo. Se pregunta cuando alguien
 * acaba de pulsar el interruptor, que es cuando la pregunta se entiende.
 */
export async function enablePush(): Promise<PushFailure | null> {
  if (!pushSupported()) return "unsupported";

  let clave: { public_key: string; available: boolean };
  try {
    clave = await api<{ public_key: string; available: boolean }>("GET", "/api/v1/push/key");
  } catch {
    return "unavailable";
  }
  if (!clave.available) return "unavailable";

  const permiso = await Notification.requestPermission();
  if (permiso !== "granted") return "denied";

  const reg = await registro();
  if (!reg) return "unsupported";

  try {
    /* `userVisibleOnly` es obligatorio en Chromium y además es la verdad: cada
       aviso que llegue se enseña. Un push silencioso sería una forma de saber
       cuándo está encendido el ordenador de alguien. */
    const suscripcion =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64Url(clave.public_key),
      }));

    await api("POST", "/api/v1/push/subscriptions", {
      endpoint: suscripcion.endpoint,
      keys: {
        p256dh: toBase64Url(suscripcion.getKey("p256dh")),
        auth: toBase64Url(suscripcion.getKey("auth")),
      },
    });
    return null;
  } catch {
    return "failed";
  }
}

/**
 * Desactiva los avisos: se da de baja en el navegador **y** se borra de la
 * instancia. Solo lo primero dejaría una fila muerta en la base de quien
 * hospeda; solo lo segundo dejaría al navegador despertándose para nada.
 */
export async function disablePush(): Promise<void> {
  const reg = await registro();
  const suscripcion = await reg?.pushManager.getSubscription();
  if (!suscripcion) return;
  try {
    await api("DELETE", "/api/v1/push/subscriptions", { endpoint: suscripcion.endpoint });
  } catch {
    /* Si la instancia no contesta, igual se cancela por este lado: el aviso
       dejará de llegar, que es lo que la persona acaba de pedir. */
  }
  await suscripcion.unsubscribe();
}
