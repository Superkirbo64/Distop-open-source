/**
 * Traducciones (§32). Ningún texto visible vive dentro de un componente.
 * Las claves faltantes caen a español en vez de romper la interfaz.
 */
import { es, type MessageKey } from "./locales/es.ts";

export const LOCALES = ["es", "pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  es: "Español",
  "pt-BR": "Português (Brasil)",
  en: "English",
};

/* Solo el español viaja en el bundle inicial: es la fuente tipada de las claves
   y el fallback, así que no puede faltar. Los otros dos llegan por loadLocale
   como chunks aparte, que la mayoría de sesiones nunca descarga. */
const DICTIONARIES: Partial<Record<Locale, Record<MessageKey, string>>> = { es };

export type { MessageKey };

/**
 * Descarga en diferido el diccionario de un idioma. Los import() van con rutas
 * literales para que Vite pueda partir cada locale en su propio chunk; con una
 * ruta calculada los metería todos juntos. Idempotente: pedir un idioma ya
 * cargado (o el español) no vuelve a la red.
 */
export async function loadLocale(locale: Locale): Promise<void> {
  if (DICTIONARIES[locale]) return;
  if (locale === "en") DICTIONARIES.en = (await import("./locales/en.ts")).en;
  else if (locale === "pt-BR") DICTIONARIES["pt-BR"] = (await import("./locales/pt-BR.ts")).ptBR;
}

export function translate(locale: Locale, key: MessageKey, vars?: Record<string, string | number>): string {
  // Mientras el chunk del idioma no haya llegado se enseña español, no la clave.
  const template = DICTIONARIES[locale]?.[key] ?? es[key] ?? key;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => String(vars[name] ?? match));
}

export function detectLocale(): Locale {
  const stored = localStorage.getItem("distop.locale");
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;

  for (const preferred of navigator.languages ?? [navigator.language]) {
    if (preferred.startsWith("pt")) return "pt-BR";
    if (preferred.startsWith("en")) return "en";
    if (preferred.startsWith("es")) return "es";
  }
  return "es";
}

/** Formatos regionales: fechas, números y tamaños siguen el idioma elegido (§32). */
export function formatTime(locale: Locale, ms: number): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(ms);
}

export function formatDate(locale: Locale, ms: number): string {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(ms);
}

export function formatDayHeading(locale: Locale, ms: number): string {
  const day = new Date(ms);
  const today = new Date();
  const sameDay = day.toDateString() === today.toDateString();
  if (sameDay) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "day");

  const yesterday = new Date(today.getTime() - 86_400_000);
  if (day.toDateString() === yesterday.toDateString())
    return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(-1, "day");

  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric" }).format(ms);
}

export function formatBytes(locale: Locale, bytes: number): string {
  const units = ["B", "kB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${units[unit]}`;
}

export function formatDuration(locale: Locale, seconds: number): string {
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "narrow" });
  const table: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, size] of table) {
    if (seconds >= size) return format.format(Math.floor(seconds / size), unit).replace(/^\D+/, "");
  }
  return format.format(seconds, "second").replace(/^\D+/, "");
}
