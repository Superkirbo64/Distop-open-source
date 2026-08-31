/**
 * Panel de canales de la comunidad activa.
 * Lo que no puedes usar no se pinta apagado: si no tienes VIEW_CHANNEL el canal
 * simplemente no llega desde la instancia.
 *
 * La forma de operar la lista sigue lo que la gente ya tiene aprendido de
 * Discord —clic para entrar, clic derecho para el menú, engranaje al pasar el
 * ratón, arrastrar para reordenar, categoría contraída que aun así deja ver lo
 * que tiene mensajes— con dos diferencias deliberadas:
 *
 * 1. El segundo clic sobre el canal que ya está abierto abre sus ajustes. En
 *    Discord ese clic no hace nada, y el engranaje no existe si no hay ratón.
 * 2. Todo lo que se puede hacer arrastrando se puede hacer también desde el
 *    menú (subir, bajar, mover de categoría): arrastrar no funciona con teclado
 *    ni es cómodo en táctil, y §31 no admite una función que solo exista para
 *    quien usa ratón.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarClock,
  Check,
  ChevronDown,
  Copy,
  CopyPlus,
  Pencil,
  Settings,
  Trash2,
  UserPlus,
} from "lucide-react";
import { Announcement, ChannelHash, Cross, Speaker } from "./icons.tsx";
import { PERMISSIONS, has, toBits, type Category, type Channel } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import {
  Button,
  ContextMenu,
  ErrorNote,
  Field,
  Menu,
  MenuItem,
  Modal,
  Select,
  Tooltip,
  useConfirm,
  useT,
  useErrorText,
} from "./ui.tsx";
import { CategorySettings, ChannelSettings } from "./ChannelSettings.tsx";
import { VoiceParticipants } from "./Voice.tsx";
import { CreateMeeting } from "./Meeting.tsx";
import { joinVoice } from "../lib/voice.ts";

/* Una reunión lleva reloj y no altavoz: el altavoz ya significa "sala de voz
   de siempre", y confundir las dos es confundir "esto está abierto todo el día"
   con "esto empieza a las seis y termina". */
const ICONS = {
  /* Solo aquí el hash hace un zoom mínimo al señalarlo (.ai-zoom,
     styles.css): en la cabecera del chat el mismo icono se queda quieto. */
  text: ({ size, className }: { size?: number; className?: string }) => (
    <ChannelHash size={size ?? 18} className={className ? `ai-zoom ${className}` : "ai-zoom"} />
  ),
  voice: Speaker,
  announcement: Announcement,
  meeting: ({ size, className }: { size?: number; className?: string }) => (
    <CalendarClock size={size ?? 16} className={className} />
  ),
} as const;

/** Dónde caería lo que se arrastra: encima o debajo de esa fila. */
type Drop = { id: string; where: "before" | "after" };

/** Qué abrió el menú contextual. Uno solo a la vez, como en cualquier escritorio. */
type Contexto =
  | { at: { x: number; y: number }; kind: "channel"; channel: Channel }
  | { at: { x: number; y: number }; kind: "category"; category: Category };

