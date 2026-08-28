/**
 * Explorar comunidades públicas (§34, §19).
 *
 * La lista sale de `directorySources()`: hoy solo la instancia activa, mañana
 * también el directorio global sin tocar esta vista. Los tres estados se dicen
 * tal cual son (§26): directorio apagado, encendido pero vacío, o error de la
 * fuente — nunca una lista en blanco sin explicación.
 *
 * Límite honesto v1: una ficha no lleva invitación. Entrar sigue exigiendo un
 * enlace de alguien de dentro, y la interfaz lo dice en vez de fingir un botón
 * de "unirse" que no existe en el protocolo.
 */
import { useEffect, useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { collectDirectory, directorySources, type DirectoryListing } from "../lib/directory.ts";
import { EmptyState, ErrorNote, Modal, Spinner, useErrorText, useT } from "./ui.tsx";

export function Explore({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const enabled = useStore((s) => s.publicDiscoveryEnabled);

  const [isHost, setIsHost] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);

  /* ¿Quien mira es además quien hospeda? Mismo patrón 403 que el resto del
     panel de servidor: un GET host-only que falla en silencio. Solo cambia el
     texto de ayuda — al anfitrión se le dice qué variable enciende el
     directorio; a cualquier otra persona, solo que está apagado. */
  useEffect(() => {
    if (!open) return;
    void api("GET", "/api/v1/instance/relay")
      .then(() => setIsHost(true))
      .catch(() => setIsHost(false));
  }, [open]);

  useEffect(() => {
    if (!open || !enabled) return;
    setListing(null);
    void collectDirectory(directorySources()).then(setListing);
  }, [open, enabled]);

  const failure = listing && listing.communities.length === 0 ? listing.failures[0] : undefined;

  return (
    <Modal open={open} onClose={onClose} title={t("explore.title")}>
      {!enabled ? (
        <EmptyState
          title={t("explore.disabled")}
          {...(isHost ? { hint: t("explore.disabledHostHint") } : {})}
        />
      ) : !listing ? (
        <Spinner label={t("common.loading")} />
      ) : failure ? (
        <ErrorNote>{errorText(failure.error)}</ErrorNote>
      ) : listing.communities.length === 0 ? (
        <EmptyState title={t("explore.empty")} hint={t("explore.emptyHint")} />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {listing.communities.map((community) => (
              <li
                key={`${community.origin ?? ""}:${community.id}`}
                className="flex items-center gap-3 rounded-[10px] border border-line p-3"
              >
                {community.icon_url ? (
                  <img src={community.icon_url} alt="" className="h-10 w-10 shrink-0 rounded-[12px] object-cover" />
                ) : (
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] text-white"
                    // Color por estilo en línea, como la vista previa de invitación:
                    // el acento viene de datos, no de una clase conocida de antemano.
                    style={{ background: community.accent_color ?? "var(--accent)" }}
                  >
                    <span className="display text-sm font-bold">{community.name.slice(0, 2).toUpperCase()}</span>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="display truncate font-bold">{community.name}</p>
                  {community.description ? <p className="truncate text-xs text-muted">{community.description}</p> : null}
                  <p className="text-xs text-muted">
                    {t(community.members === 1 ? "invite.memberOne" : "invite.members", { count: community.members })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">{t("explore.needInvite")}</p>
        </div>
      )}
    </Modal>
  );
}
