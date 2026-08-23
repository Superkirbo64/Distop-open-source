/**
 * Entrada a la instancia (§7).
 * Las tres vías conviven en igualdad: cuenta local, invitado y —cuando exista—
 * cuenta central. Ninguna se esconde para empujar hacia otra.
 */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import { api } from "../lib/api.ts";
import { connectToInstance, instanceBase, isPackaged, knownInstances, requestManualConnect, setActiveInstance } from "../lib/instance.ts";
import { useStore } from "../store.ts";
import { Avatar, Button, ErrorNote, Field, useT, useErrorText } from "../components/ui.tsx";

type Mode = "login" | "register" | "guest";

interface InstanceInfo {
  name: string;
  version: string;
  registration_enabled: boolean;
  guest_mode_enabled: boolean;
  /** Solo llega con contenido desde el propio equipo anfitrión, o con el
      código de puesta en marcha. */
  recoverable: Array<{ username: string; display_name: string; avatar_url: string | null; community: string | null }>;
}

export function Auth({ onDone }: { onDone?: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const authenticate = useStore((s) => s.authenticate);

  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<InstanceInfo>("GET", "/api/v1/info")
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "guest") await authenticate("/api/v1/auth/guest", { display_name: displayName });
      else if (mode === "register")
        await authenticate("/api/v1/auth/register", {
          username,
          ...(password ? { password } : {}),
          display_name: displayName || username,
        });
      else await authenticate("/api/v1/auth/login", { username, password });
      onDone?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 sm:p-8">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-card border border-line bg-surface shadow-[var(--shadow)] md:grid-cols-[1.05fr_1fr]">
        {/* Panel de marca: identidad propia, no un clon (§25). */}
        <aside className="relative hidden flex-col justify-between gap-8 p-9 md:flex" style={{ background: BRAND.accent }}>
          <div
            aria-hidden="true"
            className="absolute inset-0 opacity-30"
            style={{
              backgroundImage:
                "radial-gradient(circle at 20% 15%, rgb(255 255 255 / 0.5) 0, transparent 42%), radial-gradient(circle at 82% 78%, rgb(255 255 255 / 0.35) 0, transparent 38%)",
            }}
          />
          <p className="display relative text-3xl font-bold text-white">{BRAND.name}</p>
          <div className="relative flex flex-col gap-4 text-white">
            <p className="display text-2xl leading-snug font-bold">{t("auth.tagline")}</p>
            {/* Lo que le importa a una PERSONA entrando, no a quien administra:
                los detalles de exportar y hospedar viven en Ajustes, no aquí. */}
            <ul className="flex flex-col gap-1.5 text-sm text-white/85">
              <li>· {t("auth.point1")}</li>
              <li>· {t("auth.point2")}</li>
            </ul>
          </div>
          <p className="relative text-xs text-white/70">
            {info ? `${info.name} · ${t("instance.version")} ${info.version}` : ""}
          </p>
        </aside>

        <section className="flex flex-col gap-5 p-7 sm:p-9">
          <div className="flex flex-col gap-1">
            <h1 className="display text-2xl font-bold md:hidden">{BRAND.name}</h1>
            <h2 className="display text-xl font-bold">
              {mode === "login" ? t("auth.login") : mode === "register" ? t("auth.register") : t("auth.guestTitle")}
            </h2>
            {mode === "guest" ? <p className="text-sm text-muted">{t("auth.guestHint")}</p> : null}
          </div>

          {/* Quien puso en marcha la instancia sin contraseña no puede "entrar":
              no hay nada que teclear. Desde su propio equipo, un botón (§26). */}
          {mode === "login" && info?.recoverable?.length ? (
            <section className="flex flex-col gap-2 rounded-[10px] border border-line bg-raise p-3">
              <p className="text-sm font-semibold">{t("auth.recoverTitle")}</p>
              <p className="text-xs text-muted">{t("auth.recoverHint")}</p>
              <div className="flex flex-wrap gap-3">
                {info.recoverable.map((account) => (
                  <button
                    key={account.username}
                    className="flex w-20 flex-col items-center gap-1.5 rounded-[10px] p-2 text-center hover:bg-surface"
                    onClick={async () => {
                      setError(null);
                      try {
                        await authenticate("/api/v1/auth/recover", { username: account.username });
                        onDone?.();
                      } catch (err) {
                        setError(errorText(err));
                      }
                    }}
                  >
                    <Avatar name={account.display_name} url={account.avatar_url} size={56} />
                    <span className="line-clamp-2 text-xs font-medium">{account.display_name}</span>
                    {account.community ? <span className="line-clamp-1 text-[0.65rem] text-muted">{account.community}</span> : null}
                  </button>
                ))}
              </div>
            </section>
          ) : null}

          <form onSubmit={submit} className="flex flex-col gap-4">
            {mode === "guest" ? (
              <Field label={t("auth.displayName")}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    required
                    minLength={2}
                    maxLength={24}
                    autoComplete="nickname"
                    autoFocus
                  />
                )}
              </Field>
            ) : (
              <>
                <Field label={t("auth.username")} hint={mode === "register" ? t("auth.usernameHint") : undefined}>
                  {(id) => (
                    <input
                      id={id}
                      className="field"
                      value={username}
                      onChange={(e) => setUsername(e.target.value.toLowerCase())}
                      required
                      minLength={3}
                      maxLength={32}
                      pattern="[a-z0-9._\-]+"
                      autoComplete="username"
                      autoFocus
                    />
                  )}
                </Field>
                <Field label={t("auth.password")} hint={mode === "register" ? t("auth.passwordHint") : undefined}>
                  {(id) => (
                    <input
                      id={id}
                      type="password"
                      className="field"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required={mode !== "register"}
                      minLength={mode === "register" ? 10 : 1}
                      maxLength={200}
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                    />
                  )}
                </Field>
                {mode === "register" && !password ? <p className="text-xs text-warn">{t("auth.noPasswordWarning")}</p> : null}
              </>
            )}

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <Button type="submit" variant="primary" disabled={busy}>
              {busy ? t("common.loading") : mode === "guest" ? t("auth.guest") : mode === "register" ? t("auth.register") : t("auth.login")}
            </Button>
          </form>

          {/* Entrar sin cuenta es una vía igual de válida, así que se ofrece como
              botón —no como enlace escondido— y con lo que implica escrito. */}
          {mode !== "guest" && info?.guest_mode_enabled !== false ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <Button onClick={() => setMode("guest")}>{t("auth.guest")}</Button>
              <p className="text-xs text-muted">{t("auth.guestEqual")}</p>
            </div>
          ) : null}

          <div className="flex flex-col gap-2 border-t border-line pt-4 text-sm">
            {mode !== "login" ? (
              <button className="text-left text-accent hover:underline" onClick={() => setMode("login")}>
                {t("auth.haveAccount")} {t("auth.login")}
              </button>
            ) : null}

            {mode !== "register" && info?.registration_enabled !== false ? (
              <button className="text-left text-accent hover:underline" onClick={() => setMode("register")}>
                {t("auth.noAccount")} {t("auth.register")}
              </button>
            ) : null}

            {info && !info.registration_enabled && mode === "login" ? (
              <p className="text-xs text-muted">{t("auth.registrationClosed")}</p>
            ) : null}

            {/* Si la instancia activa no responde —la de un amigo que apagó su
                equipo, por ejemplo— la salida está aquí mismo, sin pasar por
                "Cambiar de comunidad" y su pantalla en blanco. */}
            {isPackaged() && knownInstances().some((instance) => instance.url !== instanceBase) ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-xs font-semibold text-muted">{t("connect.known")}</p>
                {knownInstances()
                  .filter((instance) => instance.url !== instanceBase)
                  .map((instance) => (
                    <button
                      key={instance.url}
                      className="text-left text-accent hover:underline"
                      onClick={() => void connectToInstance(instance.url)}
                    >
                      {instance.name}
                    </button>
                  ))}
              </div>
            ) : null}

            {/* Empaquetada, esta pantalla pertenece a UNA instancia. Si no es
                la que querías —o no responde— tiene que haber puerta de salida:
                sin esto, una instancia apagada dejaba la app secuestrada. */}
            {isPackaged() ? (
              <button
                className="text-left text-accent hover:underline"
                onClick={() => {
                  requestManualConnect();
                  setActiveInstance(null);
                }}
              >
                {t("connect.changeInstance")}
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