export function Sidebar({
  onOpenManage,
  onOpenInvite,
  onNavigate,
}: {
  onOpenManage: () => void;
  onOpenInvite: () => void;
  onNavigate?: () => void;
}) {
  const t = useT();
  const { confirm, element: confirmElement } = useConfirm();
  const errorText = useErrorText();

  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const activeChannelId = useStore((s) => s.activeChannelId);
  const openChannel = useStore((s) => s.openChannel);
  const catchUp = useStore((s) => s.catchUp);
  const user = useStore((s) => s.user);
  const voiceRooms = useStore((s) => s.voice);
  const unread = useStore((s) => s.unread);
  const meetings = useStore((s) => s.meetings);
  const loadMeetings = useStore((s) => s.loadMeetings);

  const [creating, setCreating] = useState<{ category: string | null } | null>(null);
  const [convocando, setConvocando] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [editando, setEditando] = useState<Channel | null>(null);
  const [editandoCategoria, setEditandoCategoria] = useState<Category | null>(null);
  const [menu, setMenu] = useState<Contexto | null>(null);
  const [error, setError] = useState<string | null>(null);

  /* Arrastre: qué se mueve y dónde caería. Vive aquí y no en cada fila porque
     el destino es siempre una fila distinta de la que arrastra.

     Lo que se arrastra va además en una referencia: `dragover` y `drop` tienen
     que saberlo YA, y el estado solo está disponible tras repintar. En un
     arrastre humano da tiempo de sobra, pero depender de eso es apostar a que
     React no agrupe dos eventos en la misma tarea. La referencia manda; el
     estado solo existe para apagar la fila que viaja. */
  const arrastrado = useRef<string | null>(null);
  const caida = useRef<Drop | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<Drop | null>(null);

  /* Sin los estados no se puede separar lo vivo de lo terminado, y los canales
     del bootstrap no los traen. Una petición por comunidad; los cambios
     posteriores llegan solos por MEETING_UPDATE. */
  const historialDe = useRef<string | null>(null);
  const hayReuniones = data?.channels.some((channel) => channel.kind === "meeting") ?? false;
  useEffect(() => {
    if (!communityId || !hayReuniones || historialDe.current === communityId) return;
    historialDe.current = communityId;
    void loadMeetings(communityId);
  }, [communityId, hayReuniones, loadMeetings]);

  if (!communityId || !data) {
    return (
      <div data-pane="sidebar" className="hidden w-full rounded-br-card border-r border-line bg-surface wide:block" aria-hidden="true" />
    );
  }

  const permissions = toBits(data.permissions);
  const canManageChannels = has(permissions, PERMISSIONS.MANAGE_CHANNELS);
  /* Permiso propio y no MANAGE_CHANNELS: convocar una reunión no es crear un
     canal, y quien organiza la agenda no tiene por qué poder rehacer el
     servidor entero. */
  const canCallMeetings = has(permissions, PERMISSIONS.MANAGE_MEETINGS);
  const canInvite = has(permissions, PERMISSIONS.CREATE_INVITE);
  const canManage = has(permissions, PERMISSIONS.MANAGE_COMMUNITY) || has(permissions, PERMISSIONS.MANAGE_ROLES);

  /* Las reuniones se apartan de la lista de canales y viven en su propia
     sección. Una reunión empieza y termina; un canal está siempre. Mezclarlas
     dejaría la barra lateral llena de reuniones de la semana pasada, y hay que
     poder mirar los canales sin ver una agenda. */
  const esReunion = (channel: Channel) => channel.kind === "meeting";

  /* Por `position` y no por el orden en que llegaron: la instancia ordena así,
     y sin ordenar también aquí, arrastrar una fila no movía nada hasta
     recargar — CHANNEL_UPDATE sustituye el canal en el sitio que ya ocupaba. */
  const conversacion = data.channels
    .filter((channel) => !esReunion(channel))
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const reuniones = data.channels.filter(esReunion);

  /* Una reunión terminada no es basura ni agenda: es acta (§8.4). Se aparta al
     historial de Ajustes → Reuniones en vez de quedarse mezclada con las
     próximas en la barra lateral. */
  const terminada = (channel: Channel) => {
    const meeting = meetings[channel.id];
    return !!meeting && (meeting.state === "ENDED" || meeting.state === "CANCELLED");
  };
  const reunionesVivas = reuniones.filter((channel) => !terminada(channel));

  const categorias = data.categories.slice().sort((a, b) => a.position - b.position);
  const uncategorised = conversacion.filter((channel) => !channel.category_id);

  /** La lista tal y como se pinta, en grupos: es el orden que hay que conservar al mover. */
  const grupos: { id: string | null; channels: Channel[] }[] = [
    { id: null, channels: uncategorised },
    ...categorias.map((category) => ({
      id: category.id,
      channels: conversacion.filter((channel) => channel.category_id === category.id),
    })),
  ];
  const grouped = categorias
    .map((category) => ({ category, channels: conversacion.filter((c) => c.category_id === category.id) }))
    .filter((group) => group.channels.length > 0 || canManageChannels);

  async function leave() {
    if (!(await confirm(t("community.leaveConfirm")))) return;
    await api("POST", `/api/v1/communities/${communityId}/leave`);
  }

  /**
   * Deja un canal en otro sitio y renumera lo que haga falta.
   *
   * La instancia guarda una sola `position` por comunidad, así que mover una
   * fila puede correr a las de debajo. Se manda solo lo que de verdad cambia:
   * cada PATCH avisa por WebSocket a toda la comunidad, y renumerar la lista
   * entera en cada arrastre sería una tormenta de eventos para nada.
   */
  async function reordenar(channel: Channel, categoria: string | null, indice: number) {
    const sinEl = grupos.map((grupo) => ({
      id: grupo.id,
      channels: grupo.channels.filter((c) => c.id !== channel.id),
    }));
    const destino = sinEl.find((grupo) => grupo.id === categoria);
    if (!destino) return;
    destino.channels.splice(Math.max(0, Math.min(indice, destino.channels.length)), 0, channel);

    const plano = sinEl.flatMap((grupo) => grupo.channels.map((c) => ({ channel: c, categoria: grupo.id })));
    setError(null);
    try {
      await Promise.all(
        plano.flatMap(({ channel: c, categoria: destinoId }, i) =>
          c.position === i && (c.category_id ?? null) === destinoId
            ? []
            : [api("PATCH", `/api/v1/channels/${c.id}`, { position: i, category_id: destinoId })],
        ),
      );
    } catch (err) {
      setError(errorText(err));
    }
  }

  /** Subir y bajar del menú: lo mismo que arrastrar, pero llegando con teclado (§31). */
  async function desplazar(channel: Channel, delta: number) {
    const grupo = grupos.find((g) => g.id === (channel.category_id ?? null));
    if (!grupo) return;
    const desde = grupo.channels.findIndex((c) => c.id === channel.id);
    const hasta = desde + delta;
    if (desde < 0 || hasta < 0 || hasta >= grupo.channels.length) return;
    await reordenar(channel, channel.category_id ?? null, hasta);
  }

  async function duplicar(channel: Channel) {
    setError(null);
    try {
      await api("POST", `/api/v1/communities/${communityId}/channels`, {
        name: channel.name,
        kind: channel.kind,
        category_id: channel.category_id,
        topic: channel.topic,
      });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function eliminarCanal(channel: Channel) {
    if (!(await confirm(t("channel.deleteConfirm")))) return;
    setError(null);
    try {
      await api("DELETE", `/api/v1/channels/${channel.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function eliminarCategoria(category: Category) {
    if (!(await confirm(t("category.deleteConfirm")))) return;
    setError(null);
    try {
      await api("DELETE", `/api/v1/categories/${category.id}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  function abrir(channel: Channel) {
    /* Segundo clic sobre el que ya está abierto = sus ajustes. Solo para quien
       puede cambiarlos: abrir un panel que no se deja tocar es una promesa
       falsa, así que sin MANAGE_CHANNELS el segundo clic no hace nada. */
    if (channel.id === activeChannelId && canManageChannels) {
      setEditando(channel);
      return;
    }
    void openChannel(channel.id);
    // En un canal de voz, un clic entra en la llamada: es lo que se espera.
    if (channel.kind === "voice") void joinVoice(channel.id);
    onNavigate?.();
  }

  function renderChannel(channel: Channel) {
    const Icon = ICONS[channel.kind];
    const active = channel.id === activeChannelId;
    const inRoom = voiceRooms[channel.id] ?? [];

    /* Dos avisos distintos, no uno más fuerte: el punto dice "aquí ha pasado
       algo" y el número dice "te han nombrado". Mezclarlos en un solo contador
       obliga a entrar en el canal para saber si te tocaba a ti. */
    const pending = unread[channel.id];
    const mentions = pending?.mentions ?? 0;
    const hasUnread = (pending?.count ?? 0) > 0;

    /* Un canal de voz con gente dentro deja de ser una fila y pasa a ser un
       bloque: el canal, quién está hablando y cómo meter a alguien más, todo
       sobre el mismo fondo. Suelto, la lista de participantes parecía colgar
       del canal siguiente. */
    const enLlamada = channel.kind === "voice" && inRoom.length > 0;
    const yoDentro = inRoom.some((state) => state.user_id === user?.id);

    const acciones = canManageChannels || canInvite;
    const marca = dropAt?.id === channel.id ? dropAt.where : null;

    return (
      <li
        key={channel.id}
        draggable={canManageChannels && !esReunion(channel)}
        onDragStart={(event) => {
          arrastrado.current = channel.id;
          setDragId(channel.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", channel.id);
        }}
        onDragEnd={() => {
          arrastrado.current = null;
          caida.current = null;
          setDragId(null);
          setDropAt(null);
        }}
        onDragOver={(event) => {
          const viajero = arrastrado.current;
          if (!viajero || viajero === channel.id || esReunion(channel)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const caja = event.currentTarget.getBoundingClientRect();
          const donde: Drop = {
            id: channel.id,
            where: event.clientY < caja.top + caja.height / 2 ? "before" : "after",
          };
          caida.current = donde;
          setDropAt(donde);
        }}
        onDragLeave={(event) => {
          // Solo si el puntero sale de la fila entera, no al pasar de un hijo a otro.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            if (caida.current?.id === channel.id) caida.current = null;
            setDropAt((prev) => (prev?.id === channel.id ? null : prev));
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          const movido = data!.channels.find((c) => c.id === arrastrado.current);
          const donde = caida.current;
          arrastrado.current = null;
          caida.current = null;
          setDragId(null);
          setDropAt(null);
          if (!movido || !donde || movido.id === channel.id) return;
          const destino = grupos.find((g) => g.id === (channel.category_id ?? null));
          if (!destino) return;
          const resto = destino.channels.filter((c) => c.id !== movido.id);
          const i = resto.findIndex((c) => c.id === channel.id);
          if (i < 0) return;
          void reordenar(movido, channel.category_id ?? null, donde.where === "before" ? i : i + 1);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ at: { x: event.clientX, y: event.clientY }, kind: "channel", channel });
        }}
        className={`relative ${enLlamada ? "rounded-[10px] bg-raise/50 py-0.5" : ""} ${
          dragId === channel.id ? "opacity-40" : ""
        }`}
      >
        {marca ? (
          <span
            aria-hidden="true"
            className={`pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent ${
              marca === "before" ? "top-0" : "bottom-0"
            }`}
          />
        ) : null}

        <div className="group relative flex items-center">
          <button
            onClick={() => abrir(channel)}
            aria-current={active ? "page" : undefined}
            className={`flex w-full items-center gap-2 rounded-[10px] py-1.5 pl-2 text-left text-sm transition-colors ${
              acciones ? "pr-2 group-focus-within:pr-14 group-hover:pr-14" : "pr-2"
            } ${
              active
                ? "bg-accent-soft font-semibold text-accent"
                : hasUnread
                  ? "font-semibold text-ink hover:bg-raise"
                  : "text-muted hover:bg-raise hover:text-ink"
            }`}
          >
            <Icon size={16} className="shrink-0 opacity-80" />
            <span className="truncate">{channel.name}</span>

            {/* Los avisos se apartan mientras el ratón está encima: en ese hueco
                entran el engranaje y la invitación, y taparlos con iconos sería
                peor que esconderlos un momento. */}
            <span
              className={`ml-auto flex items-center gap-2 ${
                acciones ? "group-focus-within:hidden group-hover:hidden" : ""
              }`}
            >
              {mentions > 0 ? (
                <span
                  className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-danger px-1 text-[0.65rem] font-bold text-white tabular-nums"
                  aria-label={t("unread.mentions", { count: mentions })}
                >
                  {mentions > 99 ? "99+" : mentions}
                </span>
              ) : hasUnread && !active ? (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink" aria-label={t("unread.some")} />
              ) : null}

              {channel.kind === "voice" && inRoom.length > 0 ? (
                <span className="shrink-0 text-[0.65rem] text-muted tabular-nums">{inRoom.length}</span>
              ) : null}
            </span>
          </button>

          {acciones ? (
            <span className="absolute right-1.5 hidden items-center gap-0.5 group-focus-within:flex group-hover:flex">
              {canInvite ? (
                <RowAction label={t("community.invite")} onClick={onOpenInvite}>
                  <UserPlus size={14} />
                </RowAction>
              ) : null}
              {canManageChannels ? (
                <RowAction label={t("channel.edit")} onClick={() => setEditando(channel)}>
                  <Settings size={14} />
                </RowAction>
              ) : null}
            </span>
          ) : null}
        </div>

        {channel.kind === "voice" ? <VoiceParticipants states={inRoom} members={data!.members} /> : null}

        {yoDentro && canInvite ? (
          <button
            onClick={onOpenInvite}
            className="flex w-full items-center gap-2 rounded-[10px] py-1 pr-2 pl-8 text-left text-xs text-muted transition-colors hover:bg-raise hover:text-ink"
          >
            <UserPlus size={13} className="shrink-0" />
            <span className="truncate">{t("voice.invite")}</span>
          </button>
        ) : null}
      </li>
    );
  }

  return (
    <div data-pane="sidebar" className="flex w-full flex-col rounded-br-card border-r border-line bg-surface">
      <Menu
        trigger={({ onClick }) => (
          <button
            onClick={onClick}
            className="flex h-[var(--header-h)] w-full shrink-0 items-center gap-2.5 border-b border-line px-3 text-left transition-colors hover:bg-raise"
          >
            {/* El icono también aquí, y no solo en la columna de comunidades: con
                varias abiertas, el nombre a secas obliga a mirar al rail para saber
                en cuál estás. */}
            <span
              className="grid h-6 w-6 shrink-0 place-items-center overflow-hidden rounded-[7px] text-[0.6rem] font-bold text-white"
              style={{ background: data.community.icon_url ? undefined : data.community.accent_color }}
              aria-hidden="true"
            >
              {data.community.icon_url ? (
                <img src={data.community.icon_url} alt="" className="h-full w-full object-cover" />
              ) : (
                data.community.name.slice(0, 2).toUpperCase()
              )}
            </span>
            <span className="display min-w-0 flex-1 truncate text-[0.95rem] font-bold">{data.community.name}</span>
            <ChevronDown size={16} className="shrink-0 text-muted" />
          </button>
        )}
      >
        {(close) => (
          <>
            {canInvite ? (
              <MenuItem
                onClick={() => {
                  close();
                  onOpenInvite();
                }}
              >
                <UserPlus size={15} /> {t("community.invite")}
              </MenuItem>
            ) : null}
            {canCallMeetings ? (
              <MenuItem
                onClick={() => {
                  close();
                  setConvocando(true);
                }}
              >
                <CalendarClock size={15} /> {t("meeting.create")}
              </MenuItem>
            ) : null}
            {canManage ? (
              <MenuItem
                onClick={() => {
                  close();
                  onOpenManage();
                }}
              >
                <Settings size={15} /> {t("community.manage")}
              </MenuItem>
            ) : null}
            {data.community.owner_id === user?.id ? null : (
              <MenuItem
                danger
                onClick={() => {
                  close();
                  void leave();
                }}
              >
                {t("community.leave")}
              </MenuItem>
            )}
          </>
        )}
      </Menu>

      <nav aria-label={t("channel.create")} className="flex-1 overflow-x-hidden overflow-y-auto px-2 py-3">
        {data.channels.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {t("channel.none")}
            <span className="mt-1 block text-xs">{t("channel.noneHint")}</span>
          </p>
        ) : null}

        {error ? (
          <div className="mb-2">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}

        {uncategorised.length > 0 ? <ul className="mb-2 flex flex-col gap-0.5">{uncategorised.map(renderChannel)}</ul> : null}

        {grouped.map(({ category, channels }) => {
          /* Contraída no significa vacía: lo que tiene mensajes sin leer, lo
             que está abierto y las salas con gente dentro se siguen viendo. Si
             no, contraer una categoría es dejar de enterarse de lo que pasa
             dentro de ella. */
          const cerrada = collapsed[category.id] ?? false;
          const visibles = cerrada
            ? channels.filter(
                (channel) =>
                  channel.id === activeChannelId ||
                  (unread[channel.id]?.count ?? 0) > 0 ||
                  (voiceRooms[channel.id]?.length ?? 0) > 0,
              )
            : channels;

          return (
            <section key={category.id} className="group/cat mb-2">
              <div
                className="flex items-center"
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ at: { x: event.clientX, y: event.clientY }, kind: "category", category });
                }}
                onDragOver={(event) => {
                  if (!arrastrado.current) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const movido = data!.channels.find((c) => c.id === arrastrado.current);
                  arrastrado.current = null;
                  caida.current = null;
                  setDragId(null);
                  setDropAt(null);
                  // Soltar sobre la cabecera mete el canal el primero de esa categoría.
                  if (movido && !esReunion(movido)) void reordenar(movido, category.id, 0);
                }}
              >
                <button
                  onClick={() => setCollapsed((prev) => ({ ...prev, [category.id]: !prev[category.id] }))}
                  aria-expanded={!cerrada}
                  /* Sin `uppercase`: quien crea la categoría elige cómo se llama, y
                     forzar mayúsculas se comía esa elección. */
                  className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1 text-[0.72rem] font-semibold tracking-wide text-muted transition-colors hover:text-ink"
                >
                  <ChevronDown size={12} className={`transition-transform ${cerrada ? "-rotate-90" : ""}`} />
                  <span className="truncate">{category.name}</span>
                </button>
                {canManageChannels ? (
                  <span className="hidden pr-1 group-focus-within/cat:flex group-hover/cat:flex">
                    <RowAction label={t("category.addChannel")} onClick={() => setCreating({ category: category.id })}>
                      <Cross size={13} />
                    </RowAction>
                  </span>
                ) : null}
              </div>
              {visibles.length > 0 ? <ul className="flex flex-col gap-0.5">{visibles.map(renderChannel)}</ul> : null}
            </section>
          );
        })}

        {/* Convocar vive en el menú del nombre de la comunidad, y el historial
            en Ajustes → Reuniones: lo único que queda en la barra es la
            reunión que está pasando ahora mismo, para poder entrar. */}
        {reunionesVivas.length > 0 ? (
          <section className="mb-2">
            <p className="flex items-center gap-1 px-2 py-1 text-[0.72rem] font-semibold tracking-wide text-muted">
              <CalendarClock size={12} className="shrink-0" />
              <span className="truncate">{t("meeting.section")}</span>
            </p>
            <ul className="flex flex-col gap-0.5">{reunionesVivas.map(renderChannel)}</ul>
          </section>
        ) : null}

        {canManageChannels ? (
          <button
            onClick={() => setCreating({ category: null })}
            className="mt-2 flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raise hover:text-ink"
          >
            <Cross size={15} /> {t("channel.create")}
          </button>
        ) : null}
      </nav>

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)}>
        {(close) =>
          menu?.kind === "channel" ? (
            <ChannelMenu
              channel={menu.channel}
              close={close}
              canManageChannels={canManageChannels}
              canInvite={canInvite}
              pending={(unread[menu.channel.id]?.count ?? 0) > 0}
              onMarkRead={() => void catchUp(menu.channel.id)}
              onInvite={onOpenInvite}
              onEdit={() => setEditando(menu.channel)}
              onMove={(delta) => void desplazar(menu.channel, delta)}
              onDuplicate={() => void duplicar(menu.channel)}
              onDelete={() => void eliminarCanal(menu.channel)}
            />
          ) : menu?.kind === "category" ? (
            <CategoryMenu
              category={menu.category}
              close={close}
              collapsed={collapsed[menu.category.id] ?? false}
              canManageChannels={canManageChannels}
              onToggle={() => setCollapsed((prev) => ({ ...prev, [menu.category.id]: !prev[menu.category.id] }))}
              onMarkRead={() => {
                for (const channel of conversacion)
                  if (channel.category_id === menu.category.id) void catchUp(channel.id);
              }}
              onAddChannel={() => setCreating({ category: menu.category.id })}
              onEdit={() => setEditandoCategoria(menu.category)}
              onDelete={() => void eliminarCategoria(menu.category)}
            />
          ) : null
        }
      </ContextMenu>

      <CreateChannel
        communityId={communityId}
        open={creating !== null}
        initialCategory={creating?.category ?? null}
        onClose={() => setCreating(null)}
      />
      <CreateMeeting communityId={communityId} open={convocando} onClose={() => setConvocando(false)} />
      <ChannelSettings channel={editando} onClose={() => setEditando(null)} />
      <CategorySettings category={editandoCategoria} onClose={() => setEditandoCategoria(null)} />
      {confirmElement}
    </div>
  );
}

