/**
 * Personalización del perfil: marco, placa, fuente, efectos y tema (§10.1).
 *
 * Todo el catálogo está aquí y todo es gratis. No hay "tus artículos" separado
 * de "la tienda", ni candados, ni un bloque de "mejora tu perfil": esa división
 * solo existe donde la personalización se vende, y aquí no se vende (§10, §29.6).
 *
 * En línea y no un diálogo por categoría: la pantalla de ajustes ya es un
 * diálogo, y anidar otro encima obliga a cerrar dos cosas para volver. Además
 * así se ve el efecto de cada opción sobre la vista previa sin abrir nada.
 */
import { Suspense, lazy, useState, useSyncExternalStore, type ReactNode } from "react";
import { ImagePlus, RotateCcw } from "lucide-react";
import {
  NAMEPLATES,
  NAME_EFFECTS,
  NAME_FONTS,
  PROFILE_EFFECTS,
  RINGS,
  type ProfileEffect,
  type ProfileStyle,
} from "@distop/protocol";
import type { MessageKey } from "../i18n.ts";
import { useStore } from "../store.ts";
import { Avatar, DisplayName, ImageField, useLocale, useT } from "./ui.tsx";

/**
 * El fondo de una tarjeta de perfil, en un solo sitio.
 * Lo usan la vista previa, la tarjeta de miembro y la barra de usuario: si cada
 * una lo compusiera por su cuenta, cambiar el orden de prioridad —foto, luego
 * degradado, luego acento— habría que acertarlo tres veces.
 */
export function cardBackground(style: ProfileStyle, accent: string | null, bannerUrl: string | null): string {
  const gradient = profileGradient(style, accent);
  if (!bannerUrl) return gradient;
  const a = style.theme_a ?? accent ?? "var(--accent)";
  const b = style.theme_b ?? accent ?? "var(--accent)";
  const center = `color-mix(in oklab, ${a} 50%, ${b})`;
  return `linear-gradient(${style.theme_angle}deg, color-mix(in srgb, ${a} 28%, transparent) 0%, color-mix(in srgb, ${center} 38%, transparent) ${style.theme_balance}%, color-mix(in srgb, ${b} 42%, transparent) 100%), center/cover no-repeat url(${JSON.stringify(bannerUrl)})`;
}

/** El gradiente base, compartido por portada, cuerpo y vista previa. */
export function profileGradient(style: ProfileStyle, accent: string | null): string {
  const a = style.theme_a ?? accent ?? "var(--accent)";
  const b = style.theme_b ?? accent ?? "var(--accent)";
  const center = `color-mix(in oklab, ${a} 50%, ${b})`;
  return `linear-gradient(${style.theme_angle}deg, ${a} 0%, ${center} ${style.theme_balance}%, ${b} 100%)`;
}

/** Gradiente oscurecido para que el texto siga siendo legible sobre cualquier color. */
export function profileSurfaceBackground(style: ProfileStyle, accent: string | null): string {
  return `linear-gradient(color-mix(in srgb, var(--surface) 62%, transparent), color-mix(in srgb, var(--surface) 76%, transparent)), ${profileGradient(style, accent)}`;
}

/* Los efectos que dibuja tsParticles en un canvas; el resto sigue siendo CSS
   puro. La división vive aquí y no en el protocolo porque es un detalle de
   CÓMO los pinta este cliente, no de qué ids existen. */
const PARTICLE_EFFECTS: ReadonlySet<string> = new Set(["snow", "fireworks", "bubbles"]);

/* lazy: engine y presets de tsParticles van en un chunk aparte que solo se
   descarga la primera vez que hay que pintar uno de estos efectos. */
const ParticleEffect = lazy(() => import("./ParticleEffect.tsx"));

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = matchMedia("(prefers-reduced-motion: reduce)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
}

/**
 * La capa decorativa de la tarjeta, en un solo sitio. Misma razón que
 * cardBackground: la usan la vista previa, la tarjeta de miembro, la barra de
 * usuario y las muestras del selector.
 */
export function CardEffectLayer({ effect, className }: { effect: ProfileEffect; className: string }) {
  /* A los efectos CSS los congela la regla global de reduced-motion; el canvas
     no lee CSS, así que las dos formas de pedir quietud se aplican aquí: sin
     movimiento, el canvas ni se monta. */
  const motion = useStore((s) => s.prefs.motion);
  const reduced = usePrefersReducedMotion();

  if (effect === "none") return null;
  if (PARTICLE_EFFECTS.has(effect)) {
    if (!motion || reduced) return null;
    return (
      <Suspense fallback={null}>
        <ParticleEffect effect={effect} className={`pfx-live ${className}`} />
      </Suspense>
    );
  }
  return <div className={`pfx pfx-${effect} ${className}`} aria-hidden />;
}

