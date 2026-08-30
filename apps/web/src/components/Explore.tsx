/** Directorio de comunidades como sección completa del shell. */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Blocks,
  Compass,
  Search,
  Server,
  Trophy,
} from "lucide-react";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import {
  collectDirectory,
  directorySources,
  enterDirectoryCommunity,
  type DirectoryCommunity,
  type DirectoryListing,
} from "../lib/directory.ts";
import type { MessageKey } from "../i18n.ts";
import type { CommunityCategory } from "@distop/protocol";
import bannerArt from "./explore-banner.svg?raw";
import { Button, EmptyState, ErrorNote, IconButton, Spinner, useErrorText, useLocale, useT } from "./ui.tsx";

/** "home" no es una categoría, es la pestaña que no filtra. */
type ExploreCategory = "home" | CommunityCategory;

const CATEGORY_KEYS: Array<{ id: ExploreCategory; label: MessageKey }> = [
  { id: "home", label: "explore.category.home" },
  { id: "games", label: "explore.category.games" },
  { id: "music", label: "explore.category.music" },
  { id: "entertainment", label: "explore.category.entertainment" },
  { id: "science", label: "explore.category.science" },
  { id: "education", label: "explore.category.education" },
  { id: "students", label: "explore.category.students" },
  { id: "other", label: "explore.category.other" },
];

function searchable(community: DirectoryCommunity): string {
  return `${community.name} ${community.description ?? ""}`.toLocaleLowerCase();
}

/**
 * La categoría la declara quien crea la comunidad; aquí solo se compara. Antes
 * se adivinaba buscando palabras como "minecraft" o "radio" en el nombre y la
 * descripción, y eso ponía la misma comunidad en dos pestañas, fallaba en
 * cuanto estaba escrita en otro idioma y no había forma de corregirlo desde la
 * comunidad. Una ficha de un nodo viejo llega sin campo: cae en "other", que
 * es honesto —nadie eligió por ella— en vez de inventarle un tema.
 */
function visibleInCategory(community: DirectoryCommunity, category: ExploreCategory): boolean {
  if (category === "home") return true;
  return (community.category ?? "other") === category;
}

export function ExploreSidebar({
  onNavigate,
  onJoinWithLink,
}: {
  onNavigate?: () => void;
  onJoinWithLink: () => void;
}) {
  const t = useT();
  return (
    <aside data-pane="sidebar" className="flex min-h-0 flex-col border-r border-line bg-surface">
      <header className="flex h-14 shrink-0 items-center border-b border-line px-4">
        <h1 className="display text-lg font-bold">{t("explore.discover")}</h1>
      </header>
      <nav className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2" aria-label={t("explore.discover")}>
        <DiscoverItem icon={<Blocks size={20} />} label={t("explore.applications")} soon />
        <DiscoverItem icon={<Server size={20} />} label={t("explore.servers")} active onClick={onNavigate} />
        <DiscoverItem icon={<Trophy size={20} />} label={t("explore.missions")} soon />
      </nav>
      <div className="border-t border-line p-3">
        <Button className="w-full" onClick={onJoinWithLink}>{t("community.join")}</Button>
      </div>
    </aside>
  );
}

