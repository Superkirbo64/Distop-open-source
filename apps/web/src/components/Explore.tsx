/** Explorar comunidades locales y del índice global, sin acoplar sus fallos. */
import { useEffect, useState } from "react";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { collectDirectory, directorySources, enterDirectoryCommunity, type DirectoryListing } from "../lib/directory.ts";
import { Button, EmptyState, ErrorNote, Modal, Spinner, useErrorText, useT } from "./ui.tsx";

export function Explore({ open, onClose, onJoinWithLink }: { open: boolean; onClose: () => void; onJoinWithLink?: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const enabled = useStore((s) => s.publicDiscoveryEnabled);
  const directoryUrl = useStore((s) => s.directoryUrl);
  const reloadCommunities = useStore((s) => s.reloadCommunities);
  const openCommunity = useStore((s) => s.openCommunity);
  const mine = useStore((s) => s.communities);

  const [isHost, setIsHost] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void api("GET", "/api/v1/instance/relay")
      .then(() => setIsHost(true))
      .catch(() => setIsHost(false));
  }, [open]);

  useEffect(() => {
    if (!open || (!enabled && !directoryUrl)) return;
    setListing(null);
    setJoinError(null);
    void collectDirectory(directorySources({ localEnabled: enabled, directoryUrl })).then(setListing);
  }, [open, enabled, directoryUrl]);

  const failure = listing && listing.communities.length === 0 ? listing.failures[0] : undefined;

  return (
    <Modal open={open} onClose={onClose} title={t("explore.title")}>
      {!enabled && !directoryUrl ? (
        <EmptyState title={t("explore.disabled")} {...(isHost ? { hint: t("explore.disabledHostHint") } : {})} />
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
              <li key={`${community.origin ?? ""}:${community.id}`} className="flex items-center gap-3 rounded-[10px] border border-line p-3">
                {community.icon_url ? (
                  <img src={community.icon_url} alt="" className="h-10 w-10 shrink-0 rounded-[12px] object-cover" />
                ) : (
                  <span
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] text-white"
                    style={{ background: community.accent_color ?? "var(--accent)" }}
                  >
                    <span className="display text-sm font-bold">{community.name.slice(0, 2).toUpperCase()}</span>
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <p className="display truncate font-bold">{community.name}</p>
                  {community.description ? <p className="truncate text-xs text-muted">{community.description}</p> : null}
                  <p className="truncate text-xs text-muted">
                    {t(community.members === 1 ? "invite.memberOne" : "invite.members", { count: community.members })}
                    {/* De quién es el servidor. Entrar aquí lleva a la máquina de
                        otra persona: ocultar a cuál sería pedir confianza a ciegas. */}
                    {community.origin ? ` · ${new URL(community.origin).host}` : ""}
                  </p>
                </div>
                {mine.some((item) => item.id === community.id) ? (
                  /* Tu propia comunidad también aparece aquí en cuanto la publicas.
                     Ofrecer «Entrar» a un sitio donde ya estás no significa nada. */
                  <Button variant="ghost" onClick={() => { void openCommunity(community.id); onClose(); }}>
                    {t("explore.openMine")}
                  </Button>
                ) : community.join_policy === "open" || community.join_policy === "request" ? (
                  <Button
                    variant="primary"
                    disabled={joining !== null}
                    onClick={async () => {
                      setJoining(community.id);
                      setJoinError(null);
                      try {
                        const result = await enterDirectoryCommunity(community);
                        if (result === "joined") {
                          await reloadCommunities();
                          await openCommunity(community.id);
                          onClose();
                        } else if (result === "requested") {
                          setJoinError(t("explore.requested"));
                        } else if (result !== "switching") {
                          setJoinError(t(result === "identity-mismatch" ? "explore.identityMismatch" : "explore.unreachable"));
                        }
                      } catch (error) {
                        setJoinError(errorText(error));
                      } finally {
                        setJoining(null);
                      }
                    }}
                  >
                    {joining === community.id
                      ? t("common.loading")
                      : t(community.join_policy === "request" ? "explore.request" : "explore.join")}
                  </Button>
                ) : (
                  <span className="shrink-0 text-xs text-muted">
                    {t("explore.inviteOnly")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {joinError ? <ErrorNote>{joinError}</ErrorNote> : null}
          {onJoinWithLink ? (
            /* Vivía en el carril, entre los iconos de comunidades. Su sitio es
               este: quien no encuentra la suya en la lista es quien tiene un
               enlace en el bolsillo. */
            <Button variant="ghost" onClick={() => { onClose(); onJoinWithLink(); }}>
              {t("community.join")}
            </Button>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
