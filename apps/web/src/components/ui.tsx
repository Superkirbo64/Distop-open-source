/**
 * Piezas de interfaz compartidas.
 * Los diálogos usan <dialog> nativo: trampa de foco, Escape y fondo modal ya
 * vienen resueltos por el navegador, sin librería de por medio.
 */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { translate, type MessageKey } from "../i18n.ts";
import { useStore } from "../store.ts";
import { RequestError } from "../lib/api.ts";

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
      className={`icon-btn grid h-9 w-9 place-items-center rounded-[10px] ${
        pressed ? "bg-accent-soft text-accent" : "text-muted hover:bg-raise hover:text-ink"
      } ${className}`}
    >
      {children}
    </button>
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
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
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
      style={{ width: `min(94vw, ${size === "lg" ? "56rem" : "34rem"})` }}
      className="card m-auto max-h-[86dvh] overflow-hidden bg-surface p-0 text-ink"
    >
      {open ? (
        <div className="flex max-h-[86dvh] flex-col">
          <header className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
            <h2 className="display text-lg font-bold">{title}</h2>
            <IconButton label="×" onClick={onClose}>
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </IconButton>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
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

export function Menu({ trigger, children }: { trigger: (props: { onClick: () => void }) => ReactNode; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

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
          className="card absolute right-0 z-30 mt-1 min-w-52 overflow-hidden p-1 text-sm"
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

export function Avatar({
  name,
  url,
  size = 36,
  id,
  ring,
}: {
  name: string;
  url?: string | null | undefined;
  size?: number | undefined;
  id?: string | undefined;
  ring?: "online" | "offline" | undefined;
}) {
  const hue = hueOf(id ?? name);
  const initials = name.trim().slice(0, 2).toUpperCase();

  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }}>
      {url ? (
        <img src={url} alt="" className="h-full w-full rounded-full object-cover" loading="lazy" />
      ) : (
        <span
          aria-hidden="true"
          className="grid h-full w-full place-items-center rounded-full font-semibold text-white"
          style={{ background: `oklch(0.55 0.13 ${hue})`, fontSize: size * 0.36 }}
        >
          {initials}
        </span>
      )}
      {ring ? (
        <span
          className="absolute -right-0.5 -bottom-0.5 block rounded-full border-2 border-surface"
          style={{
            width: size * 0.3,
            height: size * 0.3,
            background: ring === "online" ? "var(--ok)" : "var(--muted)",
          }}
        />
      ) : null}
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
