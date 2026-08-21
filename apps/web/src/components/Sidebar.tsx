/**
 * Panel de canales de la comunidad activa.
 * Lo que no puedes usar no se pinta apagado: si no tienes VIEW_CHANNEL el canal
 * simplemente no llega desde la instancia.
 */
import { useState } from "react";
import { ChevronDown, Hash, Megaphone, Settings, UserPlus } from "lucide-react";
import { Cross, Speaker } from "./icons.tsx";
import { PERMISSIONS, has, toBits, type Channel } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Button, ErrorNote, Field, Menu, MenuItem, Modal, useConfirm, useT, useErrorText } from "./ui.tsx";
import { VoiceParticipants } from "./Voice.tsx";
import { joinVoice } from "../lib/voice.ts";

const ICONS = { text: Hash, voice: Speaker, announcement: Megaphone } as const;

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

  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const activeChannelId = useStore((s) => s.activeChannelId);
  const openChannel = useStore((s) => s.openChannel);
  const user = useStore((s) => s.user);
  const voiceRooms = useStore((s) => s.voice);
  const unread = useStore((s) => s.unread);

  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!communityId || !data) {
    return (
      <div data-pane="sidebar" className="hidden w-full rounded-br-card border-r border-line bg-surface wide:block" aria-hidden="true" />
    );
  }

  const permissions = toBits(data.permissions);
  const canManageChannels = has(permissions, PERMISSIONS.MANAGE_CHANNELS);
  const canInvite = has(permissions, PERMISSIONS.CREATE_INVITE);
  const canManage = has(permissions, PERMISSIONS.MANAGE_COMMUNITY) || has(permissions, PERMISSIONS.MANAGE_ROLES);

  const uncategorised = data.channels.filter((channel) => !channel.category_id);
  const grouped = data.categories
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((category) => ({ category, channels: data.channels.filter((c) => c.category_id === category.id) }))
    .filter((group) => group.channels.length > 0 || canManageChannels);

  async function leave() {
    if (!(await confirm(t("community.leaveConfirm")))) return;
    await api("POST", `/api/v1/communities/${communityId}/leave`);
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

    return (
      <li key={channel.id} className={enLlamada ? "rounded-[10px] bg-raise/50 py-0.5" : undefined}>
        <button
          onClick={() => {
            void openChannel(channel.id);
            // En un canal de voz, un clic entra en la llamada: es lo que se espera.
            if (channel.kind === "voice") void joinVoice(channel.id);
            onNavigate?.();
          }}
          aria-current={active ? "page" : undefined}
          className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm transition-colors ${
            active
              ? "bg-accent-soft font-semibold text-accent"
              : hasUnread
                ? "font-semibold text-ink hover:bg-raise"
                : "text-muted hover:bg-raise hover:text-ink"
          }`}
        >
          <Icon size={16} className="shrink-0 opacity-80" />
          <span className="truncate">{channel.name}</span>

          {mentions > 0 ? (
            <span
              className="ml-auto grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-full bg-danger px-1 text-[0.65rem] font-bold text-white tabular-nums"
              aria-label={t("unread.mentions", { count: mentions })}
            >
              {mentions > 99 ? "99+" : mentions}
            </span>
          ) : hasUnread && !active ? (
            <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ink" aria-label={t("unread.some")} />
          ) : null}

          {channel.kind === "voice" && inRoom.length > 0 ? (
            <span className={`shrink-0 text-[0.65rem] text-muted tabular-nums ${mentions > 0 || hasUnread ? "" : "ml-auto"}`}>
              {inRoom.length}
            </span>
          ) : null}
        </button>
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

      <nav aria-label={t("channel.create")} className="flex-1 overflow-y-auto px-2 py-3">
        {data.channels.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted">
            {t("channel.none")}
            <span className="mt-1 block text-xs">{t("channel.noneHint")}</span>
          </p>
        ) : null}

        {uncategorised.length > 0 ? <ul className="mb-2 flex flex-col gap-0.5">{uncategorised.map(renderChannel)}</ul> : null}

        {grouped.map(({ category, channels }) => (
          <section key={category.id} className="mb-2">
            <button
              onClick={() => setCollapsed((prev) => ({ ...prev, [category.id]: !prev[category.id] }))}
              aria-expanded={!collapsed[category.id]}
              /* Sin `uppercase`: quien crea la categoría elige cómo se llama, y
                 forzar mayúsculas se comía esa elección. */
              className="flex w-full items-center gap-1 px-2 py-1 text-[0.72rem] font-semibold tracking-wide text-muted transition-colors hover:text-ink"
            >
              <ChevronDown size={12} className={`transition-transform ${collapsed[category.id] ? "-rotate-90" : ""}`} />
              <span className="truncate">{category.name}</span>
            </button>
            {collapsed[category.id] ? null : <ul className="flex flex-col gap-0.5">{channels.map(renderChannel)}</ul>}
          </section>
        ))}

        {canManageChannels ? (
          <button
            onClick={() => setCreating(true)}
            className="mt-2 flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raise hover:text-ink"
          >
            <Cross size={15} /> {t("channel.create")}
          </button>
        ) : null}
      </nav>

      <CreateChannel communityId={communityId} open={creating} onClose={() => setCreating(false)} />
      {confirmElement}
    </div>
  );
}

function CreateChannel({ communityId, open, onClose }: { communityId: string; open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const data = useStore((s) => s.data[communityId]);

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "voice" | "announcement">("text");
  const [categoryId, setCategoryId] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
            <select id={id} className="field" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">{t("common.none")}</option>
              {data?.categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
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
