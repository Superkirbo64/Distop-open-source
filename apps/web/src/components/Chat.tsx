/**
 * Canal activo: cabecera, historial y composición.
 * El historial se agrupa por autor y por día para que leer una conversación
 * larga no sea una lista plana de bloques repetidos.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CornerUpLeft, Hash, Megaphone, MoreVertical, Paperclip, Pin, Search, Smile, Volume2, X } from "lucide-react";
import { Clip, Panel, People, Send } from "./icons.tsx";
import { PERMISSIONS, has, toBits, type Member, type Message } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, upload } from "../lib/api.ts";
import { renderContent } from "../lib/markdown.tsx";
import { VoiceStage, useVoiceLocal } from "./Voice.tsx";
import { joinVoice, leaveVoice } from "../lib/voice.ts";
import { formatBytes, formatDayHeading, formatTime } from "../i18n.ts";
import { Avatar, Button, EmptyState, ErrorNote, IconButton, Menu, MenuItem, Modal, Spinner, useConfirm, useLocale, useT, useErrorText } from "./ui.tsx";

const ICONS = { text: Hash, voice: Volume2, announcement: Megaphone } as const;
const QUICK_REACTIONS = ["👍", "🎉", "❤️", "😄", "👀", "🚀"];
const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function Chat({
  onToggleMembers,
  onToggleSidebar,
  onOpenSidebar,
  onCreateCommunity,
  onJoinCommunity,
  sidebarOpen,
  membersOpen,
}: {
  onToggleMembers: () => void;
  onToggleSidebar: () => void;
  onOpenSidebar: () => void;
  onCreateCommunity: () => void;
  onJoinCommunity: () => void;
  sidebarOpen: boolean;
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

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [showPins, setShowPins] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const voiceLocal = useVoiceLocal();

  const channel = data?.channels.find((c) => c.id === channelId);
  const memberIndex = useMemo(() => new Map((data?.members ?? []).map((m) => [m.user.id, m])), [data?.members]);
  // Los del canal, no los de la comunidad: un canal puede denegar lo que la comunidad concede.
  const permissions = toBits((channelId ? data?.channel_permissions[channelId] : undefined) ?? "0");

  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

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
          <IconButton label={t("nav.panel")} onClick={onToggleSidebar} aria-pressed={sidebarOpen} className="hidden wide:inline-flex">
            <Panel size={17} open={sidebarOpen} />
          </IconButton>
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
        <IconButton label={t("nav.panel")} onClick={onToggleSidebar} aria-pressed={sidebarOpen} className="hidden wide:inline-flex">
          <Panel size={17} open={sidebarOpen} />
        </IconButton>
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
          atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
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
              const grouped =
                !newDay &&
                previous?.author_id === message.author_id &&
                message.created_at - previous.created_at < GROUP_WINDOW_MS &&
                !message.reply_to_id;

              return (
                <div key={message.id}>
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
  onReply: () => void;
  onEdit: () => void;
  onDelete: () => void;
  myId: string;
}) {
  const t = useT();
  const locale = useLocale();

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
      className="group relative flex gap-3 rounded-[10px] px-2 transition-colors hover:bg-surface/70"
      style={{ paddingTop: grouped ? "0.1rem" : "var(--row-gap)", paddingBottom: "0.1rem" }}
    >
      <div className="w-9 shrink-0 pt-0.5">
        {grouped ? null : <Avatar name={name} url={member?.user.avatar_url} id={message.author_id} size={36} />}
      </div>

      <div className="min-w-0 flex-1">
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

        <div className="text-[0.94rem] leading-relaxed break-words whitespace-pre-wrap">
          {renderContent(message.content)}
          {message.edited_at ? <span className="ml-1.5 text-[0.68rem] text-muted">({t("message.edited")})</span> : null}
        </div>

        {message.attachments.length > 0 ? (
          <ul className="mt-1.5 flex flex-wrap gap-2">
            {message.attachments.map((file) =>
              file.content_type.startsWith("image/") && file.content_type !== "image/svg+xml" ? (
                <li key={file.id}>
                  <a href={file.url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={file.url}
                      alt={file.filename}
                      loading="lazy"
                      className="max-h-72 max-w-full rounded-[10px] border border-line object-cover"
                    />
                  </a>
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

      <div className="absolute top-0 right-2 hidden gap-0.5 rounded-[10px] border border-line bg-surface p-0.5 shadow-[var(--shadow)] group-hover:flex group-focus-within:flex">
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

function Composer({
  channelId,
  channelName,
  canSend,
  canAttach,
  replyTo,
  replyName,
  onCancelReply,
}: {
  channelId: string;
  channelName: string;
  canSend: boolean;
  canAttach: boolean;
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
  const box = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);

  useEffect(() => {
    setText("");
    setPending([]);
    setError(null);
  }, [channelId]);

  // Auto-alto sin librería: el textarea crece con el contenido hasta un techo.
  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);

  async function submit() {
    const content = text.trim();
    if ((!content && pending.length === 0) || busy) return;

    setBusy(true);
    setError(null);
    try {
      await send(channelId, content, pending.map((file) => file.id), replyTo?.id ?? null);
      setText("");
      setPending([]);
      onCancelReply();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function attach(files: FileList | null) {
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
      <div className="border-t border-line bg-surface px-4 py-4 text-center text-sm text-muted">
        {t("message.noPermission")}
      </div>
    );
  }

  return (
    <div className="flex min-h-[var(--footer-h)] flex-col justify-center border-t border-line bg-surface px-3 py-1.5 sm:px-5">
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

      <div className="flex items-end gap-2 rounded-card border border-line bg-bg px-2 py-1.5 focus-within:border-accent">
        {canAttach ? (
          <label className="icon-btn grid h-9 w-9 shrink-0 cursor-pointer place-items-center rounded-[10px] text-muted hover:bg-raise hover:text-ink">
            <Clip size={17} />
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
            const now = Date.now();
            if (now - lastTyping.current > 3000) {
              lastTyping.current = now;
              notifyTyping(channelId);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t("message.placeholder", { channel: `#${channelName}` })}
          aria-label={t("message.placeholder", { channel: `#${channelName}` })}
          maxLength={4000}
          className="max-h-52 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[0.94rem] outline-none"
        />

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
