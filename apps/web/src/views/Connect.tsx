/**
 * Primera pantalla de la app instalada sin usuario (§7.2).
 *
 * En el PC hay dos caminos (Kirbo, 14-09): crear usuario para participar, o
 * entrar como admin de mi servidor (VPS o PC por su dirección de Tailscale).
 * El segundo solo conecta con esa instancia: al recargar, la propia instancia
 * decide si toca reclamarla (código del terminal) o entrar con usuario,
 * contraseña y, desde fuera, el código del autenticador.
 *
 * El teléfono solo participa: ahí no hay segundo camino.
 */
import { useState } from "react";
import { connectToInstance } from "../lib/instance.ts";
import { createLocalIdentity, localUser } from "../lib/portable.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, useT } from "../components/ui.tsx";
import { AuthShell } from "./Auth.tsx";

type Path = "choose" | "user" | "admin";

export function CreateProfile() {
  const t = useT();
  const pc = Boolean(window.distop);
  const [path, setPath] = useState<Path>(pc ? "choose" : "user");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function createUser(event: React.FormEvent): void {
    event.preventDefault();
    if (name.trim().length < 2) return;
    createLocalIdentity(name);
    useStore.setState({ user: localUser() });
  }

  async function connectAdmin(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const url = address.trim();
    if (!url.startsWith("https://")) {
      setError(t("start.addressInvalid"));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await connectToInstance(url);
    // "ok" recarga la app sobre esa instancia; los demás se explican aquí.
    if (result === "ok") return;
    setBusy(false);
    setError(result === "not-instance" ? t("start.notInstance") : result === "invalid" ? t("start.addressInvalid") : t("connect.unreachable"));
  }

  const card = "w-full max-w-md rounded-card border border-line bg-surface/95 p-7 shadow-[var(--shadow)] backdrop-blur-sm sm:p-9";
  const back = pc ? (
    <div className="mt-5 flex justify-center border-t border-line pt-5 text-sm">
      <button type="button" className="text-muted hover:text-ink hover:underline" onClick={() => { setPath("choose"); setError(null); }}>
        {t("start.back")}
      </button>
    </div>
  ) : null;

  if (path === "choose") {
    const option =
      "flex w-full flex-col gap-1 rounded-card border border-line bg-surface/95 p-5 text-left shadow-[var(--shadow)] transition hover:-translate-y-0.5 hover:border-accent focus-visible:border-accent";
    return (
      <AuthShell>
        <div className="flex w-full max-w-md flex-col gap-4">
          <h1 className="display mb-2 text-center text-3xl font-bold">{t("start.title")}</h1>
          <button type="button" className={option} onClick={() => setPath("user")}>
            <span className="display text-lg font-bold">{t("start.createUser")}</span>
            <span className="text-sm text-muted">{t("start.createUserHint")}</span>
          </button>
          <button type="button" className={option} onClick={() => setPath("admin")}>
            <span className="display text-lg font-bold">{t("start.admin")}</span>
            <span className="text-sm text-muted">{t("start.adminHint")}</span>
          </button>
        </div>
      </AuthShell>
    );
  }

  if (path === "admin") {
    return (
      <AuthShell>
        <div className={card}>
          <header className="mb-7 flex flex-col gap-2">
            <h1 className="display text-2xl font-bold">{t("start.admin")}</h1>
            <p className="text-sm text-muted">{t("start.adminHint")}</p>
          </header>
          <form onSubmit={(event) => void connectAdmin(event)} className="flex flex-col gap-4">
            <Field label={t("start.address")} hint={t("start.addressHint")}>
              {(id) => (
                <input
                  id={id}
                  className="field"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  required
                  inputMode="url"
                  autoComplete="url"
                  placeholder="https://"
                  autoFocus
                />
              )}
            </Field>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <Button type="submit" variant="primary" disabled={busy || address.trim().length < 9}>
              {busy ? t("common.loading") : t("start.connect")}
            </Button>
          </form>
          {back}
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className={card}>
        <header className="mb-7 flex flex-col gap-2">
          <h1 className="display text-2xl font-bold">{pc ? t("start.createUser") : t("auth.addProfile")}</h1>
          <p className="text-sm text-muted">{t("phone.createHint")}</p>
        </header>
        <form onSubmit={createUser} className="flex flex-col gap-4">
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
        {back}
      </div>
    </AuthShell>
  );
}
