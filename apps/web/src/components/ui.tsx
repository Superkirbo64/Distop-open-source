/**
 * Piezas de interfaz compartidas.
 * Los diálogos usan <dialog> nativo: trampa de foco, Escape y fondo modal ya
 * vienen resueltos por el navegador, sin librería de por medio.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ExternalLink, Image as ImageIcon, Pipette, Search } from "lucide-react";
import { RINGS, type ProfileStyle } from "@distop/protocol";
import { translate, type MessageKey } from "../i18n.ts";
import { useStore } from "../store.ts";
import { RequestError, upload } from "../lib/api.ts";
import { playUi } from "../lib/notify.ts";

export function useT() {
  const locale = useStore((s) => s.prefs.locale);
  // El diccionario llega en diferido: el contador cambia al aterrizar el chunk
  // y fuerza un `t` nuevo, que repinta los textos que salieron en español.
  const epoch = useStore((s) => s.localeEpoch);
  return useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) =>
      translate(locale, key, vars),
    [locale, epoch],
  );
}

export function useLocale() {
  return useStore((s) => s.prefs.locale);
}

/**
 * Traduce cualquier fallo a algo que sirva para actuar.
 * La instancia manda errores con mensaje propio y ya redactado: ese se muestra
 * tal cual. Lo que no viene de ella (red caída, proxy o túnel de por medio) se
 * nombra como lo que es, en vez de soltar el "Internal Server Error" del proxy.
 */
export function useErrorText() {
  const t = useT();
  return useCallback(
    (err: unknown): string => {
      if (!(err instanceof RequestError)) return t("error.generic");
      if (err.code === "NETWORK") return t("error.network");
      if (err.code === "INSTANCE_UNREACHABLE")
        return t("error.unreachable", { status: err.status });
      return err.message;
    },
    [t],
  );
}

/* ── botones y campos ──────────────────────────────────────────────── */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

export function Button({
  variant = "ghost",
  className = "",
  ...props
}: ButtonProps) {
  return <button {...props} className={`btn btn-${variant} ${className}`} />;
}

/**
 * Enlace externo con aspecto de botón y el icono de "sale de aquí".
 * Nació en Ajustes para llevar a la página donde se saca cada credencial —sin
 * esto hay que salir a buscar a mano en qué rincón del panel del proveedor
 * está la clave, que es justo donde la gente abandona— y ahora también lo usan
 * las guías de la nube y de copias, así que vive aquí.
 */
export function ExternalLinkButton({ href, children }: { href: string; children: string }) {
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
 * La burbuja de un tooltip, sola: separada de `Tooltip` para que
 * `IconButton` pueda montarla sin envolverse dos veces en su propio grupo.
 * `pointer-events-none` porque es texto de apoyo, no algo que se pueda pulsar.
 */
function TooltipBubble({ label }: { label: string }) {
  return (
    <span
      role="tooltip"
      // Debajo del disparador, no encima: la mayoría de los botones-icono de
      // esta app viven en una barra superior (cabecera de canal, de reunión),
      // y un tooltip hacia arriba ahí se corta contra el borde de la ventana
      // — se vio literalmente así al medirlo con una captura real.
      className="pointer-events-none absolute top-full left-1/2 z-50 mt-1.5 -translate-x-1/2 -translate-y-1 scale-95 whitespace-nowrap rounded-md bg-ink px-2 py-1 text-[0.7rem] font-medium text-bg opacity-0 shadow-[var(--shadow)] transition-all duration-150 group-hover/tt:translate-y-0 group-hover/tt:scale-100 group-hover/tt:opacity-100 group-focus-visible/tt:translate-y-0 group-focus-visible/tt:scale-100 group-focus-visible/tt:opacity-100"
    >
      {label}
    </span>
  );
}

/**
 * Tooltip propio en vez del `title` del navegador: mismo texto, pero con la
 * tipografía y el color de la aplicación, y sin el retraso ni el estilo que
 * pone cada sistema operativo. Para envolver cualquier botón-icono, no solo
 * `IconButton` — el botón grande de "Empezar" reducido a icono también lo usa.
 */
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <TooltipBubble label={label} />
    </span>
  );
}

/**
 * Botón sólo-icono: sigue necesitando nombre accesible, por eso `label` es
 * obligatorio. `tooltip={false}` quita solo la burbuja, nunca el `aria-label`:
 * hay sitios donde el icono ya se entiende solo y el cartelito estorba (la
 * barra de escribir), pero un lector de pantalla sigue necesitando el nombre.
 */
export function IconButton({
  label,
  children,
  className = "",
  pressed,
  tooltip = true,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
  pressed?: boolean;
  tooltip?: boolean;
}) {
  return (
    <span className="group/tt relative inline-flex">
      <button
        {...props}
        aria-label={label}
        // Un interruptor tiene que decir en qué posición está, no solo qué hace.
        {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
        // Se centra con flex y no con `place-items`: quien use este botón puede
        // cambiarle el display desde className (`wide:inline-flex`, por ejemplo), y
        // en flex `justify-items` no hace nada — el icono se quedaba pegado al
        // borde izquierdo. `items-center justify-center` centra en los dos casos.
        className={`icon-btn flex h-9 w-9 items-center justify-center rounded-[10px] ${
          pressed
            ? "bg-accent-soft text-accent"
            : "text-muted hover:bg-raise hover:text-ink"
        } ${className}`}
      >
        {children}
      </button>
      {tooltip ? <TooltipBubble label={label} /> : null}
    </span>
  );
}

/**
 * Imagen que sale del equipo de quien la pone, no de una URL que hay que buscar
 * por ahí (§10).
 * Sube el archivo a la propia instancia y devuelve su dirección. El campo de
 * texto sigue debajo porque pegar un enlace externo también vale —un GIF alojado
 * fuera no ocupa disco del anfitrión— pero deja de ser la única forma.
 */
export function ImageField({
  label,
  hint,
  value,
  onChange,
  preview = "square",
}: {
  label: string;
  hint?: string | undefined;
  value: string;
  onChange: (url: string) => void;
  preview?: "square" | "wide" | "round";
}) {
  const t = useT();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = await upload(file);
      onChange(uploaded.url);
    } catch (err) {
      // El límite de tamaño y los tipos permitidos los pone la instancia: su
      // mensaje ya dice cuál es, así que se enseña tal cual.
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  const shape =
    preview === "round"
      ? "h-16 w-16 rounded-full"
      : preview === "wide"
        ? "h-16 w-28 rounded-[10px]"
        : "h-16 w-16 rounded-[10px]";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>

      <div className="flex items-center gap-3">
        <span
          className={`grid shrink-0 place-items-center overflow-hidden border border-line bg-sunken ${shape}`}
        >
          {value ? (
            <img src={value} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon size={18} className="text-muted" />
          )}
        </span>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex gap-1.5">
            <Button onClick={() => input.current?.click()} disabled={busy}>
              {busy ? t("common.uploading") : t("common.chooseFile")}
            </Button>
            {value ? (
              <Button onClick={() => onChange("")}>{t("common.remove")}</Button>
            ) : null}
          </div>
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(event) => void pick(event.target.files?.[0])}
      />

      <input
        className="field text-xs"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("common.orPasteUrl")}
        inputMode="url"
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-ink">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  keywords?: string;
}

