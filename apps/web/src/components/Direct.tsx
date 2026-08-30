import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Check, Clock3, File, MessageCircle, MessageSquareWarning, Paperclip, Pencil, Plus, Reply, Search, Send, Trash2, UserMinus, UserRoundPlus, Users, X } from "lucide-react";
import { isJumbo, type Attachment, type DirectMessage, type PublicUser } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, upload } from "../lib/api.ts";
import { directMessagesFor } from "../lib/direct.ts";
import { formatBytes, formatTime } from "../i18n.ts";
import { renderContent } from "../lib/markdown.tsx";
import { Avatar, Button, EmptyState, ErrorNote, IconButton, Modal, Spinner, useErrorText, useLocale, useT } from "./ui.tsx";
import { VoiceMessagePlayer } from "./VoiceMessagePlayer.tsx";

export function DirectSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const conversations = useStore((state) => state.directConversations);
  const activeId = useStore((state) => state.activeDirectId);
  const directView = useStore((state) => state.directView);
  const social = useStore((state) => state.social);
  const openDirect = useStore((state) => state.openDirect);
  const setDirectView = useStore((state) => state.setDirectView);
  const [creating, setCreating] = useState(false);
  const visibleConversations = conversations.filter((conversation) => conversation.request_state !== "incoming");
  const messageRequests = conversations.filter((conversation) => conversation.request_state === "incoming");

  function show(view: "friends" | "friend_requests" | "message_requests") {
    setDirectView(view);
    onNavigate?.();
  }

  return (
    <aside data-pane="sidebar" className="flex min-h-0 flex-col border-r border-line bg-surface">
      <header className="shrink-0 border-b border-line p-3">
        <button
          className="field flex h-10 min-h-10 w-full items-center gap-2 text-left text-sm text-muted"
          onClick={() => setCreating(true)}
        >
          <Search size={15} />
          <span className="truncate">{t("direct.searchOrStart")}</span>
        </button>
      </header>
      <nav className="min-h-0 flex-1 overflow-y-auto p-2" aria-label={t("direct.title")}>
        <div className="mb-3 flex flex-col gap-1">
          <SocialNavButton active={directView === "friends"} icon={<Users size={18} />} label={t("direct.friends")} onClick={() => show("friends")} />
          <SocialNavButton
            active={directView === "friend_requests"}
            icon={<UserRoundPlus size={18} />}
            label={t("direct.friendRequests")}
            badge={social.incoming_friend_requests.length}
            onClick={() => show("friend_requests")}
          />
          <SocialNavButton
            active={directView === "message_requests"}
            icon={<MessageSquareWarning size={18} />}
            label={t("direct.messageRequests")}
            badge={messageRequests.length}
            onClick={() => show("message_requests")}
          />
        </div>
        <div className="mb-1 flex items-center gap-2 border-t border-line px-2 pt-3 pb-1">
          <span className="min-w-0 flex-1 truncate text-[0.7rem] font-semibold tracking-wider text-muted uppercase">{t("direct.title")}</span>
          <IconButton label={t("direct.new")} onClick={() => setCreating(true)} className="h-7 w-7" tooltip={false}>
            <Plus size={15} />
          </IconButton>
        </div>
        {visibleConversations.length === 0 ? (
          <EmptyState
            title={t("direct.empty")}
            hint={t("direct.emptyHint")}
            action={<Button onClick={() => setCreating(true)}>{t("direct.start")}</Button>}
          />
        ) : (
          <ul className="flex flex-col gap-1">
            {visibleConversations.map((conversation) => (
              <li key={conversation.id}>
                <button
                  className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left transition-colors ${
                    activeId === conversation.id ? "bg-accent-soft text-ink" : "text-muted hover:bg-raise hover:text-ink"
                  }`}
                  onClick={() => void openDirect(conversation.id).then(onNavigate)}
                >
                  <Avatar
                    id={conversation.other_user.id}
                    name={conversation.other_user.display_name}
                    url={conversation.other_user.avatar_url}
                    profile={conversation.other_user.profile_style}
                    size={38}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{conversation.other_user.display_name}</span>
                    <span className="block truncate text-xs text-muted">
                      {conversation.last_message?.content || (conversation.last_message ? t("direct.attachment") : `@${conversation.other_user.username}`)}
                    </span>
                  </span>
                  {conversation.request_state === "outgoing" ? <Clock3 size={14} className="shrink-0 text-muted" aria-label={t("direct.awaitingApproval")} /> : null}
                  {conversation.unread_count > 0 ? (
                    <span className="grid h-5 min-w-5 place-items-center rounded-full bg-accent px-1.5 text-[0.65rem] font-bold text-accent-ink">
                      {conversation.unread_count > 99 ? "99+" : conversation.unread_count}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <NewDirect open={creating} onClose={() => setCreating(false)} onStarted={onNavigate} />
    </aside>
  );
}

function SocialNavButton({ active, icon, label, badge = 0, onClick }: { active: boolean; icon: ReactNode; label: string; badge?: number; onClick: () => void }) {
  return (
    <button
      className={`flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left text-sm font-medium transition-colors ${
        active ? "bg-raise text-ink" : "text-muted hover:bg-raise hover:text-ink"
      }`}
      onClick={onClick}
    >
      {icon}<span className="min-w-0 flex-1 truncate">{label}</span>
      {badge > 0 ? <span className="grid h-5 min-w-5 place-items-center rounded-full bg-danger px-1 text-[0.65rem] font-bold text-white">{badge > 99 ? "99+" : badge}</span> : null}
    </button>
  );
}

function NewDirect({ open, onClose, onStarted }: { open: boolean; onClose: () => void; onStarted?: (() => void) | undefined }) {
  const t = useT();
  const errorText = useErrorText();
  const startDirect = useStore((state) => state.startDirect);
  const sendFriendRequest = useStore((state) => state.sendFriendRequest);
  const acceptFriendRequest = useStore((state) => state.acceptFriendRequest);
  const social = useStore((state) => state.social);
  const [contacts, setContacts] = useState<PublicUser[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setError(null);
    setBusy(true);
    void api<PublicUser[]>("GET", "/api/v1/direct-contacts")
      .then(setContacts)
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setBusy(false));
  }, [open, errorText]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return contacts;
    return contacts.filter((contact) =>
      `${contact.display_name} ${contact.username}`.toLowerCase().includes(needle),
    );
  }, [contacts, query]);

  async function choose(userId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await startDirect(userId);
      /* Primero deja que Modal retire su <dialog> de la top layer. Si el mismo
         render cambia al panel principal, el sidebar queda display:none y
         algunos navegadores conservan solo el backdrop: una pantalla negra. */
      onClose();
      if (onStarted) setTimeout(onStarted, 0);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function friend(userId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const incoming = social.incoming_friend_requests.some((request) => request.user.id === userId);
      if (incoming) await acceptFriendRequest(userId);
      else await sendFriendRequest(userId);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  const friendIds = new Set(social.friends.map((friend) => friend.id));
  const outgoingIds = new Set(social.outgoing_friend_requests.map((request) => request.user.id));
  const incomingIds = new Set(social.incoming_friend_requests.map((request) => request.user.id));

  return (
    <Modal open={open} onClose={onClose} title={t("direct.new")}>
      <div className="flex min-h-64 flex-col gap-3">
        <label className="relative">
          <span className="sr-only">{t("direct.search")}</span>
          <Search size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted" />
          <input
            className="field pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("direct.searchPlaceholder")}
            autoFocus
          />
        </label>
        {busy && contacts.length === 0 ? <Spinner label={t("common.loading")} /> : null}
        {!busy && filtered.length === 0 ? <EmptyState title={t("direct.noContacts")} /> : null}
        <div className="flex max-h-80 flex-col gap-1 overflow-y-auto">
          {filtered.map((contact) => (
            <div
              key={contact.id}
              className="flex items-center gap-3 rounded-[10px] p-2 text-left hover:bg-raise"
            >
              <Avatar id={contact.id} name={contact.display_name} url={contact.avatar_url} profile={contact.profile_style} />
              <span className="min-w-0 flex-1">
                <strong className="block truncate text-sm">{contact.display_name}</strong>
                <span className="block truncate text-xs text-muted">@{contact.username}</span>
              </span>
              <IconButton label={t("direct.message")} disabled={busy} onClick={() => void choose(contact.id)} tooltip={false}>
                <MessageCircle size={16} />
              </IconButton>
              <IconButton
                label={
                  friendIds.has(contact.id)
                    ? t("direct.alreadyFriends")
                    : outgoingIds.has(contact.id)
                      ? t("direct.requestSent")
                      : incomingIds.has(contact.id)
                        ? t("direct.acceptFriend")
                        : t("direct.addFriend")
                }
                disabled={busy || friendIds.has(contact.id) || outgoingIds.has(contact.id)}
                onClick={() => void friend(contact.id)}
                tooltip={false}
              >
                {friendIds.has(contact.id) ? <Check size={16} /> : outgoingIds.has(contact.id) ? <Clock3 size={16} /> : <UserRoundPlus size={16} />}
              </IconButton>
            </div>
          ))}
        </div>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}

function SocialHome({ view, onOpenSidebar }: { view: "friends" | "friend_requests" | "message_requests"; onOpenSidebar: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const social = useStore((state) => state.social);
  const conversations = useStore((state) => state.directConversations);
  const startDirect = useStore((state) => state.startDirect);
  const openDirect = useStore((state) => state.openDirect);
  const acceptFriendRequest = useStore((state) => state.acceptFriendRequest);
  const removeFriendship = useStore((state) => state.removeFriendship);
  const acceptMessageRequest = useStore((state) => state.acceptMessageRequest);
  const rejectMessageRequest = useStore((state) => state.rejectMessageRequest);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const messageRequests = conversations.filter((conversation) => conversation.request_state === "incoming");
  const title = view === "friends" ? t("direct.friends") : view === "friend_requests" ? t("direct.friendRequests") : t("direct.messageRequests");

  async function act(id: string, action: () => Promise<void>): Promise<void> {
    setBusy(id);
    setError(null);
    try { await action(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(null); }
  }

  return (
    <main data-pane="main" className="relative flex min-h-0 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3 md:px-5">
        <IconButton label={t("common.back")} onClick={onOpenSidebar} className="min-[901px]:hidden"><ArrowLeft size={18} /></IconButton>
        {view === "friends" ? <Users size={19} className="text-muted" /> : view === "friend_requests" ? <UserRoundPlus size={19} className="text-muted" /> : <MessageSquareWarning size={19} className="text-muted" />}
        <h1 className="display flex-1 font-bold">{title}</h1>
        {view === "friends" ? <Button variant="primary" onClick={() => setCreating(true)}><Plus size={16} />{t("direct.addFriend")}</Button> : null}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        {view === "friends" ? (
          social.friends.length === 0 ? <EmptyState title={t("direct.noFriends")} hint={t("direct.noFriendsHint")} action={<Button onClick={() => setCreating(true)}>{t("direct.addFriend")}</Button>} /> : (
            <section className="mx-auto max-w-3xl">
              <p className="mb-3 text-xs font-semibold tracking-wider text-muted uppercase">{t("direct.allFriends", { count: social.friends.length })}</p>
              <div className="flex flex-col divide-y divide-line border-y border-line">
                {social.friends.map((friend) => (
                  <PersonRow key={friend.id} user={friend}>
                    <IconButton label={t("direct.message")} onClick={() => void act(friend.id, () => startDirect(friend.id))}><MessageCircle size={17} /></IconButton>
                    <IconButton label={t("direct.removeFriend")} onClick={() => {
                      if (confirm(t("direct.removeFriendConfirm", { name: friend.display_name })))
                        void act(friend.id, () => removeFriendship(friend.id));
                    }}><UserMinus size={17} /></IconButton>
                  </PersonRow>
                ))}
              </div>
            </section>
          )
        ) : view === "friend_requests" ? (
          <div className="mx-auto flex max-w-3xl flex-col gap-8">
            <RequestSection title={t("direct.receivedRequests")} empty={t("direct.noFriendRequests")}>
              {social.incoming_friend_requests.map((request) => (
                <PersonRow key={request.user.id} user={request.user}>
                  <Button variant="primary" disabled={busy === request.user.id} onClick={() => void act(request.user.id, () => acceptFriendRequest(request.user.id))}>{t("direct.accept")}</Button>
                  <Button disabled={busy === request.user.id} onClick={() => void act(request.user.id, () => removeFriendship(request.user.id))}>{t("direct.reject")}</Button>
                </PersonRow>
              ))}
            </RequestSection>
            <RequestSection title={t("direct.sentRequests")} empty={t("direct.noSentRequests")}>
              {social.outgoing_friend_requests.map((request) => (
                <PersonRow key={request.user.id} user={request.user}>
                  <Button disabled={busy === request.user.id} onClick={() => void act(request.user.id, () => removeFriendship(request.user.id))}>{t("common.cancel")}</Button>
                </PersonRow>
              ))}
            </RequestSection>
          </div>
        ) : messageRequests.length === 0 ? (
          <EmptyState title={t("direct.noMessageRequests")} hint={t("direct.noMessageRequestsHint")} />
        ) : (
          <section className="mx-auto max-w-3xl">
            <p className="mb-4 text-sm text-muted">{t("direct.messageRequestsHint")}</p>
            <div className="flex flex-col gap-2">
              {messageRequests.map((conversation) => (
                <div key={conversation.id} className="card flex items-center gap-3 p-3">
                  <Avatar id={conversation.other_user.id} name={conversation.other_user.display_name} url={conversation.other_user.avatar_url} profile={conversation.other_user.profile_style} size={44} />
                  <button className="min-w-0 flex-1 text-left" onClick={() => void openDirect(conversation.id)}>
                    <strong className="block truncate text-sm">{conversation.other_user.display_name}</strong>
                    <span className="block truncate text-xs text-muted">{conversation.last_message?.content || t("direct.wantsToMessage")}</span>
                  </button>
                  <Button variant="primary" disabled={busy === conversation.id} onClick={() => void act(conversation.id, () => acceptMessageRequest(conversation.id))}>{t("direct.accept")}</Button>
                  <Button disabled={busy === conversation.id} onClick={() => void act(conversation.id, () => rejectMessageRequest(conversation.id))}>{t("direct.reject")}</Button>
                </div>
              ))}
            </div>
          </section>
        )}
        {error ? <div className="mx-auto mt-4 max-w-3xl"><ErrorNote>{error}</ErrorNote></div> : null}
      </div>
      <NewDirect open={creating} onClose={() => setCreating(false)} />
    </main>
  );
}

function PersonRow({ user, children }: { user: PublicUser; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-3">
      <Avatar id={user.id} name={user.display_name} url={user.avatar_url} profile={user.profile_style} size={42} />
      <span className="min-w-0 flex-1"><strong className="block truncate text-sm">{user.display_name}</strong><span className="block truncate text-xs text-muted">@{user.username}</span></span>
      <span className="flex shrink-0 items-center gap-2">{children}</span>
    </div>
  );
}

function RequestSection({ title, empty, children }: { title: string; empty: string; children: ReactNode[] }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{title}</h2>
      {children.length === 0 ? <p className="rounded-[10px] border border-dashed border-line p-5 text-center text-sm text-muted">{empty}</p> : <div className="flex flex-col divide-y divide-line border-y border-line">{children}</div>}
    </section>
  );
}

export function DirectChat({ onOpenSidebar }: { onOpenSidebar: () => void }) {
  const t = useT();
  const locale = useLocale();
  const user = useStore((state) => state.user);
  const directView = useStore((state) => state.directView);
  const conversationId = useStore((state) => state.activeDirectId);
  const conversation = useStore((state) => state.directConversations.find((item) => item.id === state.activeDirectId));
  const messages = useStore((state) => directMessagesFor(state.activeDirectId, state.directMessages));
  const hasMore = useStore((state) => (state.activeDirectId ? state.directHasMore[state.activeDirectId] : false));
  const loadOlder = useStore((state) => state.loadOlderDirect);
  const markRead = useStore((state) => state.markDirectRead);
  const expressions = useStore((state) => state.expressions);
  const [replyTo, setReplyTo] = useState<DirectMessage | null>(null);
  const [editing, setEditing] = useState<DirectMessage | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const lastMessageId = messages.at(-1)?.id;
  const renderContext = useMemo(() => ({
    users: new Map([
      ...(user ? [[user.id, user.display_name] as const] : []),
      [conversation?.other_user.id ?? "", conversation?.other_user.display_name ?? ""],
    ]),
    emojis: new Map(
      expressions
        .filter((expression) => expression.kind !== "sound")
        .map((expression) => [expression.id, { name: expression.name, url: expression.url, kind: expression.kind }]),
    ),
    selfId: user?.id,
  }), [conversation?.other_user, expressions, user]);

  useEffect(() => {
    setReplyTo(null);
    setEditing(null);
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId || !lastMessageId) return;
    markRead(conversationId);
    requestAnimationFrame(() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight }));
  }, [conversationId, lastMessageId, markRead]);

  if (directView !== "chat") return <SocialHome view={directView} onOpenSidebar={onOpenSidebar} />;

  if (!conversationId || !conversation) {
    return (
      <main data-pane="main" className="relative flex min-h-0 flex-col bg-bg">
        <header className="flex h-14 shrink-0 items-center border-b border-line px-3 min-[901px]:hidden">
          <IconButton label={t("common.back")} onClick={onOpenSidebar}><ArrowLeft size={18} /></IconButton>
        </header>
        <EmptyState title={t("direct.noSelection")} hint={t("direct.noSelectionHint")} />
      </main>
    );
  }

  return (
    <main data-pane="main" className="relative flex min-h-0 flex-col bg-bg">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-3">
        <IconButton label={t("common.back")} onClick={onOpenSidebar} className="min-[901px]:hidden"><ArrowLeft size={18} /></IconButton>
        <Avatar
          id={conversation.other_user.id}
          name={conversation.other_user.display_name}
          url={conversation.other_user.avatar_url}
          profile={conversation.other_user.profile_style}
          size={34}
        />
        <span className="min-w-0">
          <strong className="block truncate text-sm">{conversation.other_user.display_name}</strong>
          <span className="block truncate text-xs text-muted">@{conversation.other_user.username}</span>
        </span>
      </header>

      <div ref={scroller} id="direct-message-log" className="min-h-0 flex-1 overflow-y-auto px-3 py-4 md:px-6" role="log">
        {hasMore ? (
          <div className="mb-4 text-center">
            <Button onClick={() => void loadOlder(conversationId)}>{t("direct.loadMore")}</Button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <EmptyState title={t("direct.noMessages")} hint={t("direct.noMessagesHint", { name: conversation.other_user.display_name })} />
        ) : (
          <div className="flex flex-col gap-1">
            {messages.map((message) => {
              const own = message.author_id === user?.id;
              const author = own ? user : conversation.other_user;
              const replied = message.reply_to_id ? messages.find((item) => item.id === message.reply_to_id) : undefined;
              return (
                <article key={message.id} className="group flex gap-3 rounded-[10px] px-2 py-2 hover:bg-raise/60">
                  <Avatar id={author?.id} name={author?.display_name ?? "?"} url={author?.avatar_url} profile={author?.profile_style} size={36} />
                  <div className="min-w-0 flex-1">
                    {replied ? (
                      <div className="mb-1 truncate border-l-2 border-line pl-2 text-xs text-muted">
                        {replied.content || t("direct.attachment")}
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <strong className="text-sm">{own ? t("direct.you") : author?.display_name}</strong>
                      <time className="text-[0.68rem] text-muted" dateTime={new Date(message.created_at).toISOString()}>
                        {formatTime(locale, message.created_at)}
                      </time>
                      {message.edited_at ? <span className="text-[0.68rem] text-muted">{t("direct.edited")}</span> : null}
                    </div>
                    {message.content ? (
                      <div className={`break-words text-sm leading-6 ${isJumbo(message.content) ? "text-4xl leading-tight" : ""}`}>
                        {renderContent(message.content, { ...renderContext, jumbo: isJumbo(message.content) })}
                      </div>
                    ) : null}
                    <DirectAttachments attachments={message.attachments} />
                  </div>
                  <div className="flex shrink-0 self-start opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                    <IconButton label={t("direct.reply")} onClick={() => setReplyTo(message)} tooltip={false}><Reply size={15} /></IconButton>
                    {own ? <IconButton label={t("direct.edit")} onClick={() => setEditing(message)} tooltip={false}><Pencil size={15} /></IconButton> : null}
                    {own ? <DeleteDirect message={message} /> : null}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
      {conversation.request_state === "incoming" ? (
        <MessageRequestDecision conversation={conversation} />
      ) : (
        <>
          {conversation.request_state === "outgoing" ? (
            <p className="mx-3 mb-2 rounded-[10px] border border-line bg-raise px-3 py-2 text-center text-xs text-muted md:mx-6">
              {t("direct.awaitingMessageApproval", { name: conversation.other_user.display_name })}
            </p>
          ) : null}
          <DirectComposer conversationId={conversationId} name={conversation.other_user.display_name} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} />
        </>
      )}
      <EditDirect message={editing} onClose={() => setEditing(null)} />
    </main>
  );
}

function MessageRequestDecision({ conversation }: { conversation: ReturnType<typeof useStore.getState>["directConversations"][number] }) {
  const t = useT();
  const errorText = useErrorText();
  const accept = useStore((state) => state.acceptMessageRequest);
  const reject = useStore((state) => state.rejectMessageRequest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function decide(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return (
    <div className="shrink-0 border-t border-line bg-surface p-4 text-center">
      <p className="mb-3 text-sm">{t("direct.wantsToMessageNamed", { name: conversation.other_user.display_name })}</p>
      <div className="flex justify-center gap-2">
        <Button disabled={busy} onClick={() => void decide(() => reject(conversation.id))}>{t("direct.reject")}</Button>
        <Button variant="primary" disabled={busy} onClick={() => void decide(() => accept(conversation.id))}>{t("direct.acceptAndReply")}</Button>
      </div>
      {error ? <div className="mx-auto mt-3 max-w-md"><ErrorNote>{error}</ErrorNote></div> : null}
    </div>
  );
}

function DirectAttachments({ attachments }: { attachments: Attachment[] }) {
  const locale = useLocale();
  if (attachments.length === 0) return null;
  return (
    <div className="mt-2 flex max-w-xl flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.content_type.startsWith("image/") ? (
          <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-[10px] border border-line">
            <img src={attachment.url} alt={attachment.filename} className="max-h-80 max-w-full object-contain" loading="lazy" />
          </a>
        ) : attachment.content_type.startsWith("audio/") ? (
          <VoiceMessagePlayer key={attachment.id} src={attachment.url} label={attachment.filename} />
        ) : (
          <a key={attachment.id} href={attachment.url} className="flex min-w-56 items-center gap-3 rounded-[10px] border border-line bg-surface p-3">
            <File size={20} className="shrink-0 text-muted" />
            <span className="min-w-0"><strong className="block truncate text-sm">{attachment.filename}</strong><span className="text-xs text-muted">{formatBytes(locale, attachment.size)}</span></span>
          </a>
        ),
      )}
    </div>
  );
}

function DirectComposer({ conversationId, name, replyTo, onCancelReply }: { conversationId: string; name: string; replyTo: DirectMessage | null; onCancelReply: () => void }) {
  const t = useT();
  const locale = useLocale();
  const errorText = useErrorText();
  const sendDirect = useStore((state) => state.sendDirect);
  const maxUploadMb = useStore((state) => state.instance?.max_upload_mb ?? 25);
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Array<{ id: string; filename: string; size: number }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => { setText(""); setPending([]); setError(null); }, [conversationId]);

  async function addFiles(files: FileList | File[]): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const room = Math.max(0, 10 - pending.length);
      const selected = Array.from(files).slice(0, room);
      for (const file of selected) {
        if (file.size > maxUploadMb * 1024 * 1024) throw new Error(t("direct.fileTooLarge", { size: maxUploadMb }));
        const saved = await upload(file);
        setPending((current) => [...current, { id: saved.id, filename: saved.filename, size: saved.size }]);
      }
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submit(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (busy || (!text.trim() && pending.length === 0)) return;
    setBusy(true);
    setError(null);
    try {
      await sendDirect(conversationId, text.trim(), pending.map((item) => item.id), replyTo?.id ?? null);
      setText("");
      setPending([]);
      onCancelReply();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="shrink-0 px-3 pb-4 md:px-6">
      {replyTo ? (
        <div className="flex items-center gap-2 rounded-t-[10px] border border-b-0 border-line bg-raise px-3 py-2 text-xs text-muted">
          <Reply size={14} /><span className="min-w-0 flex-1 truncate">{t("direct.replyingTo")}: {replyTo.content || t("direct.attachment")}</span>
          <IconButton label={t("common.cancel")} onClick={onCancelReply} type="button" tooltip={false}><X size={14} /></IconButton>
        </div>
      ) : null}
      {pending.length > 0 ? (
        <div className="flex flex-wrap gap-2 border border-b-0 border-line bg-surface p-2">
          {pending.map((item) => (
            <span key={item.id} className="flex max-w-56 items-center gap-2 rounded-full bg-raise px-3 py-1 text-xs">
              <span className="truncate">{item.filename} · {formatBytes(locale, item.size)}</span>
              <button type="button" aria-label={t("common.remove")} onClick={() => setPending((current) => current.filter((file) => file.id !== item.id))}><X size={13} /></button>
            </span>
          ))}
        </div>
      ) : null}
      <div className={`flex items-end gap-1 border border-line bg-surface p-2 ${replyTo || pending.length ? "rounded-b-[12px]" : "rounded-[12px]"}`}>
        <input ref={picker} type="file" multiple className="hidden" onChange={(event) => event.target.files && void addFiles(event.target.files)} />
        <IconButton type="button" label={t("direct.attach")} disabled={busy || pending.length >= 10} onClick={() => picker.current?.click()} tooltip={false}><Paperclip size={18} /></IconButton>
        <textarea
          className="min-h-9 max-h-36 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submit(); }
          }}
          placeholder={t("direct.placeholder", { name })}
          rows={1}
          maxLength={4000}
        />
        <IconButton type="submit" label={t("direct.send")} disabled={busy || (!text.trim() && pending.length === 0)} pressed={Boolean(text.trim() || pending.length)} tooltip={false}><Send size={18} /></IconButton>
      </div>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
    </form>
  );
}

function DeleteDirect({ message }: { message: DirectMessage }) {
  const t = useT();
  const errorText = useErrorText();
  async function remove(): Promise<void> {
    if (!confirm(t("direct.deleteConfirm"))) return;
    try { await api("DELETE", `/api/v1/direct-messages/${message.id}`); }
    catch (reason) { alert(errorText(reason)); }
  }
  return <IconButton label={t("common.delete")} onClick={() => void remove()} tooltip={false}><Trash2 size={15} /></IconButton>;
}

function EditDirect({ message, onClose }: { message: DirectMessage | null; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setContent(message?.content ?? ""); setError(null); }, [message]);
  async function save(): Promise<void> {
    if (!message || !content.trim()) return;
    setBusy(true);
    try { await api("PATCH", `/api/v1/direct-messages/${message.id}`, { content: content.trim() }); onClose(); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return (
    <Modal open={Boolean(message)} onClose={onClose} title={t("direct.edit")} footer={<><Button onClick={onClose}>{t("common.cancel")}</Button><Button variant="primary" disabled={busy || !content.trim()} onClick={() => void save()}>{t("common.save")}</Button></>}>
      <textarea className="field min-h-32 resize-y" value={content} onChange={(event) => setContent(event.target.value)} maxLength={4000} autoFocus />
      {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    </Modal>
  );
}
