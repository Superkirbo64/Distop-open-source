/**
 * Ajustes de la persona usuaria (§10.1, §10.2).
 * Toda la personalización es gratuita por definición: aquí no hay nada bloqueado
 * ni ningún aviso de "mejora tu plan".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PROFILE_STYLE, type SelfUser } from "@distop/protocol";
import { ChevronDown } from "lucide-react";
import { useStore, type BackdropChoice, type Density, type FontChoice, type ThemeChoice } from "../store.ts";
import { api, setTokens, type Tokens } from "../lib/api.ts";
import { inputDevice, probeNetwork, retuneVideo, setIceServers, setInputDevice, setVideoMode, setVoiceMode } from "../lib/voice.ts";
import * as audio from "../lib/relay.ts";
import { LOCALES, LOCALE_LABELS } from "../i18n.ts";
import {
  Avatar,
  Button,
  ColorInput,
  DisplayName,
  ErrorNote,
  ExternalLinkButton,
  Field,
  ImageField,
  Modal,
  Range,
  Select,
  Toggle,
  useT,
  useErrorText,
  useLocale,
} from "../components/ui.tsx";
import { WallpaperField, WallpaperPicker } from "../components/Wallpaper.tsx";
import { Gallery } from "../components/Gallery.tsx";
import { CameraBackgroundSetup } from "../components/CameraBackground.tsx";
import {
  AvatarDecoPicker,
  CardEffectLayer,
  CardEffectPicker,
  GradientControls,
  NameStylePicker,
  ProfileCardPreview,
  profileGradient,
} from "../components/ProfileStyle.tsx";
import { askNotifyPermission, notifyPermission, type NotifyLevel } from "../lib/notify.ts";
import { activeAvailabilityWatch, setActiveAvailabilityWatch } from "../lib/instance.ts";
import { disablePush, enablePush, pushState, type PushFailure, type PushState } from "../lib/push.ts";
import { CLOUD_GUIDE_URL } from "../lib/publish.ts";

/** Paleta de partida. Cualquier otro color sale del selector, sin cortapisas. */
const ACCENTS = ["#4059e0", "#7b5cff", "#c2389c", "#d94f43", "#e08c2f", "#2f9e6f", "#2f8fd6", "#5b6472"];