/**
 * Selector dibujado por Distop, no por Windows/macOS.
 * Usa semántica de listbox, teclado completo y portal para no quedar recortado
 * dentro de un modal, un panel con scroll o un menú pegado al borde.
 */
export function Select({
  id,
  value,
  options,
  onChange,
  disabled = false,
  placeholder,
  searchable = false,
  compact = false,
  className = "",
  label,
}: {
  id?: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  searchable?: boolean;
  compact?: boolean;
  className?: string;
  /** Nombre accesible cuando el selector no está dentro de Field. */
  label?: string;
}) {
  const t = useT();
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const listId = `${controlId}-listbox`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);

  const selected = options.find((option) => option.value === value);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = normalizedQuery
    ? options.filter((option) => `${option.label} ${option.keywords ?? ""}`.toLocaleLowerCase().includes(normalizedQuery))
    : options;
  const enabled = filtered.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled);

  const place = useCallback(() => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor) return;
    const dialog = trigger.current?.closest("dialog");
    const boundary = dialog?.getBoundingClientRect() ?? {
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      left: 0,
    };
    const margin = 8;
    const gap = 6;
    const width = Math.min(Math.max(anchor.width, 220), boundary.right - boundary.left - margin * 2);
    const left = Math.min(Math.max(boundary.left + margin, anchor.left), boundary.right - width - margin);
    const below = boundary.bottom - anchor.bottom - gap - margin;
    const above = anchor.top - boundary.top - gap - margin;
    const opensAbove = below < 190 && above > below;
    setPosition({
      left,
      width,
      ...(opensAbove ? { bottom: window.innerHeight - anchor.top + gap } : { top: anchor.bottom + gap }),
      maxHeight: Math.max(120, Math.min(320, opensAbove ? above : below)),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const selectedIndex = Math.max(0, filtered.findIndex((option) => option.value === value && !option.disabled));
    setActive(selectedIndex);
    const frame = requestAnimationFrame(() => {
      if (!searchable && options.length < 8) popup.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, options.length, place, searchable, value]);

  useEffect(() => {
    if (!open) return;
    const closeAway = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    const reposition = () => place();
    document.addEventListener("mousedown", closeAway);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      document.removeEventListener("mousedown", closeAway);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, place]);

  function move(direction: 1 | -1): void {
    if (enabled.length === 0) return;
    const current = enabled.findIndex(({ index }) => index === active);
    const next = enabled[(current + direction + enabled.length) % enabled.length] ?? enabled[0]!;
    setActive(next.index);
    document.getElementById(`${listId}-${next.index}`)?.scrollIntoView({ block: "nearest" });
  }

  function choose(option: SelectOption): void {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => trigger.current?.focus());
  }

  const portalRoot = trigger.current?.closest("dialog") ?? document.body;
  const listbox = open && position ? createPortal(
    <div
      ref={popup}
      id={listId}
      role="listbox"
      tabIndex={-1}
      aria-label={label}
      aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
      className="select-popover card fixed z-[1100] flex flex-col overflow-hidden p-1 text-sm"
      style={{
        left: position.left,
        width: position.width,
        top: position.top,
        bottom: position.bottom,
        maxHeight: position.maxHeight,
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          trigger.current?.focus();
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        } else if (event.key === "Home" && enabled[0]) {
          event.preventDefault();
          setActive(enabled[0].index);
        } else if (event.key === "End" && enabled.at(-1)) {
          event.preventDefault();
          setActive(enabled.at(-1)!.index);
        } else if ((event.key === "Enter" || event.key === " ") && filtered[active]) {
          event.preventDefault();
          choose(filtered[active]!);
        }
      }}
    >
      {searchable || options.length >= 8 ? (
        <div className="relative m-1 mb-2 shrink-0">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted" />
          <input
            className="field h-9 min-h-9 py-1 pr-2 pl-8 text-xs"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                move(event.key === "ArrowDown" ? 1 : -1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setOpen(false);
                trigger.current?.focus();
              }
            }}
            placeholder={t("common.search")}
            aria-label={t("common.search")}
            autoFocus
          />
        </div>
      ) : null}
      <div className="min-h-0 overflow-y-auto">
        {filtered.map((option, index) => (
          <button
            key={option.value}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={option.value === value}
            disabled={option.disabled}
            className={`select-option flex w-full items-center gap-3 rounded-[9px] px-3 py-2 text-left transition-colors ${
              index === active ? "bg-raise" : "hover:bg-raise"
            } ${option.disabled ? "opacity-45" : ""}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => choose(option)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{option.label}</span>
              {option.description ? <span className="block truncate text-xs text-muted">{option.description}</span> : null}
            </span>
            {option.value === value ? <Check size={16} className="shrink-0 text-accent" aria-hidden /> : null}
          </button>
        ))}
        {filtered.length === 0 ? <p className="px-3 py-5 text-center text-xs text-muted">{t("common.none")}</p> : null}
      </div>
    </div>,
    portalRoot,
  ) : null;

  return (
    <>
      <button
        ref={trigger}
        id={controlId}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        className={`select-trigger field flex items-center gap-3 text-left ${compact ? "h-9 min-h-9 py-1 text-sm" : ""} ${className}`}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-ink" : "text-muted"}`}>
          {selected?.label ?? placeholder ?? t("common.none")}
        </span>
        <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {listbox}
    </>
  );
}

/**
 * Tabla arcoíris de la aplicación: familias por fila y claridades por columna,
 * como una paleta de dibujo. El HEX sigue aceptando cualquier color exacto.
 */
const PALETTE = [
  ["#ffffff", "#c9ced9", "#8b93a5", "#4a5162", "#272c38", "#000000"],
  ["#ffb3b3", "#f87171", "#ef4444", "#c62c2c", "#8f1d1d", "#5c0f0f"],
  ["#ffd8a8", "#fbbf24", "#f59e0b", "#c47a06", "#8a5504", "#573403"],
  ["#bbf7d0", "#4ade80", "#22c55e", "#16a34a", "#116b33", "#0a441f"],
  ["#a5f3fc", "#38bdf8", "#0ea5e9", "#0b7fb4", "#075a80", "#04384f"],
  ["#c7d2fe", "#818cf8", "#6366f1", "#4a4dc4", "#33358a", "#1f2054"],
  ["#f5d0fe", "#e879f9", "#c026d3", "#941da3", "#6b1576", "#440d4b"],
];

/** La gota del sistema. Es de Chromium, así que en el escritorio siempre está. */
interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}

