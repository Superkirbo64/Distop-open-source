/**
 * Barra de comunidades y estado de la instancia.
 * El indicador de conexión vive aquí a propósito: en self-hosting saber si el
 * servidor está vivo es tan importante como el propio contenido (§26).
 */
import { useState } from "react";
import { useEffect, useMemo } from "react";
import { Link as LinkIcon, Server } from "lucide-react";
import { Compass, Cross } from "./icons.tsx";
import { useStore } from "../store.ts";
import { Button, ErrorNote, ExternalLinkButton, Field, IconButton, Modal, Select, Spinner, Toggle, useT, useLocale, useErrorText } from "./ui.tsx";
import { Explore } from "./Explore.tsx";
import { api } from "../lib/api.ts";
import { CLOUD_GUIDE_URL, RASPBERRY_GUIDE_URL, VPS_INSTALL_GUIDE_URL, detectLane, hasStablePublicAddress } from "../lib/publish.ts";
import { describeSchedule, sortBackupFiles, type BackupJob, type BackupsView } from "../lib/backups.ts";
import {
  clientOrigin,
  connectToInstance,
  forgetKnownCommunity,
  instanceBase,
  isPackaged,
  knownInstances,
  normalizeInstanceUrl,
  parseInvite,
  rememberCommunities,
  setActiveInstance,
  storePendingCommunity,
  type CachedCommunity,
} from "../lib/instance.ts";
import { ensurePortableIdentity } from "../lib/portable.ts";
import { formatBytes, formatDate, formatDuration } from "../i18n.ts";
import type { Community } from "@distop/protocol";

/**
 * Lo que queda sin leer en cada comunidad, sumando sus canales.
 * Se calcula aquí y no se guarda: son dos objetos pequeños y un bucle, y tener
 * el total duplicado en el estado es la forma segura de que un día no cuadren.
 */
function useCommunityUnread(): Record<string, { count: number; mentions: number }> {
  const unread = useStore((s) => s.unread);
  const owner = useStore((s) => s.channelOwner);

  return useMemo(() => {
    const totals: Record<string, { count: number; mentions: number }> = {};
    for (const [channelId, entry] of Object.entries(unread)) {
      const communityId = owner[channelId];
      if (!communityId || entry.count === 0) continue;
      const current = totals[communityId] ?? { count: 0, mentions: 0 };
      totals[communityId] = { count: current.count + entry.count, mentions: current.mentions + entry.mentions };
    }
    return totals;
  }, [unread, owner]);
}

