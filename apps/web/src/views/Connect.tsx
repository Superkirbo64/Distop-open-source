/**
 * Primera pantalla de la app instalada sin usuario (§7.2).
 *
 * PC y teléfono entran igual: un nombre y dentro. El usuario vive en el
 * dispositivo y viaja con él a cada servidor; las comunidades se encuentran
 * dentro, en Explorar o por invitación. Hospedar es un botón aparte del PC
 * ("Crear comunidad"), nunca el arranque.
 */
import { useState } from "react";
import { BRAND } from "../brand.ts";
import { createLocalIdentity, localUser } from "../lib/portable.ts";
import { useStore } from "../store.ts";
import { Button, Field, useT } from "../components/ui.tsx";

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
