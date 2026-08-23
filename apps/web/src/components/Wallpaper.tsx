/**
 * Fondo de pantalla del chat (§10.2): buscador, imagen propia y ajuste fino.
 *
 * Vive fuera de Settings.tsx porque son dos piezas que se pintan en sitios
 * distintos —una dentro del modal de ajustes, otra flotando sobre la
 * aplicación con el modal ya cerrado— y meterlas allí sería engordar un
 * fichero que ya pasa de mil líneas por parentesco temático y nada más.
 *
 * El fondo solo cubre el panel del chat. La barra de canales y la lista de
 * miembros se quedan opacas: son las que llevan la información que hay que
 * poder leer siempre, y no puede depender de la foto de hoy (§31).
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Button, Field, IconButton, ImageField, Range, Spinner, useT } from "./ui.tsx";

interface Wallpaper {
  id: string;
  url: string;
  preview: string;
  resolution: string;
}

/**
 * Los cinco ajustes con sus topes: el panel se pinta recorriendo esto, así que
 * añadir uno nuevo es una línea aquí y su traducción, no otro bloque de JSX.
 */
const TUNING = [
  { key: "wallpaperVeil", label: "settings.wallpaperVeil", min: 0, max: 95, step: 5, unit: "%" },
  { key: "wallpaperBlur", label: "settings.wallpaperBlur", min: 0, max: 24, step: 1, unit: "px" },
  { key: "wallpaperBright", label: "settings.wallpaperBright", min: 30, max: 170, step: 5, unit: "%" },
  { key: "wallpaperContrast", label: "settings.wallpaperContrast", min: 40, max: 180, step: 5, unit: "%" },
  { key: "wallpaperSaturate", label: "settings.wallpaperSaturate", min: 0, max: 200, step: 5, unit: "%" },
] as const;

const DEFAULTS = { wallpaperVeil: 78, wallpaperBlur: 0, wallpaperBright: 100, wallpaperContrast: 100, wallpaperSaturate: 100 } as const;

/* ── dentro de Ajustes → Apariencia ────────────────────────────────── */

/**
 * Buscador suelto, sin saber a qué se va a aplicar la imagen: el fondo del chat
 * lo usa igual que el banner del perfil. Separarlo fue lo que evitó escribir dos
 * veces la búsqueda, el antirrebote y la rejilla.
 */
