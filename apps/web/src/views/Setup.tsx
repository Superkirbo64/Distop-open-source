/**
 * Puesta en marcha de una instancia recién instalada (§34, §37).
 * Quien la hospeda no pasa por ningún formulario de acceso: pone su nombre y el
 * de su comunidad, y ya está dentro y administrando. La contraseña es un paso
 * posterior y opcional, no un peaje de entrada.
 */
import { useState } from "react";
import { BRAND } from "../brand.ts";
import { api } from "../lib/api.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, useErrorText, useT } from "../components/ui.tsx";
import type { Community } from "@distop/protocol";

export function Setup({ requiresCode }: { requiresCode: boolean }) {
  const t = useT();
  const errorText = useErrorText();
  const authenticate = useStore((s) => s.authenticate);
  const reloadCommunities = useStore((s) => s.reloadCommunities);
  const openCommunity = useStore((s) => s.openCommunity);

  const [name, setName] = useState("");
  const [community, setCommunity] = useState("");
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
      const created = await api<Community>("POST", "/api/v1/communities", { name: community.trim() });
      await reloadCommunities();
      await openCommunity(created.id);
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  const ready = name.trim().length >= 2 && community.trim().length >= 2 && (!requiresCode || code.trim().length > 0);

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4 sm:p-8">
      <div className="card w-full max-w-lg overflow-hidden">
        <div className="h-2" style={{ background: BRAND.accent }} />

        <form onSubmit={start} className="flex flex-col gap-5 p-7 sm:p-9">
          <header className="flex flex-col gap-2">
            <p className="display text-sm font-bold text-muted">{BRAND.name}</p>
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

          <Field label={t("setup.communityName")}>
            {(id) => (
              <input
                id={id}
                className="field"
                value={community}
                onChange={(e) => setCommunity(e.target.value)}
                maxLength={64}
                required
                minLength={2}
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
