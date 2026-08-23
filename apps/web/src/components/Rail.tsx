/**
 * Barra de comunidades y estado de la instancia.
 * El indicador de conexión vive aquí a propósito: en self-hosting saber si el
 * servidor está vivo es tan importante como el propio contenido (§26).
 */
import { useState } from "react";
import { useEffect, useMemo } from "react";
import { Link as LinkIcon, Server } from "lucide-react";
import { Cross } from "./icons.tsx";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, IconButton, Modal, Toggle, useT, useLocale, useErrorText } from "./ui.tsx";
import { api } from "../lib/api.ts";
import { clientOrigin, connectToInstance, isPackaged, parseInvite } from "../lib/instance.ts";
import { formatDuration } from "../i18n.ts";
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
  const unread = useCommunityUnread();

  const [status, setStatus] = useState(false);

  return (
    <nav
      data-pane="rail"
      aria-label={t("community.yours")}
      className="flex w-[4.5rem] flex-col items-center gap-2 border-r border-line bg-sunken pt-1 pb-3"
    >
      <ul className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
        {communities.map((community) => (
          <li key={community.id} className="group relative">
            {/* Una sola pastilla para los tres estados en vez de un punto y un
                marcador aparte: crece de 0 a 8 a 36 píxeles según sea "nada",
                "algo sin leer" o "estoy aquí". Así se lee una altura, que es una
                escala, en lugar de tener que distinguir dos formas distintas. */}
            <span
              aria-hidden="true"
              className={`marker-active absolute top-1/2 -left-3 w-1 -translate-y-1/2 transition-all duration-200 ${
                activeId === community.id
                  ? "h-9"
                  : unread[community.id]
                    ? "h-2 group-hover:h-5"
                    : "h-0 group-hover:h-5"
              }`}
            />
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

            {/* Fuera del botón y no dentro: el icono recorta su contenido, y una
                insignia dentro se quedaría a medias contra el borde redondeado. */}
            {unread[community.id] && activeId !== community.id ? (
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

      <IconButton label={t("instance.status")} onClick={() => setStatus(true)} className="h-10 w-10">
        <Server size={18} />
      </IconButton>
      <ConnectionDot />

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
      void api<{ community: { name: string; accent_color: string }; members: number }>(
        "GET",
        `/api/v1/invites/${encodeURIComponent(code)}`,
      )
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
      onCreated?.();
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

  // Solo quien hospeda puede abrir el túnel; para el resto, la sección se queda
  // en "esta es la dirección" sin botones que darían 403.
  useEffect(() => {
    void api<TunnelState>("GET", "/api/v1/instance/tunnel")
      .then((state) => {
        setIsHost(true);
        setTunnel(state);
        useStore.setState({ publicUrl: state.public_url });
        if (typeof state.autostart === "boolean") setAutostart(state.autostart);
      })
      .catch(() => setIsHost(false));
  }, []);

  async function toggleAutostart(enabled: boolean): Promise<void> {
    setAutostart(enabled);
    try {
      await api("PUT", "/api/v1/instance/tunnel/autostart", { enabled });
    } catch (err) {
      setAutostart(!enabled);
      setError(errorText(err));
    }
  }

  const address = publicUrl || clientOrigin();
  const isLocal = !publicUrl && /localhost|127\.0\.0\.1|\[::1\]/.test(address);

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
        <div className="flex flex-col gap-1.5">
          <Button variant={tunnel?.status === "on" ? "ghost" : "primary"} onClick={toggle} disabled={busy}>
            {busy ? t("share.opening") : tunnel?.status === "on" ? t("share.closeLink") : t("share.createLink")}
          </Button>
          <p className="text-xs text-muted">
            {tunnel?.status === "on" ? t("share.linkTemporary") : t("share.createLinkHint")}
          </p>

          {/* Se abre solo al arrancar, pero el ordenador queda accesible desde
              internet mientras la app este abierta: tiene que poder apagarse. */}
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

          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      ) : null}

      <p className="text-xs text-muted">{t("share.hostReminder")}</p>
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
