/**
 * Cascarón de la aplicación: rejilla maestra y navegación.
 * Tres rutas justifican treinta líneas de router propio, no una dependencia:
 * la aplicación entera vive detrás de una sesión y solo /invite es profunda.
 */
import { Suspense, lazy, useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { CreateCommunity, JoinCommunity, Rail } from "./components/Rail.tsx";
import { NoticeToaster } from "./components/Notices.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { VoiceBar } from "./components/Voice.tsx";
import { UserBar } from "./components/UserBar.tsx";
import { Chat, VoiceChatPanel } from "./components/Chat.tsx";
import { Members } from "./components/Members.tsx";
import { DirectChat, DirectSidebar } from "./components/Direct.tsx";
import { Explore, ExploreSidebar } from "./components/Explore.tsx";
import { Auth } from "./views/Auth.tsx";
import { Connect } from "./views/Connect.tsx";
import { Setup } from "./views/Setup.tsx";
import { Invite } from "./views/Invite.tsx";
import { GuestMeeting, Meet } from "./views/Meet.tsx";
import type { SettingsTab } from "./views/Settings.tsx";
import { WallpaperTuner } from "./components/Wallpaper.tsx";

/* Ajustes y administración pesan miles de líneas y la mayoría de sesiones no
   los abren: van en su propio chunk y se piden con el primer clic. Una vez
   montados no se desmontan, para que la animación de cierre del modal viva. */
const Settings = lazy(() => import("./views/Settings.tsx").then((m) => ({ default: m.Settings })));
const Manage = lazy(() => import("./views/Manage.tsx").then((m) => ({ default: m.Manage })));
import { Button, ErrorNote, Field, Modal, Spinner, Toggle, useErrorText, useT } from "./components/ui.tsx";
import { api } from "./lib/api.ts";
import {
  clearPendingCommunity,
  clearPendingPublicJoin,
  clientOrigin,
  connectToInstance,
  forgetKnownCommunity,
  instanceBase,
  isLocalInstance,
  isPackaged,
  normalizeInstanceUrl,
  peekPendingCommunity,
  peekPendingPublicJoin,
  setActiveInstance,
  takePendingInvite,
  type PendingCommunity,
} from "./lib/instance.ts";
import { phoneCanHost, startPhoneServer } from "./lib/phoneHost.ts";
import { ensurePortableIdentity } from "./lib/portable.ts";
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

/** El mismo punto de corte que la rejilla de styles.css, en un solo sitio.
    `pointer: coarse` además del ancho: una ventana de PC angosta tiene ratón,
    no dedo, y el sidebar no se pliega solo porque la ventana sea estrecha. */
const MOBILE_QUERY = "(max-width: 900px) and (pointer: coarse)";
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(() => matchMedia(MOBILE_QUERY).matches);

  useEffect(() => {
    const query = matchMedia(MOBILE_QUERY);
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
  const backupPassphrase = useStore((s) => s.backupPassphrase);
  const guestMeeting = useStore((s) => s.guestMeeting);
  const instance = useStore((s) => s.instance);
  const boot = useStore((s) => s.boot);
  const communities = useStore((s) => s.communities);
  const activeCommunityId = useStore((s) => s.activeCommunityId);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const directOpen = useStore((s) => s.directOpen);
  const activeData = useStore((s) => (activeCommunityId ? s.data[activeCommunityId] : undefined));
  const openCommunity = useStore((s) => s.openCommunity);
  const reloadCommunities = useStore((s) => s.reloadCommunities);

  const [settings, setSettings] = useState<SettingsTab | null>(null);
  /* En el store y no aquí: el selector de stickers, enterrado dentro de Chat,
     también ofrece traerte a esta pantalla, y pasarle un callback por tres
     componentes para eso era peor que una bandera compartida. */
  const manage = useStore((s) => s.manageOpen);
  const setManage = useStore((s) => s.setManageOpen);
  const [invite, setInvite] = useState(false);
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);
  const [explore, setExplore] = useState(false);
  const [pendingCommunity, setPendingCommunity] = useState<PendingCommunity | null>(() => peekPendingCommunity());
  const [mobilePane, setMobilePane] = useState<"nav" | "main" | "members">("main");
  const [membersOpen, setMembersOpen] = usePanel("members", true);
  const [changedPublicUrl, setChangedPublicUrl] = useState("");
  const isMobile = useIsMobile();
  const activeChannel = activeData?.channels.find((channel) => channel.id === activeChannelId);
  // Una reunión también tiene su chat: es un canal (§8.1), y sin esto el panel
  // lateral de mensajes solo existía para las salas de voz de siempre.
  const voiceChat = activeChannel?.kind === "voice" || activeChannel?.kind === "meeting";

  // Montados con el primer uso y ya no se desmontan (ver el lazy de arriba).
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [manageMounted, setManageMounted] = useState(false);
  useEffect(() => {
    if (settings !== null) setSettingsMounted(true);
  }, [settings]);
  useEffect(() => {
    if (manage) setManageMounted(true);
  }, [manage]);

  /* El panel de miembros plegado se desmonta cuando termina la animación de su
     columna (--dur-3 = 0.42s): plegado ya no re-renderiza con cada presencia ni
     retiene su DOM (banners incluidos). En móvil manda mobilePane, como siempre. */
  const membersVisible = !directOpen && !explore && (isMobile ? mobilePane === "members" : membersOpen);
  const [membersMounted, setMembersMounted] = useState(membersVisible);
  useEffect(() => {
    if (directOpen) setMobilePane("main");
  }, [directOpen]);
  useEffect(() => {
    if (membersVisible) {
      setMembersMounted(true);
      return;
    }
    const timer = setTimeout(() => setMembersMounted(false), 450);
    return () => clearTimeout(timer);
  }, [membersVisible]);

  // Al cambiar a una sala de voz, el lateral se convierte en su chat y se abre
  // una vez. Si la persona lo cierra después, se respeta hasta cambiar de canal.
  // Una reunión entra sin el chat delante: se viene a ver caras, no mensajes.
  useEffect(() => {
    if (isMobile) return;
    if (activeChannel?.kind === "voice") setMembersOpen(true);
    else if (activeChannel?.kind === "meeting") setMembersOpen(false);
  }, [activeChannelId, activeChannel?.kind, isMobile, setMembersOpen]);

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

  /* Toda forma de entrada termina poniendo `user` en el store. Enlazar aquí la
     identidad del dispositivo evita que una dirección pública nueva cree otra
     persona: el servidor puede devolver el mismo user_id, membresías y roles. */
  useEffect(() => {
    if (!user) return;
    void ensurePortableIdentity(user).catch(() => {
      // Compatibilidad con instancias antiguas: conservar la sesión actual.
    });
  }, [user?.id]);

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
        if (tunnel.public_url) {
          const key = "distop.lastPublicUrl";
          const previous = localStorage.getItem(key);
          if (previous && previous !== tunnel.public_url) setChangedPublicUrl(tunnel.public_url);
          localStorage.setItem(key, tunnel.public_url);
        }
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

  /* Explorar puede llevar a otra instancia. El objetivo sobrevive tanto a la
     recarga de la app instalada como al formulario de acceso de la web. */
  useEffect(() => {
    if (!ready || !user) return;
    const query = new URLSearchParams(location.search).get("join");
    const queryPolicy = new URLSearchParams(location.search).get("policy") === "request" ? "request" : "open";
    const pending = peekPendingPublicJoin();
    const communityId = query || pending?.communityId;
    const policy = query ? queryPolicy : (pending?.policy ?? "open");
    if (!communityId) return;
    const endpoint = `/api/v1/public-communities/${encodeURIComponent(communityId)}/${policy === "open" ? "join" : "requests"}`;
    void api<{ community?: { id: string } }>("POST", endpoint, {})
      .then(async ({ community }) => {
        clearPendingPublicJoin();
        history.replaceState({}, "", "/");
        navigate("/");
        if (!community) return;
        await reloadCommunities();
        await openCommunity(community.id);
      })
      .catch(() => {
        /* Se conserva el objetivo: iniciar sesión puede completar la entrada
           después sin perder la comunidad que se eligió. */
      });
  }, [ready, user, navigate, reloadCommunities, openCommunity]);

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
    if (user && !pendingCommunity && !directOpen && !activeCommunityId && communities[0]) void openCommunity(communities[0].id);
  }, [user, pendingCommunity, directOpen, activeCommunityId, communities, openCommunity]);

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

  /* Enlace de reunión. Va antes que todo lo demás —incluso que el arranque— por
     lo mismo que /invite: es la única ruta profunda que alguien puede recibir
     sin tener nada abierto. La sesión que produce solo sirve para esa reunión,
     así que en cuanto existe, la aplicación entera se sustituye por ella. */
  const meetToken = path.startsWith("/meet/") ? path.slice("/meet/".length) : null;

  if (guestMeeting) return <GuestMeeting meeting={guestMeeting} />;

  if (meetToken) {
    return <Meet token={meetToken} onEnter={() => navigate("/")} />;
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
      data-members={!directOpen && !explore && membersOpen ? "on" : "off"}
      data-right={voiceChat ? "voice-chat" : "members"}
    >
      {/* Fuera de la rejilla: se pinta encima de todo y no empuja nada. */}
      <NoticeToaster />
      <Rail
        onNavigate={() => { setExplore(false); setMobilePane("main"); }}
        onCreate={() => setCreating(true)}
        onJoin={() => setJoining(true)}
        onExplore={() => { setExplore(true); setMobilePane("main"); }}
      />

      {explore ? (
        <ExploreSidebar onNavigate={() => setMobilePane("main")} onJoinWithLink={() => { setExplore(false); setJoining(true); }} />
      ) : directOpen ? (
        <DirectSidebar onNavigate={() => setMobilePane("main")} />
      ) : (
        <Sidebar
          onOpenManage={() => setManage(true)}
          onOpenInvite={() => setInvite(true)}
          onNavigate={() => setMobilePane("main")}
        />
      )}

      {explore ? (
        <Explore onOpenSidebar={() => setMobilePane("nav")} onLeave={() => setExplore(false)} />
      ) : directOpen ? (
        <DirectChat onOpenSidebar={() => setMobilePane("nav")} />
      ) : (
        <Chat
          onToggleMembers={() => (isMobile ? setMobilePane(mobilePane === "members" ? "main" : "members") : setMembersOpen(!membersOpen))}
          membersOpen={membersOpen}
          onOpenSidebar={() => setMobilePane("nav")}
          onCreateCommunity={() => setCreating(true)}
          onJoinCommunity={() => setJoining(true)}
        />
      )}

      {/* El lateral sigue montado DURANTE el pliegue (la columna anima sin
          saltos) y se desmonta al terminar: plegado no cuesta nada. */}
      {!directOpen && !explore && voiceChat ? (
        <VoiceChatPanel onClose={() => (isMobile ? setMobilePane("main") : setMembersOpen(false))} />
      ) : !directOpen && !explore && membersMounted ? (
        <Members onClose={() => (isMobile ? setMobilePane("main") : setMembersOpen(false))} />
      ) : null}

      {/* Fuera del panel de canales y en su propia fila: así la barra de perfil
          cruza por debajo de la columna de comunidades en vez de terminar donde
          termina la lista, que es lo que la dejaba a media pared. */}
      <div data-pane="user" className="flex flex-col gap-2 p-2">
        <VoiceBar />
        <UserBar onOpenSettings={(tab = "profile") => setSettings(tab)} />
      </div>

      {settingsMounted ? (
        <Suspense fallback={null}>
          <Settings open={settings !== null} initialTab={settings ?? "profile"} onClose={() => setSettings(null)} />
        </Suspense>
      ) : null}
      {manageMounted ? (
        <Suspense fallback={null}>
          <Manage open={manage} onClose={() => setManage(false)} />
        </Suspense>
      ) : null}
      <CreateInvite open={invite} onClose={() => setInvite(false)} />
      {/* Crear la comunidad desemboca en invitar: una comunidad de uno no es
          una comunidad, y el enlace es el siguiente paso natural, no un menú
          que haya que descubrir. */}
      <CreateCommunity open={creating} onClose={() => setCreating(false)} onCreated={() => setInvite(true)} />
      <JoinCommunity open={joining} onClose={() => setJoining(false)} />
      <WelcomeCreate
        onCreate={() => setCreating(true)}
        onJoin={() => setJoining(true)}
        /* La frase de las copias se enseña una sola vez: la bienvenida, que
           vuelve siempre que no haya comunidad, espera en vez de taparla. */
        blocked={directOpen || explore || creating || joining || invite || Boolean(inviteCode) || Boolean(backupPassphrase)}
      />
      <BackupPassphraseNotice />
      <WallpaperTuner />
      {changedPublicUrl ? (
        <div className="fixed right-4 bottom-4 z-50 flex max-w-sm flex-col gap-2 rounded-card border border-line bg-raise p-4 shadow-[var(--shadow)]">
          <p className="text-sm font-semibold">{t("share.addressChanged")}</p>
          <code className="truncate rounded bg-sunken p-2 text-xs">{changedPublicUrl}</code>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setChangedPublicUrl("")}>{t("common.close")}</Button>
            <Button variant="primary" onClick={() => void navigator.clipboard.writeText(changedPublicUrl)}>{t("common.copy")}</Button>
          </div>
        </div>
      ) : null}
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
          <Button variant="primary" onClick={() => void retry()} disabled={busy || !normalizeInstanceUrl(link)}>
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
/**
 * Frase de las copias, enseñada al reclamar la instancia (§21).
 * Solo aparece donde hay copias programadas y la instancia llega desde fuera
 * —una VM en la nube—, porque ahí el fichero solo se lee por SSH y una frase
 * que nadie guardó convierte cada copia diaria en un fichero inútil. Se cierra
 * a mano; si se cierra sin copiarla, sigue en /data/backup-passphrase, que es
 * justo lo que dice el aviso para que un descuido no dé miedo.
 */
function BackupPassphraseNotice() {
  const t = useT();
  const passphrase = useStore((s) => s.backupPassphrase);
  const [copied, setCopied] = useState(false);

  if (!passphrase) return null;

  /* Se borra del estado al cerrar, no se marca "visto" aparte: mientras siga
     ahí, la bienvenida espera (arriba, en `blocked`), y así el aviso no vive
     más de lo que dura en pantalla. */
  const close = () => useStore.setState({ backupPassphrase: null });

  return (
    <Modal
      open
      onClose={close}
      title={t("backupPhrase.title")}
      footer={<Button variant="primary" onClick={close}>{t("backupPhrase.saved")}</Button>}
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t("backupPhrase.body")}</p>
        <code className="rounded-card border border-line bg-sunken p-3 font-mono text-sm break-all select-all">{passphrase}</code>
        <Button
          onClick={() => {
            void navigator.clipboard.writeText(passphrase).then(() => setCopied(true));
          }}
        >
          {copied ? t("common.copied") : t("common.copy")}
        </Button>
        <p className="text-xs text-muted">{t("backupPhrase.fallback")}</p>
      </div>
    </Modal>
  );
}

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