export function WallpaperSearch({ current, onPick }: { current: string; onPick: (url: string) => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Wallpaper[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Nada de buscar en cada tecla: cada una es una petición que sale de la
  // instancia, y Wallhaven corta a 45 por minuto para toda la comunidad.
  useEffect(() => {
    setResults(null);
    setError(null);
    const timer = setTimeout(() => {
      api<Wallpaper[]>("GET", `/api/v1/wallpapers?q=${encodeURIComponent(query.trim())}`)
        .then(setResults)
        .catch(() => {
          setResults([]);
          setError(t("settings.wallpaperError"));
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [query, t]);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings.wallpaperPlaceholder")}
        aria-label={t("settings.wallpaperPlaceholder")}
        className="field"
      />

      {results === null ? (
        <Spinner label={t("common.loading")} />
      ) : error ? (
        <p className="py-6 text-center text-sm text-muted">{error}</p>
      ) : results.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("settings.wallpaperEmpty")}</p>
      ) : (
        <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => onPick(item.url)}
              aria-pressed={current === item.url}
              title={item.resolution}
              className={`overflow-hidden rounded-[10px] border ${
                current === item.url ? "border-accent" : "border-line hover:border-accent"
              }`}
            >
              <img src={item.preview} alt={item.resolution} loading="lazy" className="aspect-video w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Botón que despliega el buscador, para colgarlo de cualquier campo de imagen. */
export function WallpaperPicker({ current, onPick }: { current: string; onPick: (url: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-2">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="btn btn-ghost"
      >
        {t(open ? "settings.wallpaperHide" : "settings.wallpaperSearch")}
      </button>
      {open ? <WallpaperSearch current={current} onPick={onPick} /> : null}
    </div>
  );
}

export function WallpaperField({ onAdjust }: { onAdjust: () => void }) {
  const t = useT();
  const wallpaper = useStore((s) => s.prefs.wallpaper);
  const setPref = useStore((s) => s.setPref);
  const setTuner = useStore((s) => s.setTuner);
  const [open, setOpen] = useState(false);

  return (
    /* Bloque con `space-y`, no columna flex: como elemento flex la rejilla se
       encogía cuando el modal apretaba, y las filas aplastaban las miniaturas
       hasta dejarlas en tiras. En bloque cada fila mide lo que mide su imagen. */
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm font-medium">{t("settings.wallpaper")}</legend>

      {/* La imagen propia va primero: buscar en Wallhaven es la alternativa a
          tener una, no al revés. Este campo ya trae subir fichero y pegar URL. */}
      <ImageField
        label={t("settings.wallpaperOwn")}
        hint={t("settings.wallpaperOwnHint")}
        value={wallpaper}
        onChange={(url) => setPref("wallpaper", url)}
        preview="wide"
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {t(open ? "settings.wallpaperHide" : "settings.wallpaperSearch")}
        </Button>
        {wallpaper ? (
          <Button
            variant="primary"
            onClick={() => {
              // El panel se juzga mirando el fondo, y el modal lo tapa entero.
              setTuner(true);
              onAdjust();
            }}
          >
            {t("settings.wallpaperTune")}
          </Button>
        ) : null}
      </div>

      {open ? <WallpaperSearch current={wallpaper} onPick={(url) => setPref("wallpaper", url)} /> : null}
    </fieldset>
  );
}

/* ── panel flotante, con el fondo a la vista ───────────────────────── */

/**
 * Se monta siempre en la raíz y decide solo si aparece: el botón que lo abre
 * está dentro de un modal que se cierra en ese mismo clic, así que no puede
 * colgar de él.
 */
export function WallpaperTuner() {
  const t = useT();
  const open = useStore((s) => s.tuner);
  const setTuner = useStore((s) => s.setTuner);
  const prefs = useStore((s) => s.prefs);
  const setPref = useStore((s) => s.setPref);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTuner(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setTuner]);

  // Quitar el fondo desde otro sitio deja el panel gobernando la nada.
  if (!open || !prefs.wallpaper) return null;

  return (
    <aside
      aria-label={t("settings.wallpaperTune")}
      className="fixed bottom-4 right-4 z-50 flex w-[19rem] max-w-[calc(100vw-2rem)] flex-col gap-3 rounded-card border border-line bg-raise/70 p-4 shadow-[var(--shadow)] backdrop-blur-md"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="display text-sm font-bold">{t("settings.wallpaperTune")}</p>
        <IconButton label={t("common.close")} onClick={() => setTuner(false)}>
          <X size={15} />
        </IconButton>
      </div>

      {TUNING.map((item) => (
        <Field key={item.key} label={`${t(item.label)} — ${prefs[item.key]}${item.unit}`}>
          {(id) => (
            <Range
              id={id}
              min={item.min}
              max={item.max}
              step={item.step}
              value={prefs[item.key]}
              onChange={(e) => setPref(item.key, Number(e.target.value))}
              className="w-full"
              style={{ accentColor: "var(--accent)" }}
            />
          )}
        </Field>
      ))}

      <div className="flex gap-2">
        <Button
          className="flex-1"
          onClick={() => {
            for (const [key, value] of Object.entries(DEFAULTS)) setPref(key as keyof typeof DEFAULTS, value);
          }}
        >
          {t("settings.reset")}
        </Button>
        <Button
          className="flex-1"
          onClick={() => {
            setPref("wallpaper", "");
            setTuner(false);
          }}
        >
          {t("settings.wallpaperClear")}
        </Button>
      </div>
    </aside>
  );
}
