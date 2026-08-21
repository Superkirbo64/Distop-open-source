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
import type { ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import {
  NAMEPLATES,
  NAME_EFFECTS,
  NAME_FONTS,
  PROFILE_EFFECTS,
  RINGS,
  type ProfileStyle,
} from "@distop/protocol";
import type { MessageKey } from "../i18n.ts";
import { Avatar, DisplayName, ImageField, useT } from "./ui.tsx";

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

/** Clase del efecto de tarjeta, o cadena vacía. Misma razón que cardBackground. */
export function effectClass(style: ProfileStyle): string {
  return style.profile_effect === "none" ? "" : `pfx pfx-${style.profile_effect}`;
}

export function ProfileStyleEditor({
  value,
  onChange,
  name,
  avatarUrl,
  bannerUrl,
  accent,
  userId,
}: {
  value: ProfileStyle;
  onChange: (patch: Partial<ProfileStyle>) => void;
  name: string;
  avatarUrl: string;
  bannerUrl: string;
  accent: string;
  userId: string | undefined;
}) {
  const t = useT();

  return (
    <section className="flex flex-col gap-4 rounded-[10px] border border-line p-3">
      <div>
        <h3 className="display text-sm font-bold">{t("profileStyle.title")}</h3>
        <p className="mt-0.5 text-xs text-muted">{t("profileStyle.hint")}</p>
      </div>

      {/* Vista previa arriba del todo: cada fila de abajo cambia esto en directo,
          que es lo que evita ir probando a ciegas y guardar para ver el resultado. */}
      <div
        className="overflow-hidden rounded-[10px] border border-line"
        style={{ background: profileSurfaceBackground(value, accent) }}
      >
        <div className="h-24 w-full" style={{ background: cardBackground(value, accent, bannerUrl || null) }}>
          <div className={`h-full w-full ${effectClass(value)}`} />
        </div>
        <div className="-mt-10 px-4 pb-4">
          <Avatar name={name || "?"} url={avatarUrl || null} id={userId} size={80} profile={value} cutout={5} />
          <p className="mt-2 truncate text-lg font-bold">
            <DisplayName name={name || "?"} style={value} accent={null} />
          </p>
          {/* Cómo se ve en la lista de miembros, que es donde vive la placa. */}
          <div className={`mt-2 flex items-center gap-2 rounded-[10px] border border-line bg-surface/75 px-2 py-1.5 backdrop-blur-sm plate plate-${value.nameplate}`}>
            <Avatar name={name || "?"} url={avatarUrl || null} id={userId} size={24} />
            <span className="truncate text-sm font-medium">
              <DisplayName name={name || "?"} style={value} accent={accent} />
            </span>
          </div>
        </div>
      </div>

      {/* Aros incluidos. Rejilla y no fila con scroll como las demas: con 39 y
          uno solo visible a la vez, deslizar seria buscar a ciegas. */}
      <fieldset>
        <legend className="mb-1.5 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
          {t("profileStyle.rings")}
        </legend>
        <div className="grid max-h-56 grid-cols-6 gap-2 overflow-y-auto pb-1 sm:grid-cols-8">
          <button
            onClick={() => onChange({ avatar_ring: null })}
            aria-pressed={!value.avatar_ring}
            title={t("style.none")}
            className={`grid aspect-square place-items-center rounded-[10px] border text-[0.6rem] text-muted transition-colors ${
              !value.avatar_ring ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
            }`}
          >
            {t("style.none")}
          </button>
          {RINGS.map((aro) => (
            <button
              key={aro.id}
              onClick={() => onChange({ avatar_ring: aro.id })}
              aria-pressed={value.avatar_ring === aro.id}
              title={aro.name}
              className={`grid aspect-square place-items-center rounded-[10px] border transition-colors ${
                value.avatar_ring === aro.id ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
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
      </fieldset>

      {/* Decoracion propia. Aqui no viene ninguna incluida a proposito: repartir
          marcos exigiria repartir arte con licencia para ello, y el proyecto no
          distribuye ilustraciones que no sean suyas (§24). La pone quien la usa,
          y entonces no hay lista de 65 sino las que quiera. */}
      <ImageField
        label={t("profileStyle.ownDeco")}
        hint={t("profileStyle.ownDecoHint")}
        value={value.avatar_deco_url ?? ""}
        onChange={(url) => onChange({ avatar_deco_url: url || null })}
        preview="round"
      />

      <Row
        label={t("profileStyle.plate")}
        options={NAMEPLATES}
        current={value.nameplate}
        onPick={(nameplate) => onChange({ nameplate })}
        render={(id) => <span className={`block h-7 w-14 rounded-md border border-line plate plate-${id}`} />}
      />

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

      <Row
        label={t("profileStyle.profileEffect")}
        options={PROFILE_EFFECTS}
        current={value.profile_effect}
        onPick={(profile_effect) => onChange({ profile_effect })}
        render={(id) => (
          <span
            className={`block h-7 w-14 rounded-md ${id === "none" ? "" : `pfx pfx-${id}`}`}
            style={{ background: cardBackground(value, accent, null) }}
          />
        )}
      />

      <div className="grid gap-3 sm:grid-cols-1">
        <ColorSlot label={t("profileStyle.nameColor")} value={value.name_color} fallback={accent} onChange={(name_color) => onChange({ name_color })} />
      </div>

      <GradientControls value={value} accent={accent} onChange={onChange} />
    </section>
  );
}

function GradientControls({
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
