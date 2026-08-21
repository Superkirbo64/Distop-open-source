/**
 * Puerta de entrada del cliente empaquetado (§4, §26).
 * A la web la sirve una instancia y esta pantalla no existe; a la app la
 * instala una persona y lo primero es decidir con qué instancia hablar.
 * Los fallos se cuentan por su causa —dirección mal escrita, nodo apagado,
 * respuesta que no es de Distop— nunca con un "error" genérico.
 */
import { useEffect, useState } from "react";
import { BRAND } from "../brand.ts";
import {
  forgetInstance,
  knownInstances,
  normalizeInstanceUrl,
  rememberInstance,
  setActiveInstance,
  type HostStatus,
} from "../lib/instance.ts";
import { Button, ErrorNote, Field, useT } from "../components/ui.tsx";

type Check = "idle" | "checking";

export function Connect() {
  const t = useT();
  const [address, setAddress] = useState("");
  const [check, setCheck] = useState<Check>("idle");
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState(knownInstances());

  async function connectTo(raw: string): Promise<void> {
    const origin = normalizeInstanceUrl(raw);
    if (!origin) {
      setError(t("connect.invalid"));
      return;
    }
    setCheck("checking");
    setError(null);
    try {
      const res = await fetch(`${origin}/api/v1/info`, { signal: AbortSignal.timeout(8000) });
      const info = (await res.json()) as { name?: string; version?: string };
      // Una web cualquiera también responde 200: lo que identifica a una
      // instancia es que /api/v1/info devuelva su carné con nombre y versión.
      if (!res.ok || typeof info.name !== "string" || typeof info.version !== "string") {
        setError(t("connect.notInstance"));
        setCheck("idle");
        return;
      }
      rememberInstance(origin, info.name);
      setActiveInstance(origin); // recarga con la instancia activa
    } catch {
      setError(t("connect.unreachable"));
      setCheck("idle");
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 sm:p-8">
      <div className="flex w-full max-w-md flex-col gap-5 rounded-card border border-line bg-surface p-7 shadow-[var(--shadow)] sm:p-9">
        <div className="flex flex-col gap-1">
          <h1 className="display text-2xl font-bold">{BRAND.name}</h1>
          <h2 className="display text-lg font-bold">{t("connect.title")}</h2>
          <p className="text-sm text-muted">{t("connect.hint")}</p>
        </div>

        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void connectTo(address);
          }}
        >
          <Field label={t("connect.url")} hint={t("connect.urlHint")}>
            {(id) => (
              <input
                id={id}
                className="field"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="https://mi-comunidad.ejemplo.org"
                required
                autoFocus
                spellCheck={false}
                autoCapitalize="off"
              />
            )}
          </Field>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Button type="submit" variant="primary" disabled={check === "checking"}>
            {check === "checking" ? t("connect.checking") : t("connect.action")}
          </Button>
        </form>

        <HostHere onReady={(url) => void connectTo(url)} />

        {known.length > 0 ? (
          <section className="flex flex-col gap-2 border-t border-line pt-4">
            <p className="text-sm font-semibold">{t("connect.known")}</p>
            {known.map((instance) => (
              <div key={instance.url} className="flex items-center gap-2 rounded-[10px] border border-line p-2">
                <button
                  className="min-w-0 flex-1 text-left hover:underline"
                  onClick={() => void connectTo(instance.url)}
                >
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
        ) : null}
      </div>
    </main>
  );
}

/**
 * "Hospedar aquí" (§5): la instancia corre en ESTE equipo, dentro de la app.
 * Solo existe en la app de escritorio (window.distop.host); en Android no hay
 * forma de ejecutar el servidor y la sección directamente no aparece (§29.3).
 * Lo que implica hospedar —encendido, ancho de banda, copias— lo cuenta el
 * texto, no la letra pequeña.
 */
function HostHere({ onReady }: { onReady: (url: string) => void }) {
  const t = useT();
  const host = window.distop?.host;
  const [status, setStatus] = useState<HostStatus | null>(null);

  useEffect(() => {
    if (!host) return;
    void host.status().then(setStatus);
    return host.onStatus(setStatus);
  }, [host]);

  if (!host) return null;

  async function start(): Promise<void> {
    const result = await host!.start();
    setStatus(result);
    if (result.state === "on" && result.url) onReady(result.url);
  }

  return (
    <section className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-sm font-semibold">{t("connect.hostHere")}</p>
      <p className="text-xs text-muted">{t("connect.hostHint")}</p>

      {status?.state === "on" ? (
        <Button variant="primary" onClick={() => onReady(status.url)}>
          {t("connect.hostEnter")}
        </Button>
      ) : (
        <Button variant="primary" onClick={() => void start()} disabled={status?.state === "starting"}>
          {status?.state === "starting" ? t("connect.hostStarting") : t("connect.hostHere")}
        </Button>
      )}

      {status?.state === "error" ? (
        <ErrorNote>
          {status.error}
          {status.log.length > 0 ? (
            <pre className="mt-2 max-h-32 overflow-auto text-[0.65rem] whitespace-pre-wrap">{status.log.slice(-8).join("\n")}</pre>
          ) : null}
        </ErrorNote>
      ) : null}
    </section>
  );
}
