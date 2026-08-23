/**
 * Ajustes de la persona usuaria (§10.1, §10.2).
 * Toda la personalización es gratuita por definición: aquí no hay nada bloqueado
 * ni ningún aviso de "mejora tu plan".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PROFILE_STYLE, type SelfUser } from "@distop/protocol";
import { ChevronDown, ExternalLink, Pipette } from "lucide-react";
import { useStore, type BackdropChoice, type Density, type FontChoice, type ThemeChoice } from "../store.ts";
import { api, setTokens, type Tokens } from "../lib/api.ts";
import { inputDevice, probeNetwork, setIceServers, setInputDevice, setVideoMode } from "../lib/voice.ts";
import * as audio from "../lib/relay.ts";
import { LOCALES, LOCALE_LABELS } from "../i18n.ts";
import { Avatar, Button, DisplayName, ErrorNote, Field, ImageField, Modal, Toggle, useT, useErrorText } from "../components/ui.tsx";
import { WallpaperField, WallpaperPicker } from "../components/Wallpaper.tsx";
import { Gallery } from "../components/Gallery.tsx";
import {
  AvatarDecoPicker,
  CardEffectLayer,
  CardEffectPicker,
  GradientControls,
  NameStylePicker,
  PlatePicker,
  ProfileCardPreview,
  profileGradient,
} from "../components/ProfileStyle.tsx";
import { askNotifyPermission, notifyPermission, type NotifyLevel } from "../lib/notify.ts";

/** Paleta de partida. Cualquier otro color sale del selector, sin cortapisas. */
const ACCENTS = ["#4059e0", "#7b5cff", "#c2389c", "#d94f43", "#e08c2f", "#2f9e6f", "#2f8fd6", "#5b6472"];

export type SettingsTab = "profile" | "appearance" | "alerts" | "voice" | "account";

export function Settings({ open, onClose, initialTab = "profile" }: { open: boolean; onClose: () => void; initialTab?: SettingsTab }) {
  const t = useT();
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);

  const tabs: Array<[SettingsTab, string]> = [
    ["profile", t("settings.profile")],
    ["appearance", t("settings.appearance")],
    ["alerts", t("settings.notifications")],
    ["voice", t("settings.voice")],
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
          {tab === "appearance" ? <AppearanceTab onAdjust={onClose} /> : null}
          {tab === "alerts" ? <AlertsTab /> : null}
          {tab === "voice" ? <VoiceTab /> : null}
          {tab === "account" ? <AccountTab onClose={onClose} /> : null}
        </div>
      </div>
    </Modal>
  );
}

/** Abre bajo demanda: montar la galería de entrada dispara peticiones que
    nadie ha pedido, y son peticiones que salen de la instancia. */
