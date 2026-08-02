/**
 * Barra de comunidades y estado de la instancia.
 * El indicador de conexión vive aquí a propósito: en self-hosting saber si el
 * servidor está vivo es tan importante como el propio contenido (§26).
 */
import { useState } from "react";
import { Server } from "lucide-react";
import { Cross } from "./icons.tsx";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, IconButton, Modal, Toggle, useT, useLocale, useErrorText } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { formatDuration } from "../i18n.ts";
import type { Community } from "@distop/protocol";

export function Rail({ onNavigate }: { onNavigate?: () => void }) {
  const t = useT();
  const communities = useStore((s) => s.communities);
  const activeId = useStore((s) => s.activeCommunityId);
  const openCommunity = useStore((s) => s.openCommunity);

  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState(false);

  return (
    <nav
      data-pane="rail"
      aria-label={t("community.yours")}
      className="flex w-[4.5rem] flex-col items-center gap-2 border-r border-line bg-sunken py-3"
    >
      <ul className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
        {communities.map((community) => (
          <li key={community.id} className="relative">
            {activeId === community.id ? (
              <span aria-hidden="true" className="marker-active absolute top-1/2 -left-3 h-8 w-1 -translate-y-1/2" />
            ) : null}
            <button
              onClick={() => {
                void openCommunity(community.id);
                onNavigate?.();
              }}
              aria-current={activeId === community.id ? "true" : undefined}
              title={community.name}
              className={`grid h-12 w-12 place-items-center overflow-hidden border transition-all duration-200 ${
                activeId === community.id
                  ? "rounded-[14px] border-transparent"
                  : "rounded-[24px] border-line hover:rounded-[14px]"
              }`}
              style={{ background: community.icon_url ? undefined : community.accent_color, color: "#fff" }}
            >
              {community.icon_url ? (
                <img src={community.icon_url} alt="" className="h-full w-full object-cover" />
              ) : (
                <span className="display text-base font-bold">{community.name.slice(0, 2).toUpperCase()}</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      <IconButton label={t("community.create")} onClick={() => setCreating(true)} className="h-12 w-12 border border-dashed border-line">
        <Cross size={20} />
      </IconButton>

      <IconButton label={t("instance.status")} onClick={() => setStatus(true)} className="h-10 w-10">
        <Server size={18} />
      </IconButton>
      <ConnectionDot />

      <CreateCommunity open={creating} onClose={() => setCreating(false)} />
      <InstanceStatus open={status} onClose={() => setStatus(false)} />
    </nav>
  );
}

function ConnectionDot() {
  const t = useT();
  const status = useStore((s) => s.status);

  const label =
    status === "online" ? t("instance.online") : status === "connecting" ? t("instance.connecting") : status === "reconnecting" ? t("instance.reconnecting") : t("instance.offline");

  return (
    <p className="flex items-center gap-1.5 text-[0.6rem] text-muted" role="status" aria-live="polite">
      <span
        className={`block h-2 w-2 rounded-full ${status === "reconnecting" || status === "connecting" ? "animate-pulse" : ""}`}
        style={{ background: status === "online" ? "var(--ok)" : status === "offline" ? "var(--danger)" : "var(--warn)" }}
      />
      <span className="sr-only">{label}</span>
    </p>
  );
}

function CreateCommunity({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const openCommunity = useStore((s) => s.openCommunity);
  const reload = useStore((s) => s.reloadCommunities);

  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const community = await api<Community>("POST", "/api/v1/communities", { name, is_public: isPublic });
      await reload();
      await openCommunity(community.id);
      setName("");
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
      title={t("community.createTitle")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={create} disabled={busy || name.trim().length < 2}>
            {t("common.create")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("community.name")}>
          {(id) => (
            <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
          )}
        </Field>
        <Toggle checked={isPublic} onChange={setIsPublic} label={t("community.public")} hint={t("community.publicHint")} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}

function InstanceStatus({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const instance = useStore((s) => s.instance);
  const status = useStore((s) => s.status);

  const rows: Array<[string, string]> = instance
    ? [
        [t("instance.version"), `${instance.version} · ${instance.protocol}`],
        [t("instance.uptime"), formatDuration(locale, instance.uptime_s)],
        [t("instance.users"), String(instance.online_users)],
        [t("instance.memory"), `${instance.memory_used_mb} / ${instance.memory_total_mb} MB`],
        [t("instance.storage"), `${instance.storage_used_mb} MB`],
      ]
    : [];

  return (
    <Modal open={open} onClose={onClose} title={t("instance.status")}>
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <span
            className="block h-2.5 w-2.5 rounded-full"
            style={{ background: status === "online" ? "var(--ok)" : status === "offline" ? "var(--danger)" : "var(--warn)" }}
          />
          {instance?.instance_name ?? t("instance.offline")}
          <span className="font-normal text-muted">
            {status === "online" ? instance?.status : status === "reconnecting" ? t("instance.reconnecting") : t("instance.offline")}
          </span>
        </p>

        <dl className="flex flex-col divide-y divide-line rounded-[10px] border border-line">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-4 px-3 py-2 text-sm">
              <dt className="text-muted">{label}</dt>
              <dd className="font-medium tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>

        <ShareInstance />

        <p className="text-xs text-muted">{t("instance.offlineHelp")}</p>
      </div>
    </Modal>
  );
}

/**
 * Cómo abrir tu instancia al mundo (§6).
 * La diferencia entre "solo yo" y "mi comunidad entera" es una dirección
 * pública, así que se dice aquí con el comando ya escrito, en vez de dejarlo
 * enterrado en la documentación.
 */
function ShareInstance() {
  const t = useT();
  const publicUrl = useStore((s) => s.publicUrl);
  const [copied, setCopied] = useState(false);

  const address = publicUrl || location.origin;
  const isLocal = !publicUrl && /localhost|127\.0\.0\.1|\[::1\]/.test(location.origin);
  const tunnelCommand = `cloudflared tunnel --url ${location.origin}`;

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
      <h3 className="display text-sm font-bold">{t("share.title")}</h3>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">{t("share.address")}</span>
        <div className="flex items-center gap-2 rounded-[10px] bg-sunken px-2 py-1.5">
          <code className="min-w-0 flex-1 truncate text-xs">{address}</code>
          <button
            className="btn btn-ghost h-8 min-h-8 px-2 text-xs"
            onClick={async () => {
              await navigator.clipboard.writeText(address);
              setCopied(true);
            }}
          >
            {copied ? t("common.copied") : t("common.copy")}
          </button>
        </div>
      </div>

      {isLocal ? (
        <>
          <p className="text-xs text-warn">{t("share.localOnly")}</p>
          <p className="text-xs text-muted">{t("share.howTo")}</p>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted">{t("share.tunnel")}</span>
            <code className="block overflow-x-auto rounded-[10px] bg-sunken px-2 py-1.5 text-[0.7rem] whitespace-nowrap">
              {tunnelCommand}
            </code>
            <p className="text-xs text-muted">{t("share.thenSet")}</p>
          </div>
        </>
      ) : (
        <p className="text-xs text-ok">{t("share.ready")}</p>
      )}

      <p className="text-xs text-muted">{t("share.hostReminder")}</p>
    </section>
  );
}
