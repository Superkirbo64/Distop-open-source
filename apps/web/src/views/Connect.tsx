/**
 * Bienvenida del cliente empaquetado (§4, §5, §26).
 *
 * Lo que una persona quiere al abrir la aplicación es USARLA, no configurar
 * infraestructura. Así que:
 *
 * — En el ESCRITORIO, la app hospeda su servidor sola y entra: el primer
 *   arranque te lleva directo a "crea tu usuario". Esta pantalla solo aparece
 *   si eso falla o si la pides ("Cambiar de comunidad").
 * — En ANDROID, el servidor también puede correr DENTRO de la app (motor Node
 *   embebido en el APK, sin instalar nada): la tarjeta de arriba lo enciende
 *   con un botón. Y para entrar a comunidades de otros: pegar la invitación o
 *   encontrar el PC en la Wi-Fi solo.
 *
 * Los fallos se cuentan por su causa, nunca con un "error" genérico.
 */
import { useEffect, useRef, useState } from "react";
import { BRAND } from "../brand.ts";
import {
  connectToInstance,
  forgetInstance,
  isPackaged,
  knownInstances,
  takeManualConnect,
} from "../lib/instance.ts";
import { PHONE_INSTANCE_URL, phoneCanHost, phoneServerAlive, startPhoneServer } from "../lib/phoneHost.ts";
import { scanLan, type FoundInstance, type Scan } from "../lib/scan.ts";
import { Button, ErrorNote, Field, Spinner, useT } from "../components/ui.tsx";

