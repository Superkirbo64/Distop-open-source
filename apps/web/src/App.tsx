/**
 * Cascarón de la aplicación: rejilla maestra y navegación.
 * Tres rutas justifican treinta líneas de router propio, no una dependencia:
 * la aplicación entera vive detrás de una sesión y solo /invite es profunda.
 */
import { useEffect, useState } from "react";
import { useStore } from "./store.ts";
import { Rail } from "./components/Rail.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Chat } from "./components/Chat.tsx";
import { Members } from "./components/Members.tsx";
import { Auth } from "./views/Auth.tsx";
import { Setup } from "./views/Setup.tsx";
import { Invite } from "./views/Invite.tsx";
import { Settings } from "./views/Settings.tsx";
import { Manage } from "./views/Manage.tsx";
import { Button, ErrorNote, Field, Modal, Spinner, Toggle, useErrorText, useT } from "./components/ui.tsx";
import { api } from "./lib/api.ts";
import type { Invite as InviteEntity } from "@distop/protocol";

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
  const boot = useStore((s) => s.boot);
  const communities = useStore((s) => s.communities);
  const activeCommunityId = useStore((s) => s.activeCommunityId);
  const openCommunity = useStore((s) => s.openCommunity);

  const [settings, setSettings] = useState(false);
  const [manage, setManage] = useState(false);
  const [invite, setInvite] = useState(false);
  const [mobilePane, setMobilePane] = useState<"nav" | "main" | "members">("main");
  const [sidebarOpen, setSidebarOpen] = usePanel("sidebar", true);
  const [membersOpen, setMembersOpen] = usePanel("members", true);
  const isMobile = useIsMobile();

  useEffect(() => {
    void boot();
  }, [boot]);

  // Ctrl/⌘+B para los canales, Ctrl/⌘+U para los miembros: plegar sin ratón.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== "b" && key !== "u") return;
      event.preventDefault();
      if (key === "b") setSidebarOpen((open) => !open);
      else setMembersOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setSidebarOpen, setMembersOpen]);

  // Al entrar sin comunidad activa, abre la primera: nadie quiere una pantalla vacía.
  useEffect(() => {
    if (user && !activeCommunityId && communities[0]) void openCommunity(communities[0].id);
  }, [user, activeCommunityId, communities, openCommunity]);

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
      data-sidebar={sidebarOpen ? "on" : "off"}
      data-members={membersOpen ? "on" : "off"}
    >
      <Rail onNavigate={() => setMobilePane("main")} />

      <Sidebar
        onOpenSettings={() => setSettings(true)}
        onOpenManage={() => setManage(true)}
        onOpenInvite={() => setInvite(true)}
        onNavigate={() => setMobilePane("main")}
      />

      <Chat
        onToggleMembers={() => (isMobile ? setMobilePane(mobilePane === "members" ? "main" : "members") : setMembersOpen(!membersOpen))}
        onToggleSidebar={() => setSidebarOpen(!sidebarOpen)}
        sidebarOpen={sidebarOpen}
        membersOpen={membersOpen}
        onOpenSidebar={() => setMobilePane("nav")}
      />

      {/* Siempre montado: plegarlo anima su columna, y desmontarlo daría el salto
          que estamos quitando. En móvil lo esconde la rejilla, no React. */}
      <Members onClose={() => (isMobile ? setMobilePane("main") : setMembersOpen(false))} />

      <Settings open={settings} onClose={() => setSettings(false)} />
      <Manage open={manage} onClose={() => setManage(false)} />
      <CreateInvite open={invite} onClose={() => setInvite(false)} />
    </div>
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

  useEffect(() => {
    if (!open) {
      setLink("");
      setCopied(false);
      setError(null);
    }
  }, [open]);

  async function create() {
    if (!communityId) return;
    setError(null);
    try {
      const created = await api<InviteEntity>("POST", `/api/v1/communities/${communityId}/invites`, {
        max_uses: maxUses ? Number(maxUses) : null,
        expires_in_s: temporary ? 60 * 60 * 24 * 7 : null,
      });
      // La dirección pública manda: un enlace a localhost no le sirve a nadie más.
      setLink(`${(publicUrl || location.origin).replace(/\/$/, "")}/invite/${created.code}`);
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
          <Button variant="primary" onClick={create}>
            {t("manage.newInvite")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("manage.inviteUses")} hint={t("manage.inviteUnlimited")}>
          {(id) => (
            <input
              id={id}
              className="field"
              type="number"
              min={1}
              max={10000}
              value={maxUses}
              onChange={(e) => setMaxUses(e.target.value)}
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
