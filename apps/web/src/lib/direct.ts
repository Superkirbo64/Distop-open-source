import type { DirectMessage } from "@distop/protocol";

/* useSyncExternalStore exige que un snapshot sin cambios conserve identidad.
   Un `?? []` dentro del selector crea un array distinto en cada lectura y, en
   React 19, un DM nuevo sin caché termina en un bucle de renderizado. */
const EMPTY_DIRECT_MESSAGES: DirectMessage[] = [];

export function directMessagesFor(
  activeId: string | null,
  messages: Record<string, DirectMessage[]>,
): DirectMessage[] {
  return activeId ? messages[activeId] ?? EMPTY_DIRECT_MESSAGES : EMPTY_DIRECT_MESSAGES;
}