/**
 * La tarjeta de perfil grande, como la verán los demás (§10.1).
 * Es la protagonista del editor —estilo Discord: controles a un lado, tarjeta
 * viva al otro— y cada cambio de la izquierda se pinta aquí al instante.
 */
export function ProfileCardPreview({
  style,
  name,
  username,
  pronouns,
  bio,
  avatarUrl,
  bannerUrl,
  accent,
  userId,
  createdAt,
}: {
  style: ProfileStyle;
  name: string;
  username: string;
  pronouns: string;
  bio: string;
  avatarUrl: string;
  bannerUrl: string;
  accent: string;
  userId: string | undefined;
  createdAt: number | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  const since = createdAt
    ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(createdAt))
    : null;

  return (
    <div
      className="relative overflow-hidden rounded-[14px] border border-line shadow-[var(--shadow)]"
      style={{ background: profileSurfaceBackground(style, accent) }}
    >
      <div className="h-28 w-full" style={{ background: cardBackground(style, accent, bannerUrl || null) }} />

      <div className="-mt-12 px-4 pb-4">
        <div className="relative inline-block">
          <Avatar name={name || "?"} url={avatarUrl || null} id={userId} size={96} profile={style} cutout={6} />
          {/* El punto de presencia es parte de cómo te ven: la vista previa lo enseña. */}
          <span
            className="absolute right-1 bottom-1 block h-5 w-5 rounded-full border-[3px]"
            style={{ background: "var(--ok)", borderColor: "var(--surface)" }}
            aria-hidden
          />
        </div>

        <p className="mt-2 truncate text-xl font-bold">
          <DisplayName name={name || "?"} style={style} accent={null} />
        </p>
        <p className="truncate text-sm text-muted">
          @{username}
          {pronouns ? ` · ${pronouns}` : ""}
        </p>

        {bio ? <p className="mt-2 text-sm whitespace-pre-wrap">{bio}</p> : null}

        {since ? (
          <div className="mt-3 rounded-[10px] border border-line bg-surface/75 px-3 py-2 backdrop-blur-sm">
            <p className="text-[0.65rem] font-semibold tracking-wider text-muted uppercase">{t("profile.memberSince")}</p>
            <p className="text-sm font-medium">{since}</p>
          </div>
        ) : null}

        {/* Cómo se ve en la lista de miembros, que es donde vive la placa. */}
        <div
          className={`mt-2 flex items-center gap-2 rounded-[10px] border border-line bg-surface/75 px-2 py-1.5 backdrop-blur-sm plate plate-${style.nameplate}`}
        >
          <Avatar name={name || "?"} url={avatarUrl || null} id={userId} size={24} />
          <span className="truncate text-sm font-medium">
            <DisplayName name={name || "?"} style={style} accent={accent} />
          </span>
        </div>
      </div>

      {/* El efecto cubre la tarjeta ENTERA, no solo la portada. Va al final
          para pintarse encima del contenido; sus clases llevan
          pointer-events: none, así que nada de debajo pierde el clic. */}
      <CardEffectLayer effect={style.profile_effect} className="absolute inset-0" />
    </div>
  );
}

/* ── seletores por categoría, para el carril del editor ──────────────────
   Cada uno es una sección del editor estilo Discord. Todo el catálogo está en
   todos: no hay "tus artículos" contra "la tienda", ni candados (§10, §29.6). */

/**
 * Decoración del avatar: UN solo catálogo.
 * Los aros incluidos y la imagen propia son la misma decisión —qué adorna tu
 * avatar—, así que viven en la misma rejilla y se excluyen entre sí: el
 * componente Avatar pinta las dos capas a la vez, y apiladas son un borrón.
 */
