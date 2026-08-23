/**
 * Galería de avatares y banners (§10.1).
 *
 * Existe para no tener que salir de la aplicación a buscar una imagen y volver
 * con el enlace en el portapapeles. Las categorías animadas van primero a
 * propósito: son justo las que en otras plataformas se cobran, y aquí son la
 * mitad de la galería.
 *
 * Las imágenes las sirve nekos.best a través de la instancia. No es capricho de
 * privacidad: esa API exige una cabecera `User-Agent` propia, y `User-Agent` es
 * una de las que el navegador prohíbe fijar desde JavaScript. Sin proxy no hay
 * petición posible.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { Select, Spinner, useT } from "./ui.tsx";

interface Pfp {
  id: string;
  url: string;
  preview: string;
  source: string;
  animated: boolean;
}

interface Category {
  name: string;
  animated: boolean;
}

export function Gallery({ current, onPick }: { current: string; onPick: (url: string) => void }) {
  const t = useT();
  const [categories, setCategories] = useState<Category[] | null>(null);
  const [category, setCategory] = useState("");
  const [results, setResults] = useState<Pfp[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Category[]>("GET", "/api/v1/avatars/categories")
      .then((list) => {
        setCategories(list);
        setCategory((prev) => prev || (list[0]?.name ?? ""));
      })
      .catch(() => setError(t("settings.galleryError")));
  }, [t]);

  useEffect(() => {
    if (!category) return;
    setResults(null);
    setError(null);
    api<Pfp[]>("GET", `/api/v1/avatars?category=${encodeURIComponent(category)}&amount=20`)
      .then(setResults)
      .catch(() => {
        setResults([]);
        setError(t("settings.galleryError"));
      });
  }, [category, t]);

  if (error && !categories) return <p className="py-4 text-sm text-muted">{error}</p>;
  if (!categories) return <Spinner label={t("common.loading")} />;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{t("settings.galleryCategory")}</span>
        <Select
          value={category}
          onChange={setCategory}
          compact
          className="flex-1"
          label={t("settings.galleryCategory")}
          options={categories.map((item) => ({ value: item.name, label: `${item.name}${item.animated ? " ✦" : ""}` }))}
        />
      </div>

      {/* La marca dice cuáles se mueven, sin tener que cargarlas para saberlo. */}
      <p className="text-xs text-muted">{t("settings.galleryAnimated")}</p>

      {results === null ? (
        <Spinner label={t("common.loading")} />
      ) : error ? (
        <p className="py-4 text-sm text-muted">{error}</p>
      ) : (
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
          {results.map((item) => (
            <button
              key={item.id}
              onClick={() => onPick(item.url)}
              aria-pressed={current === item.url}
              title={item.source}
              className={`aspect-square overflow-hidden rounded-[10px] border ${
                current === item.url ? "border-accent" : "border-line hover:border-accent"
              }`}
            >
              <img src={item.preview} alt={item.source} loading="lazy" className="h-full w-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
