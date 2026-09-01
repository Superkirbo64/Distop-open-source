/** Entrada por perfiles: primero quién eres; la contraseña, solo si hace falta. */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import { api } from "../lib/api.ts";
import { useStore } from "../store.ts";
import { Avatar, Button, ErrorNote, Field, Spinner, useErrorText, useT } from "../components/ui.tsx";

type Mode = "profiles" | "login" | "register";

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

export function Auth({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const authenticate = useStore((s) => s.authenticate);

  const [info, setInfo] = useState<InstanceInfo | null | undefined>(undefined);
  const [mode, setMode] = useState<Mode>("profiles");
  const [selected, setSelected] = useState<LocalAccount | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entering, setEntering] = useState<string | null>(null);

  const accounts = info?.local_accounts ?? [];

  useEffect(() => {
    let cancelled = false;
    api<InstanceInfo>("GET", "/api/v1/info")
      .then((next) => {
        if (cancelled) return;
        setInfo(next);
        setMode(next.local_accounts.length > 0 ? "profiles" : "login");
      })
      .catch(() => {
        if (!cancelled) {
          setInfo(null);
          setMode("login");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
      setError(errorText(err));
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
      setError(errorText(err));
      setBusy(false);
    }
  }

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

      <section className="relative z-[1] flex min-h-dvh items-center justify-center px-5 py-24 sm:px-10">
        {info === undefined ? (
          <Spinner label={t("common.loading")} />
        ) : mode === "profiles" && accounts.length > 0 ? (
          <div className="flex w-full max-w-6xl flex-col items-center gap-10 text-center">
            <header className="flex flex-col gap-3">
              <h1 className="display text-4xl font-bold tracking-tight sm:text-5xl">{t("auth.chooseProfile")}</h1>
              <p className="text-sm text-muted sm:text-base">{t("auth.chooseProfileHint")}</p>
            </header>

            <div className="tabs-scroll w-full overflow-x-auto py-3">
              <ul className="flex w-max min-w-full snap-x justify-center gap-5 px-3">
                {accounts.map((account) => (
                  <li key={account.username} className="shrink-0 snap-center">
                  <button
                    type="button"
                    className="group flex w-32 flex-col items-center gap-3 rounded-card p-2 text-center disabled:cursor-wait disabled:opacity-60 sm:w-36"
                    onClick={() => void chooseAccount(account)}
                    disabled={entering !== null}
                    aria-label={account.display_name}
                  >
                    <span className="grid h-28 w-28 place-items-center rounded-full border-2 border-transparent bg-raise shadow-[var(--shadow)] transition duration-300 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:border-accent group-focus-visible:border-accent sm:h-32 sm:w-32">
                      <Avatar name={account.display_name} url={account.avatar_url} size={104} />
                    </span>
                    <span className="line-clamp-2 text-base font-medium text-muted transition-colors group-hover:text-ink group-focus-visible:text-ink">
                      {entering === account.username ? t("common.loading") : account.display_name}
                    </span>
                  </button>
                  </li>
                ))}

                {info?.registration_enabled !== false ? (
                  <li className="shrink-0 snap-center">
                    <button
                      type="button"
                      className="group flex w-32 flex-col items-center gap-3 rounded-card p-2 text-center sm:w-36"
                      onClick={openRegister}
                    >
                      <span className="grid h-28 w-28 place-items-center rounded-full border-2 border-line bg-surface text-5xl font-light text-muted shadow-[var(--shadow)] transition duration-300 group-hover:-translate-y-1 group-hover:scale-[1.04] group-hover:border-accent group-hover:text-accent group-focus-visible:border-accent group-focus-visible:text-accent sm:h-32 sm:w-32">
                        +
                      </span>
                      <span className="text-base font-medium text-muted transition-colors group-hover:text-ink group-focus-visible:text-ink">
                        {t("auth.addProfile")}
                      </span>
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
                <h1 className="display text-2xl font-bold">
                  {mode === "register" ? t("auth.addProfile") : t("auth.login")}
                </h1>
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
                  <input
                    id={id}
                    type="password"
                    className="field"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required={mode === "login"}
                    minLength={mode === "register" ? 10 : 1}
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
              {accounts.length > 0 ? (
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
      </section>
    </main>
  );
}
