/**
 * Canal activo: cabecera, historial y composición.
 * El historial se agrupa por autor y por día para que leer una conversación
 * larga no sea una lista plana de bloques repetidos.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronDown, CornerUpLeft, Hash, Megaphone, MessageSquareText, MonitorUp, MoreVertical, Paperclip, PhoneOff, Pin, Search, Smile, VideoOff, Volume2, X } from "lucide-react";
import { People, Send, Upload } from "./icons.tsx";
import { PERMISSIONS, has, isJumbo, toBits, type Attachment, type Channel, type Member, type Message } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, upload } from "../lib/api.ts";
import { Picker } from "./Picker.tsx";
import { renderContent, type RenderContext } from "../lib/markdown.tsx";
import { StageLayoutPicker, VoiceFunMenu, VoiceSoundboard, VoiceSoundError, VoiceStage, useVoiceLocal } from "./Voice.tsx";
import { MeetingPanel } from "./Meeting.tsx";
import { joinVoice, leaveVoice, setVideoSource } from "../lib/voice.ts";
import { formatBytes, formatDayHeading, formatTime } from "../i18n.ts";
import { Avatar, Button, EmptyState, ErrorNote, IconButton, Menu, MenuItem, Modal, PanelResizeHandle, Spinner, useConfirm, useLocale, useT, useErrorText } from "./ui.tsx";

const ICONS = { text: Hash, voice: Volume2, announcement: Megaphone, meeting: CalendarClock } as const;
const QUICK_REACTIONS = ["👍", "🎉", "❤️", "😄", "👀", "🚀"];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function Chat({
  onToggleMembers,
  onOpenSidebar,
  onCreateCommunity,
  onJoinCommunity,
  membersOpen,
}: {
  onToggleMembers: () => void;
  onOpenSidebar: () => void;
  onCreateCommunity: () => void;
  onJoinCommunity: () => void;
  membersOpen: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { confirm, element: confirmElement } = useConfirm();

  const communityId = useStore((s) => s.activeCommunityId);
  const channelId = useStore((s) => s.activeChannelId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const messages = useStore((s) => (channelId ? s.messages[channelId] : undefined));
  const hasMore = useStore((s) => (channelId ? s.hasMore[channelId] : false));
  const typing = useStore((s) => (channelId ? s.typing[channelId] : undefined));
  const user = useStore((s) => s.user);
  const loadOlder = useStore((s) => s.loadOlder);
  const markRead = useStore((s) => s.markRead);
  const unread = useStore((s) => (channelId ? s.unread[channelId] : undefined));
  const dividerAfter = useStore((s) => (channelId ? s.divider[channelId] : null));

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  /* Antes el visor vivía dentro de cada fila y cambiar de canal lo desmontaba;
     con el estado subido aquí hay que conservar ese cierre a mano. */
  useEffect(() => setViewing(null), [channelId]);

  const channel = data?.channels.find((c) => c.id === channelId);
  const memberIndex = useMemo(() => new Map((data?.members ?? []).map((m) => [m.user.id, m])), [data?.members]);
  /* Índice por id para resolver la respuesta de cada mensaje en O(1): con
     find() el render del historial recorría la lista entera por cada fila. */
  const messageIndex = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);

  /* Identidades estables para que el React.memo de MessageRow surta efecto:
     una closure nueva por fila invalidaría la comparación en cada render, así
     que reciben el mensaje como argumento en vez de capturarlo. `confirm` y
     `t` ya son estables (useCallback en ui.tsx; `t` solo cambia de identidad
     con el idioma). */
  const handleReply = useCallback((message: Message) => setReplyTo(message), []);
  const handleEdit = useCallback((message: Message) => setEditing(message), []);
  const handleViewImage = useCallback((file: Attachment) => setViewing(file), []);
  const handleCloseImage = useCallback(() => setViewing(null), []);
  const handleDelete = useCallback(
    async (message: Message) => {
      if (await confirm(t("message.deleteConfirm"))) await api("DELETE", `/api/v1/messages/${message.id}`);
    },
    [confirm, t],
  );

  /* Los nombres que hacen falta para pintar `<@id>` y `<#id>`. Se pasan al
     markdown en vez de que él lea el estado: así renderContent sigue siendo una
     función pura y se puede probar sin montar la aplicación entera. */
  const expressions = useStore((s) => s.expressions);

  const renderCtx = useMemo(
    () => ({
      users: new Map((data?.members ?? []).map((m) => [m.user.id, m.nickname ?? m.user.display_name])),
      channels: new Map((data?.channels ?? []).map((c) => [c.id, c.name])),
      /* De TODAS mis comunidades, no solo de esta: un mensaje puede traer el
         emoji de otra comunidad mía, y si aquí solo estuvieran los de esta se
         vería `:nombre:` en vez de la imagen que sí tengo derecho a ver. */
      /* Los sonidos comparten tabla con los emojis pero no se escriben dentro
         de un mensaje: si entraran aquí, un `<:x:id>` apuntando a uno pintaría
         un <img> de un mp3, o sea un cuadro roto. Fuera del mapa se queda en
         `:nombre:`, que al menos se lee. */
      emojis: new Map(
        expressions.filter((e) => e.kind !== "sound").map((e) => [e.id, { name: e.name, url: e.url, kind: e.kind }]),
      ),
      selfId: user?.id,
    }),
    [data?.members, data?.channels, expressions, user?.id],
  );
  // Los del canal, no los de la comunidad: un canal puede denegar lo que la comunidad concede.
  const permissions = toBits((channelId ? data?.channel_permissions[channelId] : undefined) ?? "0");

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  // En estado y no solo en ref: el botón de "ir a lo último" tiene que repintarse.
  const [showJump, setShowJump] = useState(false);

  // Anclar abajo solo si ya estabas abajo: leer historial antiguo no debe dar saltos.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && atBottom.current) element.scrollTop = element.scrollHeight;
  }, [messages?.length, channelId]);

  if (!data) {
    return (
      <main data-pane="main" className="grid flex-1 place-items-center bg-bg">
        {/* Con la barra de comunidades escondida (móvil), esta pantalla era un
            callejón sin salida: ni cabecera, ni botón de volver, ni forma de
            crear la primera comunidad. */}
        <EmptyState
          title={t("community.empty")}
          hint={t("community.emptyHint")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={onCreateCommunity}>
                {t("community.create")}
              </Button>
              <Button onClick={onJoinCommunity}>{t("community.join")}</Button>
            </div>
          }
        />
      </main>
    );
  }

  if (!channel) {
    return (
      <main data-pane="main" className="grid flex-1 place-items-center bg-bg">
        <EmptyState title={t("channel.none")} hint={t("channel.noneHint")} />
      </main>
    );
  }

  const Icon = ICONS[channel.kind];
  const canSend = has(permissions, PERMISSIONS.SEND_MESSAGES);

  // El centro sigue siendo la sala con su gente; sus mensajes viven en el
  // lateral derecho para no sustituir la experiencia de voz.
  if (channel.kind === "voice") {
    return (
      <main data-pane="main" className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <button onClick={onOpenSidebar} className="wide:hidden" aria-label={t("common.back")}>
            <CornerUpLeft size={18} />
          </button>
          <Icon size={18} className="shrink-0 text-muted" />
          <h1 className="display truncate text-[0.95rem] font-bold">{channel.name}</h1>
          <span className="flex-1" />
          <VoiceFunMenu channelId={channel.id} />
          <IconButton label={t("voice.chatTitle")} onClick={onToggleMembers} pressed={membersOpen}>
            <MessageSquareText size={17} />
          </IconButton>
        </header>

        <VoiceStage channelId={channel.id} />

        <ChatVoiceHeader
          channel={channel}
          communityId={communityId}
          communityName={data.community.name}
          canConnect={has(permissions, PERMISSIONS.CONNECT_VOICE)}
        />
        {confirmElement}
      </main>
    );
  }

  /* Una reunión es la misma sala de voz con reglas encima, así que el escenario
     de vídeo es literalmente el mismo componente: lo que cambia es todo lo que
     lo rodea —sala de espera, papeles, manos, grabación, turno—, y eso vive en
     su propio panel. En pantalla ancha van uno al lado del otro; en estrecha, el
     panel primero, porque quien espera fuera solo tiene eso que mirar. */
  if (channel.kind === "meeting") {
    return (
      <main data-pane="main" className="flex min-w-0 flex-1 flex-col bg-bg">
        <header className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <button onClick={onOpenSidebar} className="wide:hidden" aria-label={t("common.back")}>
            <CornerUpLeft size={18} />
          </button>
          <Icon size={18} className="shrink-0 text-muted" />
          <h1 className="display truncate text-[0.95rem] font-bold">{channel.name}</h1>
          <span className="flex-1" />
          <StageLayoutPicker />
          <IconButton label={t("voice.chatTitle")} onClick={onToggleMembers} pressed={membersOpen}>
            <MessageSquareText size={17} />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-1 flex-col wide:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <VoiceStage channelId={channel.id} mode="meeting" />
          </div>
          <div className="flex min-h-0 shrink-0 flex-col border-line wide:w-[22rem] wide:border-l">
            <MeetingPanel channelId={channel.id} communityId={communityId} />
          </div>
        </div>

        <ChatVoiceHeader
          channel={channel}
          communityId={communityId}
          communityName={data.community.name}
          canConnect={has(permissions, PERMISSIONS.CONNECT_VOICE)}
        />
        {confirmElement}
      </main>
    );
  }
  const typingNames = Object.keys(typing ?? {})
    .map((id) => memberIndex.get(id)?.nickname ?? memberIndex.get(id)?.user.display_name)
    .filter((name): name is string => Boolean(name));

  return (
    <main data-pane="main" data-open="true" className="flex min-w-0 flex-1 flex-col bg-bg">
      <a href="#message-log" className="skip-link">
        {t("skip.toMessages")}
      </a>

      <header className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <button onClick={onOpenSidebar} className="wide:hidden" aria-label={t("common.back")}>
          <CornerUpLeft size={18} />
        </button>
        <Icon size={18} className="shrink-0 text-muted" />
        <h1 className="display truncate text-[0.95rem] font-bold">{channel.name}</h1>
        {channel.topic ? (
          <p className="hidden min-w-0 flex-1 truncate border-l border-line pl-3 text-sm text-muted sm:block">
            {channel.topic}
          </p>
        ) : (
          <span className="flex-1" />
        )}
        <IconButton label={t("message.pinned")} onClick={() => setShowPins(true)}>
          <Pin size={17} />
        </IconButton>
        <IconButton label={t("common.search")} onClick={() => setShowSearch(true)}>
          <Search size={17} />
        </IconButton>
        <IconButton label={t("members.title")} onClick={onToggleMembers} pressed={membersOpen}>
          <People size={17} />
        </IconButton>
      </header>

      <div
        id="message-log"
        ref={scroller}
        tabIndex={-1}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
          atBottom.current = bottom;
          setShowJump(!bottom);
          // Llegar abajo es haberlo leído: no hace falta un botón para decirlo.
          if (bottom) markRead(channel.id);
        }}
        className="flex flex-1 flex-col overflow-y-auto px-3 py-4 sm:px-5"
        role="log"
        aria-live="polite"
        aria-label={channel.name}
      >
        {messages === undefined ? (
          <Spinner label={t("common.loading")} />
        ) : messages.length === 0 ? (
          <EmptyState title={t("message.empty")} hint={t("message.emptyHint", { channel: `#${channel.name}` })} />
        ) : (
          // mt-auto: una conversación corta se apoya abajo, junto a la caja de
          // escritura, en vez de flotar arriba con medio panel vacío debajo.
          <div className="mt-auto flex flex-col">
            {hasMore ? (
              <Button className="mx-auto mb-4" onClick={() => void loadOlder(channel.id)}>
                {t("message.loadMore")}
              </Button>
            ) : null}

            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const newDay =
                !previous || new Date(previous.created_at).toDateString() !== new Date(message.created_at).toDateString();

              /* La línea va justo antes del primer mensaje que no había leído, y
                 nunca antes de uno mío: volver a un canal y encontrarse "mensajes
                 nuevos" señalando algo que escribiste tú no informa de nada. */
              const isFirstUnread =
                dividerAfter !== null &&
                dividerAfter !== undefined &&
                message.id > dividerAfter &&
                message.author_id !== user?.id &&
                (!previous || previous.id <= dividerAfter || previous.author_id === user?.id);

              const grouped =
                !newDay &&
                !isFirstUnread &&
                previous?.author_id === message.author_id &&
                message.created_at - previous.created_at < GROUP_WINDOW_MS &&
                !message.reply_to_id;

              return (
                <div key={message.id}>
                  {isFirstUnread ? (
                    <div className="my-3 flex items-center gap-3 text-[0.7rem] font-semibold text-danger uppercase">
                      <span className="h-px flex-1 bg-danger/40" />
                      {t("unread.newMessages")}
                      <span className="h-px flex-1 bg-danger/40" />
                    </div>
                  ) : null}
                  {newDay ? (
                    <div className="my-3 flex items-center gap-3 text-[0.7rem] font-semibold text-muted uppercase">
                      <span className="h-px flex-1 bg-line" />
                      {formatDayHeading(locale, message.created_at)}
                      <span className="h-px flex-1 bg-line" />
                    </div>
                  ) : null}
                  <MessageRow
                    message={message}
                    member={memberIndex.get(message.author_id)}
                    roles={data.roles}
                    grouped={grouped}
                    isSelf={message.author_id === user?.id}
                    canManage={has(permissions, PERMISSIONS.MANAGE_MESSAGES)}
                    canReact={has(permissions, PERMISSIONS.ADD_REACTIONS)}
                    replyTarget={message.reply_to_id ? messageIndex.get(message.reply_to_id) : undefined}
                    renderCtx={renderCtx}
                    mentioned={
                      (user ? message.content.includes(`<@${user.id}>`) : false) || message.mentions_everyone
                    }
                    onReply={handleReply}
                    onEdit={handleEdit}
                    onDelete={handleDelete}
                    onViewImage={handleViewImage}
                    myId={user?.id ?? ""}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Aparece solo si te has ido hacia arriba. Lleva el número de lo que
          queda por leer porque "hay algo más abajo" y "hay 14 mensajes que no
          has visto" no piden lo mismo de quien lee. */}
      {showJump ? (
        <div className="relative">
          <button
            onClick={() => {
              const element = scroller.current;
              if (!element) return;
              element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
              markRead(channel.id);
            }}
            className="absolute right-4 -top-12 z-10 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs shadow-[var(--shadow)] hover:border-accent"
          >
            <ChevronDown size={14} />
            {unread && unread.count > 0 ? t("unread.jumpCount", { count: unread.count }) : t("unread.jump")}
          </button>
        </div>
      ) : null}

      <p className="h-5 px-5 text-xs text-muted" aria-live="polite">
        {typingNames.length === 1
          ? t("message.typingOne", { name: typingNames[0]! })
          : typingNames.length > 1
            ? t("message.typingMany")
            : ""}
      </p>

      <Composer
        channelId={channel.id}
        channelName={channel.name}
        canSend={canSend}
        canAttach={has(permissions, PERMISSIONS.ATTACH_FILES)}
        members={data.members}
        channels={data.channels}
        replyTo={replyTo}
        replyName={replyTo ? (memberIndex.get(replyTo.author_id)?.user.display_name ?? "") : ""}
        onCancelReply={() => setReplyTo(null)}
      />

      <ImageViewer viewing={viewing} onClose={handleCloseImage} />
      <EditMessage message={editing} onClose={() => setEditing(null)} />
      <PinnedMessages channelId={channel.id} open={showPins} onClose={() => setShowPins(false)} members={memberIndex} />
      <ChannelSearch channelId={channel.id} open={showSearch} onClose={() => setShowSearch(false)} members={memberIndex} />
      {confirmElement}
    </main>
  );
}

/**
 * Controles de llamada del canal de voz activo.
 * Vive aparte de Chat a propósito: useVoiceLocal emite en cada transición de
 * habla (~180 ms durante una llamada), y con el hook dentro de Chat cada
 * emisión repintaba también el historial completo. Aquí el repintado se queda
 * en esta franja.
 */
function ChatVoiceHeader({
  channel,
  communityId,
  communityName,
  canConnect,
}: {
  channel: Channel;
  communityId: string | null;
  communityName: string;
  canConnect: boolean;
}) {
  const t = useT();
  const voiceLocal = useVoiceLocal();
  const [voiceNoteOff, setVoiceNoteOff] = useState(false);
  /* Se descarta la nota, no el aviso: vuelve a aparecer la próxima vez que
     entres a una sala de voz, que es cuando otra vez importa. */
  useEffect(() => {
    if (voiceLocal.channelId) setVoiceNoteOff(false);
  }, [voiceLocal.channelId]);

  return (
    <div className="flex flex-col items-center gap-2 px-4 py-4">
      {voiceLocal.channelId === channel.id ? (
        /* Pastilla de cristal en vez de barra opaca: flota sobre la sala y
           deja quitar la cámara o la pantalla sin colgar la llamada. */
        /* `relative z-20` no es decoración: `backdrop-blur` crea contexto de
           apilamiento, así que el z-30 del menú de sonidos se resuelve DENTRO
           de la pastilla y no la sube por encima de la nota de abajo —que
           también lleva blur y va después en el DOM. Sin esto, a 390 px la
           nota se comía los clics de la tabla de sonidos. */
        <div className="relative z-20 flex items-center gap-1 rounded-full border border-line bg-surface/60 p-1 shadow-[var(--shadow)] backdrop-blur-md">
          {/* La tabla de sonidos va primero: es lo que se usa durante la
              llamada, y colgar es lo último que se hace. */}
          {communityId ? (
            <VoiceSoundboard
              communityId={communityId}
              communityName={communityName}
              muted={voiceLocal.muted || voiceLocal.forcedMuted}
            />
          ) : null}
          <span className="h-5 w-px shrink-0 bg-line" />
          {voiceLocal.video ? (
            <>
              <button
                onClick={() => void setVideoSource(null)}
                className="btn btn-ghost rounded-full border-transparent px-3 text-xs"
              >
                {voiceLocal.video === "camera" ? <VideoOff size={15} /> : <MonitorUp size={15} />}
                {t(voiceLocal.video === "camera" ? "voice.cameraOff" : "voice.screenOff")}
              </button>
              <span className="h-5 w-px shrink-0 bg-line" />
            </>
          ) : null}
          <button onClick={leaveVoice} className="btn btn-danger rounded-full border-transparent px-4 text-xs">
            <PhoneOff size={15} />
            {t("voice.disconnect")}
          </button>
        </div>
      ) : (
        <Button variant="primary" disabled={!canConnect} onClick={() => void joinVoice(channel.id)}>
          {t("voice.join")}
        </Button>
      )}
      <VoiceSoundError error={voiceLocal.soundError} />
      {voiceNoteOff ? null : (
        <div className="flex max-w-md items-center gap-1 rounded-2xl border border-line bg-surface/50 py-1.5 pr-1.5 pl-3.5 backdrop-blur-md">
          <p className="text-xs leading-relaxed text-muted">{t("voice.limits")}</p>
          <IconButton label={t("common.close")} onClick={() => setVoiceNoteOff(true)} className="shrink-0">
            <X size={15} />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/**
 * El lateral de una sala de voz es el chat de ESE canal, no una segunda lista
 * de miembros. Reutiliza exactamente mensajes, permisos, adjuntos y eventos del
 * chat principal; solo cambia la disposición para caber en una columna estrecha.
 */
export function VoiceChatPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { confirm, element: confirmElement } = useConfirm();
  const communityId = useStore((s) => s.activeCommunityId);
  const channelId = useStore((s) => s.activeChannelId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const messages = useStore((s) => (channelId ? s.messages[channelId] : undefined));
  const hasMore = useStore((s) => (channelId ? s.hasMore[channelId] : false));
  const typing = useStore((s) => (channelId ? s.typing[channelId] : undefined));
  const user = useStore((s) => s.user);
  const expressions = useStore((s) => s.expressions);
  const loadOlder = useStore((s) => s.loadOlder);
  const markRead = useStore((s) => s.markRead);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  const channel = data?.channels.find((candidate) => candidate.id === channelId && candidate.kind === "voice");
  const memberIndex = useMemo(() => new Map((data?.members ?? []).map((member) => [member.user.id, member])), [data?.members]);
  // Mismo índice O(1) y mismas identidades estables que en Chat: MessageRow es
  // compartido y su React.memo depende de ellas.
  const messageIndex = useMemo(() => new Map((messages ?? []).map((m) => [m.id, m])), [messages]);
  const handleReply = useCallback((message: Message) => setReplyTo(message), []);
  const handleEdit = useCallback((message: Message) => setEditing(message), []);
  const handleViewImage = useCallback((file: Attachment) => setViewing(file), []);
  const handleCloseImage = useCallback(() => setViewing(null), []);
  const handleDelete = useCallback(
    async (message: Message) => {
      if (await confirm(t("message.deleteConfirm"))) await api("DELETE", `/api/v1/messages/${message.id}`);
    },
    [confirm, t],
  );
  const renderCtx = useMemo<RenderContext>(
    () => ({
      users: new Map((data?.members ?? []).map((member) => [member.user.id, member.nickname ?? member.user.display_name])),
      channels: new Map((data?.channels ?? []).map((candidate) => [candidate.id, candidate.name])),
      emojis: new Map(
        expressions
          .filter((expression) => expression.kind !== "sound")
          .map((expression) => [expression.id, { name: expression.name, url: expression.url, kind: expression.kind }]),
      ),
      selfId: user?.id,
    }),
    [data?.members, data?.channels, expressions, user?.id],
  );
  const permissions = toBits((channelId ? data?.channel_permissions[channelId] : undefined) ?? "0");
  const typingNames = Object.keys(typing ?? {})
    .map((id) => memberIndex.get(id)?.nickname ?? memberIndex.get(id)?.user.display_name)
    .filter((name): name is string => Boolean(name));

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
    setViewing(null);
    atBottom.current = true;
  }, [channelId]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element || !atBottom.current) return;
    element.scrollTop = element.scrollHeight;
  }, [messages?.length, channelId]);

  if (!channel || !data) return null;

  return (
    <aside data-pane="members" data-panel="voice-chat" className="relative flex w-full flex-col border-l border-line bg-surface">
      <PanelResizeHandle />
      <header className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-line px-3">
        <MessageSquareText size={17} className="shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <h2 className="display truncate text-[0.95rem] font-bold">{t("voice.chatTitle")}</h2>
          <p className="truncate text-[0.68rem] text-muted"># {channel.name}</p>
        </div>
        <IconButton label={t("common.close")} onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label={t("voice.chatTitle")}
        onScroll={(event) => {
          const element = event.currentTarget;
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100;
          if (atBottom.current) markRead(channel.id);
        }}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-3"
      >
        {messages === undefined ? (
          <Spinner label={t("common.loading")} />
        ) : messages.length === 0 ? (
          <EmptyState title={t("voice.chatEmpty")} hint={t("voice.chatEmptyHint")} />
        ) : (
          <div className="mt-auto flex flex-col">
            {hasMore ? (
              <Button className="mx-auto mb-3" onClick={() => void loadOlder(channel.id)}>
                {t("message.loadMore")}
              </Button>
            ) : null}
            {messages.map((message, index) => {
              const previous = messages[index - 1];
              const grouped =
                previous?.author_id === message.author_id &&
                message.created_at - previous.created_at < GROUP_WINDOW_MS &&
                !message.reply_to_id;
              return (
                <MessageRow
                  key={message.id}
                  message={message}
                  member={memberIndex.get(message.author_id)}
                  roles={data.roles}
                  grouped={grouped}
                  isSelf={message.author_id === user?.id}
                  canManage={has(permissions, PERMISSIONS.MANAGE_MESSAGES)}
                  canReact={has(permissions, PERMISSIONS.ADD_REACTIONS)}
                  replyTarget={message.reply_to_id ? messageIndex.get(message.reply_to_id) : undefined}
                  renderCtx={renderCtx}
                  mentioned={(user ? message.content.includes(`<@${user.id}>`) : false) || message.mentions_everyone}
                  onReply={handleReply}
                  onEdit={handleEdit}
                  onDelete={handleDelete}
                  onViewImage={handleViewImage}
                  myId={user?.id ?? ""}
                />
              );
            })}
          </div>
        )}
      </div>

      <p className="h-5 shrink-0 px-3 text-[0.7rem] text-muted" aria-live="polite">
        {typingNames.length === 1
          ? t("message.typingOne", { name: typingNames[0]! })
          : typingNames.length > 1
            ? t("message.typingMany")
            : ""}
      </p>

      <Composer
        channelId={channel.id}
        channelName={channel.name}
        canSend={has(permissions, PERMISSIONS.SEND_MESSAGES)}
        canAttach={has(permissions, PERMISSIONS.ATTACH_FILES)}
        compact
        members={data.members}
        channels={data.channels}
        replyTo={replyTo}
        replyName={replyTo ? (memberIndex.get(replyTo.author_id)?.user.display_name ?? "") : ""}
        onCancelReply={() => setReplyTo(null)}
      />

      <ImageViewer viewing={viewing} onClose={handleCloseImage} />
      <EditMessage message={editing} onClose={() => setEditing(null)} />
      {confirmElement}
    </aside>
  );
}

/* ── una línea del historial ───────────────────────────────────────── */

/* React.memo porque el historial entero se repinta con cada mensaje nuevo, cada
   "escribiendo…" y cada cambio del store que toque a Chat: con cientos de filas
   eso era volver a pasar el markdown de todas. Solo funciona si TODAS las props
   son primitivas o referencias estables — por eso los callbacks reciben el
   mensaje como argumento en vez de capturarlo en una closure por fila. */
const MessageRow = memo(function MessageRow({
  message,
  member,
  roles,
  grouped,
  isSelf,
  canManage,
  canReact,
  replyTarget,
  renderCtx,
  mentioned,
  onReply,
  onEdit,
  onDelete,
  onViewImage,
  myId,
}: {
  message: Message;
  member: Member | undefined;
  roles: { id: string; color: string | null; position: number }[];
  grouped: boolean;
  isSelf: boolean;
  canManage: boolean;
  canReact: boolean;
  replyTarget: Message | undefined;
  renderCtx: RenderContext;
  mentioned: boolean;
  onReply: (message: Message) => void;
  onEdit: (message: Message) => void;
  onDelete: (message: Message) => void;
  onViewImage: (file: Attachment) => void;
  myId: string;
}) {
  const t = useT();
  const locale = useLocale();

  const jumbo = isJumbo(message.content);

  const name = member?.nickname ?? member?.user.display_name ?? "…";
  const color = roles
    .filter((role) => role.color && member?.role_ids.includes(role.id))
    .sort((a, b) => b.position - a.position)[0]?.color;

  async function toggleReaction(emoji: string, mine: boolean) {
    if (mine) await api("DELETE", `/api/v1/messages/${message.id}/reactions?emoji=${encodeURIComponent(emoji)}`);
    else await api("POST", `/api/v1/messages/${message.id}/reactions`, { emoji });
  }

  return (
    <article
      /* Un mensaje que te nombra se distingue del resto sin depender del color:
         lleva además una barra a la izquierda, para quien no distinga tonos (§31).
         Sin resaltado al pasar el ratón: la banda tapaba el fondo de pantalla,
         y las acciones del mensaje ya aparecen solas con el hover. */
      className={`group relative flex gap-3 rounded-[10px] px-2 transition-colors ${
        mentioned ? "border-l-2 border-warn bg-warn/10" : ""
      }`}
      style={{ paddingTop: grouped ? "0.1rem" : "var(--row-gap)", paddingBottom: "0.1rem" }}
    >
      <div className="w-9 shrink-0 pt-0.5">
        {grouped ? null : <Avatar name={name} url={member?.user.avatar_url} id={message.author_id} size={36} />}
      </div>

      {/* Sin `flex-1`: la columna mide lo que mide el mensaje, y así la barra de
          acciones cae justo a su lado en vez de irse al borde del panel. */}
      <div className="min-w-0">
        {replyTarget ? (
          <p className="mb-0.5 flex items-center gap-1.5 truncate text-xs text-muted">
            <CornerUpLeft size={12} />
            <span className="font-medium">{replyTarget.content.slice(0, 90) || "—"}</span>
          </p>
        ) : null}

        {grouped ? null : (
          <p className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold" style={color ? { color } : undefined}>
              {name}
            </span>
            {member?.user.pronouns ? <span className="text-[0.7rem] text-muted">{member.user.pronouns}</span> : null}
            <time className="text-[0.7rem] text-muted" dateTime={new Date(message.created_at).toISOString()}>
              {formatTime(locale, message.created_at)}
            </time>
            {message.pinned ? <Pin size={11} className="text-warn" aria-label={t("message.pinned")} /> : null}
          </p>
        )}

        {/* Un mensaje que es solo emojis se pinta grande, como en cualquier
            mensajería: el emoji ES el mensaje, no un adorno dentro de una frase. */}
        <div
          className={`leading-relaxed break-words whitespace-pre-wrap ${
            jumbo ? "text-[2.6rem] leading-[1.15]" : "text-[0.94rem]"
          }`}
        >
          {renderContent(message.content, { ...renderCtx, everyone: message.mentions_everyone, jumbo })}
          {message.edited_at ? <span className="ml-1.5 text-[0.68rem] text-muted">({t("message.edited")})</span> : null}
        </div>

        {message.attachments.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {message.attachments.map((file) =>
              file.content_type.startsWith("image/") && file.content_type !== "image/svg+xml" ? (
                <li key={file.id}>
                  {/* Abre en un diálogo, no en otra pestaña: mirar una foto no
                      debería sacarte de la conversación ni de la llamada. */}
                  <button onClick={() => onViewImage(file)} aria-label={t("message.imageOpen")}>
                    <img
                      src={file.url}
                      alt={file.filename}
                      loading="lazy"
                      className="max-h-72 max-w-full rounded-[10px] object-cover transition-opacity hover:opacity-90"
                    />
                  </button>
                </li>
              ) : (
                <li key={file.id}>
                  <a
                    href={file.url}
                    download={file.filename}
                    className="flex items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm hover:border-accent"
                  >
                    <Paperclip size={14} />
                    <span className="max-w-56 truncate">{file.filename}</span>
                    <span className="text-xs text-muted">{formatBytes(locale, file.size)}</span>
                  </a>
                </li>
              ),
            )}
          </ul>
        ) : null}

        {message.reactions.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-1">
            {message.reactions.map((reaction) => {
              const mine = reaction.user_ids.includes(myId);
              return (
                <li key={reaction.emoji}>
                  <button
                    onClick={() => void toggleReaction(reaction.emoji, mine)}
                    disabled={!canReact && !mine}
                    aria-pressed={mine}
                    className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors ${
                      mine ? "border-accent bg-accent-soft text-accent" : "border-line bg-surface hover:border-muted"
                    }`}
                  >
                    <span aria-hidden="true">{reaction.emoji}</span>
                    <span className="tabular-nums">{reaction.count}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      {/* `invisible` y no `hidden`: ocupando sitio siempre, aparecer al pasar el
          ratón no reflota el texto de los mensajes largos. */}
      <div className="invisible flex shrink-0 gap-0.5 self-start rounded-[10px] border border-line bg-surface p-0.5 shadow-[var(--shadow)] group-hover:visible group-focus-within:visible">
        {canReact ? (
          <Menu
            trigger={({ onClick }) => (
              <IconButton label={t("message.react")} onClick={onClick} className="h-7 w-7">
                <Smile size={15} />
              </IconButton>
            )}
          >
            {(close) => (
              <div className="flex gap-1 p-1">
                {QUICK_REACTIONS.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      void toggleReaction(emoji, false);
                      close();
                    }}
                    className="grid h-8 w-8 place-items-center rounded-lg text-base hover:bg-raise"
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </Menu>
        ) : null}

        <IconButton label={t("message.reply")} onClick={() => onReply(message)} className="h-7 w-7">
          <CornerUpLeft size={15} />
        </IconButton>

        {isSelf || canManage ? (
          <Menu
            trigger={({ onClick }) => (
              <IconButton label={t("message.edit")} onClick={onClick} className="h-7 w-7">
                <MoreVertical size={15} />
              </IconButton>
            )}
          >
            {(close) => (
              <>
                {isSelf ? (
                  <MenuItem
                    onClick={() => {
                      close();
                      onEdit(message);
                    }}
                  >
                    {t("message.edit")}
                  </MenuItem>
                ) : null}
                {canManage ? (
                  <MenuItem
                    onClick={() => {
                      close();
                      void api("POST", `/api/v1/messages/${message.id}/pin`, { pinned: !message.pinned });
                    }}
                  >
                    {message.pinned ? t("message.unpin") : t("message.pin")}
                  </MenuItem>
                ) : null}
                <MenuItem
                  danger
                  onClick={() => {
                    close();
                    onDelete(message);
                  }}
                >
                  {t("message.delete")}
                </MenuItem>
              </>
            )}
          </Menu>
        ) : null}
      </div>
    </article>
  );
});

/**
 * Visor de imagen ÚNICO para todo el historial.
 * Antes cada fila montaba su propio <dialog>: cientos de diálogos vacíos en el
 * DOM y un motivo más para repintar filas. Con el estado en el contenedor hay
 * un solo modal y las filas solo avisan de qué adjunto abrir.
 */
function ImageViewer({ viewing, onClose }: { viewing: Attachment | null; onClose: () => void }) {
  const locale = useLocale();
  return (
    <Modal open={viewing !== null} onClose={onClose} title={viewing?.filename ?? ""}>
      {viewing ? (
        <div className="flex flex-col gap-3">
          <img src={viewing.url} alt={viewing.filename} className="max-h-[70vh] w-full rounded-[10px] object-contain" />
          <a
            href={viewing.url}
            download={viewing.filename}
            className="btn btn-ghost self-start"
          >
            <Paperclip size={14} />
            {viewing.filename} · {formatBytes(locale, viewing.size)}
          </a>
        </div>
      ) : null}
    </Modal>
  );
}

/* ── caja de escritura ─────────────────────────────────────────────── */

/** Cuántas sugerencias caben sin tapar la conversación. */
const SUGGEST_LIMIT = 8;

interface Suggestion {
  id: string;
  label: string;
  hint?: string | undefined;
}

function Composer({
  channelId,
  channelName,
  canSend,
  canAttach,
  compact = false,
  members,
  channels,
  replyTo,
  replyName,
  onCancelReply,
}: {
  channelId: string;
  channelName: string;
  canSend: boolean;
  canAttach: boolean;
  compact?: boolean;
  members: Member[];
  channels: Channel[];
  replyTo: Message | null;
  replyName: string;
  onCancelReply: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const locale = useLocale();
  const send = useStore((s) => s.send);
  const notifyTyping = useStore((s) => s.notifyTyping);
  const maxUploadMb = useStore((s) => s.instance?.max_upload_mb ?? 25);

  const [text, setText] = useState("");
  const [pending, setPending] = useState<Array<{ id: string; filename: string; size: number; url?: string; content_type?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  /* Mención a medio escribir. `at` es dónde empieza el "@" o el "#", para poder
     sustituir justo ese trozo sin tocar lo que hay escrito alrededor. */
  const [token, setToken] = useState<{ kind: "user" | "channel"; query: string; at: number } | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    setText("");
    setPending([]);
    setError(null);
    setToken(null);
  }, [channelId]);

  const resizeBox = useCallback(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(element.scrollHeight, compact ? 120 : 200)}px`;
  }, [compact]);

  // Auto-alto sin librería: el textarea crece con el contenido hasta un techo.
  // Al abrir el chat lateral, la rejilla puede montarlo inicialmente con ancho
  // cero. Medir solo aquí envolvería el placeholder letra por letra y dejaría
  // una burbuja de 200 px hasta que el usuario escribiera.
  useLayoutEffect(() => {
    resizeBox();
  }, [text, resizeBox]);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let lastWidth = -1;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? element.clientWidth;
      if (Math.abs(width - lastWidth) < 0.5) return;
      lastWidth = width;
      resizeBox();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resizeBox]);

  const suggestions = useMemo<Suggestion[]>(() => {
    if (!token) return [];
    const query = token.query.toLowerCase();

    if (token.kind === "channel")
      return channels
        .filter((channel) => channel.kind !== "voice" && channel.name.toLowerCase().includes(query))
        .slice(0, SUGGEST_LIMIT)
        .map((channel) => ({ id: channel.id, label: channel.name }));

    return members
      .filter((member) => {
        const nickname = member.nickname?.toLowerCase() ?? "";
        return (
          member.user.display_name.toLowerCase().includes(query) ||
          member.user.username.toLowerCase().includes(query) ||
          nickname.includes(query)
        );
      })
      .slice(0, SUGGEST_LIMIT)
      .map((member) => ({
        id: member.user.id,
        label: member.nickname ?? member.user.display_name,
        hint: `@${member.user.username}`,
      }));
  }, [token, members, channels]);

  /**
   * Qué se está escribiendo justo antes del cursor.
   * El "@" solo cuenta si abre palabra: sin esa condición, escribir un correo
   * electrónico abriría la lista de menciones a mitad de la dirección.
   */
  function detectToken(value: string, cursor: number): void {
    const upto = value.slice(0, cursor);
    const match = /(?:^|\s)([@#])([\p{L}\p{N}_.-]*)$/u.exec(upto);
    if (!match) {
      setToken(null);
      return;
    }
    const query = match[2] ?? "";
    setToken({ kind: match[1] === "@" ? "user" : "channel", query, at: cursor - query.length - 1 });
    setHighlight(0);
  }

  /** Sustituye el "@algo" a medio escribir por la mención de verdad. */
  function applySuggestion(suggestion: Suggestion): void {
    if (!token) return;
    const cursor = token.at + token.query.length + 1;
    const marker = token.kind === "user" ? `<@${suggestion.id}>` : `<#${suggestion.id}>`;
    const next = `${text.slice(0, token.at)}${marker} ${text.slice(cursor)}`;

    setText(next);
    setToken(null);
    /* El cursor queda detrás de lo insertado, no al final del texto: así se puede
       mencionar a alguien en mitad de una frase ya escrita. */
    const caret = token.at + marker.length + 1;
    requestAnimationFrame(() => {
      box.current?.focus();
      box.current?.setSelectionRange(caret, caret);
    });
  }

  function insertAtCursor(fragment: string): void {
    const element = box.current;
    const cursor = element?.selectionStart ?? text.length;
    setText(`${text.slice(0, cursor)}${fragment}${text.slice(cursor)}`);
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(cursor + fragment.length, cursor + fragment.length);
    });
  }

  async function submit() {
    const content = text.trim();
    if ((!content && pending.length === 0) || busy) return;

    setBusy(true);
    setError(null);
    try {
      await send(channelId, content, pending.map((file) => file.id), replyTo?.id ?? null);
      setText("");
      setPending([]);
      setToken(null);
      onCancelReply();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Un GIF o sticker de la galería no se enlaza directo ni se descarga entero:
   * la instancia solo anota de dónde sale, y lo reenvía cada vez que alguien
   * lo ve — así el mensaje no le entrega la IP de cada lector a Giphy, sin
   * ocupar disco del anfitrión (§22). El precio: si Giphy lo borra, el mensaje
   * queda roto para siempre, a diferencia de un archivo subido a mano.
   */
  async function adjuntarGif(url: string) {
    setError(null);
    setBusy(true);
    try {
      const guardado = await api<{ id: string; filename: string; size: number; url: string; content_type: string }>("POST", "/api/v1/gifs/save", { url });
      setPending((prev) => [...prev, guardado]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function attach(files: FileList | File[] | null) {
    if (!files?.length) return;
    setError(null);
    for (const file of Array.from(files).slice(0, 5)) {
      if (file.size > maxUploadMb * 1024 * 1024) {
        setError(t("message.tooLarge", { mb: maxUploadMb }));
        continue;
      }
      try {
        const uploaded = await upload(file);
        setPending((prev) => [...prev, { id: uploaded.id, filename: uploaded.filename, size: uploaded.size, url: uploaded.url, content_type: uploaded.content_type }]);
      } catch (err) {
        setError(errorText(err));
      }
    }
  }

  if (!canSend) {
    return (
      <div className="px-4 py-4 text-center text-sm text-muted">
        {t("message.noPermission")}
      </div>
    );
  }

  return (
    <div
      /* Sin fondo ni borde propios: antes esta franja tapaba el fondo del chat
         con una barra opaca de punta a punta. Ahora es solo el hueco donde
         flota la caja de verdad (más abajo), como una insignia sobre la
         imagen en vez de una barra encima de ella. */
      className={`relative flex flex-col justify-center ${
        compact ? "shrink-0 px-2 pb-2 pt-1" : "min-h-[var(--footer-h)] px-3 py-2 sm:px-5"
      }`}
      /* Arrastrar un archivo es el primer gesto que prueba la gente. `dragOver`
         hay que cancelarlo o el navegador abre el archivo y te saca de la
         aplicación, que es la forma más rápida de perder lo que estabas escribiendo. */
      onDragOver={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!canAttach) return;
        event.preventDefault();
        setDragging(false);
        void attach(event.dataTransfer.files);
      }}
    >
      {dragging ? (
        <div className="pointer-events-none absolute inset-1 z-20 grid place-items-center rounded-card border-2 border-dashed border-accent bg-bg/90 text-sm font-medium text-accent">
          {t("message.dropHere")}
        </div>
      ) : null}

      {/* Flota encima y no empuja la caja: escribir no debe mover lo que estás
          mirando cada vez que aparece o desaparece una sugerencia. */}
      {suggestions.length > 0 ? (
        <ul
          role="listbox"
          aria-label={t(token?.kind === "channel" ? "message.mentionChannel" : "message.mentionUser")}
          className="absolute inset-x-3 bottom-full z-30 mb-1 max-h-64 overflow-y-auto rounded-card border border-line bg-surface p-1 shadow-[var(--shadow)] sm:inset-x-5"
        >
          {suggestions.map((suggestion, index) => (
            <li key={suggestion.id}>
              <button
                role="option"
                aria-selected={index === highlight}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => applySuggestion(suggestion)}
                className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm ${
                  index === highlight ? "bg-accent-soft text-accent" : "hover:bg-raise"
                }`}
              >
                {token?.kind === "channel" ? (
                  <Hash size={14} className="shrink-0 opacity-70" />
                ) : (
                  <Avatar name={suggestion.label} id={suggestion.id} size={20} />
                )}
                <span className="truncate font-medium">{suggestion.label}</span>
                {suggestion.hint ? <span className="truncate text-xs text-muted">{suggestion.hint}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {replyTo ? (
        <p className="mb-2 flex items-center gap-2 rounded-[10px] bg-raise px-3 py-1.5 text-xs text-muted">
          <CornerUpLeft size={13} />
          {t("message.replyingTo", { name: replyName })}
          <button onClick={onCancelReply} aria-label={t("common.cancel")} className="ml-auto hover:text-ink">
            <X size={14} />
          </button>
        </p>
      ) : null}

      {pending.length > 0 ? (
        <ul className="mb-2 flex flex-wrap gap-2">
          {pending.map((file) => (
            <li key={file.id} className="group relative flex items-center gap-2 rounded-[10px] border border-line px-2 py-1 text-xs bg-surface/50">
              {file.content_type?.startsWith("image/") && file.content_type !== "image/svg+xml" ? (
                <div className="relative h-16 w-16 overflow-hidden rounded-[6px] bg-bg/50">
                  <img src={file.url} alt={file.filename} className="h-full w-full object-cover" />
                </div>
              ) : (
                <>
                  <Paperclip size={12} className="shrink-0" />
                  <span className="max-w-40 truncate">{file.filename}</span>
                  <span className="text-muted shrink-0">{formatBytes(locale, file.size)}</span>
                </>
              )}
              <button
                onClick={() => setPending((prev) => prev.filter((item) => item.id !== file.id))}
                aria-label={t("common.delete")}
                className="absolute -right-2 -top-2 rounded-full border border-line bg-surface p-0.5 hover:text-danger opacity-0 group-hover:opacity-100 transition-opacity focus-visible:opacity-100"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}

      <div
        className={`flex items-end border border-line bg-surface/90 shadow-[var(--shadow)] backdrop-blur-md focus-within:border-accent ${
          compact ? "gap-1 rounded-[18px] px-2 py-1" : "gap-2 rounded-full px-3 py-1.5"
        }`}
      >
        {canAttach ? (
          <label className="icon-btn grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[10px] text-muted hover:bg-raise hover:text-ink">
            <Upload size={17} />
            <span className="sr-only">{t("message.attach")}</span>
            <input type="file" multiple className="hidden" onChange={(e) => void attach(e.target.files)} />
          </label>
        ) : null}

        <textarea
          ref={box}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            detectToken(e.target.value, e.target.selectionStart);
            const now = Date.now();
            if (now - lastTyping.current > 3000) {
              lastTyping.current = now;
              notifyTyping(channelId);
            }
          }}
          /* El cursor también se mueve con el ratón y con las flechas: sin esto la
             lista se quedaría abierta sobre una mención que ya no se está escribiendo. */
          onSelect={(e) => detectToken(text, e.currentTarget.selectionStart)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0 || !canAttach) return;
            /* Una captura pegada es un archivo, no texto: sin cortar aquí el
               navegador además escribe su nombre dentro de la caja. */
            e.preventDefault();
            void attach(files);
          }}
          onKeyDown={(e) => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((current) => (current + 1) % suggestions.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((current) => (current - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                const chosen = suggestions[highlight];
                if (chosen) applySuggestion(chosen);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setToken(null);
                return;
              }
            }

            if (e.key === "Escape" && replyTo) {
              e.preventDefault();
              onCancelReply();
              return;
            }

            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("message.placeholder", { channel: `#${channelName}` })}
          aria-label={t("message.placeholder", { channel: `#${channelName}` })}
          maxLength={4000}
          className={`${compact ? "max-h-[120px]" : "max-h-52"} min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.94rem] outline-none`}
        />

        <Menu
          flush
          trigger={({ onClick }) => (
            <IconButton label={t("picker.open")} onClick={onClick} className="shrink-0">
              <Smile size={17} />
            </IconButton>
          )}
        >
          {(close) => (
            <Picker
              onPick={(token) => {
                // El panel se queda abierto: casi nunca se pone un emoji solo.
                insertAtCursor(token);
              }}
              onPickGif={(gif) => {
                close();
                void adjuntarGif(gif.url);
              }}
              onClose={close}
            />
          )}
        </Menu>

        <IconButton label={t("message.send")} onClick={() => void submit()} className="shrink-0 text-accent">
          <Send size={18} />
        </IconButton>
      </div>
    </div>
  );
}


/* ── diálogos auxiliares ───────────────────────────────────────────── */

function EditMessage({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(message?.content ?? ""), [message]);

  async function save() {
    if (!message) return;
    try {
      await api("PATCH", `/api/v1/messages/${message.id}`, { content: text.trim() });
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal
      open={message !== null}
      onClose={onClose}
      title={t("message.edit")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={save} disabled={!text.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <textarea className="field min-h-32" value={text} onChange={(e) => setText(e.target.value)} maxLength={4000} autoFocus />
      {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    </Modal>
  );
}

function MessageDigest({ list, members }: { list: Message[]; members: Map<string, Member> }) {
  const locale = useLocale();
  return (
    <ul className="flex flex-col gap-3">
      {list.map((message) => (
        <li key={message.id} className="rounded-[10px] border border-line p-3">
          <p className="mb-1 flex items-center gap-2 text-xs text-muted">
            <span className="font-semibold text-ink">
              {members.get(message.author_id)?.user.display_name ?? "…"}
            </span>
            {formatDayHeading(locale, message.created_at)} · {formatTime(locale, message.created_at)}
          </p>
          <p className="text-sm break-words whitespace-pre-wrap">{message.content}</p>
        </li>
      ))}
    </ul>
  );
}

function PinnedMessages({
  channelId,
  open,
  onClose,
  members,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
  members: Map<string, Member>;
}) {
  const t = useT();
  const [list, setList] = useState<Message[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setList(null);
    api<Message[]>("GET", `/api/v1/channels/${channelId}/pins`).then(setList).catch(() => setList([]));
  }, [open, channelId]);

  return (
    <Modal open={open} onClose={onClose} title={t("message.pinned")}>
      {list === null ? (
        <Spinner label={t("common.loading")} />
      ) : list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("message.searchEmpty")}</p>
      ) : (
        <MessageDigest list={list} members={members} />
      )}
    </Modal>
  );
}

function ChannelSearch({
  channelId,
  open,
  onClose,
  members,
}: {
  channelId: string;
  open: boolean;
  onClose: () => void;
  members: Map<string, Member>;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [list, setList] = useState<Message[]>([]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setList([]);
      return;
    }
    // Espera de 250 ms: buscar en cada tecla castiga a la instancia sin necesidad.
    const timer = setTimeout(() => {
      api<Message[]>("GET", `/api/v1/channels/${channelId}/search?q=${encodeURIComponent(query.trim())}`)
        .then(setList)
        .catch(() => setList([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, channelId]);

  return (
    <Modal open={open} onClose={onClose} title={t("common.search")}>
      <input
        className="field mb-4"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("message.searchPlaceholder")}
        autoFocus
      />
      {list.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t("message.searchEmpty")}</p>
      ) : (
        <MessageDigest list={list} members={members} />
      )}
    </Modal>
  );
}