export function Rail({
  onNavigate,
  onCreate,
  onJoin,
}: {
  onNavigate?: () => void;
  onCreate: () => void;
  onJoin: () => void;
}) {
  const t = useT();
  const communities = useStore((s) => s.communities);
  const activeId = useStore((s) => s.activeCommunityId);
  const openCommunity = useStore((s) => s.openCommunity);
  const user = useStore((s) => s.user);
  const unread = useCommunityUnread();

  const [status, setStatus] = useState(false);
  const [explore, setExplore] = useState(false);
  const [knownRevision, setKnownRevision] = useState(0);
  const [unavailable, setUnavailable] = useState<{ community: CachedCommunity; url: string } | null>(null);

  useEffect(() => {
    if (isPackaged() && instanceBase) rememberCommunities(instanceBase, communities);
  }, [communities, knownRevision]);

  const visibleCommunities = useMemo(() => {
    const here = communities.map((community) => ({ community, url: instanceBase }));
    if (!isPackaged()) return here;
    const elsewhere = knownInstances()
      .filter((known) => known.url !== instanceBase)
      .flatMap((known) => (known.communities ?? []).map((community) => ({ community, url: known.url })));
    return [...here, ...elsewhere];
  }, [communities]);

  async function selectCommunity(community: CachedCommunity, url: string): Promise<void> {
    if (!url || url === instanceBase) {
      await openCommunity(community.id);
      onNavigate?.();
      return;
    }

    try {
      const response = await fetch(`${url}/api/v1/info`, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error("offline");
      storePendingCommunity({ id: community.id, name: community.name, url, previous_url: instanceBase });
      setActiveInstance(url);
    } catch {
      setUnavailable({ community, url });
    }
  }

  return (
    <nav
      data-pane="rail"
      aria-label={t("community.yours")}
      className="flex w-[4.5rem] flex-col items-center gap-2 border-r border-line bg-sunken pt-1 pb-3"
    >
      <ul className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
        {visibleCommunities.map(({ community, url }) => (
          <li key={`${url}:${community.id}`} className="group relative">
            {/* Una sola pastilla para los tres estados en vez de un punto y un
                marcador aparte: crece de 0 a 8 a 36 píxeles según sea "nada",
                "algo sin leer" o "estoy aquí". Así se lee una altura, que es una
                escala, en lugar de tener que distinguir dos formas distintas. */}
            <span
              aria-hidden="true"
              className={`marker-active absolute top-1/2 -left-3 w-1 -translate-y-1/2 transition-all duration-200 ${
                url === instanceBase && activeId === community.id
                  ? "h-9"
                  : unread[community.id]
                    ? "h-2 group-hover:h-5"
                    : "h-0 group-hover:h-5"
              }`}
            />
            <button
              onClick={() => {
                void selectCommunity(community, url);
              }}
              aria-current={url === instanceBase && activeId === community.id ? "true" : undefined}
              title={community.name}
              className={`grid h-12 w-12 place-items-center overflow-hidden border transition-all duration-200 ${
                url === instanceBase && activeId === community.id
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

            {/* Fuera del botón y no dentro: el icono recorta su contenido, y una
                insignia dentro se quedaría a medias contra el borde redondeado. */}
            {url === instanceBase && unread[community.id] && activeId !== community.id ? (
              unread[community.id]!.mentions > 0 ? (
                <span
                  className="absolute -right-1 -bottom-1 grid h-[18px] min-w-[18px] place-items-center rounded-full border-2 border-sunken bg-danger px-1 text-[0.6rem] font-bold text-white tabular-nums"
                  aria-label={t("unread.mentions", { count: unread[community.id]!.mentions })}
                >
                  {unread[community.id]!.mentions > 99 ? "99+" : unread[community.id]!.mentions}
                </span>
              ) : (
                <span className="sr-only">{t("unread.some")}</span>
              )
            ) : null}
          </li>
        ))}
      </ul>

      <IconButton label={t("community.create")} onClick={onCreate} className="h-12 w-12 border border-dashed border-line">
        <Cross size={20} />
      </IconButton>

      <IconButton label={t("community.join")} onClick={onJoin} className="h-10 w-10">
        <LinkIcon size={18} />
      </IconButton>

      <IconButton label={t("explore.open")} onClick={() => setExplore(true)} className="h-10 w-10">
        <Compass size={18} />
      </IconButton>

      <IconButton label={t("instance.status")} onClick={() => setStatus(true)} className="h-10 w-10">
        <Server size={18} />
      </IconButton>
      <ConnectionDot />

      <InstanceStatus open={status} onClose={() => setStatus(false)} />
      <Explore open={explore} onClose={() => setExplore(false)} />
      <UnavailableCommunity
        target={unavailable}
        user={user}
        onClose={() => setUnavailable(null)}
        onForget={() => setKnownRevision((revision) => revision + 1)}
      />
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

/** Recuperación en contexto: el campo aparece junto a la comunidad que falló. */
function UnavailableCommunity({
  target,
  user,
  onClose,
  onForget,
}: {
  target: { community: CachedCommunity; url: string } | null;
  user: ReturnType<typeof useStore.getState>["user"];
  onClose: () => void;
  onForget: () => void;
}) {
  const t = useT();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    if (!user) return;
    setBusy(true);
    setError(null);
    try {
      await ensurePortableIdentity(user);
      const result = await connectToInstance(link);
      if (result !== "ok") setError(t(result === "unreachable" ? "connect.unreachable" : "connect.notInstance"));
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  function forget(): void {
    if (!target || !confirm(t("community.forgetConfirm"))) return;
    forgetKnownCommunity(target.url, target.community.id);
    onForget();
    onClose();
  }

  return (
    <Modal open={Boolean(target)} onClose={onClose} title={target?.community.name ?? t("community.unavailableTitle")}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("community.unavailable")}</p>
        <Field label={t("community.joinLabel")} hint={t("community.rejoinHint")}>
          {(id) => <input id={id} className="field" value={link} onChange={(event) => setLink(event.target.value)} />}
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="danger" onClick={forget}>{t("community.forget")}</Button>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void retry()} disabled={busy || !normalizeInstanceUrl(link)}>
            {t("community.joinAction")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Entrar con un enlace sin salir de la aplicación (§34).
 * Pegar la invitación aquí evita el rodeo de abrirla en el navegador, y funciona
 * igual con el enlace entero o solo con el código.
 */
export function JoinCommunity({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const openCommunity = useStore((s) => s.openCommunity);
  const reload = useStore((s) => s.reloadCommunities);
  const user = useStore((s) => s.user);

  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ community: { name: string; accent_color: string }; members: number } | null>(null);

  // Se acepta lo que la gente pega de verdad: la URL completa, con o sin barra
  // final, o el código suelto.
  const code = value.trim().replace(/\/+$/, "").split("/").pop() ?? "";

  /* Vista previa mientras se escribe: entrar a una comunidad sin saber cuál es
     antes de pulsar es pedir un acto de fe. Si el código no existe todavía, se
     calla: escribir a medias no es un error. */
  useEffect(() => {
    if (code.length < 3) {
      setPreview(null);
      return;
    }
    let vigente = true;
    const timer = setTimeout(() => {
      const parsed = isPackaged() ? parseInvite(value) : null;
      const request = parsed?.code && parsed.origin !== clientOrigin()
        ? fetch(`${parsed.origin}/api/v1/invites/${encodeURIComponent(parsed.code)}`).then((response) => {
            if (!response.ok) throw new Error("invite");
            return response.json();
          })
        : api<{ community: { name: string; accent_color: string }; members: number }>(
            "GET",
            `/api/v1/invites/${encodeURIComponent(code)}`,
          );
      void request
        .then((data) => vigente && setPreview(data))
        .catch(() => vigente && setPreview(null));
    }, 350);

    return () => {
      vigente = false;
      clearTimeout(timer);
    };
  }, [code]);

  async function join(): Promise<void> {
    setBusy(true);
    setError(null);

    /* Empaquetada, una invitación puede ser de OTRA comunidad en OTRO servidor:
       ahí no se hace join aquí — se cambia de servidor con el código apuntado,
       y App abre la invitación al volver a estar en pie (§4). */
    if (isPackaged()) {
      const parsed = parseInvite(value);
      if (parsed?.code && parsed.origin !== clientOrigin()) {
        if (!user) throw new Error("No active user");
        await ensurePortableIdentity(user);
        const result = await connectToInstance(value);
        if (result === "ok") return; // recarga en marcha
        setError(t(result === "unreachable" ? "connect.unreachable" : "connect.notInstance"));
        setBusy(false);
        return;
      }
    }

    try {
      const result = await api<{ community: Community | null }>("POST", `/api/v1/invites/${encodeURIComponent(code)}/join`);
      await reload();
      if (result.community) await openCommunity(result.community.id);
      setValue("");
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
      title={t("community.join")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={join} disabled={busy || code.length < 3}>
            {t("community.joinAction")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("community.joinLabel")} hint={t("community.joinHint")}>
          {(id) => (
            <input
              id={id}
              className="field"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="abc123  ·  https://…/invite/abc123"
              autoFocus
            />
          )}
        </Field>

        {preview ? (
          <div className="flex items-center gap-3 rounded-[10px] border border-line p-3">
            <span
              className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] text-white"
              style={{ background: preview.community.accent_color }}
            >
              <span className="display text-sm font-bold">{preview.community.name.slice(0, 2).toUpperCase()}</span>
            </span>
            <div className="min-w-0">
              <p className="display truncate font-bold">{preview.community.name}</p>
              <p className="text-xs text-muted">
                {t(preview.members === 1 ? "invite.memberOne" : "invite.members", { count: preview.members })}
              </p>
            </div>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}

/**
 * Vive fuera de la barra a propósito: en móvil la barra está escondida, y quien
 * todavía no tiene ninguna comunidad no llegaba a ella. El diálogo lo monta el
 * cascarón, así que se puede abrir desde donde haga falta.
 */
/* Espejo de los tipos del node-server (discord-import.ts): el protocolo aún no
   los publica, y duplicar dos formas pequeñas es más barato que acoplar el
   cliente al paquete del servidor. */
interface DiscordPreview {
  guild: { id: string; name: string; description: string | null; icon_url: string | null };
  counts: { channels: number; categories: number; roles: number; emojis: number; members: number | null };
  unsupported_channels: number;
}

interface DiscordImportReport {
  community_id: string;
  channels: number;
  messages: number;
  imported_profiles: number;
  warnings: string[];
}

const DISCORD_WARNINGS = [
  "MESSAGE_CONTENT_EMPTY",
  "MEMBERS_ONLY_AUTHORS",
  "ATTACHMENTS_SKIPPED",
  "UNSUPPORTED_CHANNELS",
  "MEMBERS_TRUNCATED",
] as const;
type DiscordWarning = (typeof DISCORD_WARNINGS)[number];

export function CreateCommunity({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama con la comunidad ya creada y abierta: App encadena el invitar. */
  onCreated?: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const openCommunity = useStore((s) => s.openCommunity);
  const reload = useStore((s) => s.reloadCommunities);

  const [mode, setMode] = useState<"blank" | "discord">("blank");
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Importar de Discord: el token vive en este estado y muere con el diálogo.
  const [botToken, setBotToken] = useState("");
  const [guildId, setGuildId] = useState("");
  const [preview, setPreview] = useState<DiscordPreview | null>(null);
  const [historyLimit, setHistoryLimit] = useState("200");
  const [withMembers, setWithMembers] = useState(true);
  const [report, setReport] = useState<DiscordImportReport | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const community = await api<Community>("POST", "/api/v1/communities", {
        name,
        visibility: isPublic ? "public" : "private",
        join_policy: "invite",
      });
      await reload();
      await openCommunity(community.id);
      setName("");
      onClose();
      onCreated?.();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadPreview() {
    setBusy(true);
    setError(null);
    try {
      setPreview(await api<DiscordPreview>("POST", "/api/v1/import/discord/preview", {
        token: botToken,
        guild_id: guildId.trim(),
      }));
    } catch (err) {
      setPreview(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setError(null);
    try {
      const result = await api<DiscordImportReport>("POST", "/api/v1/import/discord", {
        token: botToken,
        guild_id: guildId.trim(),
        history_limit: Number(historyLimit),
        import_members: withMembers,
      });
      setBotToken("");
      setReport(result);
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function openImported() {
    if (report) await openCommunity(report.community_id);
    setGuildId("");
    setPreview(null);
    setReport(null);
    setMode("blank");
    onClose();
  }

  const guildIdOk = /^\d{6,24}$/.test(guildId.trim());
  const discordReady = botToken.trim().length >= 20 && guildIdOk;

  const footer = report ? (
    <Button variant="primary" onClick={openImported}>
      {t("discord.open")}
    </Button>
  ) : mode === "blank" ? (
    <>
      <Button onClick={onClose}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={create} disabled={busy || name.trim().length < 2}>
        {t("common.create")}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
      <Button onClick={loadPreview} disabled={busy || !discordReady}>
        {t("discord.preview")}
      </Button>
      <Button variant="primary" onClick={runImport} disabled={busy || !discordReady}>
        {t("discord.import")}
      </Button>
    </>
  );

  return (
    <Modal open={open} onClose={busy ? () => {} : onClose} title={t("community.createTitle")} footer={footer}>
      <div className="flex flex-col gap-4">
        {report ? (
          <>
            <p className="font-semibold">{t("discord.done")}</p>
            <p className="text-sm text-muted">
              {t("discord.reportSummary", {
                channels: report.channels,
                messages: report.messages,
                profiles: report.imported_profiles,
              })}
            </p>
            {report.warnings
              .filter((w): w is DiscordWarning => (DISCORD_WARNINGS as readonly string[]).includes(w))
              .map((warning) => (
                <p key={warning} className="text-sm text-muted">
                  {t(`discord.warn.${warning}`)}
                </p>
              ))}
          </>
        ) : (
          <>
            <div className="flex gap-2">
              <Button onClick={() => setMode("blank")} variant={mode === "blank" ? "primary" : "ghost"} disabled={busy}>
                {t("discord.blankTab")}
              </Button>
              <Button onClick={() => setMode("discord")} variant={mode === "discord" ? "primary" : "ghost"} disabled={busy}>
                {t("discord.tab")}
              </Button>
            </div>

            {mode === "blank" ? (
              <>
                <Field label={t("community.name")}>
                  {(id) => (
                    <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
                  )}
                </Field>
                <Toggle checked={isPublic} onChange={setIsPublic} label={t("community.public")} hint={t("community.publicHint")} />
              </>
            ) : (
              <>
                <p className="text-sm text-muted">{t("discord.intro")}</p>
                <Field label={t("discord.token")}>
                  {(id) => (
                    <input
                      id={id}
                      className="field"
                      type="password"
                      autoComplete="off"
                      value={botToken}
                      onChange={(e) => setBotToken(e.target.value)}
                      disabled={busy}
                    />
                  )}
                </Field>
                <Field label={t("discord.guildId")} hint={t("discord.guildIdHint")}>
                  {(id) => (
                    <input
                      id={id}
                      className="field"
                      inputMode="numeric"
                      value={guildId}
                      onChange={(e) => setGuildId(e.target.value)}
                      disabled={busy}
                    />
                  )}
                </Field>

                {preview ? (
                  <div className="flex items-center gap-3 rounded-xl border border-line p-3">
                    {preview.guild.icon_url ? (
                      <img src={preview.guild.icon_url} alt="" className="h-10 w-10 shrink-0 rounded-[12px] object-cover" />
                    ) : null}
                    <div className="min-w-0">
                      <p className="display truncate font-bold">{preview.guild.name}</p>
                      <p className="text-xs text-muted">
                        {t("discord.previewCounts", {
                          channels: preview.counts.channels,
                          categories: preview.counts.categories,
                          roles: preview.counts.roles,
                          emojis: preview.counts.emojis,
                        })}
                        {preview.counts.members !== null
                          ? ` · ${t("discord.previewMembers", { count: preview.counts.members })}`
                          : ""}
                      </p>
                      {preview.unsupported_channels > 0 ? (
                        <p className="text-xs text-muted">{t("discord.warn.UNSUPPORTED_CHANNELS")}</p>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                <Field label={t("discord.history")}>
                  {(id) => (
                    <Select
                      id={id}
                      value={historyLimit}
                      onChange={setHistoryLimit}
                      disabled={busy}
                      options={[
                        { value: "0", label: t("discord.historyNone") },
                        { value: "100", label: "100" },
                        { value: "200", label: "200" },
                        { value: "1000", label: "1000" },
                      ]}
                    />
                  )}
                </Field>
                <Toggle
                  checked={withMembers}
                  onChange={setWithMembers}
                  label={t("discord.members")}
                  hint={t("discord.membersHint")}
                />
                {busy ? <p className="text-sm text-muted">{t("discord.importing")}</p> : null}
              </>
            )}
          </>
        )}
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
  const publicDiscoveryEnabled = useStore((s) => s.publicDiscoveryEnabled);

  /* GB o TB según el tamaño: "quedan 231,4 GB" dice algo; "quedan 236993 MB" no.
     Intl y no toFixed: el separador decimal es del idioma, no siempre un punto. */
  const freeMb = instance?.storage_free_mb ?? 0;
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const freeLabel =
    freeMb >= 1024 * 1024
      ? `${decimal.format(freeMb / 1024 / 1024)} TB`
      : freeMb >= 1024
        ? `${decimal.format(freeMb / 1024)} GB`
        : `${freeMb} MB`;

  const rows: Array<[string, string]> = instance
    ? [
        [t("instance.version"), `${instance.version} · ${instance.protocol}`],
        [t("instance.uptime"), formatDuration(locale, instance.uptime_s)],
        [t("instance.users"), String(instance.online_users)],
        [t("instance.memory"), `${instance.memory_used_mb} / ${instance.memory_total_mb} MB`],
        [
          t("instance.storage"),
          freeMb > 0
            ? `${instance.storage_used_mb} MB · ${t("instance.storageFree", { free: freeLabel })}`
            : `${instance.storage_used_mb} MB`,
        ],
        /* El estado del directorio se dice aquí, mirando a la cara: una
           instancia que se anuncia (o no) es algo que su gente debe saber sin
           bucear en variables de entorno (§26). */
        [t("instance.discovery"), publicDiscoveryEnabled ? t("instance.discoveryOn") : t("instance.discoveryOff")],
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

        <BackupsStatus />

        <PurgeData />

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
interface TunnelState {
  status: "off" | "starting" | "on" | "error";
  url: string;
  error: string;
  /** Túnel vivo o, si existe, PUBLIC_URL configurada por el anfitrión. */
  public_url: string;
  /** Si se abre solo al arrancar. Solo viene en la respuesta de quien hospeda. */
  autostart?: boolean;
  fixed_url?: string;
}

interface TailscaleState {
  step: number;
  state: "missing" | "login" | "ready" | "active" | "error";
  url: string;
  error: string;
  hint_url: string;
}

/**
 * Abrir la instancia al mundo, desde la propia aplicación (§6).
 * Antes esto era un comando para copiar en un terminal y una variable que
 * editar a mano en un fichero. Quien hospeda desde casa no tiene por qué pasar
 * por ahí para invitar a alguien: el botón hace las dos cosas.
 */
function ShareInstance() {
  const t = useT();
  const errorText = useErrorText();
  const publicUrl = useStore((s) => s.publicUrl);

  const [tunnel, setTunnel] = useState<TunnelState | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [autostart, setAutostart] = useState(true);
  const publicDiscoveryEnabled = useStore((s) => s.publicDiscoveryEnabled);
  const [mode, setMode] = useState<"cloudflare" | "tailscale" | "cloud">("cloudflare");
  const [tailscale, setTailscale] = useState<TailscaleState | null>(null);

  // Solo quien hospeda puede abrir el túnel; para el resto, la sección se queda
  // en "esta es la dirección" sin botones que darían 403.
  useEffect(() => {
    void api<TunnelState>("GET", "/api/v1/instance/tunnel")
      .then((state) => {
        setIsHost(true);
        setTunnel(state);
        /* El carril inicial lo dice el estado real, no una preferencia: con
           Funnel activo se abre Tailscale, y en un despliegue con PUBLIC_URL
           (la VM de la nube) se abre el carril nube — ahí los túneles sobran. */
        const lane = detectLane(state);
        if (lane === "tailscale") setMode("tailscale");
        else if (lane === "cloud-fixed") setMode("cloud");
        useStore.setState({ publicUrl: state.public_url });
        if (typeof state.autostart === "boolean") setAutostart(state.autostart);
      })
      .catch(() => setIsHost(false));
  }, []);

  useEffect(() => {
    if (!isHost || mode !== "tailscale") return;
    let cancelled = false;
    const load = () => void api<TailscaleState>("GET", "/api/v1/instance/tailscale")
      .then((state) => !cancelled && setTailscale(state))
      .catch((err) => !cancelled && setError(errorText(err)));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isHost, mode, errorText]);

  async function toggleAutostart(enabled: boolean): Promise<void> {
    setAutostart(enabled);
    try {
      await api("PUT", "/api/v1/instance/tunnel/autostart", { enabled });
    } catch (err) {
      setAutostart(!enabled);
      setError(errorText(err));
    }
  }

  /* El índice público es cosa de la instancia, no de una comunidad: por eso vive
     aquí y no en los ajustes de cada una. Al apagarlo la ficha sale del índice
     en el acto, no se queda hasta que caduque. */
  async function toggleDiscovery(enabled: boolean): Promise<void> {
    try {
      const state = await api<{ enabled: boolean }>("PUT", "/api/v1/instance/discovery", { enabled });
      useStore.setState({ publicDiscoveryEnabled: state.enabled });
    } catch (reason) {
      setError(errorText(reason));
    }
  }

  const address = publicUrl || clientOrigin();
  const isLocal = !publicUrl && /localhost|127\.0\.0\.1|\[::1\]/.test(address);
  /* Ya desplegada en una máquina con PUBLIC_URL propia (la VM de la nube):
     la dirección es fija y los túneles solo podrían romperla. */
  const cloudFixed = detectLane(tunnel) === "cloud-fixed";
  const tailscaleTextKey = {
    missing: "share.tailscale.missing",
    login: "share.tailscale.login",
    ready: "share.tailscale.ready",
    active: "share.tailscale.active",
    error: "share.tailscale.error",
  } as const;

  async function toggle(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const state = await api<TunnelState>(tunnel?.status === "on" ? "DELETE" : "POST", "/api/v1/instance/tunnel");
      setTunnel(state);
      // La dirección nueva manda ya para las invitaciones, sin reiniciar nada.
      useStore.setState({ publicUrl: state.public_url });
      if (state.status === "error") setError(t(state.error === "no-cloudflared" ? "share.needsCloudflared" : "share.failed"));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function advanceFixed(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const state = await api<TailscaleState>("POST", "/api/v1/instance/tailscale");
      setTailscale(state);
      if (state.url && state.state === "active") useStore.setState({ publicUrl: state.url });
      /* La primera activación devuelve una URL oficial que ya contiene el
         tailnet y el equipo. Abrirla evita mandar a la persona a buscar Funnel
         a mano en una consola cuyo menú cambia con frecuencia. El enlace queda
         también visible por si el navegador bloquea la pestaña automática. */
      if (state.hint_url) window.open(state.hint_url, "_blank", "noopener,noreferrer");
      if (state.error) setError(state.error);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function disableFixed(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const state = await api<TailscaleState>("DELETE", "/api/v1/instance/tailscale");
      setTailscale(state);
      setMode("cloudflare");
      const cloudflare = await api<TunnelState>("GET", "/api/v1/instance/tunnel");
      setTunnel(cloudflare);
      useStore.setState({ publicUrl: cloudflare.public_url });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

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

      {isLocal ? <p className="text-xs text-warn">{t("share.localOnly")}</p> : <p className="text-xs text-ok">{t("share.ready")}</p>}

      {isHost ? (
        <div className="flex flex-col gap-3">
          {/* Lo primero después de la dirección, porque es la pregunta que sigue a
              «tu servidor es alcanzable»: ¿quieres que además se le encuentre? Vivía
              al final de la tarjeta, debajo del tutorial del carril elegido, y el
              aviso de los ajustes de la comunidad mandaba aquí a buscar algo que no
              se veía sin bajar tres pantallas. */}
          <label className="flex items-start gap-2 rounded-[10px] border border-line p-3 text-xs">
            <input
              type="checkbox"
              checked={publicDiscoveryEnabled}
              onChange={(e) => void toggleDiscovery(e.target.checked)}
              style={{ accentColor: "var(--accent)" }}
            />
            <span>
              <span className="font-semibold">{t("share.discovery")}</span>
              <span className="block text-muted">{t("share.discoveryHint")}</span>
              {publicDiscoveryEnabled && !hasStablePublicAddress(tunnel) ? (
                <span className="mt-1 block text-warn">{t("share.discoveryNeedsStable")}</span>
              ) : null}
            </span>
          </label>
          <div className="grid grid-cols-3 gap-2 rounded-[10px] bg-sunken p-1">
            {/* Con dirección fija de la nube, los carriles de túnel se apagan:
                abrir uno rompería la dirección que la gente ya usa, así que no
                se ofrece un botón que solo puede estropear cosas (§29.6). */}
            <Button
              variant={mode === "cloudflare" ? "primary" : "ghost"}
              onClick={() => setMode("cloudflare")}
              disabled={cloudFixed}
              className="h-auto min-h-14 flex-col gap-0.5 py-2"
            >
              <span>{t("share.quick")}</span>
              <span className="text-[10px] font-normal opacity-75">{t("share.quickCost")}</span>
            </Button>
            <Button
              variant={mode === "tailscale" ? "primary" : "ghost"}
              onClick={() => setMode("tailscale")}
              disabled={cloudFixed}
              className="h-auto min-h-14 flex-col gap-0.5 py-2"
            >
              <span>{t("share.stable")}</span>
              <span className="text-[10px] font-normal opacity-75">{t("share.stableCost")}</span>
            </Button>
            <Button
              variant={mode === "cloud" ? "primary" : "ghost"}
              onClick={() => setMode("cloud")}
              className="h-auto min-h-14 flex-col gap-0.5 py-2"
            >
              <span>{t("share.alwaysOn")}</span>
              <span className="text-[10px] font-normal opacity-75">{t("share.alwaysOnCost")}</span>
            </Button>
          </div>

          {mode === "cloudflare" ? (
            <div className="flex flex-col gap-1.5">
              <Button variant={tunnel?.status === "on" ? "ghost" : "primary"} onClick={toggle} disabled={busy}>
                {busy ? t("share.opening") : tunnel?.status === "on" ? t("share.closeLink") : t("share.createLink")}
              </Button>
              <p className="text-xs text-muted">{t("share.cloudflareHint")}</p>
              <label className="flex items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={autostart}
                  onChange={(e) => void toggleAutostart(e.target.checked)}
                  style={{ accentColor: "var(--accent)" }}
                />
                <span>
                  <span className="font-semibold">{t("share.autostart")}</span>
                  <span className="block text-muted">{t("share.autostartHint")}</span>
                </span>
              </label>
            </div>
          ) : mode === "tailscale" ? (
            <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
              <p className="text-xs font-semibold">{t("share.fixedStep", { step: String(tailscale?.step ?? 1) })}</p>
              <ol className="flex list-decimal flex-col gap-1 pl-5 text-xs text-muted">
                <li>{t("share.tutorial.install")}</li>
                <li>{t("share.tutorial.continue")}</li>
                <li>{t("share.tutorial.authorize")}</li>
                <li>{t("share.tutorial.finish")}</li>
              </ol>
              <a
                className="text-xs font-semibold text-accent underline underline-offset-2"
                href="https://tailscale.com/docs/features/tailscale-funnel"
                target="_blank"
                rel="noreferrer"
              >
                {t("share.officialTutorial")}
              </a>
              <p className="text-xs text-muted">
                {t(tailscaleTextKey[tailscale?.state ?? "ready"])}
              </p>
              {tailscale?.url ? <code className="truncate rounded bg-sunken p-2 text-xs">{tailscale.url}</code> : null}
              {tailscale?.hint_url ? (
                <div className="flex flex-col gap-2 rounded-[10px] border-2 border-accent bg-accent/10 p-3 shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_20%,transparent)]">
                  <p className="text-xs font-bold text-accent">{t("share.authorizationRequired")}</p>
                  <p className="text-xs text-muted">{t("share.authorizationHint")}</p>
                  <a className="btn btn-primary min-h-10 w-full text-center text-sm font-bold" href={tailscale.hint_url} target="_blank" rel="noreferrer">
                    {t("share.enableFunnel")}
                  </a>
                </div>
              ) : null}
              {tailscale?.state === "active" ? (
                <Button variant="ghost" onClick={() => void disableFixed()} disabled={busy}>{t("share.useCloudflare")}</Button>
              ) : (
                <Button variant="primary" onClick={() => void advanceFixed()} disabled={busy}>
                  {busy ? t("common.loading") : t("share.continue")}
                </Button>
              )}
              <p className="text-xs text-muted">{t("share.tailscaleFairUse")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
              {cloudFixed ? (
                <>
                  {/* Ya corre en la nube: aquí no hay nada que encender, solo
                      decir dónde vive y de dónde sale esa dirección. */}
                  <p className="text-xs font-semibold">{t("share.cloudFixed")}</p>
                  <code className="truncate rounded bg-sunken p-2 text-xs">{tunnel?.public_url}</code>
                  <p className="text-xs text-muted">{t("share.cloudFixedHint")}</p>
                  <p className="text-xs text-muted">{t("share.cloudTunnelsOff")}</p>
                </>
              ) : (
                <>
                  {/* La oferta, contada entera y sin vender humo: una máquina
                      que no se apaga cuesta dinero o cuesta tener un equipo
                      encendido, y las dos cosas se dicen. Aquí NO se nombra
                      ningún proveedor concreto: recomendar uno que después no
                      da capacidad —lo que nos pasó con Oracle— es peor que no
                      recomendar ninguno. */}
                  <p className="text-xs font-semibold">{t("share.cloudTitle")}</p>
                  <p className="text-xs text-muted">{t("share.cloudHint")}</p>
                  <p className="text-xs text-muted">{t("share.cloudLimits")}</p>
                  <div className="grid gap-2">
                    <div className="rounded-[8px] bg-sunken p-2.5">
                      <p className="text-xs font-semibold">{t("share.alwaysOwnTitle")}</p>
                      <p className="mt-1 text-xs text-muted">{t("share.alwaysOwnHint")}</p>
                      <a className="mt-2 inline-block text-xs font-semibold text-accent underline underline-offset-2" href={RASPBERRY_GUIDE_URL} target="_blank" rel="noreferrer">
                        {t("share.alwaysOwnAction")}
                      </a>
                    </div>
                    <div className="rounded-[8px] bg-sunken p-2.5">
                      <p className="text-xs font-semibold">{t("share.alwaysVpsTitle")}</p>
                      <p className="mt-1 text-xs text-muted">{t("share.alwaysVpsHint")}</p>
                      <a className="mt-2 inline-block text-xs font-semibold text-accent underline underline-offset-2" href={VPS_INSTALL_GUIDE_URL} target="_blank" rel="noreferrer">
                        {t("share.alwaysVpsAction")}
                      </a>
                    </div>
                    <div className="rounded-[8px] bg-sunken p-2.5">
                      <p className="text-xs font-semibold">{t("share.alwaysManagedTitle")}</p>
                      <p className="mt-1 text-xs text-muted">{t("share.alwaysManagedHint")}</p>
                    </div>
                  </div>
                  <ExternalLinkButton href={CLOUD_GUIDE_URL}>{t("share.cloudGuide")}</ExternalLinkButton>
                </>
              )}
            </div>
          )}


          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      ) : null}

      <p className="text-xs text-muted">{t("share.hostReminder")}</p>
    </section>
  );
}

/**
 * El estado de las copias de seguridad, mirando a la cara (§21, §26).
 *
 * Solo lo ve quien hospeda: el GET es host-only y con 403 la sección entera
 * desaparece, como el túnel y la purga. Funciona también en la nube — el
 * listado sobrevive al proxy a propósito—, pero ahí `manual_available` viene
 * en falso y en vez de un botón que daría 403 se dice la verdad: las copias
 * manuales solo se piden desde el propio equipo anfitrión.
 */
function BackupsStatus() {
  const t = useT();
  const locale = useLocale();
  const errorText = useErrorText();

  const [view, setView] = useState<BackupsView | null>(null);
  const [visible, setVisible] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [job, setJob] = useState<BackupJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<BackupsView>("GET", "/api/v1/instance/backups")
      .then((value) => {
        setView(value);
        setVisible(true);
      })
      .catch(() => setVisible(false));
  }, []);

  /* Un trabajo en marcha se sigue de cerca: el estado del poll manda, y al
     terminar se recarga el listado para que la copia nueva aparezca en la
     lista sin cerrar y abrir el panel. */
  useEffect(() => {
    if (!job || job.state !== "running") return;
    const timer = setInterval(() => {
      void api<BackupJob>("GET", `/api/v1/instance/backups/${job.id}`)
        .then((next) => {
          setJob(next);
          if (next.state !== "running") {
            void api<BackupsView>("GET", "/api/v1/instance/backups").then(setView).catch(() => {});
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, [job]);

  async function create(): Promise<void> {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const started = await api<BackupJob>("POST", "/api/v1/instance/backups", { passphrase });
      setJob(started);
      // La frase muere aquí: cifró la copia y no se guarda en ninguna parte.
      setPassphrase("");
    } catch (err) {
      /* Cinturón defensivo: si a pesar de `manual_available` el POST contesta
         403 (un proxy nuevo por medio), el error del servidor ya lo dice. */
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (!visible) return null;

  const schedule = view ? describeSchedule(view.schedule) : null;
  const files = view ? sortBackupFiles(view.files) : [];
  const newest = files[0];

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
      <h3 className="display text-sm font-bold">{t("backups.title")}</h3>

      {!view || !schedule ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <>
          {schedule.kind === "on" ? (
            <p className="text-xs text-ok">{t("backups.scheduleOn", { hours: schedule.hours, keep: schedule.keep })}</p>
          ) : (
            <>
              <p className="text-xs text-warn">{t("backups.scheduleOff")}</p>
              {/* El hint nombra las variables reales: sin receta no hay copia. */}
              <p className="text-xs text-muted">{t("backups.scheduleOffHint")}</p>
              <ExternalLinkButton href={CLOUD_GUIDE_URL}>{t("backups.guide")}</ExternalLinkButton>
            </>
          )}

          <p className="text-xs text-muted">
            {newest
              ? t("backups.last", { date: formatDate(locale, newest.created_at), size: formatBytes(locale, newest.size) })
              : t("backups.none")}
          </p>

          {files.length > 0 ? (
            <>
              <span className="text-xs text-muted">{t("backups.files")}</span>
              <ul className="flex flex-col divide-y divide-line rounded-[10px] border border-line">
                {files.map((file) => (
                  <li key={file.filename} className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                    <span className="min-w-0 truncate font-mono">{file.filename}</span>
                    <span className="shrink-0 text-muted tabular-nums">
                      {formatDate(locale, file.created_at)} · {formatBytes(locale, file.size)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {view.manual_available ? (
            <>
              <Field label={t("backups.passphrase")} hint={t("backups.passphraseHint")}>
                {(id) => (
                  <input
                    id={id}
                    type="password"
                    autoComplete="off"
                    className="field"
                    value={passphrase}
                    onChange={(event) => setPassphrase(event.target.value)}
                  />
                )}
              </Field>
              <Button
                variant="primary"
                className="self-start"
                onClick={() => void create()}
                disabled={busy || passphrase.length < 12 || job?.state === "running"}
              >
                {job?.state === "running" ? t("backups.running") : t("backups.create")}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted">{t("backups.manualUnavailable")}</p>
          )}

          {job?.state === "done" ? <p className="text-xs text-ok">{t("backups.done")}</p> : null}
          {job?.state === "failed" ? <ErrorNote>{t("backups.failed")}</ErrorNote> : null}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </>
      )}
    </section>
  );
}

/**
 * Vaciar el historial para recuperar disco (§28.4).
 * Solo lo ve quien hospeda: el disco que se llena es el suyo. La advertencia
 * dice exactamente qué se va (chats, fotos, GIF y archivos, de TODAS las
 * comunidades) y qué se queda (las comunidades con sus miembros, roles,
 * canales, emojis y avatares). No hay papelera, y por eso hay dos pasos.
 */
function PurgeData() {
  const t = useT();
  const errorText = useErrorText();

  const [isHost, setIsHost] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ messages: number; files: number; mb: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Mismo trato que el túnel: si la instancia contesta 403, la sección entera
  // desaparece en vez de enseñar un botón que no funcionaría.
  useEffect(() => {
    // Vaciar el disco es más sensible que abrir el túnel: solo la cuenta
    // propietaria pasa por la configuración del relevo, que usa el mismo nivel
    // de autorización que la purga.
    void api("GET", "/api/v1/instance/relay")
      .then(() => setIsHost(true))
      .catch(() => setIsHost(false));
  }, []);

  if (!isHost) return null;

  async function purge(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      setDone(await api<{ messages: number; files: number; mb: number }>("POST", "/api/v1/instance/purge"));
      setConfirming(false);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-[10px] border border-danger/40 p-3">
      <h3 className="display text-sm font-bold text-danger">{t("instance.purge")}</h3>
      <p className="text-xs text-muted">{t("instance.purgeHint")}</p>

      {done ? <p className="text-xs text-ok">{t("instance.purgeDone", { messages: String(done.messages), mb: String(done.mb) })}</p> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {confirming ? (
        <>
          <p className="text-xs font-medium text-danger">{t("instance.purgeWarning")}</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirming(false)} disabled={busy}>
              {t("common.cancel")}
            </Button>
            <Button variant="danger" onClick={() => void purge()} disabled={busy}>
              {busy ? t("common.loading") : t("instance.purgeDo")}
            </Button>
          </div>
        </>
      ) : (
        <Button variant="danger" onClick={() => setConfirming(true)} className="self-start">
          {t("instance.purge")}
        </Button>
      )}
    </section>
  );
}
