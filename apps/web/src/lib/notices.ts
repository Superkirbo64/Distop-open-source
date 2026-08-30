/**
 * Avisos: uno solo para todo (§9.2, §26).
 *
 * Antes cada cosa avisaba a su manera —un sonido aquí, una notificación del
 * sistema allá, un error que solo se veía si tenías el panel abierto— y nada
 * quedaba escrito. Quien volvía al ordenador media hora después no tenía forma
 * de saber qué se había perdido.
 *
 * Aquí vive el registro. La presentación (el aviso que asoma y el historial)
 * está en `components/Notices.tsx`; el sonido y la notificación del sistema
 * siguen en `notify.ts`, que ya sabía hacerlo.
 */

export type NoticeKind = "message" | "mention" | "member" | "meeting" | "request" | "instance" | "error";

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  body: string;
  at: number;
  read: boolean;
  /** A dónde lleva al pulsarlo. Sin esto, un aviso es un callejón sin salida. */
  target?: { channelId?: string; communityId?: string } | undefined;
}

const CLAVE = "distop.notices";
/** Cuántos se guardan. Un historial infinito solo sirve para no mirarlo nunca. */
const MAXIMO = 60;

export function loadNotices(): Notice[] {
  try {
    const crudo: unknown = JSON.parse(localStorage.getItem(CLAVE) ?? "[]");
    if (!Array.isArray(crudo)) return [];
    return crudo.filter((item): item is Notice =>
      typeof item === "object" && item !== null && typeof (item as Notice).id === "string"
    ).slice(0, MAXIMO);
  } catch {
    return [];
  }
}

export function saveNotices(notices: Notice[]): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(notices.slice(0, MAXIMO)));
  } catch {
    /* Modo privado o disco lleno: el historial es una comodidad, no un dato. */
  }
}

export function addNotice(list: Notice[], notice: Notice): Notice[] {
  return [notice, ...list].slice(0, MAXIMO);
}

/** Cuántos quedan sin leer, que es lo único que necesita el punto del carril. */
export function unreadNotices(list: Notice[]): number {
  return list.reduce((total, notice) => total + (notice.read ? 0 : 1), 0);
}
