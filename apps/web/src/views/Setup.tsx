/**
 * Primera entrada a un servidor recién instalado (§34, §37).
 * Solo pide QUIÉN ERES: tu comunidad la creas ya dentro, cuando quieras, con
 * el aviso de bienvenida. Separarlo no es capricho: crear el usuario es un
 * segundo, y ponerle nombre a una comunidad es una decisión que nadie debería
 * tomar delante de un formulario de acceso. La contraseña sigue siendo un paso
 * posterior y opcional, no un peaje de entrada.
 */
import { useState } from "react";
import { BRAND } from "../brand.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, useErrorText, useT } from "../components/ui.tsx";

export function Setup({ requiresCode }: { requiresCode: boolean }) {
  const t = useT();
  const errorText = useErrorText();
  const authenticate = useStore((s) => s.authenticate);

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await authenticate("/api/v1/auth/bootstrap", {
        display_name: name.trim(),
        ...(password ? { password } : {}),
        ...(requiresCode ? { setup_code: code.trim() } : {}),
      });
      // Sin crear comunidad aquí: al entrar sin ninguna, la bienvenida la ofrece.
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const ready = name.trim().length >= 2 && (!requiresCode || code.trim().length > 0);

  return (
    <main className="relative grid min-h-dvh place-items-center overflow-hidden bg-bg p-4 pt-24 sm:p-8 sm:pt-28">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(circle at 50% -20%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 48%)",
        }}
      />
      <p className="display absolute top-6 left-6 text-2xl font-extrabold text-accent sm:top-8 sm:left-10 sm:text-3xl">
        {BRAND.name}
      </p>
      <div className="relative w-full max-w-lg overflow-hidden rounded-card border border-line bg-surface/95 shadow-[var(--shadow)] backdrop-blur-sm">

        <form onSubmit={start} className="flex flex-col gap-5 p-7 sm:p-9">
          <header className="flex flex-col gap-2">
            <h1 className="display text-2xl font-bold">{t("setup.title")}</h1>
            <p className="text-sm text-muted">{t("setup.subtitle")}</p>
          </header>

          <Field label={t("setup.yourName")}>
            {(id) => (
              <input
                id={id}
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={48}
                required
                minLength={2}
                autoComplete="nickname"
                autoFocus
              />
            )}
          </Field>

          <Field label={`${t("setup.password")} (${t("common.optional")})`} hint={t("setup.passwordHint")}>
            {(id) => (
              <input
                id={id}
                type="password"
                className="field"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                maxLength={200}
                autoComplete="new-password"
              />
            )}
          </Field>

          {/* Solo aparece si reclamas desde otro equipo: en local sobra. */}
          {requiresCode ? (
            <Field label={t("setup.code")} hint={t("setup.codeHint")}>
              {(id) => (
                <input
                  id={id}
                  className="field font-mono tracking-widest uppercase"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={64}
                  required
                />
              )}
            </Field>
          ) : null}

          {!password ? <p className="text-xs text-warn">{t("setup.noPasswordWarning")}</p> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Button type="submit" variant="primary" disabled={busy || !ready}>
            {busy ? t("common.loading") : t("setup.start")}
          </Button>
        </form>
      </div>
    </main>
  );
}