export function AvatarDecoPicker({
  value,
  onChange,
  name,
  avatarUrl,
  userId,
}: {
  value: ProfileStyle;
  onChange: (patch: Partial<ProfileStyle>) => void;
  name: string;
  avatarUrl: string;
  userId: string | undefined;
}) {
  const t = useT();
  const custom = value.avatar_deco_url;
  /* El formulario de subida se abre desde su casilla de la rejilla; si ya hay
     una decoración propia puesta, se queda a la vista para poder cambiarla. */
  const [customOpen, setCustomOpen] = useState(false);

  return (
    <fieldset>
      <legend className="mb-1.5 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
        {t("profileStyle.deco")}
      </legend>
      {/* Rejilla y no fila con scroll: con 40 casillas y una sola visible a la
          vez, deslizar seria buscar a ciegas. */}
      <div className="grid max-h-56 grid-cols-5 gap-2 overflow-y-auto pb-1 sm:grid-cols-6">
        <button
          onClick={() => onChange({ avatar_ring: null, avatar_deco_url: null })}
          aria-pressed={!value.avatar_ring && !custom}
          title={t("style.none")}
          className={`grid aspect-square place-items-center rounded-[10px] border text-[0.6rem] text-muted transition-colors ${
            !value.avatar_ring && !custom ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
          }`}
        >
          {t("style.none")}
        </button>

        {/* Tu propia imagen es una casilla más del catálogo, no otra sección:
            decorar el avatar es una sola decisión. No viene ninguna incluida a
            propósito — repartir marcos exigiría repartir arte con licencia para
            ello, y el proyecto no distribuye ilustraciones ajenas (§24). */}
        <button
          onClick={() => setCustomOpen((v) => !v)}
          aria-pressed={Boolean(custom)}
          aria-expanded={customOpen || Boolean(custom)}
          title={t("profileStyle.ownDeco")}
          className={`grid aspect-square place-items-center rounded-[10px] border transition-colors ${
            custom ? "border-accent bg-accent-soft" : "border-dashed border-line text-muted hover:border-accent"
          }`}
        >
          {custom ? (
            <Avatar name={name || "?"} url={avatarUrl || null} id={userId} size={22} profile={{ ...value, avatar_ring: null }} />
          ) : (
            <ImagePlus size={15} aria-hidden />
          )}
          <span className="sr-only">{t("profileStyle.ownDeco")}</span>
        </button>

        {RINGS.map((aro) => (
          <button
            key={aro.id}
            onClick={() => onChange({ avatar_ring: aro.id, avatar_deco_url: null })}
            aria-pressed={value.avatar_ring === aro.id && !custom}
            title={aro.name}
            className={`grid aspect-square place-items-center rounded-[10px] border transition-colors ${
              value.avatar_ring === aro.id && !custom ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
            }`}
          >
            <Avatar
              name={name || "?"}
              url={avatarUrl || null}
              id={userId}
              size={22}
              profile={{ ...value, avatar_deco_url: null, avatar_ring: aro.id }}
            />
            <span className="sr-only">{aro.name}</span>
          </button>
        ))}
      </div>
      {/* Credito exigido por la CC BY 4.0 de estos aros: nada que pagar, pero
          si algo que citar — igual que las animaciones de Noto en el selector. */}
      <p className="mt-1.5 text-[0.65rem] text-muted">{t("profileStyle.ringsCredit")}</p>

      {customOpen || custom ? (
        <div className="mt-2">
          <ImageField
            label={t("profileStyle.ownDeco")}
            hint={t("profileStyle.ownDecoHint")}
            value={custom ?? ""}
            // Poner la propia quita el aro: son la misma capa, no dos.
            onChange={(url) => onChange({ avatar_deco_url: url || null, ...(url ? { avatar_ring: null } : {}) })}
            preview="round"
          />
        </div>
      ) : null}
    </fieldset>
  );
}

/** Placa del nombre en la lista de miembros. */
export function PlatePicker({ value, onChange }: { value: ProfileStyle; onChange: (patch: Partial<ProfileStyle>) => void }) {
  const t = useT();
  return (
    <Row
      label={t("profileStyle.plate")}
      options={NAMEPLATES}
      current={value.nameplate}
      onPick={(nameplate) => onChange({ nameplate })}
      render={(id) => <span className={`block h-7 w-14 rounded-md border border-line plate plate-${id}`} />}
    />
  );
}

/** Fuente, efecto y color del nombre visible. */
export function NameStylePicker({
  value,
  onChange,
  accent,
}: {
  value: ProfileStyle;
  onChange: (patch: Partial<ProfileStyle>) => void;
  accent: string;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3">
      <Row
        label={t("profileStyle.font")}
        options={NAME_FONTS}
        current={value.name_font}
        onPick={(name_font) => onChange({ name_font })}
        render={(id) => <span className={`text-base font-bold nfont-${id}`}>Ag</span>}
      />
      <Row
        label={t("profileStyle.effect")}
        options={NAME_EFFECTS}
        current={value.name_effect}
        onPick={(name_effect) => onChange({ name_effect })}
        render={(id) => (
          <span className="text-sm font-bold">
            <DisplayName name="Ag" style={{ ...value, name_effect: id }} accent={accent} />
          </span>
        )}
      />
      <ColorSlot
        label={t("profileStyle.nameColor")}
        value={value.name_color}
        fallback={accent}
        onChange={(name_color) => onChange({ name_color })}
      />
    </div>
  );
}

