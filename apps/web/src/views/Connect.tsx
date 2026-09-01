/** Arranque del servidor local. La selección de comunidades no pertenece al login. */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import { connectToInstance } from "../lib/instance.ts";
import { PHONE_INSTANCE_URL, phoneCanHost, phoneServerAlive, startPhoneServer } from "../lib/phoneHost.ts";
import { Button, ErrorNote, Spinner, useT } from "../components/ui.tsx";

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

  if (host && !autoError) {
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

        {host ? (
          <section className="flex flex-col gap-3">
            <Button variant="primary" onClick={() => void hostAndEnter()}>
              {t("connect.hostEnter")}
            </Button>
            {autoError ? (
              <ErrorNote>
                {autoError}
                {autoLog.length > 0 ? (
                  <pre className="mt-2 max-h-32 overflow-auto text-[0.65rem] whitespace-pre-wrap">{autoLog.join("\n")}</pre>
                ) : null}
              </ErrorNote>
            ) : null}
          </section>
        ) : phoneCanHost() ? (
          <PhoneHost />
        ) : (
          <ErrorNote>{t("connect.localUnavailable")}</ErrorNote>
        )}
      </div>
    </main>
  );
}

function PhoneHost() {
  const t = useT();
  const [state, setState] = useState<"idle" | "alive" | "starting" | "error">("idle");

  useEffect(() => {
    void phoneServerAlive().then((alive) => setState(alive ? "alive" : "idle"));
  }, []);

  async function create(): Promise<void> {
    setState("starting");
    if (await startPhoneServer()) {
      await connectToInstance(PHONE_INSTANCE_URL);
      return;
    }
    setState("error");
  }

  return (
    <section className="flex flex-col gap-3">
      <p className="text-sm text-muted">{state === "alive" ? t("connect.phoneFound") : t("connect.phoneHostHint")}</p>
      <Button variant="primary" onClick={() => void create()} disabled={state === "starting"}>
        {state === "starting" ? t("connect.phoneStarting") : state === "alive" ? t("connect.hostEnter") : t("connect.phoneCreate")}
      </Button>
      {state === "starting" ? <p className="text-xs text-muted">{t("connect.phoneStartingHint")}</p> : null}
      {state === "error" ? <ErrorNote>{t("connect.phoneError")}</ErrorNote> : null}
    </section>
  );
}