function Expander({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {label}
      </Button>
      {open ? children : null}
    </div>
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
    profile_style: user?.profile_style ?? DEFAULT_PROFILE_STYLE,
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

  const style = form.profile_style;
  const patchStyle = (patch: Partial<typeof style>) =>
    setForm((prev) => ({ ...prev, profile_style: { ...prev.profile_style, ...patch } }));

  /* Editor estilo Discord: carril de categorías a la izquierda —cada cabecera
     enseña la elección actual en miniatura— y la tarjeta viva a la derecha,
     que reacciona a cada cambio sin guardar. Una categoría abierta a la vez:
     el catálogo entero desplegado era una pared de opciones. */
  const [section, setSection] = useState<string | null>("avatar");

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <EditorSection
          id="identity"
          current={section}
          onOpen={setSection}
          title={t("profile.identity")}
          preview={<span className="max-w-28 truncate text-xs text-muted">{form.display_name || `@${user?.username}`}</span>}
        >
          <div className="flex flex-col gap-3">
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
        </EditorSection>

        <EditorSection
          id="avatar"
          current={section}
          onOpen={setSection}
          title={t("profile.avatarDeco")}
          preview={<Avatar name={form.display_name || "?"} url={form.avatar_url || null} id={user?.id} size={28} profile={style} />}
        >
          <div className="flex flex-col gap-3">
            <ImageField
              label={t("settings.avatar")}
              hint={t("settings.avatarHint")}
              value={form.avatar_url}
              onChange={(url) => setForm({ ...form, avatar_url: url })}
              preview="round"
            />
            <Expander label={t("settings.galleryAvatar")}>
              <Gallery current={form.avatar_url} onPick={(url) => setForm({ ...form, avatar_url: url })} />
            </Expander>
            <AvatarDecoPicker value={style} onChange={patchStyle} name={form.display_name} avatarUrl={form.avatar_url} userId={user?.id} />
          </div>
        </EditorSection>

        {/* Banner y placa juntos: los dos son "el fondo sobre el que va tu
            nombre" — el banner en la tarjeta, la placa en la lista de miembros.
            La cabecera enseña las dos miniaturas. */}
        <EditorSection
          id="banner"
          current={section}
          onOpen={setSection}
          title={t("profile.bannerPlate")}
          preview={
            <>
              <span
                className="block h-7 w-12 rounded-md border border-line"
                style={{
                  background: form.banner_url
                    ? `center/cover no-repeat url(${JSON.stringify(form.banner_url)})`
                    : profileGradient(style, form.accent_color),
                }}
              />
              <span className={`block h-7 w-12 rounded-md border border-line plate plate-${style.nameplate}`} />
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <ImageField
              label={t("settings.banner")}
              hint={t("settings.bannerHint")}
              value={form.banner_url}
              onChange={(url) => setForm({ ...form, banner_url: url })}
              preview="wide"
            />
            {/* Dos galerías porque son dos cosas distintas: paisajes de
                Wallhaven, y arte animado de la galería de perfiles. */}
            <Expander label={t("settings.galleryBanner")}>
              <Gallery current={form.banner_url} onPick={(url) => setForm({ ...form, banner_url: url })} />
            </Expander>
            <WallpaperPicker current={form.banner_url} onPick={(url) => setForm({ ...form, banner_url: url })} />

            <PlatePicker value={style} onChange={patchStyle} />
          </div>
        </EditorSection>

        <EditorSection
          id="name"
          current={section}
          onOpen={setSection}
          title={t("profile.nameStyle")}
          preview={
            <span className="text-sm font-bold">
              <DisplayName name="Ag" style={style} accent={form.accent_color} />
            </span>
          }
        >
          <NameStylePicker value={style} onChange={patchStyle} accent={form.accent_color} />
        </EditorSection>

        <EditorSection
          id="theme"
          current={section}
          onOpen={setSection}
          title={t("profile.theme")}
          preview={<span className="block h-7 w-12 rounded-md border border-line" style={{ background: profileGradient(style, form.accent_color) }} />}
        >
          <GradientControls value={style} accent={form.accent_color} onChange={patchStyle} />
        </EditorSection>

        <EditorSection
          id="effect"
          current={section}
          onOpen={setSection}
          title={t("profileStyle.profileEffect")}
          preview={
            <span
              className="relative block h-7 w-12 overflow-hidden rounded-md border border-line"
              style={{ background: profileGradient(style, form.accent_color) }}
            >
              <CardEffectLayer effect={style.profile_effect} className="absolute inset-0" />
            </span>
          }
        >
          <CardEffectPicker value={style} onChange={patchStyle} accent={form.accent_color} />
        </EditorSection>

        <GameActivityCard />
      </div>

      {/* La tarjeta manda: es lo que verán los demás, y por eso vive fija al
          lado mientras se prueba, con el guardar debajo. En pantalla estrecha
          va PRIMERO: editar debajo de la tarjeta que cambia, no a ciegas. */}
      <div className="order-first flex min-w-0 flex-col gap-3 lg:order-last lg:sticky lg:top-2">
        <ProfileCardPreview
          style={style}
          name={form.display_name}
          username={user?.username ?? ""}
          pronouns={form.pronouns}
          bio={form.bio}
          avatarUrl={form.avatar_url}
          bannerUrl={form.banner_url}
          accent={form.accent_color}
          userId={user?.id}
          createdAt={user?.created_at}
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <Button variant="primary" onClick={save} disabled={state === "saving"} className="self-start">
          {state === "saved" ? t("common.saved") : t("common.save")}
        </Button>
      </div>
    </div>
  );
}

/**
 * Actividad de juego (§9.1, §29.6): los dos interruptores de privacidad.
 * Guardan al momento, sin botón: un interruptor de privacidad que espera a un
 * "Guardar" es un interruptor que la gente cree activado sin estarlo. Ausente
 * en los ajustes = activado — instalar la app de escritorio y dejar que detecte
 * ya fue el acto de consentimiento; esto es la pausa.
 */
function GameActivityCard() {
  const t = useT();
  const user = useStore((s) => s.user);
  const refreshUser = useStore((s) => s.refreshUser);
  if (!user) return null;

  const share = user.settings.share_game_activity !== false;
  const history = user.settings.show_game_history !== false;

  async function toggle(key: "share_game_activity" | "show_game_history", value: boolean) {
    try {
      refreshUser(await api("PATCH", "/api/v1/users/me", { settings: { ...user!.settings, [key]: value } }));
    } catch {
      // El interruptor vuelve solo: refreshUser no llegó a cambiar nada.
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
      <div>
        <h3 className="text-sm font-semibold">{t("settings.gameActivity")}</h3>
        <p className="text-xs text-muted">{t("settings.gameActivityHint")}</p>
      </div>
      <Toggle checked={share} onChange={(v) => void toggle("share_game_activity", v)} label={t("settings.gameShare")} hint={t("settings.gameShareHint")} />
      <Toggle checked={history} onChange={(v) => void toggle("show_game_history", v)} label={t("settings.gameHistory")} hint={t("settings.gameHistoryHint")} />
    </section>
  );
}

/**
 * Una categoría del editor de perfil, plegada en una fila.
 * La cabecera enseña la elección ACTUAL en miniatura —como hace Discord— para
 * que el carril entero se lea de un vistazo sin abrir nada.
 */
function EditorSection({
  id,
  current,
  onOpen,
  title,
  preview,
  children,
}: {
  id: string;
  current: string | null;
  onOpen: (id: string | null) => void;
  title: string;
  preview: React.ReactNode;
  children: React.ReactNode;
}) {
  const open = current === id;
  return (
    <section className="overflow-hidden rounded-[10px] border border-line">
      <button
        onClick={() => onOpen(open ? null : id)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition-colors hover:bg-raise"
      >
        <span className="text-sm font-semibold">{title}</span>
        <span className="flex shrink-0 items-center gap-2">
          {preview}
          <ChevronDown size={15} className={`text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </span>
      </button>
      {open ? <div className="border-t border-line p-3">{children}</div> : null}
    </section>
  );
}

/**
 * Avisos (§9.2, §8).
 *
 * Tres interruptores independientes en vez de uno con tres niveles, porque son
 * tres decisiones distintas: qué merece avisar, si suena, y si el sistema
 * operativo puede sacar una ventana. Nada de esto viaja a ninguna parte: se
 * guarda en este dispositivo, igual que la escala o la densidad.
 */
function AlertsTab() {
  const t = useT();
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);
  const [permission, setPermission] = useState(notifyPermission());

  const levels: Array<[NotifyLevel, string]> = [
    ["all", t("settings.notifyAll")],
    ["mentions", t("settings.notifyMentions")],
    ["off", t("settings.notifyOff")],
  ];

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("settings.notifications")}</legend>
        <div className="flex flex-wrap gap-2">
          {levels.map(([value, label]) => (
            <button
              key={value}
              onClick={() => setPref("notify", value)}
              aria-pressed={prefs.notify === value}
              className={`btn ${prefs.notify === value ? "btn-primary" : "btn-ghost"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">{t("settings.notifyHint")}</p>
      </fieldset>

      <Toggle
        checked={prefs.sounds}
        onChange={(value) => setPref("sounds", value)}
        label={t("settings.sounds")}
        hint={t("settings.soundsHint")}
      />

      <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
        <p className="text-sm font-medium">{t("settings.desktopNotifications")}</p>
        <p className="text-xs text-muted">{t("settings.desktopHint")}</p>

        {/* El permiso lo da el navegador y solo desde un clic real, así que aquí
            hay un botón y no un interruptor: un interruptor prometería algo que
            esta aplicación no puede cumplir por su cuenta. */}
        {permission === "unsupported" ? (
          <p className="text-xs text-warn">{t("settings.notifyUnsupported")}</p>
        ) : permission === "granted" ? (
          <p className="text-xs text-ok">{t("settings.notifyGranted")}</p>
        ) : permission === "denied" ? (
          <p className="text-xs text-warn">{t("settings.notifyDenied")}</p>
        ) : (
          <Button
            variant="primary"
            className="self-start"
            onClick={() => void askNotifyPermission().then(setPermission)}
          >
            {t("settings.notifyAsk")}
          </Button>
        )}
      </div>
    </div>
  );
}

function AppearanceTab({ onAdjust }: { onAdjust: () => void }) {
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

      <WallpaperField onAdjust={onAdjust} />

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

/**
 * Fotogramas, resolución y nitidez de cámara y pantalla (§9.5, §10.2).
 *
 * Va junto al bloque de audio y no con el de quien hospeda: es tu propia
 * cámara y tu propia pantalla, solo tu subida se ve afectada, así que vale
 * para cualquiera y no solo para quien hospeda la instancia.
 */
function VideoSetup() {
  const t = useT();
  const [quality, setQualityState] = useState(audio.videoQuality());
  const [priority, setPriorityState] = useState(audio.videoPriority());

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="display text-base font-bold">{t("voice.videoTitle")}</h3>
        <p className="mt-1 text-sm text-muted">{t("voice.videoIntro")}</p>
      </div>

      <Field label={t("voice.quality")} hint={t("voice.qualityHint")}>
        {(id) => (
          <select
            id={id}
            className="field"
            value={quality}
            onChange={(e) => {
              const value = e.target.value as audio.Quality;
              setQualityState(value);
              audio.setQuality(value);
            }}
          >
            <option value="low">{t("voice.qualityLow")}</option>
            <option value="medium">{t("voice.qualityMedium")}</option>
            <option value="high">{t("voice.qualityHigh")}</option>
          </select>
        )}
      </Field>

      <Field label={t("voice.priority")} hint={t("voice.priorityHint")}>
        {(id) => (
          <select
            id={id}
            className="field"
            value={priority}
            onChange={(e) => {
              const value = e.target.value as audio.Priority;
              setPriorityState(value);
              audio.setPriority(value);
            }}
          >
            <option value="fluid">{t("voice.priorityFluid")}</option>
            <option value="balanced">{t("voice.priorityBalanced")}</option>
            <option value="sharp">{t("voice.prioritySharp")}</option>
          </select>
        )}
      </Field>
    </div>
  );
}

/**
 * Cómo se conectan dos personas en una llamada (§9.4).
 *
 * Esto existe porque una llamada directa no siempre es posible: hay routers
 * domésticos que no dejan que dos aparatos de la misma casa se hablen entre sí, y
 * casi ninguna red móvil lo permite. Cuando no hay ruta directa no falla "el
 * vídeo": fallan a la vez el audio, la cámara y la pantalla, que es exactamente
 * lo que se ve al probar entre un ordenador y un teléfono.
 *
 * Solo lo toca quien hospeda: la decisión afecta a todo el que entre.
 */
interface RelayState {
  mode: "direct" | "custom" | "cloudflare" | "metered";
  video: "host" | "direct";
  url: string;
  username: string;
  keyId: string;
  appName: string;
  /** Fijado por ICE_SERVERS en el entorno: manda eso y desde aquí no se cambia. */
  locked: boolean;
}

type Probe = { host: boolean; stun: boolean; relay: boolean } | "running" | null;

/**
 * Enlace al sitio donde se saca la credencial.
 * Sin esto hay que salir de la aplicación a buscar a mano en qué rincón del panel
 * del proveedor está la clave, que es justo donde la gente abandona.
 */
function Externo({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      // noreferrer además de noopener: la instancia puede estar en una dirección
      // privada y no tiene por qué acabar en las estadísticas de nadie.
      rel="noopener noreferrer"
      className="btn btn-ghost self-start text-xs"
    >
      {children}
      <ExternalLink size={13} aria-hidden />
    </a>
  );
}

/**
 * Micrófono, altavoces y volúmenes (§10.2).
 *
 * Va aparte del bloque de quien hospeda —y antes— porque no es configuración de
 * la instancia: es de este equipo y de esta persona. Nada de esto viaja ni lo
 * nota nadie más en la sala.
 */
function AudioSetup() {
  const t = useT();
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([]);
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([]);
  const [mic, setMic] = useState(inputDevice);
  const [out, setOut] = useState(audio.outputDevice);
  const [micVol, setMicVol] = useState(audio.micVolume);
  const [outVol, setOutVol] = useState(audio.outputVolume);
  const [unnamed, setUnnamed] = useState(false);

  /* Sin `mediaDevices` no hay nada que elegir: pasa al abrir la instancia por
     http desde otro equipo de la red. Se dice, en vez de enseñar listas vacías. */
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  const list = useCallback(async () => {
    if (!media) return;
    const all = await media.enumerateDevices();
    setInputs(all.filter((d) => d.kind === "audioinput"));
    setOutputs(all.filter((d) => d.kind === "audiooutput"));
    // Sin permiso el navegador entrega los aparatos sin nombre: se puede elegir
    // a ciegas, pero conviene decir por qué no se lee ninguno.
    setUnnamed(all.some((d) => d.kind === "audioinput" && !d.label));
  }, [media]);

  useEffect(() => {
    void list();
    media?.addEventListener("devicechange", list);
    return () => media?.removeEventListener("devicechange", list);
  }, [list, media]);

  /** Pedir el micrófono una vez y soltarlo: es lo que destapa los nombres. */
  async function reveal(): Promise<void> {
    try {
      const stream = await media!.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      // Si lo niega se sigue con los nombres genéricos: elegir aún funciona.
    }
    await list();
  }

  const name = (device: MediaDeviceInfo, index: number, key: "voice.deviceUnnamed" | "voice.deviceUnnamedOut") =>
    device.label || t(key, { n: index + 1 });

  /* ── prueba del micrófono ─────────────────────────────────────────────
     La barra se mueve si el aparato capta algo: es la manera de saber ANTES de
     entrar en una sala que el micrófono elegido funciona. Nada sale del
     equipo: el audio muere en el AnalyserNode, sin red ni grabación. */
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const testRef = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null);

  function stopTest(): void {
    const test = testRef.current;
    if (!test) return;
    testRef.current = null;
    cancelAnimationFrame(test.raf);
    for (const track of test.stream.getTracks()) track.stop();
    void test.ctx.close();
    setTesting(false);
    setLevel(0);
  }

  async function startTest(deviceId = mic): Promise<void> {
    stopTest();
    try {
      const stream = await media!.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += (value - 128) ** 2;
        const rms = Math.sqrt(sum / data.length) / 128;
        setLevel(Math.min(100, Math.round(rms * 250)));
        if (testRef.current) testRef.current.raf = requestAnimationFrame(tick);
      };
      testRef.current = { stream, ctx, raf: requestAnimationFrame(tick) };
      setTesting(true);
      // Con el permiso ya concedido, los nombres de los aparatos aparecen.
      await list();
    } catch {
      // Permiso negado o aparato ocupado: el botón simplemente no arranca.
      setTesting(false);
    }
  }

  // El micrófono se suelta al salir de Ajustes, no cuando lo recuerde el GC.
  useEffect(() => stopTest, []);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="display text-base font-bold">{t("voice.audioTitle")}</h3>
        <p className="mt-1 text-sm text-muted">{t("voice.audioIntro")}</p>
      </div>

      {media ? (
        <>
          <Field label={t("voice.device")} hint={unnamed ? t("voice.deviceNames") : ""}>
            {(id) => (
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id={id}
                  className="field min-w-0 flex-1"
                  value={mic}
                  onChange={(e) => {
                    setMic(e.target.value);
                    void setInputDevice(e.target.value);
                    // Si la prueba está en marcha, sigue con el aparato nuevo:
                    // es justo lo que se quiere comprobar al cambiarlo.
                    if (testRef.current) void startTest(e.target.value);
                  }}
                >
                  <option value="">{t("voice.deviceDefault")}</option>
                  {inputs.map((device, index) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {name(device, index, "voice.deviceUnnamed")}
                    </option>
                  ))}
                </select>
                {unnamed ? (
                  <Button variant="ghost" onClick={() => void reveal()}>
                    {t("voice.deviceAllow")}
                  </Button>
                ) : null}
              </div>
            )}
          </Field>

          <Field
            label={`${t("voice.micVolume")} — ${Math.round(micVol * 100)}%`}
            hint={t("voice.micVolumeHint")}
          >
            {(id) => (
              <input
                id={id}
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(micVol * 100)}
                onChange={(e) => {
                  const value = Number(e.target.value) / 100;
                  setMicVol(value);
                  audio.setMicVolume(value);
                }}
                className="w-full"
                style={{ accentColor: "var(--accent)" }}
              />
            )}
          </Field>

          <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="ghost" onClick={() => (testing ? stopTest() : void startTest())}>
                {testing ? t("voice.micTestStop") : t("voice.micTest")}
              </Button>
              <p className="text-xs text-muted">{t("voice.micTestHint")}</p>
            </div>
            {testing ? (
              <div
                className="h-2 overflow-hidden rounded-full bg-raise"
                role="meter"
                aria-label={t("voice.micTest")}
                aria-valuenow={level}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${level}%`, background: "var(--accent)", transition: "width 80ms linear" }}
                />
              </div>
            ) : null}
          </div>

          <Field
            label={t("voice.outputDevice")}
            hint={audio.canPickOutput() ? "" : t("voice.outputFixed")}
          >
            {(id) => (
              <select
                id={id}
                className="field"
                value={out}
                disabled={!audio.canPickOutput()}
                onChange={(e) => {
                  setOut(e.target.value);
                  void audio.setOutputDevice(e.target.value);
                }}
              >
                <option value="">{t("voice.deviceDefault")}</option>
                {outputs.map((device, index) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {name(device, index, "voice.deviceUnnamedOut")}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      ) : (
        <p className="text-sm text-muted">{t("voice.noMedia")}</p>
      )}

      <Field
        label={`${t("voice.outVolume")} — ${Math.round(outVol * 100)}%`}
        hint={t("voice.outVolumeHint")}
      >
        {(id) => (
          <input
            id={id}
            type="range"
            min={0}
            max={200}
            step={5}
            value={Math.round(outVol * 100)}
            onChange={(e) => {
              const value = Number(e.target.value) / 100;
              setOutVol(value);
              audio.setOutputVolume(value);
            }}
            className="w-full"
            style={{ accentColor: "var(--accent)" }}
          />
        )}
      </Field>
    </div>
  );
}

function VoiceTab() {
  const t = useT();
  const errorText = useErrorText();
  const [relay, setRelayState] = useState<RelayState | null>(null);
  const [denied, setDenied] = useState(false);
  const [draft, setDraft] = useState({
    url: "",
    username: "",
    credential: "",
    keyId: "",
    apiToken: "",
    appName: "",
    apiKey: "",
  });
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [probe, setProbe] = useState<Probe>(null);
  /** Lo marcado en pantalla, que hasta pulsar "Guardar" puede no ser lo guardado. */
  const [elegido, setElegido] = useState<RelayState["mode"]>("direct");

  useEffect(() => {
    api<RelayState>("GET", "/api/v1/instance/relay")
      .then((value) => {
        setRelayState(value);
        setElegido(value.mode);
        setDraft({
          url: value.url,
          username: value.username,
          credential: "",
          keyId: value.keyId,
          apiToken: "",
          appName: value.appName,
          apiKey: "",
        });
      })
      .catch(() => setDenied(true));
  }, []);

  /** La lista viva, tal y como la anuncia la instancia ahora mismo. */
  async function currentServers(): Promise<RTCIceServer[]> {
    const info = await api<{ ice_servers: RTCIceServer[] }>("GET", "/api/v1/info");
    // Que valga ya para la próxima llamada, sin obligar a recargar la página.
    setIceServers(info.ice_servers ?? []);
    return info.ice_servers ?? [];
  }

  async function save(
    next: Partial<RelayState> & {
      credential?: string;
      apiToken?: string;
      apiKey?: string;
    },
  ): Promise<void> {
    setError("");
    setSaved(false);
    setProbe(null);
    try {
      const value = await api<RelayState>("PUT", "/api/v1/instance/relay", next);
      setRelayState(value);
      setElegido(value.mode);
      // Que valga ya para la próxima llamada, sin recargar la página.
      setVideoMode(value.video);
      await currentServers();
      setSaved(true);
      /* Guardar no es lo mismo que funcionar. Un proveedor puede aceptar tus
         credenciales por su API y tener el servidor de relevo caído o bloqueado
         desde tu red: quedaría "guardado" y las llamadas seguirían mudas. Así que
         se comprueba solo, aquí mismo, sin que haya que acordarse de pulsar nada. */
      if (value.mode !== "direct") void check();
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function check(): Promise<void> {
    setProbe("running");
    try {
      setProbe(await probeNetwork(await currentServers()));
    } catch (err) {
      setProbe(null);
      setError(errorText(err));
    }
  }

  if (denied || !relay)
    return (
      <div className="flex flex-col gap-6">
        <AudioSetup />
        <VideoSetup />
        <p className="text-sm text-muted">{denied ? t("voice.relayHostOnly") : t("common.loading")}</p>
      </div>
    );

  const modes: Array<[RelayState["mode"], string, string]> = [
    ["metered", t("voice.relayMet"), t("voice.relayMetHint")],
    ["cloudflare", t("voice.relayCf"), t("voice.relayCfHint")],
    ["direct", t("voice.relayDirect"), t("voice.relayDirectHint")],
    ["custom", t("voice.relayCustom"), t("voice.relayCustomHint")],
  ];

  /* El veredicto en una frase, que es lo que hay que leer. Un relevo apuntado
     que no responde se comporta igual que no tener ninguno, y sin decirlo aquí
     es indistinguible de "el vídeo está roto". */
  const verdict =
    probe && probe !== "running"
      ? probe.relay
        ? t("voice.probeRelayOk")
        : relay.mode !== "direct"
          ? t("voice.probeRelayDead")
          : probe.stun
            ? t("voice.probeDirectOnly")
            : t("voice.probeNoStun")
      : "";

  return (
    <div className="flex flex-col gap-6">
      <AudioSetup />
      <VideoSetup />

      <div>
        <h3 className="display text-base font-bold">{t("voice.relayTitle")}</h3>
        <p className="mt-1 text-sm text-muted">{t("voice.relayIntro")}</p>
      </div>

      {/* Lo primero, porque decide si todo lo de abajo hace falta siquiera. */}
      <fieldset className="flex flex-col gap-2" disabled={relay.locked}>
        <legend className="sr-only">{t("voice.videoWay")}</legend>
        {(
          [
            ["host", t("voice.videoHost"), t("voice.videoHostHint")],
            ["direct", t("voice.videoP2p"), t("voice.videoP2pHint")],
          ] as const
        ).map(([mode, label, hint]) => (
          <label
            key={mode}
            className={`flex cursor-pointer gap-3 rounded-card border p-3 transition-colors ${
              relay.video === mode ? "border-accent bg-accent-soft" : "border-line hover:bg-raise"
            }`}
          >
            <input
              type="radio"
              name="video-way"
              checked={relay.video === mode}
              onChange={() => void save({ video: mode })}
              className="mt-1 accent-[var(--accent)]"
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {/* Con el vídeo pasando por la instancia no hay conexión directa que
          arreglar, así que todo lo de abajo sobra. Enseñarlo igual sería invitar
          a configurar cuentas que no van a hacer nada. */}
      {relay.video === "direct" ? (
        <>
          <div className="flex flex-col gap-2 rounded-card border border-line p-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="ghost" onClick={() => void check()} disabled={probe === "running"}>
                {probe === "running" ? t("voice.probeRunning") : t("voice.probe")}
              </Button>
              <p className="text-xs text-muted">{t("voice.probeHint")}</p>
            </div>
            {probe && probe !== "running" ? (
              <>
                <ul className="flex flex-col gap-0.5 text-sm">
                  {(
                    [
                      ["voice.probeLocal", probe.host],
                      ["voice.probeStun", probe.stun],
                      ["voice.probeRelay", probe.relay],
                    ] as const
                  ).map(([key, ok]) => (
                    <li key={key} className={ok ? "text-ok" : "text-muted"}>
                      {ok ? "✓" : "✕"} {t(key)}
                    </li>
                  ))}
                </ul>
                <p className="text-sm">{verdict}</p>
              </>
            ) : null}
          </div>

          {relay.locked ? <p className="text-sm text-muted">{t("voice.relayLocked")}</p> : null}

          <fieldset className="flex flex-col gap-2" disabled={relay.locked}>
            <legend className="sr-only">{t("voice.relayTitle")}</legend>
            {modes.map(([mode, label, hint]) => (
              <label
                key={mode}
                className={`flex cursor-pointer gap-3 rounded-card border p-3 transition-colors ${
                  elegido === mode ? "border-accent bg-accent-soft" : "border-line hover:bg-raise"
                }`}
              >
                <input
                  type="radio"
                  name="relay-mode"
                  checked={elegido === mode}
                  /* "Directa" no necesita nada más, así que se guarda al momento. Los
                 otros dos piden credenciales: aquí solo se enseña su formulario, y
                 se guarda al pulsar, cuando ya hay algo que comprobar. */
                  onChange={() => (mode === "direct" ? void save({ mode }) : (setElegido(mode), setError("")))}
                  className="mt-1 accent-[var(--accent)]"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted">{hint}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {elegido === "metered" && !relay.locked ? (
            <form
              className="flex flex-col gap-3 rounded-card border border-line p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({
                  mode: "metered",
                  appName: draft.appName,
                  apiKey: draft.apiKey,
                });
              }}
            >
              <ol className="ml-4 list-decimal text-xs text-muted">
                <li>{t("voice.relayMetStep1")}</li>
                <li>{t("voice.relayMetStep2")}</li>
                <li>{t("voice.relayMetStep3")}</li>
              </ol>
              <Externo href="https://dashboard.metered.ca/signup?tool=turnserver">{t("voice.relayMetOpen")}</Externo>
              <Field label={t("voice.relayMetApp")} hint={t("voice.relayMetAppHint")}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={draft.appName}
                    onChange={(e) => setDraft({ ...draft, appName: e.target.value })}
                    placeholder="mi-app"
                  />
                )}
              </Field>
              <Field label={t("voice.relayMetKey")} hint={t("voice.relayPasswordHint")}>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    className="field"
                    value={draft.apiKey}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className="self-start">
                {t("voice.relayCfSave")}
              </Button>
            </form>
          ) : null}

          {elegido === "cloudflare" && !relay.locked ? (
            <form
              className="flex flex-col gap-3 rounded-card border border-line p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({
                  mode: "cloudflare",
                  keyId: draft.keyId,
                  apiToken: draft.apiToken,
                });
              }}
            >
              <ol className="ml-4 list-decimal text-xs text-muted">
                <li>{t("voice.relayCfStep1")}</li>
                <li>{t("voice.relayCfStep2")}</li>
                <li>{t("voice.relayCfStep3")}</li>
              </ol>
              <Externo href="https://dash.cloudflare.com/?to=/:account/calls">{t("voice.relayCfOpen")}</Externo>
              <Field label={t("voice.relayCfKey")} hint={t("voice.relayCfKeyHint")}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={draft.keyId}
                    onChange={(e) => setDraft({ ...draft, keyId: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("voice.relayCfToken")} hint={t("voice.relayPasswordHint")}>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    className="field"
                    value={draft.apiToken}
                    onChange={(e) => setDraft({ ...draft, apiToken: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className="self-start">
                {t("voice.relayCfSave")}
              </Button>
            </form>
          ) : null}

          {elegido === "custom" && !relay.locked ? (
            <form
              className="flex flex-col gap-3 rounded-card border border-line p-3"
              onSubmit={(event) => {
                event.preventDefault();
                void save({
                  mode: "custom",
                  url: draft.url,
                  username: draft.username,
                  credential: draft.credential,
                });
              }}
            >
              <p className="text-xs text-muted">{t("voice.relayHelp")}</p>
              <Externo href="https://www.expressturn.com/#signup">{t("voice.relayCustomOpen")}</Externo>
              <Field label={t("voice.relayUrl")} hint="turn:turn.tudominio.org:3478">
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={draft.url}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                    placeholder="turn:…"
                  />
                )}
              </Field>
              <Field label={t("voice.relayUser")}>
                {(id) => (
                  <input
                    id={id}
                    className="field"
                    value={draft.username}
                    onChange={(e) => setDraft({ ...draft, username: e.target.value })}
                  />
                )}
              </Field>
              <Field label={t("voice.relayPassword")} hint={t("voice.relayPasswordHint")}>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    className="field"
                    value={draft.credential}
                    onChange={(e) => setDraft({ ...draft, credential: e.target.value })}
                  />
                )}
              </Field>
              <Button type="submit" variant="primary" className="self-start">
                {t("common.save")}
              </Button>
            </form>
          ) : null}
        </>
      ) : null}

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {saved ? <p className="text-sm text-ok">{t("voice.relaySaved")}</p> : null}
    </div>
  );
}

function AccountTab({ onClose }: { onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const user = useStore((s) => s.user);
  const logout = useStore((s) => s.logout);
  const refreshUser = useStore((s) => s.refreshUser);

  // Prellenado con el nombre actual: quien puso en marcha la instancia ya
  // eligió uno, y obligar a teclearlo de nuevo invita a errores de tipeo.
  const [username, setUsername] = useState(user?.username ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function upgrade() {
    setError(null);
    try {
      const updated = await api<SelfUser>("POST", "/api/v1/users/me/upgrade", {
        username,
        password,
      });
      refreshUser(updated);
      setUsername("");
      setPassword("");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Por contraseña y no por tipo de cuenta: quien puso en marcha la
          instancia es `local` sin contraseña, y también necesita poder ponerla
          para volver desde otro equipo. */}
      {user && !user.has_password ? (
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

          <Button
            variant="primary"
            onClick={upgrade}
            disabled={username.length < 3 || password.length < 10}
            className="self-start"
          >
            {t("settings.upgrade")}
          </Button>
        </section>
      ) : (
        <>
          <p className="text-sm text-muted">
            @{user?.username} · {t("settings.account")}
          </p>
          <ChangePassword />
        </>
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

      <DeleteAccount onDone={onClose} />
    </div>
  );
}

/**
 * Cambiar una contraseña que ya existe (§22).
 * Pide la actual —tener el equipo desbloqueado no debe bastar— y el servidor
 * cierra las demás sesiones al cambiarla: esta recibe tokens nuevos y sigue
 * dentro, y aquí se dice claramente que el resto quedó fuera.
 */
function ChangePassword() {
  const t = useT();
  const errorText = useErrorText();
  const refreshUser = useStore((s) => s.refreshUser);

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function change() {
    setState("saving");
    setError(null);
    try {
      const result = await api<Tokens & { user: SelfUser }>("POST", "/api/v1/users/me/password", {
        current_password: current,
        password: next,
      });
      setTokens({ access_token: result.access_token, refresh_token: result.refresh_token });
      refreshUser(result.user);
      setCurrent("");
      setNext("");
      setState("saved");
    } catch (err) {
      setError(errorText(err));
      setState("idle");
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line p-4">
      <h3 className="display font-bold">{t("settings.changePassword")}</h3>
      <p className="text-sm text-muted">{t("settings.changePasswordHint")}</p>

      <Field label={t("settings.currentPassword")}>
        {(id) => (
          <input
            id={id}
            type="password"
            className="field"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            maxLength={200}
            autoComplete="current-password"
          />
        )}
      </Field>

      <Field label={t("settings.newPassword")} hint={t("auth.passwordHint")}>
        {(id) => (
          <input
            id={id}
            type="password"
            className="field"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            maxLength={200}
            autoComplete="new-password"
          />
        )}
      </Field>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {state === "saved" ? <p className="text-sm text-ok">{t("settings.passwordChanged")}</p> : null}

      <Button
        variant="primary"
        onClick={change}
        disabled={state === "saving" || current.length === 0 || next.length < 10}
        className="self-start"
      >
        {t("settings.changePassword")}
      </Button>
    </section>
  );
}

/**
 * Irse del todo (§29.6).
 * La eliminación de cuenta no se esconde ni se disfraza de "desactivar": está a
 * la vista, dice exactamente qué se borra, y borra de verdad. Pide escribir el
 * nombre de usuario porque no hay papelera de la que recuperarlo.
 */
function DeleteAccount({ onDone }: { onDone: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const user = useStore((s) => s.user);
  const logout = useStore((s) => s.logout);

  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", "/api/v1/users/me", { username: confirm.trim() });
      // La sesión ya no vale para nada: el servidor la revocó al borrar la fila.
      await logout();
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-danger/40 p-4">
      <h3 className="display font-bold text-danger">{t("settings.deleteAccount")}</h3>
      <p className="text-sm text-muted">{t("settings.deleteAccountHint")}</p>

      {open ? (
        <>
          <Field
            label={t("settings.deleteConfirmLabel", {
              username: user?.username ?? "",
            })}
          >
            {(id) => (
              <input
                id={id}
                className="field"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="off"
                autoFocus
              />
            )}
          </Field>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="danger"
              onClick={remove}
              disabled={busy || confirm.trim().toLowerCase() !== (user?.username ?? "").toLowerCase()}
            >
              {t("settings.deleteForever")}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="danger" onClick={() => setOpen(true)} className="self-start">
          {t("settings.deleteAccount")}
        </Button>
      )}
    </section>
  );
}