interface HsvColor {
  h: number;
  s: number;
  v: number;
}

function hexToHsv(hex: string): HsvColor {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  const raw = Number.parseInt(match?.[1] ?? "000000", 16);
  const r = ((raw >> 16) & 255) / 255;
  const g = ((raw >> 8) & 255) / 255;
  const b = (raw & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let h = 0;
  if (delta) {
    if (max === r) h = 60 * (((g - b) / delta) % 6);
    else if (max === g) h = 60 * ((b - r) / delta + 2);
    else h = 60 * ((r - g) / delta + 4);
  }
  return { h: (h + 360) % 360, s: max ? delta / max : 0, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    h < 60 ? [c, x, 0]
      : h < 120 ? [x, c, 0]
        : h < 180 ? [0, c, x]
          : h < 240 ? [0, x, c]
            : h < 300 ? [x, 0, c]
              : [c, 0, x];
  const channel = (value: number) => Math.round((value + m) * 255).toString(16).padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/** Selector continuo del anexo: plano de saturación/claridad y tono arcoíris. */
function ColorSpectrum({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const t = useT();
  const hsv = hexToHsv(value);
  const [hue, setHue] = useState(hsv.h);

  useEffect(() => {
    // En negro/gris no existe un tono matemático: conservar el último permite
    // mover el carril y después sacar color desde el cuadro, como en el anexo.
    if (hsv.s > 0) setHue(hsv.h);
  }, [hsv.h, hsv.s]);

  const setPlane = (element: HTMLDivElement, clientX: number, clientY: number): void => {
    const rect = element.getBoundingClientRect();
    const saturation = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const brightness = Math.min(1, Math.max(0, 1 - (clientY - rect.top) / rect.height));
    onChange(hsvToHex(hue, saturation, brightness));
  };

  const nudge = (ds: number, dv: number): void => {
    onChange(hsvToHex(hue, Math.min(1, Math.max(0, hsv.s + ds)), Math.min(1, Math.max(0, hsv.v + dv))));
  };

  return (
    <div className="mt-1 flex flex-col gap-2 border-t border-line pt-2">
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${t("common.saturation")} / ${t("common.lightness")}`}
        aria-valuetext={`${Math.round(hsv.s * 100)}% / ${Math.round(hsv.v * 100)}%`}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          setPlane(event.currentTarget, event.clientX, event.clientY);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            setPlane(event.currentTarget, event.clientX, event.clientY);
        }}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 0.1 : 0.02;
          if (event.key === "ArrowLeft") nudge(-step, 0);
          else if (event.key === "ArrowRight") nudge(step, 0);
          else if (event.key === "ArrowUp") nudge(0, step);
          else if (event.key === "ArrowDown") nudge(0, -step);
          else return;
          event.preventDefault();
        }}
        className="relative h-32 w-full cursor-crosshair overflow-hidden rounded-[7px] border border-line outline-none focus-visible:ring-2 focus-visible:ring-accent"
        style={{
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hue} 100% 50%))`,
        }}
      >
        <span
          aria-hidden
          className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_#111]"
          style={{
            left: `${Math.min(97, Math.max(3, hsv.s * 100))}%`,
            top: `${Math.min(96, Math.max(4, (1 - hsv.v) * 100))}%`,
          }}
        />
      </div>
      <Range
        aria-label={t("common.hue")}
        min={0}
        max={359}
        value={Math.round(hue)}
        onChange={(event) => {
          const next = Number(event.target.value);
          setHue(next);
          onChange(hsvToHex(next, hsv.s, hsv.v));
        }}
        style={
          {
            "--range-track": "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)",
            "--range-thumb": `hsl(${hue} 100% 50%)`,
          } as CSSProperties
        }
      />
    </div>
  );
}

export function ColorInput({
  id,
  value,
  onChange,
  className = "",
  label,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
  label?: string;
}) {
  const t = useT();
  const dropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;
  const [draft, setDraft] = useState(value.toUpperCase());
  useEffect(() => setDraft(value.toUpperCase()), [value]);

  return (
    <div className={`color-input field flex items-center gap-2 ${className}`}>
      {/* El cuadrito abre la paleta. Era un `span` decorativo y encima parecía
          pulsable, así que la única forma de elegir color era teclear el
          hexadecimal a mano. Y no vale `input type="color"`: Electron 40 no abre
          ningún diálogo al pulsarlo —comprobado con un clic real, no del DOM—,
          así que en la aplicación de escritorio sería un botón muerto. */}
      {/* `floating`: las secciones del editor de perfil recortan lo que se sale
          (overflow-hidden), y sin salir de ahí la paleta aparecía cortada a una
          sola columna. */}
      <Menu
        flush
        floating
        trigger={(props) => (
          <button
            {...props}
            type="button"
            aria-label={t("common.pickColor")}
            title={t("common.pickColor")}
            className="h-7 w-7 shrink-0 cursor-pointer rounded-[8px] border border-line shadow-sm transition-transform hover:scale-110"
            style={{ background: value }}
          />
        )}
      >
        {(close) => (
          <div className="flex flex-col gap-1.5 p-2">
            {PALETTE.map((row) => (
              <div key={row.join()} className="flex gap-1">
                {row.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={color}
                    aria-pressed={value.toLowerCase() === color}
                    title={color}
                    onClick={() => {
                      onChange(color);
                      close();
                    }}
                    className={`h-7 w-7 rounded-[6px] border transition-transform hover:scale-110 ${
                      value.toLowerCase() === color ? "border-ink" : "border-line"
                    }`}
                    style={{ background: color }}
                  />
                ))}
              </div>
            ))}
            <ColorSpectrum value={value} onChange={onChange} />
            <div className="mt-1 flex items-center gap-2 border-t border-line pt-2">
              <span className="h-7 w-7 shrink-0 rounded-[6px] border border-line" style={{ background: value }} aria-hidden />
              <span className="flex-1 font-mono text-xs font-semibold text-muted">{value.toUpperCase()}</span>
              {dropper ? (
                <button
                  type="button"
                  aria-label={t("common.eyedropper")}
                  title={t("common.eyedropper")}
                  onClick={() => {
                    void new dropper()
                      .open()
                      .then((picked) => {
                        onChange(picked.sRGBHex.toLowerCase());
                        close();
                      })
                      .catch(() => {});
                  }}
                  className="grid h-7 w-7 place-items-center rounded-[6px] border border-line text-muted hover:border-accent hover:text-ink"
                >
                  <Pipette size={14} aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
        )}
      </Menu>
      <input
        id={id}
        aria-label={label}
        value={draft}
        inputMode="text"
        maxLength={7}
        spellCheck={false}
        className="min-w-0 flex-1 bg-transparent font-mono text-sm font-semibold tracking-wide uppercase outline-none"
        onChange={(event) => {
          const next = event.target.value.startsWith("#") ? event.target.value : `#${event.target.value}`;
          setDraft(next.toUpperCase());
          if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => {
          if (!/^#[0-9a-f]{6}$/i.test(draft)) setDraft(value.toUpperCase());
        }}
      />
    </div>
  );
}

/** Un único aspecto para todos los deslizadores de la aplicación. */
export function Range({ className = "", style, min = 0, max = 100, value, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const numeric = typeof value === "number" ? value : Number(value ?? min);
  const minimum = Number(min);
  const maximum = Number(max);
  const progress = maximum === minimum ? 0 : ((numeric - minimum) / (maximum - minimum)) * 100;
  return (
    <input
      {...props}
      type="range"
      min={min}
      max={max}
      value={value}
      className={`range-control w-full ${className}`}
      style={{ ...style, "--range-progress": `${Math.min(100, Math.max(0, progress))}%` } as CSSProperties}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  /** Para interruptores que tardan: activar un aviso del navegador abre un
      diálogo del sistema, y volver a pulsar mientras tanto pide dos veces. */
  disabled?: boolean;
}) {
  return (
    <label className={`flex items-start gap-3 ${disabled ? "cursor-wait opacity-60" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => {
          const next = !checked;
          // Al apagar, el sonido debe arrancar antes de que la preferencia lo
          // silencie. Al encender, la preferencia debe aplicarse primero.
          if (next) {
            onChange(next);
            playUi("on");
          } else {
            playUi("off");
            onChange(next);
          }
        }}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors ${
          checked ? "border-accent bg-accent" : "border-line bg-raise"
        }`}
      >
        <span
          className={`block h-4 w-4 rounded-full bg-surface transition-transform ${
            checked ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
      </span>
    </label>
  );
}

/* ── diálogo ───────────────────────────────────────────────────────── */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  chrome = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
  /** Sin cabecera ni relleno: para contenido que llega hasta el borde, como una
      portada. Quien lo pida se encarga de cerrar y de su propio margen. */
  chrome?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const pressedOnBackdrop = useRef(false);

  /* El estado visual de un <dialog> vive fuera de React, en la top layer del
     navegador. Hay que sincronizarlo antes de pintar: con un efecto pasivo,
     React alcanzaba a vaciar el diálogo y a ocultar su panel padre mientras el
     backdrop nativo seguía abierto. El resultado era una pantalla oscura sin
     modal, especialmente al pasar de "nuevo mensaje" al chat en móvil. */
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      /* React reparte `close` y `cancel` por todos los ancestros: no burbujean
         en el DOM, pero su sistema de eventos los propaga igual. Con un
         <dialog> dentro de otro —la confirmación de un borrado, dentro de
         Ajustes— cerrar el de dentro cerraba también el de fuera y devolvía a
         la pantalla de inicio. Solo contesta el diálogo que se cerró. */
      onClose={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onCancel={(e) => {
        if (e.target === ref.current) onClose();
      }}
      /* Clic en el fondo = cerrar. El contenido llena el <dialog> (p-0), así
         que un evento cuyo target es el propio <dialog> solo puede venir del
         backdrop. La pulsación debe EMPEZAR y TERMINAR ahí: soltar fuera una
         selección de texto iniciada dentro del card no debe cerrarlo. */
      onPointerDown={(e) => {
        pressedOnBackdrop.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (pressedOnBackdrop.current && e.target === ref.current) onClose();
      }}
      // Sin cabecera no hay <h2> que nombre el diálogo, así que lo nombra el título.
      {...(chrome ? {} : { "aria-label": title })}
      style={{ width: `min(94vw, ${size === "lg" ? "56rem" : "34rem"})` }}
      className="card m-auto max-h-[86dvh] overflow-hidden bg-surface p-0 text-ink"
    >
      {open ? (
        <div className="flex max-h-[86dvh] flex-col">
          {chrome ? (
            <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
              <h2 className="display text-lg font-bold">{title}</h2>
              {/* El nombre accesible no puede ser "×": un lector de pantalla lo lee
                  como "por" o "times", que no dice qué hace el botón. */}
              <IconButton label={t("common.close")} onClick={onClose}>
                <svg
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </IconButton>
            </header>
          ) : null}
          <div
            className={`min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto ${chrome ? "px-4 py-4 sm:px-5" : ""}`}
          >
            {children}
          </div>
          {footer ? (
            <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Confirmación explícita para lo irreversible (§28.5). */
export function useConfirm() {
  const [state, setState] = useState<{
    message: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const t = useT();

  const confirm = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => setState({ message, resolve })),
    [],
  );

  const element = (
    <Modal
      open={state !== null}
      onClose={() => {
        state?.resolve(false);
        setState(null);
      }}
      title={t("common.delete")}
      footer={
        <>
          <Button
            onClick={() => {
              state?.resolve(false);
              setState(null);
            }}
          >
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              state?.resolve(true);
              setState(null);
            }}
          >
            {t("common.delete")}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">{state?.message}</p>
    </Modal>
  );

  return { confirm, element };
}

/* ── menú contextual ───────────────────────────────────────────────── */

export function Menu({
  trigger,
  children,
  /** Sin relleno: para contenido que llega al borde, como una portada o una rejilla. */
  flush,
  /** Sale del contexto de apilamiento y se centra respecto al disparador. */
  floating,
}: {
  trigger: (props: { onClick: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  flush?: boolean;
  floating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [left, setLeft] = useState(false);
  const [floatingPosition, setFloatingPosition] = useState<{ left: number; top: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);

  const positionFloating = useCallback(() => {
    if (!floating) return;
    const menu = popup.current;
    const anchor = box.current?.getBoundingClientRect();
    if (!menu || !anchor) return;

    /* Un disparador escondido mide 0×0. Pasa con los controles que solo salen al
       pasar el ratón por encima: al mover el ratón hacia el menú —o al enfocar
       algo de dentro— el botón desaparece, y recolocar respecto a un rectángulo
       vacío mandaría el menú a la esquina de la pantalla en mitad de un arrastre.
       Se queda donde se abrió. */
    if (anchor.width === 0 && anchor.height === 0) return;

    const margin = 8;
    const gap = 8;
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    const availableAbove = anchor.top - gap - margin;
    const availableBelow = window.innerHeight - anchor.bottom - gap - margin;
    const above = height <= availableAbove || availableAbove >= availableBelow;
    const idealLeft = anchor.left + anchor.width / 2 - width / 2;
    const maxLeft = Math.max(margin, window.innerWidth - width - margin);
    const idealTop = above ? anchor.top - gap - height : anchor.bottom + gap;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);

    setFloatingPosition({
      left: Math.min(maxLeft, Math.max(margin, idealLeft)),
      top: Math.min(maxTop, Math.max(margin, idealTop)),
    });
  }, [floating]);

  /**
   * Abrir hacia arriba cuando abajo no cabe.
   * Los disparadores pegados al borde inferior —el selector de emoji del
   * compositor, la barra de usuario, el menú de la última persona de una lista—
   * dejaban el menú fuera de la ventana y no había forma de llegar a él.
   * Se mide después de pintar, porque la altura depende de lo que haya dentro.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const menu = popup.current;
    const anchor = box.current?.getBoundingClientRect();
    if (!menu || !anchor) return;

    if (floating) {
      setFloatingPosition(null);
      positionFloating();
      return;
    }

    const alto = menu.offsetHeight;
    const cabeAbajo = anchor.bottom + alto + 8 <= window.innerHeight;
    const cabeArriba = anchor.top - alto - 8 >= 0;
    // Si no cabe en ningún lado se queda abajo: al menos empieza donde se espera.
    setUp(!cabeAbajo && cabeArriba);

    /* Y lo mismo en horizontal. Por defecto el menú cuelga hacia la izquierda
       desde el borde derecho del disparador; con un disparador estrecho pegado
       al lado izquierdo de la ventana —la barra de usuario— eso deja medio menú
       fuera de la pantalla. */
    const ancho = menu.offsetWidth;
    setLeft(
      anchor.right - ancho < 8 && anchor.left + ancho + 8 <= window.innerWidth,
    );
  }, [open, floating, positionFloating]);

  useEffect(() => {
    if (!open || !floating) return;
    const observer = new ResizeObserver(positionFloating);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", positionFloating);
    window.addEventListener("scroll", positionFloating, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", positionFloating);
      window.removeEventListener("scroll", positionFloating, true);
    };
  }, [open, floating, positionFloating]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!box.current?.contains(target) && !popup.current?.contains(target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const content = (
    <div
      ref={popup}
      role="menu"
      style={
        floating
          ? {
              left: floatingPosition?.left ?? 0,
              top: floatingPosition?.top ?? 0,
              zIndex: 1000,
              visibility: floatingPosition ? "visible" : "hidden",
              maxHeight: "calc(100vh - 16px)",
            }
          : undefined
      }
      className={`card min-w-52 overflow-hidden text-sm ${
        floating
          ? "fixed"
          : `absolute z-30 ${left ? "left-0" : "right-0"} ${up ? "bottom-full mb-1" : "mt-1"}`
      } ${flush ? "" : "p-1"}`}
    >
      {children(() => setOpen(false))}
    </div>
  );

  return (
    <div ref={box} className="relative">
      {trigger({ onClick: () => setOpen((v) => !v) })}
      {/* Dentro de un diálogo hay que portalizar AL diálogo, no al body: un
          <dialog> abierto con showModal vive en la top layer, y desde el body
          ningún z-index lo alcanza — el menú quedaba en el DOM, "visible" y en
          pantalla, pero pintado por debajo del modal. Mismo criterio que Select. */}
      {open
        ? floating
          ? createPortal(content, box.current?.closest("dialog") ?? document.body)
          : content
        : null}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  danger,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-raise disabled:pointer-events-none disabled:opacity-40 ${
        danger ? "text-danger" : "text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Menú de clic derecho, anclado al puntero y no a un botón.
 *
 * `Menu` cuelga de su disparador; aquí el ancla es un punto de la pantalla, así
 * que se coloca en `fixed` y se cierra al hacer scroll: un menú que sigue
 * flotando sobre una lista que se ha movido señala a otra fila.
 *
 * El teclado también lo abre — la tecla de menú contextual dispara el mismo
 * evento con las coordenadas del elemento enfocado (§31) —, por eso al abrirse
 * el foco salta al primer elemento.
 */
export function ContextMenu({
  at,
  onClose,
  children,
}: {
  at: { x: number; y: number } | null;
  onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number } | null>(null);

  /* Se mide después de pintar: la altura depende de cuántas opciones tenga
     quien lo abre, y sin medir un menú abierto abajo del todo se sale. */
  useLayoutEffect(() => {
    if (!at) {
      setBox(null);
      return;
    }
    const menu = popup.current;
    if (!menu) return;
    const margin = 8;
    const maxLeft = Math.max(margin, window.innerWidth - menu.offsetWidth - margin);
    const maxTop = Math.max(margin, window.innerHeight - menu.offsetHeight - margin);
    setBox({
      left: Math.min(maxLeft, Math.max(margin, at.x)),
      top: Math.min(maxTop, Math.max(margin, at.y)),
    });
    menu.querySelector<HTMLElement>("[role='menuitem']:not([disabled])")?.focus();
  }, [at]);

  useEffect(() => {
    if (!at) return;
    /* `mousedown` y no `click`: en un clic derecho fuera, el botón secundario
       cierra este menú antes de que el `contextmenu` de la otra fila abra el
       suyo, y así no hay dos abiertos. */
    const away = (event: MouseEvent) => {
      if (!popup.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [at, onClose]);

  if (!at) return null;

  return createPortal(
    <div
      ref={popup}
      role="menu"
      style={{
        left: box?.left ?? at.x,
        top: box?.top ?? at.y,
        zIndex: 1000,
        // Antes de medir se pinta invisible: si no, se ve saltar de sitio.
        visibility: box ? "visible" : "hidden",
        maxHeight: "calc(100vh - 16px)",
      }}
      className="card fixed min-w-52 overflow-y-auto p-1 text-sm"
    >
      {children(onClose)}
    </div>,
    document.body,
  );
}

/* ── identidad visual de una persona ───────────────────────────────── */

/**
 * Color del avatar por defecto.
 * Todos los UUIDv7 empiezan igual (llevan el tiempo delante), así que hay que
 * mezclar la cadena entera. Y el tono recorre el círculo completo en vez de una
 * paleta corta: con ocho colores, en cualquier comunidad pequeña ya hay dos
 * personas del mismo color. La luminosidad y el croma son fijos, así que el
 * texto blanco encima contrasta igual en todos los tonos.
 */
export function hueOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++)
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

/**
 * El punto de estado: color Y forma.
 *
 * Con solo color, "no molestar" y "ausente" son indistinguibles para buena parte
 * de la gente daltónica, y §31 pide explícitamente no depender del color. Así
 * que cada estado tiene además su silueta: relleno, media luna, barra y aro.
 */
export type PresenceRing = "online" | "idle" | "dnd" | "offline";

export function StatusDot({
  status,
  size = 10,
  className = "",
}: {
  status: PresenceRing;
  size?: number;
  className?: string;
}) {
  const color =
    status === "online"
      ? "var(--ok)"
      : status === "idle"
        ? "var(--warn)"
        : status === "dnd"
          ? "var(--danger)"
          : "var(--muted)";

  return (
    // Nunca se posiciona a sí mismo: quien lo usa decide dónde va. Ponerle
    // `absolute` aquí dentro lo dejaba colgando fuera del avatar.
    <span
      className={`relative block shrink-0 rounded-full border-2 border-surface ${className}`}
      style={{ width: size, height: size, background: color }}
      data-status={status}
    >
      {/* Media luna: un círculo del color del fondo mordiendo la esquina. */}
      {status === "idle" ? (
        <span
          className="block rounded-full"
          style={{
            width: "70%",
            height: "70%",
            background: "var(--surface)",
            marginLeft: "-8%",
            marginTop: "-8%",
          }}
        />
      ) : null}
      {/* Barra central, como el símbolo de prohibido. */}
      {status === "dnd" ? (
        <span
          className="absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ width: "62%", height: "26%", background: "var(--surface)" }}
        />
      ) : null}
      {/* Aro hueco: desconectado no es "gris", es "vacío". */}
      {status === "offline" ? (
        <span
          className="absolute top-1/2 left-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ width: "50%", height: "50%", background: "var(--surface)" }}
        />
      ) : null}
    </span>
  );
}

/**
 * Cuanto crece la cara cuando lleva aro.
 *
 * Los atlas estan dibujados para que el avatar ocupe el 60% del cuadro, y a esa
 * proporcion queda flotando en medio con un hueco alrededor. Al 75% la cara
 * llega al trazo interior del aro y las dos lineas se tocan, que es como se ve
 * un aro puesto y no un aro al lado. El aro NO cambia de tamano: crece la cara.
 */
const CARA_CON_ARO = 1.25;

/**
 * Cuánto se sale un aro o una decoración por debajo del cuadro del avatar
 * (`size`), en px.
 *
 * El aro pinta con un 33.33% de inset (`.ring-stack` en styles.css) y la
 * decoración propia se dibuja a `size * 1.32` (Avatar más abajo), la mitad de
 * ese extra por lado. Ninguno de los dos mueve la caja de maquetación —a
 * propósito, para que una fila de lista no se descuadre—, así que quien apile
 * algo justo debajo de un avatar GRANDE (una tarjeta de perfil, no una fila)
 * necesita este hueco de más o el aro se come lo de abajo.
 */
export function avatarOverflow(profile: ProfileStyle | null | undefined, size: number): number {
  if (profile?.avatar_ring) return size / 3;
  if (profile?.avatar_deco_url) return size * 0.16;
  return 0;
}

/**
 * Aro de "está hablando" alrededor de un avatar.
 *
 * `outline` y no `box-shadow`: la sombra necesitaba una capa del color del fondo
 * para abrir hueco, y ese color se adivinaba (`--surface`) — en la lista de la
 * barra, que no es esa superficie, el hueco salía de otro color y el resultado
 * no se leía como un aro. El contorno deja el hueco transparente y acierta
 * siempre. El relleno lo da `avatarOverflow`: el aro del perfil y las
 * decoraciones se pintan FUERA de la caja del avatar, así que sin ese margen el
 * verde caía por encima del dibujo en vez de rodearlo.
 */
export function SpeakingRing({
  speaking,
  profile,
  size,
  children,
}: {
  speaking: boolean;
  profile: ProfileStyle | null | undefined;
  size: number;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-grid place-items-center rounded-full transition-[outline-color] duration-150"
      style={{
        padding: avatarOverflow(profile, size),
        outline: `2px solid ${speaking ? "var(--ok)" : "transparent"}`,
        outlineOffset: 2,
      }}
    >
      {children}
    </span>
  );
}

export function Avatar({
  name,
  url,
  size = 36,
  id,
  ring,
  profile,
  cutout = 0,
}: {
  name: string;
  url?: string | null | undefined;
  size?: number | undefined;
  id?: string | undefined;
  ring?: PresenceRing | undefined;
  /**
   * El estilo entero, no solo el aro: asi anadir una decoracion nueva no
   * obliga a tocar los siete sitios que pintan un avatar.
   */
  profile?: ProfileStyle | undefined;
  /**
   * Grosor del recorte contra una portada, en px.
   *
   * Vive aqui y no en quien llama porque depende del aro: un borde del color de
   * la tarjeta separa bien un avatar pelado del banner, pero con aro puesto ese
   * mismo circulo corta el dibujo por la mitad. Con la decision dentro, los
   * cuatro sitios que apilan avatar sobre portada aciertan a la vez.
   */
  cutout?: number | undefined;
}) {
  const hue = hueOf(id ?? name);
  const initials = name.trim().slice(0, 2).toUpperCase();
  const aro = profile?.avatar_ring
    ? RINGS.find((r) => r.id === profile.avatar_ring)
    : undefined;

  /* `scale` y no width/height: la caja de maquetacion sigue midiendo `size`, asi
     que una fila de la lista no se descuadra porque alguien se ponga un aro. */
  const cara: CSSProperties = {
    ...(aro ? { scale: String(CARA_CON_ARO) } : {}),
    ...(cutout && !aro
      ? { boxShadow: `0 0 0 ${cutout}px var(--surface)` }
      : {}),
  };
  /* El punto de estado va pegado al borde de la cara, y la cara ha crecido:
     0.7 ≈ cos 45°, que es por donde lo cruza la diagonal de la esquina. */
  const desborde = aro ? (size * (CARA_CON_ARO - 1)) / 2 : 0;

  return (
    <span
      /* `isolate` no es decorativo: las capas de dentro (cara, asiento, aro,
         decoración, punto de estado) se ordenan con z-index 1..5, y ese orden
         es ASUNTO INTERNO del avatar. Sin aislar, esos números competían con la
         página entera: cualquier panel con su propio contexto de apilado —la
         barra de perfil lo crea con `backdrop-blur`— dejaba su contenido en la
         capa z-auto, y entonces el aro (z:3) de una cara cualquiera de la lista
         se pintaba ENCIMA de la tarjeta de perfil abierta. Aislado, el 3 solo
         significa algo dentro de este avatar. */
      className="relative isolate inline-block shrink-0"
      style={{ width: size, height: size }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="relative z-[1] h-full w-full rounded-full object-cover"
          loading="lazy"
          style={cara}
        />
      ) : (
        <span
          aria-hidden="true"
          className="relative z-[1] grid h-full w-full place-items-center rounded-full font-semibold text-white"
          style={{
            ...cara,
            background: `oklch(0.55 0.13 ${hue})`,
            fontSize: size * 0.36,
          }}
        >
          {initials}
        </span>
      )}
      {/* No todas las piezas del catálogo son círculos completos: algunas son
          alas, cascos o personajes apoyados en un lado. Este asiento continuo
          garantiza que sigan leyéndose como aro y tapa la unión con la cara;
          la ilustración animada se pinta encima en la capa siguiente. */}
      {aro ? (
        <span
          aria-hidden="true"
          className="avatar-ring-seat"
          style={
            {
              "--avatar-ring-a": profile?.theme_a ?? profile?.name_color ?? "var(--accent)",
              "--avatar-ring-b": profile?.theme_b ?? profile?.theme_a ?? profile?.name_color ?? "var(--accent)",
              "--avatar-ring-width": `${Math.max(1.5, size * 0.045)}px`,
            } as CSSProperties
          }
        />
      ) : null}
      {/* Aro del catalogo: tres capas del mismo atlas (base, acentos,
          particulas). Un solo fichero descargado y tres animaciones distintas
          encima, en vez de un GIF por aro.

          La textura va como variable en el contenedor y no en cada capa: asi
          las tres la heredan y el navegador descarga una imagen, no tres. El
          `data-ring` elige la coreografia; toda la tabla esta en styles.css. */}
      {aro ? (
        <span
          aria-hidden="true"
          className="ring-stack"
          data-ring={aro.motion}
          style={
            { "--ring-texture": `url("/rings/${aro.id}.png")` } as CSSProperties
          }
        >
          <span className="ring-layer ring-base" />
          {/* A 32px o menos, solo la estructura: los acentos y las partículas
              van en `screen` y a ese tamaño son ruido ilegible que triplica
              las superficies compuestas de cada fila de lista. El aro sigue
              puesto —la base es el dibujo— y completo en tamaños mayores. */}
          {size > 32 ? (
            <>
              <span className="ring-layer ring-accents" />
              <span className="ring-layer ring-particles" />
            </>
          ) : null}
        </span>
      ) : null}

      {/* Decoracion propia: encima del avatar pero DEBAJO del punto de estado,
          que es informacion y no puede quedar tapada por un adorno. Se dibuja
          mas grande que el avatar a proposito — un marco se sale por fuera. */}
      {profile?.avatar_deco_url ? (
        <img
          src={profile.avatar_deco_url}
          alt=""
          aria-hidden="true"
          loading="lazy"
          className="pointer-events-none absolute top-1/2 left-1/2 z-[4] max-w-none -translate-x-1/2 -translate-y-1/2"
          style={{ width: size * 1.32, height: size * 1.32 }}
        />
      ) : null}
      {ring ? (
        <span
          className="absolute z-[5] block"
          style={{ right: -2 - desborde * 0.7, bottom: -2 - desborde * 0.7 }}
        >
          <StatusDot
            status={ring}
            size={Math.max(10, Math.round(size * 0.3))}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * El nombre de alguien, con su fuente, efecto y color (§10.1).
 *
 * Existe como componente y no como un par de clases sueltas porque el nombre se
 * pinta en cuatro sitios —lista de miembros, tarjeta de perfil, barra de
 * usuario y previsualización de ajustes— y la regla de qué color gana no puede
 * estar escrita cuatro veces.
 *
 * Esa regla: el color del ROL manda sobre el personal. El rol dice qué eres en
 * esta comunidad y esa información no puede quedar tapada por una preferencia
 * estética. La fuente y el efecto sí se conservan, así que la personalización
 * sigue viéndose — a diferencia de otras plataformas, donde entrar a un
 * servidor apaga entero el estilo que elegiste.
 */
export function DisplayName({
  name,
  style,
  accent,
  roleColor,
  className = "",
}: {
  name: string;
  style?: ProfileStyle | undefined;
  /** Color de acento del perfil: el color del nombre cae aquí si no eligió uno. */
  accent?: string | null | undefined;
  roleColor?: string | null | undefined;
  className?: string | undefined;
}) {
  if (!style) return <span className={className}>{name}</span>;

  const primary = roleColor ?? style.name_color ?? accent ?? null;
  const secondary = style.theme_b ?? accent ?? null;

  /* Un efecto de degradado necesita pintar el texto transparente, y con el
     color del rol encima eso lo dejaría invisible. Con rol, efecto plano. */
  const effect =
    roleColor &&
    (style.name_effect === "gradient" || style.name_effect === "animated")
      ? "plain"
      : style.name_effect;

  return (
    <span
      className={`nfont-${style.name_font} fx-${effect} ${className}`}
      style={
        {
          ...(primary ? { "--name-color": primary } : {}),
          ...(secondary ? { "--name-color-2": secondary } : {}),
        } as CSSProperties
      }
    >
      {name}
    </span>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div
      className="flex items-center justify-center gap-3 p-8 text-sm text-muted"
      role="status"
    >
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
      <h3 className="display text-lg font-bold">{title}</h3>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

/**
 * Tira para ensanchar a mano el panel de miembros o el chat de voz.
 * Los dos ocupan la misma columna de rejilla (`--w-members`), así que un único
 * gesto de arrastre vale para cualquiera de los dos sin duplicar la lógica.
 * Solo en escritorio: en móvil ese hueco pasa a `width: 100%` y la variable no
 * pinta nada (§25).
 */
const MEMBERS_WIDTH_KEY = "distop.membersWidth";
const MEMBERS_WIDTH_MIN = 240;
const MEMBERS_WIDTH_MAX = 480;

function clampMembersWidth(value: number): number {
  return Math.min(MEMBERS_WIDTH_MAX, Math.max(MEMBERS_WIDTH_MIN, value));
}

export function PanelResizeHandle() {
  const t = useT();
  const drag = useRef<{ startX: number; startWidth: number; grid: HTMLElement } | null>(null);

  // El ancho elegido la última vez, aplicado antes de que nadie arrastre nada.
  useEffect(() => {
    const stored = Number(localStorage.getItem(MEMBERS_WIDTH_KEY));
    if (!stored) return;
    document.querySelector<HTMLElement>(".app-grid")?.style.setProperty("--w-members-user", `${clampMembersWidth(stored)}px`);
  }, []);

  // Sin `-translate-x-1/2`: centrada sobre el borde, la mitad izquierda de la
  // tira caía sobre el panel de al lado, justo donde el chat pinta su barra de
  // scroll nativa. Arrastrar esa barra redimensionaba la rejilla en vez de
  // desplazar los mensajes. Entera dentro de su propio panel, no pisa al vecino.
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t("common.resize")}
      className="absolute top-0 left-0 z-10 hidden h-full w-1.5 cursor-col-resize touch-none wide:block hover:bg-accent/40"
      onPointerDown={(event) => {
        const grid = event.currentTarget.closest<HTMLElement>(".app-grid");
        const pane = event.currentTarget.parentElement;
        if (!grid || !pane) return;
        drag.current = { startX: event.clientX, startWidth: pane.getBoundingClientRect().width, grid };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        // A la izquierda queda el chat: arrastrar hacia la izquierda ensancha.
        const width = clampMembersWidth(drag.current.startWidth - (event.clientX - drag.current.startX));
        drag.current.grid.style.setProperty("--w-members-user", `${width}px`);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        const width = parseFloat(drag.current.grid.style.getPropertyValue("--w-members-user"));
        if (width) localStorage.setItem(MEMBERS_WIDTH_KEY, String(Math.round(width)));
        drag.current = null;
      }}
    />
  );
}

/** Mensajes de error del servidor tal cual: ocultarlos solo alarga el problema (§26). */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {children}
    </p>
  );
}
