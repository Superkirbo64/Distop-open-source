/**
 * Canal activo: cabecera, historial y composición.
 * El historial se agrupa por autor y por día para que leer una conversación
 * larga no sea una lista plana de bloques repetidos.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, CornerUpLeft, Hash, Megaphone, MoreVertical, Paperclip, Pin, Search, Smile, Volume2, X } from "lucide-react";
import { People, Send, Upload } from "./icons.tsx";
import { PERMISSIONS, has, isJumbo, toBits, type Attachment, type Channel, type Member, type Message } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, upload } from "../lib/api.ts";
import { Picker } from "./Picker.tsx";
import { renderContent, type RenderContext } from "../lib/markdown.tsx";
import { VoiceStage, useVoiceLocal } from "./Voice.tsx";
import { joinVoice, leaveVoice } from "../lib/voice.ts";
import { formatBytes, formatDayHeading, formatTime } from "../i18n.ts";
import { Avatar, Button, EmptyState, ErrorNote, IconButton, Menu, MenuItem, Modal, Spinner, useConfirm, useLocale, useT, useErrorText } from "./ui.tsx";

const ICONS = { text: Hash, voice: Volume2, announcement: Megaphone } as const;
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
  const voiceLocal = useVoiceLocal();

  const channel = data?.channels.find((c) => c.id === channelId);
  const memberIndex = useMemo(() => new Map((data?.members ?? []).map((m) => [m.user.id, m])), [data?.members]);

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
      emojis: new Map(expressions.map((e) => [e.id, { name: e.name, url: e.url, kind: e.kind }])),
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

  // Un canal de voz no es una lista de mensajes: es una sala con gente dentro.
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
          <IconButton label={t("members.title")} onClick={onToggleMembers} pressed={membersOpen}>
            <People size={17} />
          </IconButton>
        </header>

        <VoiceStage channelId={channel.id} />

        <div className="flex flex-col items-center gap-2 border-t border-line bg-surface px-4 py-4">
          {voiceLocal.channelId === channel.id ? (
            <Button variant="danger" onClick={leaveVoice}>
              {t("voice.disconnect")}
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!has(permissions, PERMISSIONS.CONNECT_VOICE)}
              onClick={() => void joinVoice(channel.id)}
            >
              {t("voice.join")}
            </Button>
          )}
          <p className="max-w-md text-center text-xs text-muted">{t("voice.limits")}</p>
        </div>
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
                    replyTarget={messages.find((m) => m.id === message.reply_to_id)}
                    renderCtx={renderCtx}
                    mentioned={
                      (user ? message.content.includes(`<@${user.id}>`) : false) || message.mentions_everyone
                    }
                    onReply={() => setReplyTo(message)}
                    onEdit={() => setEditing(message)}
                    onDelete={async () => {
                      if (await confirm(t("message.deleteConfirm"))) await api("DELETE", `/api/v1/messages/${message.id}`);
                    }}
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

      <EditMessage message={editing} onClose={() => setEditing(null)} />
      <PinnedMessages channelId={channel.id} open={showPins} onClose={() => setShowPins(false)} members={memberIndex} />
      <ChannelSearch channelId={channel.id} open={showSearch} onClose={() => setShowSearch(false)} members={memberIndex} />
      {confirmElement}
    </main>
  );
}

/* ── una línea del historial ───────────────────────────────────────── */

function MessageRow({
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
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  myId: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [viewing, setViewing] = useState<Attachment | null>(null);

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
                  <button onClick={() => setViewing(file)} aria-label={t("message.imageOpen")}>
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

      <Modal open={viewing !== null} onClose={() => setViewing(null)} title={viewing?.filename ?? ""}>
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

        <IconButton label={t("message.reply")} onClick={onReply} className="h-7 w-7">
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
                      onEdit();
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
                    onDelete();
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
  const [pending, setPending] = useState<Array<{ id: string; filename: string; size: number }>>([]);
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

  // Auto-alto sin librería: el textarea crece con el contenido hasta un techo.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

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
      const guardado = await api<{ id: string; filename: string; size: number }>("POST", "/api/v1/gifs/save", { url });
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
        setPending((prev) => [...prev, { id: uploaded.id, filename: uploaded.filename, size: uploaded.size }]);
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
      className="relative flex min-h-[var(--footer-h)] flex-col justify-center px-3 py-2 sm:px-5"
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
            <li key={file.id} className="flex items-center gap-2 rounded-[10px] border border-line px-2 py-1 text-xs">
              <Paperclip size={12} />
              <span className="max-w-40 truncate">{file.filename}</span>
              <span className="text-muted">{formatBytes(locale, file.size)}</span>
              <button
                onClick={() => setPending((prev) => prev.filter((item) => item.id !== file.id))}
                aria-label={t("common.delete")}
                className="hover:text-danger"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? <div className="mb-2"><ErrorNote>{error}</ErrorNote></div> : null}

      <div className="flex items-end gap-2 rounded-full border border-line bg-surface/90 px-3 py-1.5 shadow-[var(--shadow)] backdrop-blur-md focus-within:border-accent">
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
          className="max-h-52 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.94rem] outline-none [-webkit-text-stroke:0.4px_#fff]"
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
