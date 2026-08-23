/**
 * Cascarón de la aplicación: rejilla maestra y navegación.
 * Tres rutas justifican treinta líneas de router propio, no una dependencia:
 * la aplicación entera vive detrás de una sesión y solo /invite es profunda.
 */
import { useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { CreateCommunity, JoinCommunity, Rail } from "./components/Rail.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { VoiceBar } from "./components/Voice.tsx";
import { UserBar } from "./components/UserBar.tsx";
import { Chat, VoiceChatPanel } from "./components/Chat.tsx";
import { Members } from "./components/Members.tsx";
import { Auth } from "./views/Auth.tsx";
import { Connect } from "./views/Connect.tsx";
import { Setup } from "./views/Setup.tsx";
import { Invite } from "./views/Invite.tsx";
import { Settings, type SettingsTab } from "./views/Settings.tsx";
import { WallpaperTuner } from "./components/Wallpaper.tsx";
import { Manage } from "./views/Manage.tsx";
import { Button, ErrorNote, Field, Modal, Spinner, Toggle, useErrorText, useT } from "./components/ui.tsx";
import { api } from "./lib/api.ts";
import {
  clearPendingCommunity,
  clientOrigin,
  connectToInstance,
  forgetKnownCommunity,
  instanceBase,
  isLocalInstance,
  isPackaged,
  parseInvite,
  peekPendingCommunity,
  setActiveInstance,
  takePendingInvite,
  type PendingCommunity,
} from "./lib/instance.ts";
import { phoneCanHost, startPhoneServer } from "./lib/phoneHost.ts";
import { onStaleBuild, watchBuild } from "./lib/version.ts";
import type { Invite as InviteEntity } from "@distop/protocol";

/**
 * Banda de "hay versión nueva".
 * No recarga sola: si estás en mitad de una llamada o escribiendo, decides tú
 * cuándo. Pero deja de ser invisible, que es lo que hacía perder tardes
 * persiguiendo fallos ya arreglados.
 */
function StaleBuild() {
  const t = useT();
  const [stale, setStale] = useState(false);

  useEffect(() => {
    watchBuild();
    return onStaleBuild(setStale);
  }, []);

  if (!stale) return null;

  return (
    <div className="fixed inset-x-0 bottom-3 z-50 mx-auto flex w-fit items-center gap-3 rounded-card border border-line bg-raise px-4 py-2.5 shadow-[var(--shadow)]">
      <span className="text-sm">{t("update.available")}</span>
      <Button variant="primary" onClick={() => location.reload()}>
        {t("update.reload")}
      </Button>
    </div>
  );
}

function usePath(): [string, (next: string) => void] {
  const [path, setPath] = useState(location.pathname);

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return [
    path,
    (next: string) => {
      history.pushState(null, "", next);
      setPath(next);
    },
  ];
}

/** Plegado de un panel, recordado entre sesiones: es una preferencia, no un modo. */
function usePanel(name: string, fallback: boolean) {
  const key = `distop.panel.${name}`;
  const [open, setOpen] = useState(() => (localStorage.getItem(key) ?? (fallback ? "on" : "off")) === "on");

  useEffect(() => {
    localStorage.setItem(key, open ? "on" : "off");
  }, [key, open]);

  return [open, setOpen] as const;
}

/** El mismo punto de corte que la rejilla de styles.css, en un solo sitio. */
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 900px)").matches);

  useEffect(() => {
    const query = matchMedia("(max-width: 900px)");
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return mobile;
}

export function App() {
  const t = useT();
  const [path, navigate] = usePath();

  const ready = useStore((s) => s.ready);
  const user = useStore((s) => s.user);
  const setup = useStore((s) => s.setup);
  const instance = useStore((s) => s.instance);
  const boot = useStore((s) => s.boot);
  const communities = useStore((s) => s.communities);
  const activeCommunityId = useStore((s) => s.activeCommunityId);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const activeData = useStore((s) => (activeCommunityId ? s.data[activeCommunityId] : undefined));
  const openCommunity = useStore((s) => s.openCommunity);

  const [settings, setSettings] = useState<SettingsTab | null>(null);
  /* En el store y no aquí: el selector de stickers, enterrado dentro de Chat,
     también ofrece traerte a esta pantalla, y pasarle un callback por tres
     componentes para eso era peor que una bandera compartida. */
  const manage = useStore((s) => s.manageOpen);
  const setManage = useStore((s) => s.setManageOpen);
  const [invite, setInvite] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [pendingCommunity, setPendingCommunity] = useState<PendingCommunity | null>(() => peekPendingCommunity());
  const [mobilePane, setMobilePane] = useState<"nav" | "main" | "members">("main");
  const [membersOpen, setMembersOpen] = usePanel("members", true);
  const isMobile = useIsMobile();
  const activeChannel = activeData?.channels.find((channel) => channel.id === activeChannelId);
  const voiceChat = activeChannel?.kind === "voice";

  // Al cambiar a una sala de voz, el lateral se convierte en su chat y se abre
  // una vez. Si la persona lo cierra después, se respeta hasta cambiar de canal.
  useEffect(() => {
    if (voiceChat && !isMobile) setMembersOpen(true);
  }, [activeChannelId, voiceChat, isMobile, setMembersOpen]);

  useEffect(() => {
    // Empaquetado y sin instancia elegida no hay a quién preguntar todavía.
    if (isPackaged() && !instanceBase) return;
    void (async () => {
      /* Si la comunidad activa vive en ESTE aparato, su servidor se enciende
         antes de preguntar nada: abrir la app debe encender tu comunidad, no
         recibirte con un error por tu propio servidor apagado. En el
         escritorio lo arranca Electron; en el teléfono, el motor embebido.
         Ambos arranques son idempotentes: si ya corre, vuelven al instante. */
      if (isPackaged() && isLocalInstance(instanceBase)) {
        if (window.distop?.host) await window.distop.host.start().catch(() => {});
        else if (phoneCanHost()) await startPhoneServer();
      }
      await boot();
    })();
  }, [boot]);

  /* El servidor puede abrir el túnel en paralelo al arranque del cliente. La
     primera /info aún puede verlo como "starting"; sin esta sincronización la
     URL pública existía, pero la interfaz conservaba 127.0.0.1 toda la sesión. */
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const syncTunnel = async () => {
      try {
        const tunnel = await api<{ status: string; public_url: string }>("GET", "/api/v1/instance/tunnel");
        if (cancelled) return;
        useStore.setState({ publicUrl: tunnel.public_url });
        if (tunnel.status === "starting") timer = setTimeout(syncTunnel, 750);
        else if (tunnel.status === "on") timer = setTimeout(syncTunnel, 10_000);
      } catch {
        // Un miembro remoto no administra la máquina anfitriona: 403 esperado.
      }
    };

    void syncTunnel();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [user]);

  // Una invitación pegada antes de conectar se abre en cuanto la app está en pie.
  useEffect(() => {
    if (!ready || !user) return;
    const code = takePendingInvite();
    if (code) navigate(`/invite/${code}`);
  }, [ready, user, navigate]);

  /* Al saltar a una comunidad ya conocida esperamos al READY del servidor: en
     ese momento la lista es definitiva. Si no está, la membresía desapareció;
     si está, se abre sin enseñar el cambio de instancia intermedio. */
  useEffect(() => {
    if (!pendingCommunity || !ready || !user || !instance) return;
    const found = communities.find((community) => community.id === pendingCommunity.id);
    if (found) {
      clearPendingCommunity();
      setPendingCommunity(null);
      void openCommunity(found.id);
      return;
    }
    forgetKnownCommunity(pendingCommunity.url, pendingCommunity.id);
  }, [pendingCommunity, ready, user, instance, communities, openCommunity]);

  // Ctrl/⌘+U pliega el lateral derecho sin ratón: miembros en texto, chat en voz.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "u") return;
      event.preventDefault();
      setMembersOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setMembersOpen]);

  // Al entrar sin comunidad activa, abre la primera: nadie quiere una pantalla vacía.
  useEffect(() => {
    if (user && !pendingCommunity && !activeCommunityId && communities[0]) void openCommunity(communities[0].id);
  }, [user, pendingCommunity, activeCommunityId, communities, openCommunity]);

  // La app instalada no la sirvió ninguna instancia: sin una elegida, lo
  // primero es elegirla. En la web esta rama no existe (§4).
  if (isPackaged() && !instanceBase) return <Connect />;

  if (ready && pendingCommunity && (!user || instance)) {
    const missing = !user || !communities.some((community) => community.id === pendingCommunity.id);
    if (missing)
      return (
        <UnavailableSwitch
          target={pendingCommunity}
          onBack={() => {
            clearPendingCommunity();
            setActiveInstance(pendingCommunity.previous_url || null);
          }}
        />
      );
  }

  const inviteCode = path.startsWith("/invite/") ? path.slice("/invite/".length) : null;

  if (inviteCode) {
    return (
      <Invite
        code={inviteCode}
        onEnter={(communityId) => {
          navigate("/");
          if (communityId) void openCommunity(communityId);
        }}
      />
    );
  }

  if (!ready) return <Spinner label={t("common.loading")} />;
  // Instancia sin dueño: quien la hospeda la pone en marcha sin pasar por login.
  // Con sesión abierta —de cuenta o de invitado— se entra directo: un invitado
  // puede crear su comunidad igual, y ponerle contraseña después reclama la
  // instancia sin repetir este paso.
  if (setup?.required && !user) return <Setup requiresCode={setup.requiresCode} />;
  if (!user) return <Auth />;

  return (
    <div
      className="app-grid"
      data-mobile={mobilePane}
      data-members={membersOpen ? "on" : "off"}
      data-right={voiceChat ? "voice-chat" : "members"}
    >
      <Rail onNavigate={() => setMobilePane("main")} onCreate={() => setCreating(true)} onJoin={() => setJoining(true)} />

      <Sidebar
        onOpenManage={() => setManage(true)}
        onOpenInvite={() => setInvite(true)}
        onNavigate={() => setMobilePane("main")}
      />

      <Chat
        onToggleMembers={() => (isMobile ? setMobilePane(mobilePane === "members" ? "main" : "members") : setMembersOpen(!membersOpen))}
        membersOpen={membersOpen}
        onOpenSidebar={() => setMobilePane("nav")}
        onCreateCommunity={() => setCreating(true)}
        onJoinCommunity={() => setJoining(true)}
      />

      {/* Siempre hay un lateral montado: plegarlo anima su columna y evita saltos.
          En móvil lo esconde la rejilla, no React. */}
      {voiceChat ? (
        <VoiceChatPanel onClose={() => (isMobile ? setMobilePane("main") : setMembersOpen(false))} />
      ) : (
        <Members onClose={() => (isMobile ? setMobilePane("main") : setMembersOpen(false))} />
      )}

      {/* Fuera del panel de canales y en su propia fila: así la barra de perfil
          cruza por debajo de la columna de comunidades en vez de terminar donde
          termina la lista, que es lo que la dejaba a media pared. */}
      <div data-pane="user" className="flex flex-col gap-2 p-2">
        <VoiceBar />
        <UserBar onOpenSettings={(tab = "profile") => setSettings(tab)} />
      </div>

      <Settings open={settings !== null} initialTab={settings ?? "profile"} onClose={() => setSettings(null)} />
      <Manage open={manage} onClose={() => setManage(false)} />
      <CreateInvite open={invite} onClose={() => setInvite(false)} />
      {/* Crear la comunidad desemboca en invitar: una comunidad de uno no es
          una comunidad, y el enlace es el siguiente paso natural, no un menú
          que haya que descubrir. */}
      <CreateCommunity open={creating} onClose={() => setCreating(false)} onCreated={() => setInvite(true)} />
      <JoinCommunity open={joining} onClose={() => setJoining(false)} />
      <WelcomeCreate
        onCreate={() => setCreating(true)}
        onJoin={() => setJoining(true)}
        blocked={creating || joining || invite || Boolean(inviteCode)}
      />
      <WallpaperTuner />
      <StaleBuild />
    </div>
  );
}

