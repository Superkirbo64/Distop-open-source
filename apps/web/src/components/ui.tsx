/**
 * Piezas de interfaz compartidas.
 * Los diálogos usan <dialog> nativo: trampa de foco, Escape y fondo modal ya
 * vienen resueltos por el navegador, sin librería de por medio.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Image as ImageIcon } from "lucide-react";
import { RINGS, type ProfileStyle } from "@distop/protocol";
import { translate, type MessageKey } from "../i18n.ts";
import { useStore } from "../store.ts";
import { RequestError, upload } from "../lib/api.ts";

export function useT() {
  const locale = useStore((s) => s.prefs.locale);
  return useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars),
    [locale],
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
      if (err.code === "INSTANCE_UNREACHABLE") return t("error.unreachable", { status: err.status });
      return err.message;
    },
    [t],
  );
}

/* ── botones y campos ──────────────────────────────────────────────── */

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "ghost" | "danger";
};

export function Button({ variant = "ghost", className = "", ...props }: ButtonProps) {
  return <button {...props} className={`btn btn-${variant} ${className}`} />;
}

/** Botón sólo-icono: sigue necesitando nombre accesible, por eso `label` es obligatorio. */
export function IconButton({
  label,
  children,
  className = "",
  pressed,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode; pressed?: boolean }) {
  return (
    <button
      {...props}
      aria-label={label}
      title={label}
      // Un interruptor tiene que decir en qué posición está, no solo qué hace.
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      // Se centra con flex y no con `place-items`: quien use este botón puede
      // cambiarle el display desde className (`wide:inline-flex`, por ejemplo), y
      // en flex `justify-items` no hace nada — el icono se quedaba pegado al
      // borde izquierdo. `items-center justify-center` centra en los dos casos.
      className={`icon-btn flex h-9 w-9 items-center justify-center rounded-[10px] ${
        pressed ? "bg-accent-soft text-accent" : "text-muted hover:bg-raise hover:text-ink"
      } ${className}`}
    >
      {children}
    </button>
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

  const shape = preview === "round" ? "h-16 w-16 rounded-full" : preview === "wide" ? "h-16 w-28 rounded-[10px]" : "h-16 w-16 rounded-[10px]";

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-ink">{label}</span>

      <div className="flex items-center gap-3">
        <span className={`grid shrink-0 place-items-center overflow-hidden border border-line bg-sunken ${shape}`}>
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
            {value ? <Button onClick={() => onChange("")}>{t("common.remove")}</Button> : null}
          </div>
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </div>
      </div>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="sr-only"
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

export function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={onClose}
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
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </IconButton>
            </header>
          ) : null}
          <div className={`min-h-0 flex-1 overflow-y-auto ${chrome ? "px-5 py-4" : ""}`}>{children}</div>
          {footer ? <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Confirmación explícita para lo irreversible (§28.5). */
export function useConfirm() {
  const [state, setState] = useState<{ message: string; resolve: (ok: boolean) => void } | null>(null);
  const t = useT();

  const confirm = useCallback(
    (message: string) => new Promise<boolean>((resolve) => setState({ message, resolve })),
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
}: {
  trigger: (props: { onClick: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  flush?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [left, setLeft] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  /**
   * Abrir hacia arriba cuando abajo no cabe.
   * Los disparadores pegados al borde inferior —el selector de emoji del
   * compositor, la barra de usuario, el menú de la última persona de una lista—
   * dejaban el menú fuera de la ventana y no había forma de llegar a él.
   * Se mide después de pintar, porque la altura depende de lo que haya dentro.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const menu = box.current?.querySelector<HTMLElement>('[role="menu"]');
    const anchor = box.current?.getBoundingClientRect();
    if (!menu || !anchor) return;

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
    setLeft(anchor.right - ancho < 8 && anchor.left + ancho + 8 <= window.innerWidth);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
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

  return (
    <div ref={box} className="relative">
      {trigger({ onClick: () => setOpen((v) => !v) })}
      {open ? (
        <div
          role="menu"
          className={`card absolute z-30 min-w-52 overflow-hidden text-sm ${left ? "left-0" : "right-0"} ${
            flush ? "" : "p-1"
          } ${up ? "bottom-full mb-1" : "mt-1"}`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

export function MenuItem({
  onClick,
  children,
  danger,
}: {
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors hover:bg-raise ${
        danger ? "text-danger" : "text-ink"
      }`}
    >
      {children}
    </button>
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
function hueOf(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
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
    status === "online" ? "var(--ok)" : status === "idle" ? "var(--warn)" : status === "dnd" ? "var(--danger)" : "var(--muted)";

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
          style={{ width: "70%", height: "70%", background: "var(--surface)", marginLeft: "-8%", marginTop: "-8%" }}
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
  const aro = profile?.avatar_ring ? RINGS.find((r) => r.id === profile.avatar_ring) : undefined;

  /* `scale` y no width/height: la caja de maquetacion sigue midiendo `size`, asi
     que una fila de la lista no se descuadra porque alguien se ponga un aro. */
  const cara: CSSProperties = {
    ...(aro ? { scale: String(CARA_CON_ARO) } : {}),
    ...(cutout && !aro ? { boxShadow: `0 0 0 ${cutout}px var(--surface)` } : {}),
  };
  /* El punto de estado va pegado al borde de la cara, y la cara ha crecido:
     0.7 ≈ cos 45°, que es por donde lo cruza la diagonal de la esquina. */
  const desborde = aro ? (size * (CARA_CON_ARO - 1)) / 2 : 0;

  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full rounded-full object-cover"
          loading="lazy"
          style={cara}
        />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-full w-full place-items-center rounded-full font-semibold text-white"
          style={{ ...cara, background: `oklch(0.55 0.13 ${hue})`, fontSize: size * 0.36 }}
        >
          {initials}
        </span>
      )}
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
          style={{ "--ring-texture": `url("/rings/${aro.id}.png")` } as CSSProperties}
        >
          <span className="ring-layer ring-base" />
          <span className="ring-layer ring-accents" />
          <span className="ring-layer ring-particles" />
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
          className="pointer-events-none absolute top-1/2 left-1/2 max-w-none -translate-x-1/2 -translate-y-1/2"
          style={{ width: size * 1.32, height: size * 1.32 }}
        />
      ) : null}
      {ring ? (
        <span
          className="absolute block"
          style={{ right: -2 - desborde * 0.7, bottom: -2 - desborde * 0.7 }}
        >
          <StatusDot status={ring} size={Math.max(10, Math.round(size * 0.3))} />
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
  const effect = roleColor && (style.name_effect === "gradient" || style.name_effect === "animated") ? "plain" : style.name_effect;

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
    <div className="flex items-center justify-center gap-3 p-8 text-sm text-muted" role="status">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
      {label}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 py-12 text-center">
      <h3 className="display text-lg font-bold">{title}</h3>
      {hint ? <p className="text-sm text-muted">{hint}</p> : null}
      {action}
    </div>
  );
}

/** Mensajes de error del servidor tal cual: ocultarlos solo alarga el problema (§26). */
export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="rounded-[10px] border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {children}
    </p>
  );
}
