/**
 * Selector de expresiones: emojis, stickers y GIF en un solo panel (§10.3, §12).
 *
 * Tres pestañas y no tres botones distintos porque son la misma decisión —"qué
 * pongo aquí"— y separarlas obliga a recordar cuál abre cuál. La de GIF solo
 * aparece si el anfitrión configuró la clave: una pestaña que siempre falla es
 * peor que ninguna pestaña (§29.3).
 *
 * Lo que se elige NO se envía solo: se inserta en la caja de escritura. Así se
 * puede acompañar de texto, corregir, o arrepentirse, que es lo que se espera
 * de un teclado y no de un botón de disparo.
 *
 * La rejilla pinta el emoji del sistema, quieto. La versión animada se ve al
 * enviarlo, no al elegirlo: cada animación es un JSON de ~79 KB y un bucle de
 * lottie corriendo, y con el catálogo entero delante eso era abrir el selector
 * y esperar. Elegir tiene que ser instantáneo (§10.3).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { PERMISSIONS, has, toBits, type CustomEmoji } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Spinner, useLocale, useT } from "./ui.tsx";
import type { MessageKey } from "../i18n.ts";
import { EMOJI_GROUPS, type EmojiGroupKey } from "../lib/emojiCatalog.generated.ts";
import { POPULAR_EMOJI } from "../lib/emojiPopular.ts";
import { emojiIndexCargado, emojiName, loadEmojiIndex, searchEmoji, type EmojiIndex } from "../lib/emojiIndex.ts";

type Tab = "emoji" | "sticker" | "gif";

/** Un emoji por grupo como pestaña: se reconoce de un vistazo, y cabe. */
const GROUP_ICON: Record<EmojiGroupKey, string> = {
  smileys: "🙂",
  people: "🧑",
  nature: "🐻",
  food: "🍔",
  travel: "✈️",
  activities: "⚽",
  objects: "💡",
  symbols: "🔣",
  flags: "🏁",
};

/**
 * Cuántos emojis se pintan de golpe, y cuántos se añaden al llegar al final.
 * Los 1900 del catálogo son 1900 botones: montarlos todos de una tarda lo suyo
 * en un equipo modesto, y nadie mira más allá de la primera pantalla.
 */
const CHUNK = 240;

/**
 * ¿Dibuja este sistema las banderas? Windows no trae glifos de bandera en su
 * fuente de emoji: 🇧🇷 sale como dos letras sueltas, "BR". No se arregla desde
 * el cliente —haría falta embarcar una fuente de emojis entera— así que se
 * dice, que es lo honesto: quien las reciba en un móvil sí las ve dibujadas
 * (§29.3). Una bandera de verdad ocupa lo que cualquier emoji; dos letras, no.
 */
let banderasDibujadas: boolean | undefined;

function dibujaBanderas(): boolean {
  if (banderasDibujadas !== undefined) return banderasDibujadas;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return (banderasDibujadas = true);
    ctx.font = "16px sans-serif";
    banderasDibujadas = ctx.measureText("🇧🇷").width >= ctx.measureText("🍕").width * 0.9;
  } catch {
    // Sin canvas (o con él capado) no se adivina: mejor no avisar de nada.
    banderasDibujadas = true;
  }
  return banderasDibujadas;
}

interface Gif {
  id: string;
  url: string;
  preview: string;
  title: string;
}

/** Cuántos usados recientemente se recuerdan. Vive en este dispositivo. */
const RECENT_MAX = 20;
const RECENT_KEY = "distop.recentEmoji";

function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function rememberEmoji(token: string): void {
  const lista = [token, ...loadRecent().filter((x) => x !== token)].slice(0, RECENT_MAX);
  localStorage.setItem(RECENT_KEY, JSON.stringify(lista));
}

