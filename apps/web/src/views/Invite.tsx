/**
 * Pantalla de invitación (§5).
 * Se puede ver a qué te invitan antes de decidir: nombre, gente dentro y quién
 * hospeda. Entrar sin cuenta es una opción de primera clase, no un truco.
 */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import { api, getTokens } from "../lib/api.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, Spinner, useT, useErrorText } from "../components/ui.tsx";

interface InvitePreview {
  code: string;
  community: {
    id: string;
    name: string;
    description: string | null;
    icon_url: string | null;
    banner_url: string | null;
    accent_color: string;
  };
  members: number;
  online: number;
  guest_mode_enabled: boolean;
}

export function Invite({ code, onEnter }: { code: string; onEnter: (communityId: string) => void }) {
  const t = useT();
  const errorText = useErrorText();
  const user = useStore((s) => s.user);
  const authenticate = useStore((s) => s.authenticate);
  const logout = useStore((s) => s.logout);
  const reloadCommunities = useStore((s) => s.reloadCommunities);

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InvitePreview>("GET", `/api/v1/invites/${code}`)
      .then(setPreview)
      .catch(() => setInvalid(true));
  }, [code]);

  async function join(asGuest: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (asGuest && !getTokens()) await authenticate("/api/v1/auth/guest", { display_name: guestName });
      const result = await api<{ community: { id: string } }>("POST", `/api/v1/invites/${code}/join`);
      await reloadCommunities();
      onEnter(result.community.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <main className="grid min-h-dvh place-items-center p-6 text-center">
        <div className="flex flex-col items-center gap-4">
          <h1 className="display text-xl font-bold">{t("invite.invalid")}</h1>
          <Button onClick={() => onEnter("")}>{t("invite.back")}</Button>
        </div>
      </main>
    );
  }

  if (!preview) return <Spinner label={t("common.loading")} />;

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4">
      <div className="card w-full max-w-md overflow-hidden">
        <div
          className="h-24"
          style={{
            background: preview.community.banner_url
              ? `center/cover url(${JSON.stringify(preview.community.banner_url)})`
              : preview.community.accent_color,
          }}
        />

        <div className="flex flex-col gap-4 p-6">
          <div className="-mt-12 flex items-end gap-3">
            <span
              className="grid h-16 w-16 place-items-center overflow-hidden rounded-[18px] border-4 border-surface text-white"
              style={{ background: preview.community.accent_color }}
            >
              {preview.community.icon_url ? (
                <img src={preview.community.icon_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="display text-xl font-bold">{preview.community.name.slice(0, 2).toUpperCase()}</span>
              )}
            </span>
          </div>

          <div>
            <p className="text-sm text-muted">{t("invite.joining")}</p>
            <h1 className="display text-2xl font-bold">{preview.community.name}</h1>
            {preview.community.description ? (
              <p className="mt-1 text-sm text-muted">{preview.community.description}</p>
            ) : null}
          </div>

          <p className="flex gap-4 text-sm text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--ok)]" />
              {t("invite.onlineNow", { count: preview.online })}
            </span>
            <span>{t(preview.members === 1 ? "invite.memberOne" : "invite.members", { count: preview.members })}</span>
          </p>

          {user ? (
            <div className="flex flex-col gap-2">
              <Button variant="primary" onClick={() => void join(false)} disabled={busy}>
                {t("invite.accept")}
              </Button>
              {/* Sin esto, abrir tu propio enlace no tenía más salida que entrar
                  como tú: no había forma de probar la invitación como lo haría
                  otra persona, ni de aceptarla con otra identidad. */}
              <Button onClick={() => void logout()} disabled={busy}>
                {t("invite.asSomeoneElse")}
              </Button>
              <p className="text-center text-xs text-muted">{t("invite.asSomeoneElseHint", { name: user.display_name })}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {preview.guest_mode_enabled ? (
                <>
                  <Field label={t("invite.guestName")}>
                    {(id) => (
                      <input
                        id={id}
                        className="field"
                        value={guestName}
                        onChange={(e) => setGuestName(e.target.value)}
                        maxLength={24}
                        autoFocus
                      />
                    )}
                  </Field>
                  <Button variant="primary" onClick={() => void join(true)} disabled={busy || guestName.trim().length < 2}>
                    {t("invite.asGuest")}
                  </Button>
                </>
              ) : null}
              <Button onClick={() => onEnter("")}>{t("auth.login")}</Button>
            </div>
          )}

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <p className="text-center text-xs text-muted">{BRAND.name}</p>
        </div>
      </div>
    </main>
  );
}