function UnavailableSwitch({ target, onBack }: { target: PendingCommunity; onBack: () => void }) {
  const t = useT();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function retry(): Promise<void> {
    setBusy(true);
    setError(null);
    clearPendingCommunity();
    try {
      const result = await connectToInstance(link);
      if (result !== "ok") {
        setError(t(result === "unreachable" ? "connect.unreachable" : result === "invalid" ? "connect.invalid" : "connect.notInstance"));
      }
    } catch {
      setError(t("error.generic"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-4">
      <section className="card flex w-full max-w-md flex-col gap-4 p-6">
        <h1 className="display text-xl font-bold">{target.name}</h1>
        <p className="text-sm text-muted">{t("community.unavailable")}</p>
        <Field label={t("community.joinLabel")} hint={t("community.rejoinHint")}>
          {(id) => <input id={id} className="field" value={link} onChange={(event) => setLink(event.target.value)} autoFocus />}
        </Field>
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <div className="flex justify-end gap-2">
          <Button onClick={onBack}>{t("common.back")}</Button>
          <Button variant="primary" onClick={() => void retry()} disabled={busy || !parseInvite(link)?.code}>
            {t("community.joinAction")}
          </Button>
        </div>
      </section>
    </main>
  );
}

/**
 * La bienvenida de quien entra sin ninguna comunidad (§34).
 * Es la "notificación" que pide el flujo: creas tu usuario, entras, y lo
 * primero que ves es el siguiente paso — crear tu comunidad o entrar a una.
 * Se puede cerrar ("ahora no") y no vuelve a insistir en esta sesión: la
 * pantalla vacía del chat conserva sus propios botones.
 */
function WelcomeCreate({ onCreate, onJoin, blocked }: { onCreate: () => void; onJoin: () => void; blocked: boolean }) {
  const t = useT();
  const ready = useStore((s) => s.ready);
  const user = useStore((s) => s.user);
  const communities = useStore((s) => s.communities);
  const [dismissed, setDismissed] = useState(false);

  const open = ready && Boolean(user) && communities.length === 0 && !dismissed && !blocked;
  if (!open) return null;

  return (
    <Modal
      open
      onClose={() => setDismissed(true)}
      title={t("welcome.title", { name: user!.display_name })}
      footer={
        <Button onClick={() => setDismissed(true)}>{t("welcome.later")}</Button>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("welcome.body")}</p>
        <Button
          variant="primary"
          onClick={() => {
            setDismissed(true);
            onCreate();
          }}
        >
          {t("welcome.create")}
        </Button>
        <Button
          onClick={() => {
            setDismissed(true);
            onJoin();
          }}
        >
          {t("welcome.join")}
        </Button>
      </div>
    </Modal>
  );
}

function CreateInvite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const communityId = useStore((s) => s.activeCommunityId);
  const publicUrl = useStore((s) => s.publicUrl);

  const [link, setLink] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [temporary, setTemporary] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reach, setReach] = useState<"idle" | "checking" | "ok" | "fail" | "local" | "opening">("idle");
  const [isHost, setIsHost] = useState(false);

  const address = (publicUrl || clientOrigin()).replace(/\/$/, "");
  const isLocal = /localhost|127\.0\.0\.1|\[::1\]/.test(address);

  useEffect(() => {
    if (!open) {
      setLink("");
      setCopied(false);
      setError(null);
      setReach("idle");
      return;
    }
    // Solo quien hospeda puede abrir el túnel; al resto no se le ofrece un botón
    // que devolvería 403.
    void api<{ status: string; public_url: string }>("GET", "/api/v1/instance/tunnel")
      .then((state) => {
        setIsHost(true);
        useStore.setState({ publicUrl: state.public_url });
      })
      .catch(() => setIsHost(false));
  }, [open]);

  /**
   * Comprobar la dirección ANTES de repartirla.
   * Un enlace de invitación con una dirección muerta —un túnel que se cerró, un
   * PUBLIC_URL viejo— parece perfecto y no le funciona a nadie. Quien lo comparte
   * se entera por el silencio del otro lado, y eso ya ha pasado aquí.
   */
  async function check(): Promise<void> {
    if (isLocal) {
      setReach("local");
      return;
    }
    setReach("checking");
    try {
      const res = await fetch(`${address}/health`, { signal: AbortSignal.timeout(8000) });
      setReach(res.ok ? "ok" : "fail");
    } catch {
      setReach("fail");
    }
  }

  /**
   * Abrir el túnel aquí mismo, sin mandar a nadie a otra pantalla.
   * El momento en que descubres que tu dirección no sirve es justo este, así que
   * la solución tiene que estar en este diálogo y no tres clics más allá.
   */
  async function openTunnel(): Promise<void> {
    setReach("opening");
    setError(null);
    try {
      const state = await api<{ status: string; url: string; public_url: string; error: string }>(
        "POST",
        "/api/v1/instance/tunnel",
      );
      if (state.status === "on" && state.public_url) {
        useStore.setState({ publicUrl: state.public_url });
        setReach("ok");
        // Un enlace creado con la dirección vieja ya no sirve: se rehace solo.
        if (link) await create(state.public_url);
      } else {
        setReach("fail");
        setError(t(state.error === "no-cloudflared" ? "share.needsCloudflared" : "share.failed"));
      }
    } catch (err) {
      setReach("fail");
      setError(errorText(err));
    }
  }

  async function create(overrideAddress?: string) {
    if (!communityId) return;
    setError(null);
    try {
      const created = await api<InviteEntity>("POST", `/api/v1/communities/${communityId}/invites`, {
        max_uses: maxUses ? Number(maxUses) : null,
        expires_in_s: temporary ? 60 * 60 * 24 * 7 : null,
      });
      // La dirección pública manda: un enlace a localhost no le sirve a nadie más.
      const base = (overrideAddress || publicUrl || clientOrigin()).replace(/\/$/, "");
      setLink(`${base}/invite/${created.code}`);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("community.invite")}
      footer={
        <>
          <Button onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" onClick={() => void create()}>
            {t("manage.newInvite")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Paso previo: de dónde va a salir el enlace y si esa dirección
            responde. Antes se creaba a ciegas sobre lo que hubiera en PUBLIC_URL. */}
        <section className="flex flex-col gap-2 rounded-[10px] border border-line p-3">
          <span className="text-xs text-muted">{t("invite.willUse")}</span>
          <code className="truncate text-xs">{address}</code>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void check()} disabled={reach === "checking" || reach === "opening"}>
              {reach === "checking" ? t("invite.checking") : t("invite.check")}
            </Button>
            {reach === "ok" ? <span className="text-xs text-ok">{t("invite.reachable")}</span> : null}
            {reach === "fail" ? <span className="text-xs text-danger">{t("invite.unreachable")}</span> : null}
            {reach === "local" ? <span className="text-xs text-warn">{t("invite.localOnly")}</span> : null}
          </div>

          {/* La salida está aquí mismo, no en otra pantalla. */}
          {isHost && (reach === "fail" || reach === "local" || reach === "opening") ? (
            <div className="flex flex-col gap-1.5">
              <Button variant="primary" onClick={() => void openTunnel()} disabled={reach === "opening"}>
                {reach === "opening" ? t("share.opening") : t("share.createLink")}
              </Button>
              <p className="text-xs text-muted">{t("invite.tunnelHere")}</p>
            </div>
          ) : null}

          {!isHost && (reach === "fail" || reach === "local") ? (
            <p className="text-xs text-muted">{t("invite.fixHint")}</p>
          ) : null}
        </section>

        <Field label={t("manage.inviteUses")} hint={t("manage.inviteUnlimited")}>
          {(id) => (
            <input
              id={id}
              className="field"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, "").slice(0, 5))}
            />
          )}
        </Field>

        <Toggle checked={temporary} onChange={setTemporary} label={t("manage.inviteExpires")} hint="7 d" />

        {link ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-line p-2">
            <code className="min-w-0 flex-1 truncate text-sm">{link}</code>
            <Button
              onClick={async () => {
                await navigator.clipboard.writeText(link);
                setCopied(true);
              }}
            >
              {copied ? t("common.copied") : t("common.copy")}
            </Button>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Modal>
  );
}