function DiscoverItem({
  icon,
  label,
  active = false,
  soon = false,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  soon?: boolean;
  onClick?: (() => void) | undefined;
}) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={soon}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      className={`flex min-h-12 items-center gap-3 rounded-[10px] px-3 text-left text-sm font-semibold transition-colors ${
        active ? "bg-raise text-ink" : "text-muted hover:bg-raise hover:text-ink disabled:cursor-default disabled:opacity-70"
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {soon ? <span className="rounded-full bg-sunken px-2 py-0.5 text-[0.62rem] font-bold tracking-wide uppercase">{t("explore.soon")}</span> : null}
    </button>
  );
}

export function Explore({
  onOpenSidebar,
  onLeave,
}: {
  onOpenSidebar: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const locale = useLocale();
  const errorText = useErrorText();
  const enabled = useStore((state) => state.publicDiscoveryEnabled);
  const directoryUrl = useStore((state) => state.directoryUrl);
  const reloadCommunities = useStore((state) => state.reloadCommunities);
  const openCommunity = useStore((state) => state.openCommunity);
  const mine = useStore((state) => state.communities);
  const [isHost, setIsHost] = useState(false);
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [joining, setJoining] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ExploreCategory>("home");

  useEffect(() => {
    let active = true;
    void api("GET", "/api/v1/instance/relay")
      .then(() => { if (active) setIsHost(true); })
      .catch(() => { if (active) setIsHost(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    setListing(null);
    setJoinError(null);
    if (!enabled && !directoryUrl) return () => { active = false; };
    void collectDirectory(directorySources({ localEnabled: enabled, directoryUrl }))
      .then((result) => { if (active) setListing(result); });
    return () => { active = false; };
  }, [enabled, directoryUrl]);

  const communities = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (listing?.communities ?? []).filter((community) =>
      visibleInCategory(community, category) && (!needle || searchable(community).includes(needle)),
    );
  }, [category, listing, query]);

  async function enter(community: DirectoryCommunity): Promise<void> {
    if (mine.some((item) => item.id === community.id)) {
      await openCommunity(community.id);
      onLeave();
      return;
    }
    if (community.join_policy !== "open" && community.join_policy !== "request") return;
    setJoining(community.id);
    setJoinError(null);
    try {
      const result = await enterDirectoryCommunity(community);
      if (result === "joined") {
        await reloadCommunities();
        await openCommunity(community.id);
        onLeave();
      } else if (result === "requested") {
        setJoinError(t("explore.requested"));
      } else if (result !== "switching") {
        setJoinError(t(result === "identity-mismatch" ? "explore.identityMismatch" : "explore.unreachable"));
      }
    } catch (error) {
      setJoinError(errorText(error));
    } finally {
      setJoining(null);
    }
  }

  const failure = listing && listing.communities.length === 0 ? listing.failures[0] : undefined;

  return (
    <main data-pane="main" className="relative flex min-h-0 flex-col overflow-hidden bg-bg">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Sticky y solapado con el hero: `backdrop-filter` necesita que el SVG
            exista realmente detrás del vidrio para poder muestrearlo. */}
        <header className="explore-glass-header sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b px-3">
          <IconButton label={t("common.back")} onClick={onOpenSidebar} className="min-[901px]:hidden"><ArrowLeft size={18} /></IconButton>
          <Compass size={18} className="hidden shrink-0 text-accent sm:block" />
          <nav className="tabs-scroll flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label={t("explore.categories")}>
            {CATEGORY_KEYS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={category === item.id ? "page" : undefined}
                onClick={() => setCategory(item.id)}
                className={`relative h-14 shrink-0 px-3 text-xs font-semibold transition-colors ${category === item.id ? "text-white" : "text-white/65 hover:text-white"}`}
              >
                {t(item.label)}
                {category === item.id ? <span className="absolute right-3 bottom-0 left-3 h-0.5 rounded-full bg-accent" aria-hidden /> : null}
              </button>
            ))}
          </nav>
          <label className="relative hidden w-56 shrink-0 md:block">
            <span className="sr-only">{t("explore.search")}</span>
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-white/60" />
            <input className="field explore-glass-search h-9 min-h-9 pl-9 text-sm text-white placeholder:text-white/55" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("explore.search")} />
          </label>
        </header>

        <section className="relative isolate -mt-14 flex min-h-80 items-center justify-center overflow-hidden border-b border-line px-5 pt-28 pb-14 sm:px-10 lg:min-h-[21.5rem] lg:px-16">
          {/* El fondo entero es el dibujo: trae su propio degradado, así que aquí
              no quedan capas de color sueltas. Va en línea y no como imagen de
              fondo para que el interruptor de movimiento reducido lo alcance:
              a un SVG servido como `background-image` no se le puede parar la
              animación desde fuera. */}
          <div className="hero-art absolute inset-0 -z-10" aria-hidden="true" dangerouslySetInnerHTML={{ __html: bannerArt }} />
          {/* Velo elíptico centrado: el dibujo mueve cubos de verde lima bajo el
              titular y blanco sobre lima da 1,3:1. Oscurece justo donde va el
              texto y deja las esquinas del dibujo a plena luz. */}
          <div className="absolute inset-0 -z-10 [background-image:radial-gradient(ellipse_60%_82%_at_50%_46%,rgba(11,13,41,0.9),rgba(11,13,41,0.62)_55%,transparent_88%)]" />
          <div className="mx-auto flex w-full max-w-7xl items-center justify-center">
            <div className="max-w-3xl text-center text-white">
              <h2 className="display hero-title text-4xl leading-[0.95] font-black tracking-tight uppercase sm:text-5xl lg:text-6xl">
                {t("explore.heroTitle")}
              </h2>
            </div>
          </div>
        </section>

        <section className="mx-auto flex w-full max-w-[90rem] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-10">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="display text-xl font-bold">{category === "home" ? t("explore.featured") : t(CATEGORY_KEYS.find((item) => item.id === category)!.label)}</h2>
              {listing ? <p className="mt-1 text-xs text-muted">{t("explore.results", { count: communities.length })}</p> : null}
            </div>
            <label className="relative min-w-0 flex-1 md:hidden">
              <span className="sr-only">{t("explore.search")}</span>
              <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
              <input className="field pl-9 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("explore.search")} />
            </label>
          </div>

          {!enabled && !directoryUrl ? (
            <EmptyState title={t("explore.disabled")} {...(isHost ? { hint: t("explore.disabledHostHint") } : {})} />
          ) : !listing ? (
            <Spinner label={t("common.loading")} />
          ) : failure ? (
            <ErrorNote>{errorText(failure.error)}</ErrorNote>
          ) : communities.length === 0 ? (
            <EmptyState title={query || category !== "home" ? t("explore.noResults") : t("explore.empty")} hint={query || category !== "home" ? t("explore.noResultsHint") : t("explore.emptyHint")} />
          ) : (
            /* `flex-wrap`, no grid: la referencia fija `width: 340px` en la
               propia tarjeta, y una rejilla con columnas elásticas la habría
               estirado o encogido según el hueco sobrante de cada fila. Con
               flexbox cada tarjeta mide siempre 340px y solo cambia cuántas
               caben por fila. */
            <ul className="flex flex-wrap gap-4">
              {communities.map((community) => {
                const own = mine.some((item) => item.id === community.id);
                const actionable = own || community.join_policy === "open" || community.join_policy === "request";
                /* El `group` vive en el <li> y no en la tarjeta a propósito:
                   quien se levanta al apuntar es la tarjeta, así que si ella
                   misma fuese el objetivo del hover se apartaría de debajo del
                   cursor. Con el ratón quieto en los 4px de abajo —justo lo que
                   sube— se perdía el hover y se recuperaba: un parpadeo. El
                   <li> es la celda de la rejilla y no se mueve nunca, así que
                   el estado deja de depender de la animación. */
                /* Clases y valores calcados de la referencia: mismos nombres
                   (discord-card, server-icon, dot...), mismos px, mismas
                   curvas — todo vive en styles.css tal cual. Lo único que no
                   podía copiarse literal es el contenido: la referencia trae
                   un "4.129 en línea" fijo, y la API del directorio no expone
                   ningún conteo de conectados ahora mismo, solo el total de
                   miembros. Se muestran dos datos reales (miembros y nodo de
                   origen) en el mismo hueco de dos `.status-item`, en vez de
                   inventar una cifra de gente conectada que no existe. */
                return (
                  <li key={`${community.origin ?? ""}:${community.id}`} className="group shrink-0">
                    <article className="discord-card">
                      <div className="banner-wrapper">
                        {community.banner_url ? <div className="card-banner" style={{ backgroundImage: `url(${JSON.stringify(community.banner_url)})` }} /> : <div className="card-banner" />}
                      </div>

                      <div className="card-content">
                        {community.icon_url ? (
                          <div className="server-icon" style={{ backgroundImage: `url(${JSON.stringify(community.icon_url)})` }} />
                        ) : (
                          <div className="server-icon grid place-items-center bg-accent text-white">
                            <span className="display text-xl font-black">{community.name.slice(0, 2).toLocaleUpperCase()}</span>
                          </div>
                        )}

                        <h3 className="server-name">
                          <span className="min-w-0 truncate">{community.name}</span>
                          {/* Trazado calcado del SVG de la referencia, no el icono
                              de Lucide: ese es de trazo (stroke) y el de la
                              referencia es macizo (fill), así que no valía con
                              cambiarle el color. */}
                          <svg className="badge-verified" viewBox="0 0 16 16" role="img" aria-label={t("explore.publicCommunity")}>
                            <path d="M14.6 7.4c.4-.4.4-1 0-1.4l-1.3-1.3c-.2-.2-.3-.5-.3-.7v-1.8c0-.6-.4-1-1-1h-1.8c-.3 0-.5-.1-.7-.3l-1.3-1.3c-.4-.4-1-.4-1.4 0l-1.3 1.3c-.2.2-.5.3-.7.3h-1.8c-.6 0-1 .4-1 1v1.8c0 .3-.1.5-.3.7l-1.3 1.3c-.4.4-.4 1 0 1.4l1.3 1.3c.2.2.3.5.3.7v1.8c0 .6.4 1 1 1h1.8c.3 0 .5.1.7.3l1.3 1.3c.4.4 1.4.4 1.4 0l1.3-1.3c.2-.2.5-.3.7-.3h1.8c.6 0 1-.4 1-1v-1.8c0-.3.1-.5.3-.7l1.3-1.3zm-7.6 3.1l-2.4-2.4 1.1-1.1 1.3 1.3 3.1-3.1 1.1 1.1-4.2 4.2z" />
                          </svg>
                        </h3>

                        <div className="server-status">
                          <span className="status-item">
                            <span aria-hidden="true" className="dot online" />
                            {new Intl.NumberFormat(locale).format(community.members)} {t("explore.membersShort")}
                          </span>
                          {community.origin ? (
                            <span className="status-item min-w-0">
                              <span aria-hidden="true" className="dot members" />
                              <span className="truncate">{new URL(community.origin).host}</span>
                            </span>
                          ) : null}
                        </div>

                        <p className="server-description">{community.description || t("explore.noDescription")}</p>

                        <p className="mt-2 text-[0.68rem] font-semibold text-muted">
                          {t(community.join_policy === "request" ? "explore.approvalRequired" : community.join_policy === "invite" ? "explore.inviteOnly" : "explore.openAccess")}
                        </p>

                        {actionable ? (
                          <button
                            type="button"
                            className="join-button"
                            disabled={joining !== null}
                            onClick={() => void enter(community)}
                          >
                            {joining === community.id ? t("common.loading") : t(own ? "explore.openMine" : community.join_policy === "request" ? "explore.request" : "explore.join")}
                          </button>
                        ) : null}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
          {joinError ? <ErrorNote>{joinError}</ErrorNote> : null}
          {listing && listing.communities.length > 0 && listing.failures.length > 0 ? <ErrorNote>{t("explore.partialFailure")}</ErrorNote> : null}
        </section>
      </div>
    </main>
  );
}