export type SettingsTab = "profile" | "appearance" | "alerts" | "voice" | "account" | "app";

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
  // Ajustes del cascarón: solo existen dentro de la app de escritorio.
  if (window.distop) tabs.push(["app", t("settings.desktopApp")]);

  return (
    <Modal open={open} onClose={onClose} title={t("settings.title")} size="lg">
      <div className="grid min-w-0 gap-5 md:grid-cols-[10rem_1fr]">
        <nav className="min-w-0" aria-label={t("settings.title")}>
          <ul className="tabs-scroll flex max-w-full gap-1 overflow-x-auto md:flex-col">
            {tabs.map(([id, label]) => (
              <li key={id} className="shrink-0 md:w-full">
                <button
                  onClick={() => setTab(id)}
                  aria-current={tab === id ? "page" : undefined}
                  className={`w-full whitespace-nowrap rounded-[10px] px-3 py-2 text-left text-sm transition-colors ${
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
          {tab === "app" ? <DesktopTab /> : null}
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
                <ColorInput
                  id={id}
                  value={form.accent_color}
                  onChange={(accent_color) => setForm({ ...form, accent_color })}
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

        {/* Banner y placa son la misma imagen: la de la tarjeta y la de tu fila en
            la lista de miembros. Se elige una vez —galería, fondo o un archivo
            del ordenador— y vale para las dos; no hay un color de placa aparte. */}
        <EditorSection
          id="banner"
          current={section}
          onOpen={setSection}
          title={t("profile.bannerPlate")}
          preview={
            <span
              className="block h-7 w-12 rounded-md border border-line"
              style={{
                background: form.banner_url
                  ? `center/cover no-repeat url(${JSON.stringify(form.banner_url)})`
                  : profileGradient(style, form.accent_color),
              }}
            />
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
      <GameDetectionCheck />
    </section>
  );
}

/**
 * Ajustes del cascarón de escritorio: qué aplicaciones integradas existen y si
 * se vigila el juego abierto en este equipo. La autoridad es el proceso
 * principal: cada interruptor pinta lo que main confirma, no lo que se pidió.
 * Apagar WhatsApp/Telegram quita su pestaña y libera su proceso entero; la
 * sesión queda en el disco y reactivar no obliga a vincular de nuevo.
 */
function DesktopTab() {
  const t = useT();
  const appsBridge = window.distop?.apps;
  const gamesBridge = window.distop?.games;
  const [tabs, setTabs] = useState<{ whatsapp: boolean; telegram: boolean } | null>(null);
  const [gameWatch, setGameWatch] = useState<boolean | null>(null);

  useEffect(() => {
    void appsBridge?.prefs().then(setTabs).catch(() => undefined);
    void gamesBridge?.watch?.().then(setGameWatch).catch(() => undefined);
    // Los puentes viven en window y no cambian durante la sesión.
  }, [appsBridge, gamesBridge]);

  async function toggleApp(id: "whatsapp" | "telegram", enabled: boolean) {
    try {
      const next = await appsBridge!.set(id, enabled);
      if (next) setTabs(next);
    } catch {
      // main no confirmó: el interruptor se queda como estaba.
    }
  }

  async function toggleWatch(enabled: boolean) {
    try {
      setGameWatch(await gamesBridge!.setWatch!(enabled));
    } catch {
      // Ídem: sin confirmación no se pinta el cambio.
    }
  }

  return (
    <div className="space-y-4">
      {appsBridge ? (
        <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
          <div>
            <h3 className="text-sm font-semibold">{t("settings.desktopApps")}</h3>
            <p className="text-xs text-muted">{t("settings.desktopAppsHint")}</p>
          </div>
          {tabs ? (
            <>
              <Toggle checked={tabs.whatsapp} onChange={(v) => void toggleApp("whatsapp", v)} label={t("settings.desktopWhatsapp")} />
              <Toggle checked={tabs.telegram} onChange={(v) => void toggleApp("telegram", v)} label={t("settings.desktopTelegram")} />
            </>
          ) : null}
        </section>
      ) : null}
      {gamesBridge?.setWatch ? (
        <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
          <div>
            <h3 className="text-sm font-semibold">{t("settings.gameWatch")}</h3>
            <p className="text-xs text-muted">{t("settings.gameWatchHint")}</p>
          </div>
          {gameWatch !== null ? (
            <Toggle checked={gameWatch} onChange={(v) => void toggleWatch(v)} label={t("settings.gameWatchToggle")} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * "¿Por qué no detecta mi juego?", respondido dentro de la aplicación.
 *
 * Existe porque desde fuera todas las causas se ven iguales —una pantalla que no
 * dice nada—: puede ser que la detección solo corre en la app de escritorio, que
 * el juego no venga de Steam ni de Epic, o que `tasklist` no respondiera. El
 * botón da el veredicto en una frase en vez de mandar a nadie a un terminal.
 *
 * No enseña la lista de procesos, solo cuántos había: el recuento no delata a
 * qué juega nadie, y esa lista no sale del equipo ni para esto (§22).
 */
function GameDetectionCheck() {
  const t = useT();
  const bridge = window.distop?.games;
  const [veredicto, setVeredicto] = useState<string | null>(null);

  // En el navegador no hay nada que comprobar: no hay detección que arreglar.
  if (!bridge?.scan) return <p className="text-xs text-muted">{t("settings.gameOnlyDesktop")}</p>;

  async function comprobar() {
    const [juego, scan] = await Promise.all([bridge!.current(), bridge!.scan!()]);
    if (juego) return setVeredicto(t("settings.gameFound", { name: juego }));
    if (!scan) return setVeredicto(t("settings.gameNotScanned"));
    if (!scan.tasklist) return setVeredicto(t("settings.gameNoTasklist"));
    setVeredicto(t("settings.gameNothing", { processes: scan.processes, catalog: scan.catalog }));
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Button variant="ghost" onClick={() => void comprobar()}>
        {t("settings.gameCheck")}
      </Button>
      {veredicto ? <p className="text-xs text-muted">{veredicto}</p> : null}
    </div>
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
  const availability = activeAvailabilityWatch();
  const [watchEnabled, setWatchEnabled] = useState(availability.enabled);

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

      {availability.eligible ? (
        <Toggle
          checked={watchEnabled}
          onChange={(enabled) => { setActiveAvailabilityWatch(enabled); setWatchEnabled(enabled); }}
          label={t("settings.availabilityWatch")}
          hint={t("settings.availabilityWatchHint")}
        />
      ) : null}

      <PushToggle />
      <CalendarTokens />
    </div>
  );
}

/**
 * Agenda por suscripción `.ics` (V4).
 *
 * Sin OAuth y sin integración con nadie: un fichero que entienden Google
 * Calendar, Outlook, Apple, Thunderbird y cualquier otra cosa que respete el
 * RFC 5545, sin que este proyecto pida permisos a la agenda de nadie ni guarde
 * credenciales de terceros.
 *
 * Aquí el secreto SÍ va en la dirección, y es la única concesión de todo el
 * proyecto: un cliente de calendario solo sabe pedir una URL, no mandar
 * cabeceras. Se compensa con lo que sí está en nuestra mano — la dirección solo
 * lee reuniones, no abre sesión, se guarda en la instancia como hash, y se
 * anula en un clic.
 */
function CalendarTokens() {
  const t = useT();
  const locale = useLocale();
  const errorText = useErrorText();
  const [tokens, setTokens] = useState<Array<{ id: string; label: string | null; created_at: number; last_used: number | null; revoked_at: number | null }>>([]);
  const [reciente, setReciente] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  useEffect(() => {
    api<{ tokens: typeof tokens }>("GET", "/api/v1/calendars")
      .then((respuesta) => setTokens(respuesta.tokens))
      .catch(() => undefined);
  }, []);

  const crear = async () => {
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api<{ token: (typeof tokens)[number]; url: string }>("POST", "/api/v1/calendars", {});
      setTokens((previos) => [respuesta.token, ...previos]);
      setReciente(respuesta.url);
    } catch (fallo) {
      setError(errorText(fallo));
    } finally {
      setOcupado(false);
    }
  };

  const anular = async (id: string) => {
    setError(null);
    try {
      const respuesta = await api<{ tokens: typeof tokens }>("DELETE", `/api/v1/calendars/${id}`);
      setTokens(respuesta.tokens);
      setReciente(null);
    } catch (fallo) {
      setError(errorText(fallo));
    }
  };

  const vivos = tokens.filter((token) => token.revoked_at === null);

  return (
    <fieldset className="mt-4">
      <legend className="mb-1 text-sm font-medium">{t("meeting.calendar")}</legend>
      <p className="mb-2 text-xs text-muted">{t("meeting.calendarHint")}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {reciente ? (
        <div className="mb-2 rounded-[10px] border border-ok/40 p-2">
          <p className="mb-1 text-xs text-ok">{t("meeting.calendarOnce")}</p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={reciente}
              className="field min-w-0 flex-1 text-xs"
              onFocus={(event) => event.target.select()}
            />
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(reciente)}>
              {t("common.copy")}
            </Button>
          </div>
        </div>
      ) : null}

      {vivos.length === 0 ? (
        <p className="mb-2 text-xs text-muted">{t("meeting.calendarEmpty")}</p>
      ) : (
        <ul className="mb-2 flex flex-col gap-1">
          {vivos.map((token) => (
            <li key={token.id} className="flex items-center gap-2 rounded-[10px] border border-line px-2 py-1">
              <span className="min-w-0 flex-1 truncate text-sm">
                {token.label ?? new Date(token.created_at).toLocaleDateString(locale, { dateStyle: "medium" })}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {token.last_used === null
                  ? t("meeting.calendarNever")
                  : t("meeting.calendarUsed", {
                      when: new Date(token.last_used).toLocaleDateString(locale, { dateStyle: "short" }),
                    })}
              </span>
              <Button variant="ghost" className="h-7 px-2 text-xs" onClick={() => void anular(token.id)}>
                {t("meeting.inviteRevoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Button variant="ghost" disabled={ocupado} onClick={() => void crear()}>
        {t("meeting.calendarCreate")}
      </Button>
    </fieldset>
  );
}

/**
 * Avisos con la aplicación cerrada (A2).
 *
 * Solo aparece donde puede funcionar: en el navegador, y si la instancia tiene
 * una dirección pública por la que el servicio de push pueda llegar. En la
 * aplicación de escritorio no existe —Electron no trae servicio de push— y
 * ofrecerlo ahí sería prometer algo que nunca llegaría.
 *
 * La contrapartida se dice **antes** de activarlo, no después: aunque el
 * contenido va cifrado y no lleva ni nombres ni texto, el proveedor de push
 * del navegador ve el momento, la frecuencia y el tamaño.
 */
function PushToggle() {
  const t = useT();
  const [state, setState] = useState<PushState | null>(null);
  const [error, setError] = useState<PushFailure | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let vivo = true;
    void pushState().then((next) => { if (vivo) setState(next); });
    return () => { vivo = false; };
  }, []);

  if (!state?.supported || !state.available) return null;

  const cambiar = (enabled: boolean): void => {
    setWorking(true);
    setError(null);
    const accion = enabled ? enablePush() : disablePush().then(() => null);
    void accion
      .then((fallo) => {
        setError(fallo ?? null);
        return pushState();
      })
      .then(setState)
      .finally(() => setWorking(false));
  };

  const motivo: Record<PushFailure, string> = {
    unsupported: t("settings.pushUnsupported"),
    unavailable: t("settings.pushUnavailable"),
    denied: t("settings.pushDenied"),
    failed: t("settings.pushFailed"),
  };

  return (
    <div className="flex flex-col gap-2">
      <Toggle
        checked={state.enabled}
        disabled={working}
        onChange={cambiar}
        label={t("settings.push")}
        hint={t("settings.pushHint")}
      />
      <p className="text-xs text-muted">{t("settings.pushPrivacy")}</p>
      {error ? <p className="text-xs text-warn">{motivo[error]}</p> : null}
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
          <ColorInput
            value={prefs.accent || "#4059e0"}
            onChange={(value) => setPref("accent", value)}
            label={t("settings.accentCustom")}
            className="h-9 min-h-9 w-32 py-0"
          />
          {prefs.accent ? (
            <Button onClick={() => setPref("accent", "")} className="h-9 min-h-9 text-xs">
              {t("settings.reset")}
            </Button>
          ) : null}
        </div>
      </fieldset>

      <Field label={`${t("settings.corners")} — ${prefs.radius}px`}>
        {(id) => (
          <Range
            id={id}
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
          <Range
            id={id}
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
          <Select
            id={id}
            value={prefs.locale}
            options={LOCALES.map((locale) => ({ value: locale, label: LOCALE_LABELS[locale] }))}
            onChange={(value) => {
              localStorage.setItem("distop.locale", value);
              setPref("locale", value as (typeof LOCALES)[number]);
            }}
          />
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
          <Select
            id={id}
            value={quality}
            options={[
              { value: "low", label: t("voice.qualityLow") },
              { value: "medium", label: t("voice.qualityMedium") },
              { value: "high", label: t("voice.qualityHigh") },
            ]}
            onChange={(next) => {
              const value = next as audio.Quality;
              setQualityState(value);
              audio.setQuality(value);
              // Si hay cámara o pantalla encendida, el cambio entra ya.
              void retuneVideo();
            }}
          />
        )}
      </Field>

      <Field label={t("voice.priority")} hint={t("voice.priorityHint")}>
        {(id) => (
          <Select
            id={id}
            value={priority}
            options={[
              { value: "fluid", label: t("voice.priorityFluid") },
              { value: "balanced", label: t("voice.priorityBalanced") },
              { value: "sharp", label: t("voice.prioritySharp") },
            ]}
            onChange={(next) => {
              const value = next as audio.Priority;
              setPriorityState(value);
              audio.setPriority(value);
              void retuneVideo();
            }}
          />
        )}
      </Field>

      {/* El fondo va en esta misma pestaña y no en una propia: es otra decisión
          sobre la propia cámara, y aquí es donde se viene a mirar. */}
      <div className="border-t border-line pt-4">
        <CameraBackgroundSetup />
      </div>
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
/**
 * Elegir por dónde viaja algo: por el servidor o en directo.
 * Existe porque la voz y la imagen se eligen por separado y con las mismas
 * dos opciones; duplicar el bloque solo garantizaba que uno de los dos se
 * quedara sin arreglar el día que hubiera que tocarlo.
 */
function WayPicker({
  name,
  legend,
  value,
  labels,
  disabled,
  onPick,
}: {
  name: string;
  legend: string;
  value: "host" | "direct";
  labels: Record<"host" | "direct", { label: string; hint: string }>;
  disabled: boolean;
  onPick: (mode: "host" | "direct") => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2" disabled={disabled}>
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      {(["host", "direct"] as const).map((mode) => (
        <label
          key={mode}
          className={`flex cursor-pointer gap-3 rounded-card border p-3 transition-colors ${
            value === mode ? "border-accent bg-accent-soft" : "border-line hover:bg-raise"
          }`}
        >
          <input
            type="radio"
            name={name}
            checked={value === mode}
            onChange={() => onPick(mode)}
            className="mt-1 accent-[var(--accent)]"
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium">{labels[mode].label}</span>
            <span className="block text-xs text-muted">{labels[mode].hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

interface RelayState {
  mode: "direct" | "custom" | "cloudflare" | "metered";
  video: "host" | "direct";
  /** Por dónde va la voz. Se elige aparte del vídeo porque no cuestan lo mismo. */
  voice: "host" | "direct";
  url: string;
  username: string;
  keyId: string;
  appName: string;
  /** Fijado por el entorno (ICE_SERVERS o TURN_URL/TURN_SECRET): manda eso y desde aquí no se cambia. */
  locked: boolean;
  /** Las credenciales TURN rotan solas (use-auth-secret). El secreto jamás viaja de vuelta. */
  ephemeral: boolean;
}

type Probe = { host: boolean; stun: boolean; relay: boolean } | "running" | null;

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
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Select
                  id={id}
                  className="w-full min-w-0 flex-1"
                  value={mic}
                  searchable
                  options={[
                    { value: "", label: t("voice.deviceDefault") },
                    ...inputs
                      .filter((device) => Boolean(device.deviceId))
                      .map((device, index) => ({ value: device.deviceId, label: name(device, index, "voice.deviceUnnamed") })),
                  ]}
                  onChange={(value) => {
                    setMic(value);
                    void setInputDevice(value);
                    // Si la prueba está en marcha, sigue con el aparato nuevo:
                    // es justo lo que se quiere comprobar al cambiarlo.
                    if (testRef.current) void startTest(value);
                  }}
                />
                {unnamed ? (
                  <Button className="w-full sm:w-auto" variant="ghost" onClick={() => void reveal()}>
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
              <Range
                id={id}
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
              <Select
                id={id}
                value={out}
                disabled={!audio.canPickOutput()}
                searchable
                options={[
                  { value: "", label: t("voice.deviceDefault") },
                  ...outputs
                    .filter((device) => Boolean(device.deviceId))
                    .map((device, index) => ({ value: device.deviceId, label: name(device, index, "voice.deviceUnnamedOut") })),
                ]}
                onChange={(value) => {
                  setOut(value);
                  void audio.setOutputDevice(value);
                }}
              />
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
          <Range
            id={id}
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
    secret: "",
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
  /* La variante del TURN propio: credencial fija o secreto compartido. Sale de
     `ephemeral` al cargar; un servidor viejo que no mande el campo cae en
     estático, que era el único comportamiento que existía. */
  const [customKind, setCustomKind] = useState<"static" | "ephemeral">("static");

  useEffect(() => {
    api<RelayState>("GET", "/api/v1/instance/relay")
      .then((value) => {
        setRelayState(value);
        setElegido(value.mode);
        setCustomKind(value.ephemeral ? "ephemeral" : "static");
        setDraft({
          url: value.url,
          username: value.username,
          credential: "",
          secret: "",
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
      secret?: string;
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
      setVoiceMode(value.voice);
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

      {/* La voz primero: es lo que decide si esta instancia puede vivir en una
          máquina pequeña. Y el vídeo después, porque decide si hace falta algo
          de todo lo que viene debajo. */}
      <WayPicker
        name="voice-way"
        legend={t("voice.voiceWay")}
        value={relay.voice}
        disabled={relay.locked}
        labels={{
          host: { label: t("voice.voiceHost"), hint: t("voice.voiceHostHint") },
          direct: { label: t("voice.voiceP2p"), hint: t("voice.voiceP2pHint") },
        }}
        onPick={(mode) => void save({ voice: mode })}
      />

      <WayPicker
        name="video-way"
        legend={t("voice.videoWay")}
        value={relay.video}
        disabled={relay.locked}
        labels={{
          host: { label: t("voice.videoHost"), hint: t("voice.videoHostHint") },
          direct: { label: t("voice.videoP2p"), hint: t("voice.videoP2pHint") },
        }}
        onPick={(mode) => void save({ video: mode })}
      />

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

          {relay.locked ? (
            <p className="text-sm text-muted">
              {t("voice.relayLocked")}
              {/* Con TURN_URL/TURN_SECRET del entorno las credenciales además
                  rotan solas: se dice, porque es lo único visible desde aquí. */}
              {relay.ephemeral ? ` ${t("voice.relayEphemeralActive")}` : ""}
            </p>
          ) : null}

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
              <ExternalLinkButton href="https://dashboard.metered.ca/signup?tool=turnserver">{t("voice.relayMetOpen")}</ExternalLinkButton>
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
              <ExternalLinkButton href="https://dash.cloudflare.com/?to=/:account/calls">{t("voice.relayCfOpen")}</ExternalLinkButton>
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
                /* Estático manda `secret: ""` a propósito: un secreto guardado
                   gana siempre sobre usuario y contraseña en el servidor, así
                   que cambiar de variante tiene que borrarlo o el formulario
                   estático guardaría credenciales que nunca se usarían.
                   En efímero, el secreto solo viaja si se escribió uno nuevo:
                   el campo nunca viene prellenado y mandar vacío lo borraría. */
                void save(
                  customKind === "ephemeral"
                    ? { mode: "custom", url: draft.url, ...(draft.secret ? { secret: draft.secret } : {}) }
                    : { mode: "custom", url: draft.url, username: draft.username, credential: draft.credential, secret: "" },
                );
              }}
            >
              <fieldset className="flex flex-col gap-2">
                <legend className="sr-only">{t("voice.relayCustom")}</legend>
                {(
                  [
                    ["static", t("voice.relayCustomStatic"), t("voice.relayCustomStaticHint")],
                    ["ephemeral", t("voice.relayEphemeral"), t("voice.relayEphemeralHint")],
                  ] as const
                ).map(([kind, label, hint]) => (
                  <label
                    key={kind}
                    className={`flex cursor-pointer gap-3 rounded-card border p-3 transition-colors ${
                      customKind === kind ? "border-accent bg-accent-soft" : "border-line hover:bg-raise"
                    }`}
                  >
                    <input
                      type="radio"
                      name="custom-kind"
                      checked={customKind === kind}
                      onChange={() => {
                        setCustomKind(kind);
                        setError("");
                      }}
                      className="mt-1 accent-[var(--accent)]"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{label}</span>
                      <span className="block text-xs text-muted">{hint}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {customKind === "static" ? (
                <>
                  <p className="text-xs text-muted">{t("voice.relayHelp")}</p>
                  <ExternalLinkButton href="https://www.expressturn.com/#signup">{t("voice.relayCustomOpen")}</ExternalLinkButton>
                </>
              ) : (
                <>
                  {/* El estado guardado, sin enseñar jamás el secreto: si rota, rota. */}
                  {relay.ephemeral ? <p className="text-xs text-ok">{t("voice.relayEphemeralActive")}</p> : null}
                  <ExternalLinkButton href={CLOUD_GUIDE_URL}>{t("voice.relayEphemeralOpen")}</ExternalLinkButton>
                </>
              )}

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

              {customKind === "static" ? (
                <>
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
                </>
              ) : (
                <Field label={t("voice.relaySecret")} hint={t("voice.relaySecretHint")}>
                  {(id) => (
                    <input
                      id={id}
                      type="password"
                      autoComplete="off"
                      className="field"
                      value={draft.secret}
                      onChange={(e) => setDraft({ ...draft, secret: e.target.value })}
                    />
                  )}
                </Field>
              )}

              <Button
                type="submit"
                variant="primary"
                className="self-start"
                /* El servidor rechaza secretos de menos de 16; con la rotación ya
                   activa se permite guardar sin secreto (cambiar solo la URL). */
                disabled={customKind === "ephemeral" && (draft.secret ? draft.secret.length < 16 : !relay.ephemeral)}
              >
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
