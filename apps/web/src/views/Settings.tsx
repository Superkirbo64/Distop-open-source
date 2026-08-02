/**
 * Ajustes de la persona usuaria (§10.1, §10.2).
 * Toda la personalización es gratuita por definición: aquí no hay nada bloqueado
 * ni ningún aviso de "mejora tu plan".
 */
import { useState } from "react";
import type { SelfUser } from "@distop/protocol";
import { Pipette } from "lucide-react";
import { useStore, type BackdropChoice, type Density, type FontChoice, type ThemeChoice } from "../store.ts";
import { api } from "../lib/api.ts";
import { LOCALES, LOCALE_LABELS } from "../i18n.ts";
import { Avatar, Button, ErrorNote, Field, Modal, Toggle, useT, useErrorText } from "../components/ui.tsx";

/** Paleta de partida. Cualquier otro color sale del selector, sin cortapisas. */
const ACCENTS = ["#4059e0", "#7b5cff", "#c2389c", "#d94f43", "#e08c2f", "#2f9e6f", "#2f8fd6", "#5b6472"];

type Tab = "profile" | "appearance" | "account";

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("profile");

  const tabs: Array<[Tab, string]> = [
    ["profile", t("settings.profile")],
    ["appearance", t("settings.appearance")],
    ["account", t("settings.account")],
  ];

  return (
    <Modal open={open} onClose={onClose} title={t("settings.title")} size="lg">
      <div className="grid gap-5 md:grid-cols-[10rem_1fr]">
        <nav aria-label={t("settings.title")}>
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {tabs.map(([id, label]) => (
              <li key={id}>
                <button
                  onClick={() => setTab(id)}
                  aria-current={tab === id ? "page" : undefined}
                  className={`w-full rounded-[10px] px-3 py-2 text-left text-sm transition-colors ${
                    tab === id ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-raise hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {tab === "profile" ? <ProfileTab /> : null}
          {tab === "appearance" ? <AppearanceTab /> : null}
          {tab === "account" ? <AccountTab onClose={onClose} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function ProfileTab() {
  const t = useT();
  const errorText = useErrorText();
  const user = useStore((s) => s.user);
  const refreshUser = useStore((s) => s.refreshUser);

  const [form, setForm] = useState({
    display_name: user?.display_name ?? "",
    bio: user?.bio ?? "",
    pronouns: user?.pronouns ?? "",
    avatar_url: user?.avatar_url ?? "",
    banner_url: user?.banner_url ?? "",
    accent_color: user?.accent_color ?? "#4059e0",
  });
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setState("saving");
    setError(null);
    try {
      const updated = await api<SelfUser>("PATCH", "/api/v1/users/me", form);
      refreshUser(updated);
      setState("saved");
    } catch (err) {
      setError(errorText(err));
      setState("idle");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-[10px] border border-line p-3">
        <Avatar name={form.display_name || "?"} url={form.avatar_url || null} id={user?.id} size={52} />
        <div className="min-w-0">
          <p className="display truncate font-bold">{form.display_name}</p>
          <p className="truncate text-sm text-muted">{form.pronouns || `@${user?.username}`}</p>
        </div>
      </div>

      <Field label={t("settings.displayName")}>
        {(id) => (
          <input
            id={id}
            className="field"
            value={form.display_name}
            onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            maxLength={48}
          />
        )}
      </Field>

      <Field label={t("settings.bio")} hint={t("common.optional")}>
        {(id) => (
          <textarea
            id={id}
            className="field min-h-24"
            value={form.bio}
            onChange={(e) => setForm({ ...form, bio: e.target.value })}
            maxLength={500}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("settings.pronouns")} hint={t("common.optional")}>
          {(id) => (
            <input
              id={id}
              className="field"
              value={form.pronouns}
              onChange={(e) => setForm({ ...form, pronouns: e.target.value })}
              maxLength={32}
            />
          )}
        </Field>

        <Field label={t("settings.accent")}>
          {(id) => (
            <input
              id={id}
              type="color"
              className="field h-11 p-1"
              value={form.accent_color}
              onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
            />
          )}
        </Field>
      </div>

      <Field label={t("settings.avatar")} hint={t("common.optional")}>
        {(id) => (
          <input
            id={id}
            className="field"
            value={form.avatar_url}
            onChange={(e) => setForm({ ...form, avatar_url: e.target.value })}
            maxLength={300}
            inputMode="url"
          />
        )}
      </Field>

      <Field label={t("settings.banner")} hint={t("common.optional")}>
        {(id) => (
          <input
            id={id}
            className="field"
            value={form.banner_url}
            onChange={(e) => setForm({ ...form, banner_url: e.target.value })}
            maxLength={300}
            inputMode="url"
          />
        )}
      </Field>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Button variant="primary" onClick={save} disabled={state === "saving"} className="self-start">
        {state === "saved" ? t("common.saved") : t("common.save")}
      </Button>
    </div>
  );
}

function AppearanceTab() {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);

  const themes: Array<[ThemeChoice, string]> = [
    ["light", t("settings.themeLight")],
    ["dark", t("settings.themeDark")],
    ["system", t("settings.themeSystem")],
  ];

  const densities: Array<[Density, string]> = [
    ["cozy", t("settings.densityCozy")],
    ["compact", t("settings.densityCompact")],
  ];

  const fonts: Array<[FontChoice, string]> = [
    ["default", t("settings.fontDefault")],
    ["system", t("settings.fontSystem")],
    ["serif", t("settings.fontSerif")],
    ["mono", t("settings.fontMono")],
  ];

  const backdrops: Array<[BackdropChoice, string]> = [
    ["plain", t("settings.backdropPlain")],
    ["soft", t("settings.backdropSoft")],
    ["dots", t("settings.backdropDots")],
  ];

  return (
    <div className="flex flex-col gap-6">
      <p className="rounded-[10px] border border-line bg-raise px-3 py-2 text-xs text-muted">{t("settings.free")}</p>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("settings.theme")}</legend>
        <div className="flex flex-wrap gap-2">
          {themes.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPref("theme", value)}
              aria-pressed={prefs.theme === value}
              className={`btn ${prefs.theme === value ? "btn-primary" : "btn-ghost"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("settings.accentUi")}</legend>
        <div className="flex flex-wrap items-center gap-2">
          {ACCENTS.map((color) => (
            <button
              key={color}
              onClick={() => setPref("accent", color)}
              aria-label={color}
              aria-pressed={prefs.accent === color}
              className={`h-9 w-9 rounded-full border-2 transition-transform hover:scale-110 ${
                prefs.accent === color ? "border-ink" : "border-transparent"
              }`}
              style={{ background: color }}
            />
          ))}
          <label className="icon-btn grid h-9 w-9 cursor-pointer place-items-center rounded-full border border-dashed border-line">
            <Pipette size={15} />
            <span className="sr-only">{t("settings.accentCustom")}</span>
            <input
              type="color"
              className="sr-only"
              value={prefs.accent || "#4059e0"}
              onChange={(e) => setPref("accent", e.target.value)}
            />
          </label>
          {prefs.accent ? (
            <Button onClick={() => setPref("accent", "")} className="h-9 min-h-9 text-xs">
              {t("settings.reset")}
            </Button>
          ) : null}
        </div>
      </fieldset>

      <Field label={`${t("settings.corners")} — ${prefs.radius}px`}>
        {(id) => (
          <input
            id={id}
            type="range"
            min={0}
            max={24}
            step={2}
            value={prefs.radius}
            onChange={(e) => setPref("radius", Number(e.target.value))}
            className="w-full"
            style={{ accentColor: "var(--accent)" }}
          />
        )}
      </Field>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("settings.font")}</legend>
        <div className="flex flex-wrap gap-2">
          {fonts.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPref("font", value)}
              aria-pressed={prefs.font === value}
              className={`btn ${prefs.font === value ? "btn-primary" : "btn-ghost"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("settings.backdrop")}</legend>
        <div className="flex flex-wrap gap-2">
          {backdrops.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPref("backdrop", value)}
              aria-pressed={prefs.backdrop === value}
              className={`btn ${prefs.backdrop === value ? "btn-primary" : "btn-ghost"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <Toggle
        checked={prefs.motion}
        onChange={(value) => setPref("motion", value)}
        label={t("settings.motion")}
        hint={t("settings.motionHint")}
      />

      <Field label={`${t("settings.fontSize")} — ${Math.round(prefs.scale * 100)}%`}>
        {(id) => (
          <input
            id={id}
            type="range"
            min={0.85}
            max={1.35}
            step={0.05}
            value={prefs.scale}
            onChange={(e) => setPref("scale", Number(e.target.value))}
            className="w-full"
            style={{ accentColor: "var(--accent)" }}
          />
        )}
      </Field>

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("settings.density")}</legend>
        <div className="flex flex-wrap gap-2">
          {densities.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPref("density", value)}
              aria-pressed={prefs.density === value}
              className={`btn ${prefs.density === value ? "btn-primary" : "btn-ghost"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <Field label={t("settings.language")}>
        {(id) => (
          <select
            id={id}
            className="field"
            value={prefs.locale}
            onChange={(e) => {
              localStorage.setItem("distop.locale", e.target.value);
              setPref("locale", e.target.value as (typeof LOCALES)[number]);
            }}
          >
            {LOCALES.map((locale) => (
              <option key={locale} value={locale}>
                {LOCALE_LABELS[locale]}
              </option>
            ))}
          </select>
        )}
      </Field>
    </div>
  );
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const user = useStore((s) => s.user);
  const logout = useStore((s) => s.logout);
  const refreshUser = useStore((s) => s.refreshUser);

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    setError(null);
    try {
      const updated = await api<SelfUser>("POST", "/api/v1/users/me/upgrade", { username, password });
      refreshUser(updated);
      setUsername("");
      setPassword("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {user?.kind === "guest" ? (
        <section className="flex flex-col gap-3 rounded-[10px] border border-line p-4">
          <h3 className="display font-bold">{t("settings.upgrade")}</h3>
          <p className="text-sm text-muted">{t("settings.upgradeHint")}</p>

          <Field label={t("auth.username")} hint={t("auth.usernameHint")}>
            {(id) => (
              <input
                id={id}
                className="field"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                maxLength={32}
              />
            )}
          </Field>

          <Field label={t("auth.password")} hint={t("auth.passwordHint")}>
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

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Button variant="primary" onClick={upgrade} disabled={username.length < 3 || password.length < 10} className="self-start">
            {t("settings.upgrade")}
          </Button>
        </section>
      ) : (
        <p className="text-sm text-muted">
          @{user?.username} · {t("settings.account")}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            await api("POST", "/api/v1/users/me/sessions/revoke-all");
            await logout();
            onClose();
          }}
        >
          {t("settings.revokeAll")}
        </Button>

        <Button
          variant="danger"
          onClick={async () => {
            await logout();
            onClose();
          }}
        >
          {t("settings.logout")}
        </Button>
      </div>
    </div>
  );
}
