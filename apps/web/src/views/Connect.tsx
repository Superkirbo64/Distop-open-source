/**
 * Primera pantalla de la app instalada sin usuario (§7.2).
 *
 * PC y teléfono entran igual: un nombre y dentro. El usuario vive en el
 * dispositivo y viaja con él a cada servidor; las comunidades se encuentran
 * dentro, en Explorar o por invitación. Hospedar es un botón aparte del PC
 * ("Crear comunidad"), nunca el arranque.
 *
 * Usa la misma carcasa que la entrada de un servidor (AuthShell): sin perfiles
 * todavía, el primer paso de la carcasa es siempre "Añadir perfil".
 */
import { useState } from "react";
import { createLocalIdentity, localUser } from "../lib/portable.ts";
import { useStore } from "../store.ts";
import { Button, Field, useT } from "../components/ui.tsx";
import { AuthShell } from "./Auth.tsx";

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
    <AuthShell>
      <div className="w-full max-w-md rounded-card border border-line bg-surface/95 p-7 shadow-[var(--shadow)] backdrop-blur-sm sm:p-9">
        <header className="mb-7 flex flex-col gap-2">
          <h1 className="display text-2xl font-bold">{t("auth.addProfile")}</h1>
          <p className="text-sm text-muted">{t("phone.createHint")}</p>
        </header>
        <form onSubmit={submit} className="flex flex-col gap-4">
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
      </div>
    </AuthShell>
  );
}
