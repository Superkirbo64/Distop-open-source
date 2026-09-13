/**
 * Primera pantalla del cliente empaquetado sin instancia elegida (§4, §5).
 *
 * — Escritorio: arranca el servidor de este equipo y entra en sus perfiles.
 * — Teléfono: NO hospeda, solo participa. Crea su usuario en el dispositivo y
 *   entra a la app vacía; las comunidades se encuentran dentro, en Explorar.
 */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import { connectToInstance } from "../lib/instance.ts";
import { createLocalIdentity, localUser } from "../lib/portable.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, Spinner, useT } from "../components/ui.tsx";

export function Connect() {
  const t = useT();
  const host = window.distop?.host;
  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoLog, setAutoLog] = useState<string[]>([]);

  async function hostAndEnter(): Promise<void> {
    if (!host) return;
    setAutoError(null);
    const status = await host.start();
    if (status.state === "on" && status.url) {
      if ((await connectToInstance(status.url)) === "ok") return;
      setAutoError(t("connect.autoFailed"));
    } else {
      setAutoError(status.error || t("connect.autoFailed"));
      setAutoLog(status.log.slice(-8));
    }
  }

  useEffect(() => {
    if (host) void hostAndEnter();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo el primer montaje
  }, []);

  if (!autoError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-4">
        <div className="flex flex-col items-center gap-4">
          <h1 className="display text-3xl font-bold text-accent">{BRAND.name}</h1>
          <Spinner label={t("connect.preparing")} />
          <p className="max-w-sm text-center text-xs text-muted">{t("connect.preparingHint")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 sm:p-8">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-card border border-line bg-surface p-7 shadow-[var(--shadow)] sm:p-9">
        <header className="flex flex-col gap-2">
          <p className="display text-2xl font-bold text-accent">{BRAND.name}</p>
          <h1 className="display text-xl font-bold">{t("connect.title")}</h1>
          <p className="text-sm text-muted">{t("connect.hint")}</p>
        </header>
        <section className="flex flex-col gap-3">
          <Button variant="primary" onClick={() => void hostAndEnter()}>
            {t("connect.hostEnter")}
          </Button>
          <ErrorNote>
            {autoError}
            {autoLog.length > 0 ? (
              <pre className="mt-2 max-h-32 overflow-auto text-[0.65rem] whitespace-pre-wrap">{autoLog.join("\n")}</pre>
            ) : null}
          </ErrorNote>
        </section>
      </div>
    </main>
  );
}

/** El usuario del teléfono: un nombre y dentro. Vive en el dispositivo y viaja con él. */
export function CreateProfile() {
  const t = useT();
  const [name, setName] = useState("");

  function submit(event: React.FormEvent): void {
    event.preventDefault();
    if (name.trim().length < 2) return;
    createLocalIdentity(name);
    useStore.setState({ user: localUser() });
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg px-4 py-8 sm:p-8">
      <form
        onSubmit={submit}
        className="flex w-full max-w-md flex-col gap-5 rounded-card border border-line bg-surface p-6 shadow-[var(--shadow)] sm:p-9"
      >
        <header className="flex flex-col gap-2">
          <p className="display text-2xl font-bold text-accent">{BRAND.name}</p>
          <h1 className="display text-xl font-bold">{t("phone.createTitle")}</h1>
          <p className="text-sm text-muted">{t("phone.createHint")}</p>
        </header>
        <Field label={t("auth.displayName")}>
          {(id) => (
            <input
              id={id}
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              minLength={2}
              maxLength={48}
              autoComplete="nickname"
              autoFocus
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={name.trim().length < 2}>
          {t("phone.createAction")}
        </Button>
      </form>
    </main>
  );
}
