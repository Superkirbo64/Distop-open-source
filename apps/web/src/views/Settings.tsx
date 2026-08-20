/**
 * Ajustes de la persona usuaria (§10.1, §10.2).
 * Toda la personalización es gratuita por definición: aquí no hay nada bloqueado
 * ni ningún aviso de "mejora tu plan".
 */
import { useEffect, useState } from "react";
import { DEFAULT_PROFILE_STYLE, type SelfUser } from "@distop/protocol";
import { ExternalLink, Pipette } from "lucide-react";
import { useStore, type BackdropChoice, type Density, type FontChoice, type ThemeChoice } from "../store.ts";
import { api } from "../lib/api.ts";
import { probeNetwork, setIceServers, setVideoMode } from "../lib/voice.ts";
import { LOCALES, LOCALE_LABELS } from "../i18n.ts";
import { Avatar, Button, ErrorNote, Field, ImageField, Modal, Toggle, useT, useErrorText } from "../components/ui.tsx";
import { WallpaperField, WallpaperPicker } from "../components/Wallpaper.tsx";
import { Gallery } from "../components/Gallery.tsx";
import { ProfileStyleEditor } from "../components/ProfileStyle.tsx";
import { askNotifyPermission, notifyPermission, type NotifyLevel } from "../lib/notify.ts";

/** Paleta de partida. Cualquier otro color sale del selector, sin cortapisas. */
const ACCENTS = ["#4059e0", "#7b5cff", "#c2389c", "#d94f43", "#e08c2f", "#2f9e6f", "#2f8fd6", "#5b6472"];

type Tab = "profile" | "appearance" | "alerts" | "voice" | "account";

export function Settings({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("profile");

  const tabs: Array<[Tab, string]> = [
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 rounded-[10px] border border-line p-3">
        <Avatar name={form.display_name || "?"} url={form.avatar_url || null} id={user?.id} size={52} profile={form.profile_style} />
        <div className="min-w-0">
          <p className="display truncate font-bold">{form.display_name}</p>
          <p className="truncate text-sm text-muted">{form.pronouns || `@${user?.username}`}</p>
        </div>
      </div>

      {/* Avatar y banner ARRIBA, y no al final tras el nombre y los pronombres:
          es lo primero que se viene a cambiar, y enterrados al pie no se
          encontraban. Tampoco se llaman ya "URL de...": el campo sube ficheros
          además de aceptar enlaces, y el nombre viejo hacía pensar lo contrario. */}
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

      <ImageField
        label={t("settings.banner")}
        hint={t("settings.bannerHint")}
        value={form.banner_url}
        onChange={(url) => setForm({ ...form, banner_url: url })}
        preview="wide"
      />

      {/* Dos galerías para el banner porque son dos cosas distintas: paisajes de
          Wallhaven, y arte animado de la galería de perfiles. */}
      <Expander label={t("settings.galleryBanner")}>
        <Gallery current={form.banner_url} onPick={(url) => setForm({ ...form, banner_url: url })} />
      </Expander>

      <WallpaperPicker current={form.banner_url} onPick={(url) => setForm({ ...form, banner_url: url })} />

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

      <ProfileStyleEditor
        value={form.profile_style}
        onChange={(patch) => setForm((prev) => ({ ...prev, profile_style: { ...prev.profile_style, ...patch } }))}
        name={form.display_name}
        avatarUrl={form.avatar_url}
        bannerUrl={form.banner_url}
        accent={form.accent_color}
        userId={user?.id}
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Button variant="primary" onClick={save} disabled={state === "saving"} className="self-start">
        {state === "saved" ? t("common.saved") : t("common.save")}
      </Button>
    </div>
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
  quality: "low" | "medium" | "high";
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
      setVideoMode(value.video, value.quality);
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

  if (denied) return <p className="text-sm text-muted">{t("voice.relayHostOnly")}</p>;
  if (!relay) return <p className="text-sm text-muted">{t("common.loading")}</p>;

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
    <div className="flex flex-col gap-4">
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

      {/* No es un límite comercial: es la subida de quien hospeda, que es finita
          y se multiplica por cada persona que mire. Quien la paga, la decide. */}
      <Field label={t("voice.quality")} hint={t("voice.qualityHint")}>
        {(id) => (
          <select
            id={id}
            className="field"
            value={relay.quality}
            disabled={relay.locked}
            onChange={(e) => void save({ quality: e.target.value as RelayState["quality"] })}
          >
            <option value="low">{t("voice.qualityLow")}</option>
            <option value="medium">{t("voice.qualityMedium")}</option>
            <option value="high">{t("voice.qualityHigh")}</option>
          </select>
        )}
      </Field>

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

  const [username, setUsername] = useState("");
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

      <DeleteAccount onDone={onClose} />
    </div>
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