/** Botón pequeño que solo aparece al pasar el ratón, con su nombre accesible. */
function RowAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        onClick={onClick}
        aria-label={label}
        className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:bg-line hover:text-ink"
      >
        {children}
      </button>
    </Tooltip>
  );
}

function ChannelMenu({
  channel,
  close,
  canManageChannels,
  canInvite,
  pending,
  onMarkRead,
  onInvite,
  onEdit,
  onMove,
  onDuplicate,
  onDelete,
}: {
  channel: Channel;
  close: () => void;
  canManageChannels: boolean;
  canInvite: boolean;
  pending: boolean;
  onMarkRead: () => void;
  onInvite: () => void;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const hacer = (accion: () => void) => () => {
    close();
    accion();
  };

  return (
    <>
      <MenuItem onClick={hacer(onMarkRead)} disabled={!pending}>
        <Check size={15} /> {t("channel.markRead")}
      </MenuItem>
      {canInvite ? (
        <MenuItem onClick={hacer(onInvite)}>
          <UserPlus size={15} /> {t("community.invite")}
        </MenuItem>
      ) : null}
      {/* El ID hace falta para webhooks, bots y plantillas (§12). No es un dato
          secreto: quien ve el canal ya lo tiene en cada petición. */}
      <MenuItem onClick={hacer(() => void navigator.clipboard.writeText(channel.id))}>
        <Copy size={15} /> {t("channel.copyId")}
      </MenuItem>

      {canManageChannels ? (
        <>
          <hr className="my-1 border-line" />
          <MenuItem onClick={hacer(onEdit)}>
            <Settings size={15} /> {t("channel.edit")}
          </MenuItem>
          {channel.kind === "meeting" ? null : (
            <>
              <MenuItem onClick={hacer(() => onMove(-1))}>
                <ArrowUp size={15} /> {t("channel.moveUp")}
              </MenuItem>
              <MenuItem onClick={hacer(() => onMove(1))}>
                <ArrowDown size={15} /> {t("channel.moveDown")}
              </MenuItem>
              <MenuItem onClick={hacer(onDuplicate)}>
                <CopyPlus size={15} /> {t("channel.duplicate")}
              </MenuItem>
            </>
          )}
          <MenuItem danger onClick={hacer(onDelete)}>
            <Trash2 size={15} /> {t("channel.delete")}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function CategoryMenu({
  category,
  close,
  collapsed,
  canManageChannels,
  onToggle,
  onMarkRead,
  onAddChannel,
  onEdit,
  onDelete,
}: {
  category: Category;
  close: () => void;
  collapsed: boolean;
  canManageChannels: boolean;
  onToggle: () => void;
  onMarkRead: () => void;
  onAddChannel: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const hacer = (accion: () => void) => () => {
    close();
    accion();
  };

  return (
    <>
      <MenuItem onClick={hacer(onToggle)}>
        <ChevronDown size={15} className={collapsed ? "-rotate-90" : ""} />
        {collapsed ? t("category.expand") : t("category.collapse")}
      </MenuItem>
      <MenuItem onClick={hacer(onMarkRead)}>
        <Check size={15} /> {t("category.markRead")}
      </MenuItem>
      <MenuItem onClick={hacer(() => void navigator.clipboard.writeText(category.id))}>
        <Copy size={15} /> {t("category.copyId")}
      </MenuItem>

      {canManageChannels ? (
        <>
          <hr className="my-1 border-line" />
          <MenuItem onClick={hacer(onAddChannel)}>
            <Cross size={15} /> {t("category.addChannel")}
          </MenuItem>
          <MenuItem onClick={hacer(onEdit)}>
            <Pencil size={15} /> {t("category.edit")}
          </MenuItem>
          <MenuItem danger onClick={hacer(onDelete)}>
            <Trash2 size={15} /> {t("category.delete")}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}

function CreateChannel({
  communityId,
  open,
  initialCategory,
  onClose,
}: {
  communityId: string;
  open: boolean;
  initialCategory: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const data = useStore((s) => s.data[communityId]);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "voice" | "announcement">("text");
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Crear desde el "+" de una categoría llega con ella ya elegida: si no, hay
     que volver a buscarla en el desplegable justo después de señalarla. */
  useEffect(() => {
    if (open) setCategoryId(initialCategory ?? "");
  }, [open, initialCategory]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      let category = categoryId;
      if (newCategory.trim()) {
        const created = await api<{ id: string }>("POST", `/api/v1/communities/${communityId}/categories`, {
          name: newCategory.trim(),
        });
        category = created.id;
      }
      await api("POST", `/api/v1/communities/${communityId}/channels`, {
        name: name.trim(),
        kind,
        category_id: category || null,
      });
      setName("");
      setNewCategory("");
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("channel.create")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("channel.name")}>
          {(id) => (
            <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
          )}
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("channel.create")}</legend>
          <div className="flex flex-wrap gap-2">
            {(["text", "announcement", "voice"] as const).map((option) => (
              <button
                key={option}
                onClick={() => setKind(option)}
                aria-pressed={kind === option}
                className={`btn ${kind === option ? "btn-primary" : "btn-ghost"}`}
              >
                {t(`channel.${option}`)}
              </button>
            ))}
          </div>
          {kind === "voice" ? <p className="text-xs text-warn">{t("channel.voiceSoon")}</p> : null}
        </fieldset>

        <Field label={t("channel.category")}>
          {(id) => (
            <Select
              id={id}
              value={categoryId}
              onChange={setCategoryId}
              options={[
                { value: "", label: t("common.none") },
                ...(data?.categories.map((category) => ({ value: category.id, label: category.name })) ?? []),
              ]}
            />
          )}
        </Field>

        <Field label={t("channel.newCategory")} hint={t("common.optional")}>
          {(id) => (
            <input
              id={id}
              className="field"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              maxLength={64}
              placeholder={t("channel.categoryName")}
            />
          )}
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}