/** Efecto animado de la tarjeta entera. */
export function CardEffectPicker({
  value,
  onChange,
  accent,
}: {
  value: ProfileStyle;
  onChange: (patch: Partial<ProfileStyle>) => void;
  accent: string;
}) {
  const t = useT();
  return (
    <Row
      label={t("profileStyle.profileEffect")}
      options={PROFILE_EFFECTS}
      current={value.profile_effect}
      onPick={(profile_effect) => onChange({ profile_effect })}
      render={(id) => (
        <span
          className="relative block h-7 w-14 overflow-hidden rounded-md"
          style={{ background: cardBackground(value, accent, null) }}
        >
          <CardEffectLayer effect={id} className="absolute inset-0" />
        </span>
      )}
    />
  );
}

/** Los dos colores del tema, su dirección y su punto de mezcla. */
export function GradientControls({
  value,
  accent,
  onChange,
}: {
  value: ProfileStyle;
  accent: string;
  onChange: (patch: Partial<ProfileStyle>) => void;
}) {
  const t = useT();
  return (
    <fieldset className="flex flex-col gap-3 rounded-[10px] border border-line bg-sunken/40 p-3">
      <legend className="px-1 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
        {t("profileStyle.gradient")}
      </legend>
      <p className="text-xs text-muted">{t("profileStyle.gradientHint")}</p>
      <div
        className="h-16 rounded-[10px] border border-line"
        style={{ background: profileGradient(value, accent) }}
        aria-label={t("profileStyle.gradientPreview")}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <ColorSlot label={t("profileStyle.themeA")} value={value.theme_a} fallback={accent} onChange={(theme_a) => onChange({ theme_a })} />
        <ColorSlot label={t("profileStyle.themeB")} value={value.theme_b} fallback={accent} onChange={(theme_b) => onChange({ theme_b })} />
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
          {t("profileStyle.gradientAngle")}
          <output>{value.theme_angle}°</output>
        </span>
        <input
          type="range"
          min={0}
          max={360}
          step={1}
          value={value.theme_angle}
          onChange={(event) => onChange({ theme_angle: Number(event.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="flex items-center justify-between text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
          {t("profileStyle.gradientBalance")}
          <output>{value.theme_balance}%</output>
        </span>
        <input
          type="range"
          min={10}
          max={90}
          step={1}
          value={value.theme_balance}
          onChange={(event) => onChange({ theme_balance: Number(event.target.value) })}
          className="w-full accent-[var(--accent)]"
        />
      </label>
    </fieldset>
  );
}

/**
 * Una fila del catálogo. Genérica porque las cinco son la misma cosa —elegir
 * uno de una lista corta— y solo cambia con qué se dibuja cada opción.
 */
function Row<T extends string>({
  label,
  options,
  current,
  onPick,
  render,
}: {
  label: string;
  options: readonly T[];
  current: T;
  onPick: (value: T) => void;
  render: (value: T) => ReactNode;
}) {
  const t = useT();

  return (
    <fieldset>
      <legend className="mb-1.5 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">{label}</legend>
      {/* Scroll horizontal y no salto de línea: con siete opciones cabe casi
          siempre, y cuando no cabe se desliza en vez de estirar el diálogo. */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {options.map((id) => {
          const nombre = t(`style.${id}` as MessageKey);
          return (
            <button
              key={id}
              onClick={() => onPick(id)}
              aria-pressed={current === id}
              title={nombre}
              className={`grid h-14 w-16 shrink-0 place-items-center rounded-[10px] border transition-colors ${
                current === id ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
              }`}
            >
              {render(id)}
              <span className="sr-only">{nombre}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * Un color opcional: o eliges uno, o hereda el de acento.
 * El botón de deshacer es lo que hace "opcional" alcanzable — un `<input
 * type="color">` no tiene forma de volver a "sin elegir" por sí solo.
 */
function ColorSlot({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string;
  value: string | null;
  fallback: string;
  onChange: (value: string | null) => void;
}) {
  const t = useT();

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[0.7rem] font-semibold tracking-wider text-muted uppercase">{label}</span>
      <span className="flex items-center gap-1">
        <input
          type="color"
          className="field h-10 flex-1 p-1"
          value={value ?? fallback}
          onChange={(e) => onChange(e.target.value)}
        />
        {value ? (
          <button
            onClick={() => onChange(null)}
            aria-label={t("profileStyle.useAccent")}
            title={t("profileStyle.useAccent")}
            className="grid h-10 w-9 shrink-0 place-items-center rounded-[10px] border border-line text-muted hover:border-accent hover:text-ink"
          >
            <RotateCcw size={14} />
          </button>
        ) : null}
      </span>
    </label>
  );
}
