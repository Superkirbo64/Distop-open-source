/** Entrada por perfiles: primero quién eres; la contraseña, solo si hace falta. */
import { useEffect, useState, type ReactNode } from "react";
import { MIN_PASSWORD_LENGTH } from "@distop/protocol";
import { BRAND } from "../brand.ts";
import { api, RequestError } from "../lib/api.ts";
import { entryMode, type EntryMode } from "../lib/entry.ts";
import { peekPendingInvite, peekPendingPublicJoin } from "../lib/instance.ts";
import { localUser, portableAuthPayload } from "../lib/portable.ts";
import { MfaRequired, useStore } from "../store.ts";
import { Avatar, Button, ErrorNote, Field, PasswordInput, Spinner, useErrorText, useT } from "../components/ui.tsx";

interface LocalAccount {
  username: string;
  display_name: string;
  avatar_url: string | null;
  has_password: boolean;
}

interface InstanceInfo {
  registration_enabled: boolean;
  local_accounts: LocalAccount[];
}

/* Los nombres de usuario solo llevan [a-z0-9._-]: esta clave no choca con ninguno. */
const DISPOSITIVO = ":dispositivo";

/** La carcasa común de la entrada: la misma en el navegador, el PC y el teléfono. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="relative min-h-dvh overflow-hidden bg-bg">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% -20%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 48%), radial-gradient(circle at 90% 110%, color-mix(in oklab, var(--accent) 12%, transparent), transparent 38%)",
        }}
      />

      <header className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-6 sm:px-10 sm:py-8">
        <p className="display text-2xl font-extrabold tracking-tight text-accent sm:text-3xl">{BRAND.name}</p>
      </header>

      <section className="relative z-[1] flex min-h-dvh items-center justify-center px-5 py-24 sm:px-10">{children}</section>
    </main>
  );
}

export function Auth({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const authenticate = useStore((s) => s.authenticate);

  const [info, setInfo] = useState<InstanceInfo | null | undefined>(undefined);
  const [mode, setMode] = useState<EntryMode>("profiles");
  const [selected, setSelected] = useState<LocalAccount | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);
  /* Paso del autenticador: la contraseña ya fue buena y falta el código. */
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  /* El perfil que viaja con este dispositivo, si ya existe. No es una lista
     nueva: es la misma identidad portable que usa la app. */
  const [device] = useState(() => localUser());

  const accounts = info?.local_accounts ?? [];
  const cards = accounts.length + (device ? 1 : 0);

  useEffect(() => {
    let cancelled = false;
    api<InstanceInfo>("GET", "/api/v1/info")
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setMode(
          entryMode({
            localAccounts: next.local_accounts.length,
            hasDeviceProfile: Boolean(device),
            registrationEnabled: next.registration_enabled,
          }),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setInfo(null);
          setMode(entryMode({ localAccounts: 0, hasDeviceProfile: Boolean(device), registrationEnabled: false }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [device]);

  function openProfiles(): void {
    setMode("profiles");
    setSelected(null);
    setUsername("");
    setPassword("");
    setDisplayName("");
    setError(null);
  }

  function openLogin(account?: LocalAccount): void {
    setSelected(account ?? null);
    setUsername(account?.username ?? "");
    setPassword("");
    setError(null);
    setMode("login");
  }

  function openRegister(): void {
    setSelected(null);
    setUsername("");
    setPassword("");
    setDisplayName("");
    setError(null);
    setMode("register");
  }

  async function chooseAccount(account: LocalAccount): Promise<void> {
    if (account.has_password) {
      openLogin(account);
      return;
    }

    setEntering(account.username);
    setError(null);
    try {
      await authenticate("/api/v1/auth/recover", { username: account.username });
      onDone?.();
    } catch (err) {
      if (err instanceof MfaRequired) setMfaToken(err.token);
      else setError(errorText(err));
      setEntering(null);
    }
  }

  async function submitMfa(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!mfaToken) return;
    setBusy(true);
    setError(null);
    try {
      await authenticate("/api/v1/auth/mfa", { mfa_token: mfaToken, code: mfaCode.trim() });
      onDone?.();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
      // El paso caduca a los 5 minutos: entonces toca volver a la contraseña.
      if (err instanceof RequestError && err.status === 401 && /caduc/i.test(err.message)) setMfaToken(null);
    }
  }

  /* El perfil del dispositivo entra con su identidad portable. Si hay una
     invitación o una comunidad pública pendiente, esa es la puerta; si no, el
     servidor solo la acepta si ya la conoce. Cuando no la conoce se explica, sin
     crear cuenta ni entrar como invitado. */
  async function chooseDevice(): Promise<void> {
    const payload = portableAuthPayload(peekPendingInvite(), peekPendingPublicJoin()?.communityId);
    if (!payload) return;
    setEntering(DISPOSITIVO);
    setError(null);
    try {
      await authenticate("/api/v1/auth/portable", payload);
      onDone?.();
    } catch (err) {
      setError(err instanceof RequestError && err.status >= 400 && err.status < 500 ? t("auth.deviceProfileUnknown") : errorText(err));
      setEntering(null);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "register") {
        await authenticate("/api/v1/auth/register", {
          username,
          ...(password ? { password } : {}),
          display_name: displayName.trim(),
        });
      } else {
        await authenticate("/api/v1/auth/login", { username, password });
      }
      onDone?.();
    } catch (err) {
      if (err instanceof MfaRequired) {
        setMfaToken(err.token);
        setMfaCode("");
      } else setError(errorText(err));
      setBusy(false);
    }
  }

  const cardClass =
    "group flex w-32 flex-col items-center gap-3 rounded-card p-2 text-center disabled:cursor-wait disabled:opacity-60 sm:w-36";
  const avatarRing =
    "grid h-28 w-28 place-items-center rounded-full border-2 border-transparent bg-raise shadow-[var(--shadow)] transition duration-300 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:border-accent group-focus-visible:border-accent sm:h-32 sm:w-32";
  const cardName = "line-clamp-2 text-base font-medium text-muted transition-colors group-hover:text-ink group-focus-visible:text-ink";

  return (
    <AuthShell>
      {info === undefined ? (
        <Spinner label={t("common.loading")} />
      ) : mfaToken ? (
        <div className="w-full max-w-md rounded-card border border-line bg-surface/95 p-7 shadow-[var(--shadow)] backdrop-blur-sm sm:p-9">
          <header className="mb-7 flex flex-col gap-2">
            <h1 className="display text-2xl font-bold">{t("auth.mfaTitle")}</h1>
            <p className="text-sm text-muted">{t("auth.mfaHint")}</p>
          </header>
          <form onSubmit={submitMfa} className="flex flex-col gap-4">
            <Field label={t("auth.mfaCode")}>
              {(id) => (
                <input
                  id={id}
                  className="field font-mono text-lg tracking-[0.3em]"
                  value={mfaCode}
                  onChange={(event) => setMfaCode(event.target.value)}
                  required
                  minLength={6}
                  maxLength={40}
                  inputMode="text"
                  autoComplete="one-time-code"
                  autoFocus
                />
              )}
            </Field>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" variant="primary" disabled={busy || mfaCode.trim().length < 6}>
              {busy ? t("common.loading") : t("auth.login")}
            </Button>
          </form>
          <div className="mt-5 flex justify-center border-t border-line pt-5 text-sm">
            <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => { setMfaToken(null); setError(null); }}>
              {t("auth.mfaBack")}
            </button>
          </div>
        </div>
      ) : mode === "profiles" && cards > 0 ? (
        <div className="flex w-full max-w-6xl flex-col items-center gap-10 text-center">
          <header className="flex flex-col gap-3">
            <h1 className="display text-4xl font-bold tracking-tight sm:text-5xl">{t("auth.chooseProfile")}</h1>
            <p className="text-sm text-muted sm:text-base">{t("auth.chooseProfileHint")}</p>
          </header>

          <div className="tabs-scroll w-full overflow-x-auto py-3">
            <ul className="flex w-max min-w-full snap-x justify-center gap-5 px-3">
              {device ? (
                <li className="shrink-0 snap-center">
                  <button
                    type="button"
                    className={cardClass}
                    onClick={() => void chooseDevice()}
                    disabled={entering !== null}
                    aria-label={device.display_name}
                  >
                    <span className={avatarRing}>
                      <Avatar name={device.display_name} url={device.avatar_url} size={104} />
                    </span>
                    <span className={cardName}>{entering === DISPOSITIVO ? t("common.loading") : device.display_name}</span>
                  </button>
                </li>
              ) : null}

              {accounts.map((account) => (
                <li key={account.username} className="shrink-0 snap-center">
                  <button
                    type="button"
                    className={cardClass}
                    onClick={() => void chooseAccount(account)}
                    disabled={entering !== null}
                    aria-label={account.display_name}
                  >
                    <span className={avatarRing}>
                      <Avatar name={account.display_name} url={account.avatar_url} size={104} />
                    </span>
                    <span className={cardName}>{entering === account.username ? t("common.loading") : account.display_name}</span>
                  </button>
                </li>
              ))}

              {info?.registration_enabled !== false && info !== null ? (
                <li className="shrink-0 snap-center">
                  <button
                    type="button"
                    className="group flex w-32 flex-col items-center gap-3 rounded-card p-2 text-center sm:w-36"
                    onClick={openRegister}
                  >
                    <span className="grid h-28 w-28 place-items-center rounded-full border-2 border-line bg-surface text-5xl font-light text-muted shadow-[var(--shadow)] transition duration-300 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:border-accent group-hover:text-accent group-focus-visible:border-accent group-focus-visible:text-accent sm:h-32 sm:w-32">
                      +
                    </span>
                    <span className={cardName}>{t("auth.addProfile")}</span>
                  </button>
                </li>
              ) : null}
            </ul>
          </div>

          {error ? <div className="w-full max-w-md"><ErrorNote>{error}</ErrorNote></div> : null}

          <button type="button" className="text-sm text-muted hover:text-ink hover:underline" onClick={() => openLogin()}>
            {t("auth.otherAccount")}
          </button>
        </div>
      ) : (
        <div className="w-full max-w-md rounded-card border border-line bg-surface/95 p-7 shadow-[var(--shadow)] backdrop-blur-sm sm:p-9">
          {selected ? (
            <header className="mb-7 flex flex-col items-center gap-3 text-center">
              <Avatar name={selected.display_name} url={selected.avatar_url} size={88} />
              <div>
                <h1 className="display text-2xl font-bold">{t("auth.profilePasswordTitle", { name: selected.display_name })}</h1>
                <p className="mt-1 text-sm text-muted">{t("auth.profilePasswordHint")}</p>
              </div>
            </header>
          ) : (
            <header className="mb-7 flex flex-col gap-2">
              <h1 className="display text-2xl font-bold">{mode === "register" ? t("auth.addProfile") : t("auth.login")}</h1>
              {mode === "register" ? <p className="text-sm text-muted">{t("auth.createProfileHint")}</p> : null}
            </header>
          )}

          <form onSubmit={submit} className="flex flex-col gap-4">
            {mode === "register" ? (
              <Field label={t("auth.displayName")}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                    minLength={2}
                    maxLength={48}
                    autoComplete="nickname"
                    autoFocus
                  />
                )}
              </Field>
            ) : null}

            {!selected ? (
              <Field label={t("auth.username")} hint={mode === "register" ? t("auth.usernameHint") : undefined}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={username}
                    onChange={(event) => setUsername(event.target.value.toLowerCase())}
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[a-z0-9._\-]+"
                    autoComplete="username"
                    autoFocus={mode === "login"}
                  />
                )}
              </Field>
            ) : null}

            <Field
              label={`${t("auth.password")}${mode === "register" ? ` (${t("common.optional")})` : ""}`}
              hint={mode === "register" ? t("auth.passwordHint") : undefined}
            >
              {(id) => (
                <PasswordInput
                  id={id}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required={mode === "login"}
                  minLength={mode === "register" ? MIN_PASSWORD_LENGTH : 1}
                  maxLength={200}
                  autoComplete={mode === "register" ? "new-password" : "current-password"}
                  autoFocus={selected !== null}
                />
              )}
            </Field>

            {mode === "register" && !password ? <p className="text-xs text-warn">{t("auth.noPasswordWarning")}</p> : null}
            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t("common.loading") : mode === "register" ? t("auth.register") : t("auth.login")}
            </Button>
          </form>

          <div className="mt-5 flex flex-col items-center gap-3 border-t border-line pt-5 text-sm">
            {cards > 0 ? (
              <button type="button" className="text-muted hover:text-ink hover:underline" onClick={openProfiles}>
                {t("auth.backToProfiles")}
              </button>
            ) : null}
            {mode === "login" && info?.registration_enabled !== false ? (
              <button type="button" className="text-accent hover:underline" onClick={openRegister}>
                {t("auth.noAccount")} {t("auth.addProfile")}
              </button>
            ) : mode === "register" ? (
              <button type="button" className="text-accent hover:underline" onClick={() => openLogin()}>
                {t("auth.haveAccount")} {t("auth.login")}
              </button>
            ) : null}
            {info && !info.registration_enabled && mode === "login" ? (
              <p className="text-xs text-muted">{t("auth.registrationClosed")}</p>
            ) : null}
          </div>
        </div>
      )}
    </AuthShell>
  );
}