export function Connect() {
  const t = useT();
  const host = window.distop?.host;
  // "Cambiar de comunidad" salta el arranque automático: sin esto sería una trampa.
  const manualRequested = useRef(takeManualConnect());
  const auto = Boolean(host) && !manualRequested.current;

  const [autoError, setAutoError] = useState<string | null>(null);
  const [autoLog, setAutoLog] = useState<string[]>([]);

  async function hostAndEnter(): Promise<void> {
    setAutoError(null);
    const status = await host!.start();
    if (status.state === "on" && status.url) {
      if ((await connectToInstance(status.url)) === "ok") return;
      setAutoError(t("connect.autoFailed"));
    } else {
      setAutoError(status.error || t("connect.autoFailed"));
      setAutoLog(status.log.slice(-8));
    }
  }

  useEffect(() => {
    if (auto) void hostAndEnter();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- solo el primer montaje
  }, []);

  // Escritorio arrancando su servidor: una espera con nombre, no un formulario.
  if (auto && !autoError) {
    return (
      <main className="grid min-h-dvh place-items-center bg-bg p-4">
        <div className="flex flex-col items-center gap-4">
          <h1 className="display text-3xl font-bold">{BRAND.name}</h1>
          <Spinner label={t("connect.preparing")} />
          <p className="max-w-sm text-center text-xs text-muted">{t("connect.preparingHint")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 sm:p-8">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-card border border-line bg-surface p-7 shadow-[var(--shadow)] sm:p-9">
        <div className="flex flex-col gap-1">
          <h1 className="display text-2xl font-bold">{BRAND.name}</h1>
          <h2 className="display text-lg font-bold">{t("connect.title")}</h2>
          <p className="text-sm text-muted">{host ? t("connect.hint") : t("connect.androidHint")}</p>
        </div>

        {/* Escritorio: tu servidor primero — es lo que casi todo el mundo quiere. */}
        {host ? (
          <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
            <p className="text-sm font-semibold">{t("connect.hostMine")}</p>
            <p className="text-xs text-muted">{t("connect.hostHint")}</p>
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
        ) : null}

        {!host && phoneCanHost() ? <PhoneHost /> : null}
        <JoinByLink />
        {isPackaged() ? <LanScan /> : null}
        <KnownList />
      </div>
    </main>
  );
}

/**
 * Tu comunidad EN el teléfono, sin Termux y sin instalar nada (§5):
 * el APK lleva un motor Node embebido que ejecuta el mismo servidor que el
 * escritorio (lib/phoneHost.ts). Un botón lo enciende; el resto es idéntico a
 * Windows: crea tu usuario, crea tu comunidad, invita.
 */
function PhoneHost() {
  const t = useT();
  const [state, setState] = useState<"idle" | "alive" | "starting" | "error">("idle");

  useEffect(() => {
    void phoneServerAlive().then((alive) => setState(alive ? "alive" : "idle"));
  }, []);

  async function create(): Promise<void> {
    setState("starting");
    if (await startPhoneServer()) {
      await connectToInstance(PHONE_INSTANCE_URL); // recarga con el servidor activo
      return;
    }
    setState("error");
  }

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
      <p className="text-sm font-semibold">{t("connect.phoneHost")}</p>
      <p className="text-xs text-muted">{state === "alive" ? t("connect.phoneFound") : t("connect.phoneHostHint")}</p>

      <Button variant="primary" onClick={() => void create()} disabled={state === "starting"}>
        {state === "starting" ? t("connect.phoneStarting") : state === "alive" ? t("connect.hostEnter") : t("connect.phoneCreate")}
      </Button>

      {state === "starting" ? <p className="text-xs text-muted">{t("connect.phoneStartingHint")}</p> : null}
      {state === "error" ? <ErrorNote>{t("connect.phoneError")}</ErrorNote> : null}
    </section>
  );
}

/** Una sola caja para lo que la gente de verdad recibe: un enlace de invitación. */
function JoinByLink() {
  const t = useT();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await connectToInstance(address);
    if (result !== "ok") {
      setError(
        result === "invalid"
          ? t("connect.invalid")
          : result === "not-instance"
            ? t("connect.notInstance")
            : t("connect.unreachable"),
      );
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label={t("connect.inviteOrUrl")} hint={t("connect.inviteHint")}>
        {(id) => (
          <input
            id={id}
            className="field"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="https://…/invite/abc123"
            required
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? t("connect.checking") : t("connect.action")}
      </Button>
    </form>
  );
}

/**
 * Tu PC en tu misma Wi-Fi, sin teclear una IP: la app sondea los rangos
 * domésticos típicos preguntando /api/v1/info. Nada sale de tu red.
 */
function LanScan() {
  const t = useT();
  const [found, setFound] = useState<FoundInstance[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const running = useRef<Scan | null>(null);

  useEffect(() => () => running.current?.cancel(), []);

  function start(): void {
    running.current?.cancel();
    setFound([]);
    const scan = scanLan(
      (instance) => setFound((prev) => (prev.some((p) => p.url === instance.url) ? prev : [...prev, instance])),
      (done, total) => setProgress({ done, total }),
    );
    running.current = scan;
    void scan.done.then(() => {
      if (running.current === scan) setProgress(null);
    });
  }

  const scanning = progress !== null && progress.done < progress.total;

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-sm font-semibold">{t("connect.scan")}</p>
      <p className="text-xs text-muted">{t("connect.scanHint")}</p>
      <Button onClick={start} disabled={scanning}>
        {scanning ? t("connect.scanning", { done: progress.done, total: progress.total }) : t("connect.scan")}
      </Button>

      {found.map((instance) => (
        <button
          key={instance.url}
          className="flex flex-col rounded-[10px] border border-line p-2 text-left hover:bg-raise"
          onClick={() => void connectToInstance(instance.url)}
        >
          <span className="truncate text-sm font-medium">{instance.name}</span>
          <span className="truncate text-xs text-muted">{instance.url}</span>
        </button>
      ))}

      {progress !== null && progress.done >= progress.total && found.length === 0 ? (
        <p className="text-xs text-muted">{t("connect.scanNone")}</p>
      ) : null}
    </section>
  );
}

function KnownList() {
  const t = useT();
  const [known, setKnown] = useState(knownInstances());
  if (known.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-sm font-semibold">{t("connect.known")}</p>
      {known.map((instance) => (
        <div key={instance.url} className="flex items-center gap-2 rounded-[10px] border border-line p-2">
          <button className="min-w-0 flex-1 text-left hover:underline" onClick={() => void connectToInstance(instance.url)}>
            <span className="block truncate text-sm font-medium">{instance.name}</span>
            <span className="block truncate text-xs text-muted">{instance.url}</span>
          </button>
          <Button
            onClick={() => {
              forgetInstance(instance.url);
              setKnown(knownInstances());
            }}
          >
            {t("connect.forget")}
          </Button>
        </div>
      ))}
    </section>
  );
}