export function Picker({
  onPick,
  onPickGif,
  onClose,
}: {
  /** Texto a insertar: un emoji Unicode o `<:nombre:id>`. */
  onPick: (token: string) => void;
  /** Un GIF no es texto: hay que traérselo a la instancia y adjuntarlo. */
  onPickGif: (gif: Gif) => void;
  onClose: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const expressions = useStore((s) => s.expressions);
  const communities = useStore((s) => s.communities);
  const gifEnabled = useStore((s) => s.gifEnabled);
  /* La galeria de stickers va con su propia clave (Klipy), no con la de GIF:
     un anfitrion puede querer stickers y no GIF, o al reves. */
  const galeriaStickers = useStore((s) => s.stickerGalleryEnabled);
  const setManageOpen = useStore((s) => s.setManageOpen);
  const activeCommunityId = useStore((s) => s.activeCommunityId);
  const activeData = useStore((s) => (s.activeCommunityId ? s.data[s.activeCommunityId] : undefined));
  const puedeSubir = activeData ? has(toBits(activeData.permissions), PERMISSIONS.MANAGE_COMMUNITY) : false;

  const [tab, setTab] = useState<Tab>("emoji");
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(loadRecent);
  const [gifs, setGifs] = useState<Gif[] | null>(null);
  const [gifError, setGifError] = useState<string | null>(null);
  const [packHelpOpen, setPackHelpOpen] = useState(false);
  /* Grupo elegido en la tira de categorías, o todos seguidos si no hay ninguno. */
  const [grupo, setGrupo] = useState<EmojiGroupKey | null>(null);
  const [visible, setVisible] = useState(CHUNK);
  /* Nombres y palabras clave del idioma activo: llegan en diferido y hasta
     entonces la rejilla ya se puede usar, solo que sin buscador ni tooltips. */
  const [index, setIndex] = useState<EmojiIndex | undefined>(() => emojiIndexCargado(locale));
  const busca = useRef<HTMLInputElement>(null);
  const lista = useRef<HTMLDivElement>(null);

  useEffect(() => {
    busca.current?.focus();
  }, [tab]);

  useEffect(() => {
    if (tab !== "emoji") return;
    const ya = emojiIndexCargado(locale);
    if (ya) {
      setIndex(ya);
      return;
    }
    let vivo = true;
    setIndex(undefined);
    // Sin índice el selector sigue sirviendo: se pierde la búsqueda, no la rejilla.
    void loadEmojiIndex(locale).then((cargado) => {
      if (vivo) setIndex(cargado);
    });
    return () => {
      vivo = false;
    };
  }, [tab, locale]);

  /* Dos servicios distintos —Giphy para GIF, Klipy para stickers— pero el
     servidor devuelve los dos en el mismo formato, asi que aqui comparten
     estado y efecto en vez de duplicarlos. */
  useEffect(() => {
    if (tab !== "gif" && tab !== "sticker") return;
    if (tab === "sticker" && !galeriaStickers) return;
    setGifs(null);
    setGifError(null);
    const timer = setTimeout(() => {
      const endpoint = tab === "gif" ? "/api/v1/gifs" : "/api/v1/stickers/gallery";
      api<Gif[]>("GET", `${endpoint}?q=${encodeURIComponent(query.trim())}`)
        .then(setGifs)
        .catch(() => {
          setGifs([]);
          setGifError(t("picker.gifError"));
        });
    }, 300);
    return () => clearTimeout(timer);
  }, [tab, query, t, galeriaStickers]);

  const filtro = query.trim().toLowerCase();

  /* Agrupados por comunidad, como en cualquier selector con varios orígenes: sin
     la cabecera no se sabe de dónde sale cada uno ni por qué está disponible. */
  const porComunidad = useMemo(() => {
    const kind = tab === "sticker" ? "sticker" : "emoji";
    const grupos = new Map<string, CustomEmoji[]>();
    for (const emoji of expressions) {
      if (emoji.kind !== kind) continue;
      if (filtro && !emoji.name.toLowerCase().includes(filtro)) continue;
      grupos.set(emoji.community_id, [...(grupos.get(emoji.community_id) ?? []), emoji]);
    }
    return [...grupos.entries()].map(([id, lista]) => ({
      id,
      nombre: communities.find((c) => c.id === id)?.name ?? "…",
      lista,
    }));
  }, [expressions, tab, filtro, communities]);

  /* Búsqueda sobre el catálogo entero, ignorando el grupo elegido: quien
     escribe "pizza" quiere la pizza, no que se le recuerde que estaba mirando
     las banderas. Solo en la pestaña de Emojis: en Stickers y GIF el texto es
     para la galería remota. */
  const resultados = useMemo(
    () => (tab === "emoji" && filtro ? searchEmoji(index, filtro) : []),
    [tab, filtro, index],
  );

  /* Las secciones de emojis Unicode, en el orden en que se pintan. Los
     populares solo cuando no hay ni búsqueda ni grupo: son un atajo a lo de
     siempre, no una categoría más que estorbe cuando ya se está buscando. */
  const secciones = useMemo<Array<{ key: string; titulo: string; emojis: readonly string[] }>>(() => {
    if (tab !== "emoji") return [];
    if (filtro) {
      return resultados.length > 0 ? [{ key: "resultados", titulo: t("picker.results"), emojis: resultados }] : [];
    }
    const grupos = EMOJI_GROUPS.filter((g) => !grupo || g.key === grupo).map((g) => ({
      key: g.key,
      titulo: t(`picker.group.${g.key}` as MessageKey),
      emojis: g.emojis,
    }));
    return grupo ? grupos : [{ key: "populares", titulo: t("picker.popular"), emojis: POPULAR_EMOJI }, ...grupos];
  }, [tab, filtro, resultados, grupo, t]);

  const totalUnicode = useMemo(() => secciones.reduce((n, s) => n + s.emojis.length, 0), [secciones]);

  /* Se pinta hasta donde se ha bajado y ni un botón más. Cambiar de grupo, de
     búsqueda o de pestaña vuelve a empezar, y también arriba del todo: si no,
     se cambia de categoría y se sigue viendo el hueco del scroll anterior. */
  useEffect(() => {
    setVisible(CHUNK);
    lista.current?.scrollTo({ top: 0 });
  }, [filtro, grupo, tab]);

  const visibles = useMemo(() => {
    const salida: Array<{ key: string; titulo: string; emojis: readonly string[] }> = [];
    let pintados = 0;
    for (const seccion of secciones) {
      if (pintados >= visible) break;
      const trozo = seccion.emojis.slice(0, visible - pintados);
      salida.push({ ...seccion, emojis: trozo });
      pintados += trozo.length;
    }
    return salida;
  }, [secciones, visible]);

  function alDesplazar(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight > 240) return;
    setVisible((actual) => (actual >= totalUnicode ? actual : Math.min(actual + CHUNK, totalUnicode)));
  }

  function elegir(token: string) {
    rememberEmoji(token);
    setRecent(loadRecent());
    onPick(token);
  }

  const tabs: Array<[Tab, string]> = [
    ["emoji", t("picker.emojis")],
    ["sticker", t("picker.stickers")],
    ...(gifEnabled ? ([["gif", "GIF"]] as Array<[Tab, string]>) : []),
  ];

  return (
    <div className="flex h-[26rem] w-[22rem] max-w-[92vw] flex-col overflow-hidden">
      <div className="flex items-center gap-1 border-b border-line p-1.5">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            aria-pressed={tab === id}
            className={`rounded-[10px] px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === id ? "bg-accent-soft text-accent" : "text-muted hover:bg-raise hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
        <span className="flex-1" />
        <button onClick={onClose} aria-label={t("common.close")} className="p-1 text-muted hover:text-ink">
          <X size={16} />
        </button>
      </div>

      <div className="border-b border-line p-2 flex flex-col">
        <div className="flex items-center gap-2 rounded-[10px] border border-line bg-bg px-2 py-1.5 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            ref={busca}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(tab === "gif" ? "picker.searchGif" : tab === "sticker" ? "picker.searchSticker" : "picker.search")}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
          />
        </div>
        {/* Tira de categorías: con 1900 emojis, bajar en línea recta hasta las
            banderas no es navegar. Se esconde al buscar, que entonces el
            catálogo entero ya está en juego y el grupo no pinta nada. */}
        {tab === "emoji" && !filtro ? (
          <div className="mt-2 flex gap-1 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "none" }}>
            <button
              onClick={() => setGrupo(null)}
              aria-pressed={grupo === null}
              className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                grupo === null ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-ink"
              }`}
            >
              {t("picker.group.all")}
            </button>
            {EMOJI_GROUPS.map((g) => {
              const nombre = t(`picker.group.${g.key}` as MessageKey);
              return (
                <button
                  key={g.key}
                  onClick={() => setGrupo(g.key)}
                  aria-pressed={grupo === g.key}
                  aria-label={nombre}
                  title={nombre}
                  className={`grid h-7 w-7 shrink-0 place-items-center rounded-full border text-sm transition-colors ${
                    grupo === g.key ? "border-accent bg-accent-soft" : "border-line hover:border-accent"
                  }`}
                >
                  {GROUP_ICON[g.key]}
                </button>
              );
            })}
          </div>
        ) : null}
        {tab === "gif" ? (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5" style={{ scrollbarWidth: "none" }}>
            {["Tendencias", "LOL", "OMG", "Angry", "Sad", "Dance", "Fail"].map((cat) => {
              const active = query.toLowerCase() === (cat === "Tendencias" ? "" : cat.toLowerCase());
              return (
                <button
                  key={cat}
                  onClick={() => setQuery(cat === "Tendencias" ? "" : cat)}
                  className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
                    active ? "border-accent bg-accent-soft text-accent" : "border-line text-muted hover:border-accent hover:text-ink"
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div ref={lista} onScroll={tab === "emoji" ? alDesplazar : undefined} className="flex-1 overflow-y-auto p-2">
        {tab === "emoji" && recent.length > 0 && !filtro ? (
          <Section title={t("picker.recent")}>
            {recent.map((token) => (
              <TokenButton key={token} token={token} expressions={expressions} index={index} onPick={elegir} />
            ))}
          </Section>
        ) : null}

        {/* Los propios de la comunidad (emoji o sticker subido a mano, o
            importado de Telegram): no aplica a la pestaña GIF, que no guarda nada. */}
        {tab !== "gif"
          ? porComunidad.map((grupo) => (
              <Section key={grupo.id} title={grupo.nombre}>
                {grupo.lista.map((emoji) => (
                  <button
                    key={emoji.id}
                    onClick={() => elegir(`<:${emoji.name}:${emoji.id}>`)}
                    title={`:${emoji.name}:`}
                    className={`grid place-items-center rounded-lg hover:bg-raise ${
                      tab === "sticker" ? "h-20 w-20 p-1" : "h-9 w-9 p-1"
                    }`}
                  >
                    <img src={emoji.url} alt={`:${emoji.name}:`} loading="lazy" className="max-h-full max-w-full" />
                  </button>
                ))}
              </Section>
            ))
          : null}

        {/* El catálogo Unicode: el carácter tal cual, sin lottie ni imágenes.
            Lo pinta la fuente del sistema, que es lo que ya sabe hacer. */}
        {visibles.map((seccion) => (
          <Section
            key={seccion.key}
            title={seccion.titulo}
            note={seccion.key === "flags" && !dibujaBanderas() ? t("picker.flagsUnsupported") : undefined}
          >
            {seccion.emojis.map((emoji) => (
              <button
                key={emoji}
                onClick={() => elegir(emoji)}
                title={emojiName(index, emoji)}
                className="grid h-9 w-9 place-items-center rounded-lg text-lg hover:bg-raise"
              >
                {emoji}
              </button>
            ))}
          </Section>
        ))}

        {/* Buscar con el índice a medio llegar no encuentra nada; decirlo es
            más honesto que enseñar "nada por aquí" y que aparezca solo. */}
        {tab === "emoji" && filtro && !index ? <Spinner label={t("common.loading")} /> : null}

        {/* Créditos: los nombres y las palabras con que se busca salen de CLDR,
            y las animaciones que se ven al enviar, de Noto (CC BY 4.0 exige
            citarla). Nada que pagar, pero sí algo que decir. */}
        {tab === "emoji" ? <p className="px-1 pt-1 text-[0.65rem] text-muted">{t("picker.animatedCredit")}</p> : null}

        {/* Galería buscable: Giphy en GIF, Klipy en Sticker, cada una con su
            clave. Nada de pack por nombre — se escribe y aparece, como el
            buscador de fondos. */}
        {tab === "gif" || (tab === "sticker" && galeriaStickers) ? (
          <>
            {porComunidad.length > 0 ? (
              <h4 className="mb-1 px-1 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
                {t("picker.gallery")}
              </h4>
            ) : null}
            {gifs === null ? (
              <Spinner label={t("common.loading")} />
            ) : gifError ? (
              <p className="py-8 text-center text-sm text-muted">{gifError}</p>
            ) : gifs.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">{t("picker.empty")}</p>
            ) : (
              // Dos columnas y altura libre: un GIF o sticker apaisado recortado
              // a cuadrado deja de contar el chiste que lo hacía elegible.
              <div className="columns-2 gap-2">
                {gifs.flatMap((gif, i) => {
                  const node = (
                    <button
                      key={gif.id}
                      onClick={() => onPickGif(gif)}
                      className="mb-2 block w-full overflow-hidden rounded-[10px] border border-line hover:border-accent"
                    >
                      <img src={gif.preview} alt={gif.title} loading="lazy" className="w-full" />
                    </button>
                  );
                  const ad = (i + 1) % 8 === 0 ? (
                    <div key={`ad-${i}`} className="mb-2 flex aspect-video w-full items-center justify-center rounded-[10px] border border-accent bg-accent-soft p-2 text-center text-[0.65rem] font-bold text-accent uppercase">
                      Anuncio Promocionado
                    </div>
                  ) : null;
                  return ad ? [node, ad] : [node];
                })}
              </div>
            )}
          </>
        ) : null}

        {tab === "sticker" && !galeriaStickers && porComunidad.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t("picker.noStickers")}</p>
        ) : null}

        {/* Subir los propios, con el formato dicho ANTES de ir a buscarlo: la
            mitad de los intentos fallidos son un SVG o un nombre con espacios,
            y enterarse al pulsar "guardar" es enterarse tarde. Va aqui, en el
            selector, porque es donde se descubre que faltan. */}
        {tab === "sticker" ? (
          <section className="mt-3 overflow-hidden rounded-[10px] border border-line bg-surface">
            <button
              type="button"
              aria-expanded={packHelpOpen}
              onClick={() => setPackHelpOpen((current) => !current)}
              className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left text-xs font-semibold transition-colors hover:bg-raise"
            >
              {t("picker.addPack")}
              <ChevronDown
                size={15}
                className={`shrink-0 text-muted transition-transform ${packHelpOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </button>
            {packHelpOpen ? (
              <div className="border-t border-line px-3 pb-3">
                <p className="mt-2 text-[0.7rem] leading-relaxed text-muted">{t("picker.addPackFormat")}</p>
                {puedeSubir && activeCommunityId ? (
                  <button
                    onClick={() => {
                      setManageOpen(true);
                      onClose();
                    }}
                    className="mt-2 w-full rounded-[10px] border border-line px-2 py-1.5 text-xs font-medium transition-colors hover:border-accent hover:bg-accent-soft"
                  >
                    {t("picker.addPackGo")}
                  </button>
                ) : (
                  <p className="mt-2 text-[0.7rem] text-muted">{t("picker.addPackNoPermission")}</p>
                )}
              </div>
            ) : null}
          </section>
        ) : null}

        {tab === "emoji" && porComunidad.length === 0 && visibles.length === 0 && (!filtro || index) ? (
          <p className="py-8 text-center text-sm text-muted">{t("picker.empty")}</p>
        ) : null}
      </div>

    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  /** Lo que haya que advertir de esta sección antes de que se note solo. */
  note?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-3">
      <h4 className="mb-1 px-1 text-[0.7rem] font-semibold tracking-wider text-muted uppercase">{title}</h4>
      {note ? <p className="mb-1.5 px-1 text-[0.65rem] leading-relaxed text-muted">{note}</p> : null}
      <div className="flex flex-wrap gap-0.5">{children}</div>
    </section>
  );
}

/** Un reciente puede ser Unicode o propio; y el propio puede haberse borrado. */
function TokenButton({
  token,
  expressions,
  index,
  onPick,
}: {
  token: string;
  expressions: CustomEmoji[];
  index: EmojiIndex | undefined;
  onPick: (token: string) => void;
}) {
  if (!token.startsWith("<:")) {
    return (
      <button
        onClick={() => onPick(token)}
        title={emojiName(index, token)}
        className="grid h-9 w-9 place-items-center rounded-lg text-lg hover:bg-raise"
      >
        {token}
      </button>
    );
  }

  const id = token.slice(token.lastIndexOf(":") + 1, -1);
  const emoji = expressions.find((e) => e.id === id);
  if (!emoji) return null;

  return (
    <button
      onClick={() => onPick(token)}
      title={`:${emoji.name}:`}
      className="grid h-9 w-9 place-items-center rounded-lg p-1 hover:bg-raise"
    >
      <img src={emoji.url} alt={`:${emoji.name}:`} loading="lazy" className="max-h-full max-w-full" />
    </button>
  );
}
