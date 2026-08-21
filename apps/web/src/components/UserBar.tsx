/**
 * Barra de usuario y su menú de perfil (§10.1, §25).
 *
 * Es la esquina que más se pulsa de toda la aplicación, así que el menú se abre
 * en grande: portada, avatar, estado y las acciones con su nombre entero, en vez
 * de una fila de iconos que hay que adivinar.
 *
 * Lo que NO hay aquí, a propósito: el bloque de "mejora tu perfil", la tienda y
 * las ventajas de pago. En las plataformas comerciales ocupan justo este sitio
 * —el más visible— porque desde aquí se vende la personalización. Aquí la
 * personalización ya viene incluida, así que el hueco es para el estado (§10, §29.6).
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy, LogOut, Pencil } from "lucide-react";
import { USER_STATUSES, type UserStatus } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Gear, Headset, Microphone } from "./icons.tsx";
import { Avatar, DisplayName, IconButton, Menu, StatusDot, useT, type PresenceRing } from "./ui.tsx";
import { cardBackground, effectClass, profileSurfaceBackground } from "./ProfileStyle.tsx";
import { setDeafened, setMuted } from "../lib/voice.ts";
import { useVoiceLocal } from "./Voice.tsx";

/**
 * Cómo se ve un estado desde fuera.
 * `invisible` se pinta como desconectado incluso para uno mismo: si en tu propia
 * barra siguieras viéndote en verde, sería fácil creer que la gente te ve, que
 * es exactamente lo contrario de lo que pediste.
 */
export function ringOf(status: UserStatus, connected: boolean): PresenceRing {
  if (!connected || status === "invisible") return "offline";
  return status;
}

export function UserBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const t = useT();
  const user = useStore((s) => s.user);
  const status = useStore((s) => s.status);
  const local = useVoiceLocal();

  if (!user) return null;
  const ring = ringOf(user.status, status === "online");

  /* Lo que se lee bajo el nombre, por orden de "cuanto cambia": la frase que uno
     escribe, luego estar en una llamada, y si no, el estado de presencia. El
     `@usuario` que había antes no cambia nunca, así que no informaba de nada. */
  const pie = user.custom_status
    ? user.custom_status
    : local.channelId
      ? t("voice.inChannel")
      : user.kind === "guest"
        ? t("members.guest")
        : t(`status.${status === "online" ? user.status : "offline"}`);

  return (
    /* Tarjeta suelta y no una franja pegada al borde: la barra de perfil no es
       una fila más de la lista de canales, es un panel propio. Separarla con aire
       y esquinas lo dice sin necesidad de una línea divisoria. */
    <div
      /* Tarjeta suelta y no una franja pegada al borde: la barra de perfil no es
         una fila más de la lista de canales, es un panel propio. Y lleva el mismo
         banner que la tarjeta grande, para que configurar uno configure los dos:
         son las dos caras del mismo perfil, no dos ajustes distintos. */
      /* Sin `overflow-hidden`: el menú de perfil se abre DENTRO de esta barra, y
         recortarla lo dejaba invisible —existía y medía 304×582, pero no se
         pintaba ni un píxel—. Para el fondo no hacía falta: un background-image
         ya lo recorta el propio `rounded-card`. */
      className="relative flex h-[var(--footer-h)] shrink-0 items-center gap-1 rounded-card border border-line/60 bg-raise/55 px-2 shadow-[var(--shadow)] backdrop-blur-md"
      style={
        user.banner_url
          ? {
              /* Velo alto a propósito: al 62% la foto competía con el nombre y
                 los iconos quedaban encima del dibujo, ilegibles. Aquí manda el
                 texto —es una barra de control, no una postal— y la imagen se
                 intuye. Además se oscurece hacia la derecha, que es donde están
                 el micro, los auriculares y los ajustes (§31). */
              backgroundImage: `linear-gradient(to right, color-mix(in oklab, var(--raise) 80%, transparent), color-mix(in oklab, var(--raise) 92%, transparent)), url(${JSON.stringify(user.banner_url)})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
            }
          : undefined
      }
    >
      <Menu
        flush
        trigger={({ onClick }) => (
          <button
            onClick={onClick}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1 py-1 text-left transition-colors hover:bg-surface"
          >
            <Avatar name={user.display_name} url={user.avatar_url} id={user.id} size={34} ring={ring} profile={user.profile_style} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">
                <DisplayName name={user.display_name} style={user.profile_style} accent={user.accent_color} />
              </span>
              {/* El estado escrito manda sobre el nombre de usuario: es lo que
                  cambia, y por tanto lo que aporta información al mirarlo. */}
              <span className="block truncate text-xs text-muted">{pie}</span>
            </span>
          </button>
        )}
      >
        {(close) => <ProfileMenu onOpenSettings={onOpenSettings} close={close} />}
      </Menu>

      {/* Micro y auriculares viven aquí y no solo dentro de la llamada: callarse
          es lo primero que se busca, y buscarlo dentro de otro panel es tarde. */}
      {/* Se pinta el estado REAL: si calla la instancia —moderación o falta de
          permiso para hablar— el botón no puede seguir enseñando el micro abierto. */}
      <IconButton
        label={
          local.forcedMuted
            ? t("voice.cannotSpeak")
            : local.muted
              ? t("voice.unmute")
              : t("voice.mute")
        }
        pressed={local.muted || local.forcedMuted}
        disabled={local.forcedMuted}
        onClick={() => setMuted(!local.muted)}
        className={local.muted || local.forcedMuted ? "text-danger" : ""}
      >
        <Microphone size={16} muted={local.muted || local.forcedMuted} />
      </IconButton>
      <IconButton
        label={
          local.forcedDeafened
            ? t("voice.forcedDeafened")
            : local.deafened
              ? t("voice.undeafen")
              : t("voice.deafen")
        }
        pressed={local.deafened || local.forcedDeafened}
        disabled={local.forcedDeafened}
        onClick={() => setDeafened(!local.deafened)}
        className={local.deafened || local.forcedDeafened ? "text-danger" : ""}
      >
        <Headset size={16} muted={local.deafened || local.forcedDeafened} />
      </IconButton>
      <IconButton label={t("settings.title")} onClick={onOpenSettings}>
        <Gear size={16} />
      </IconButton>
    </div>
  );
}

function ProfileMenu({ onOpenSettings, close }: { onOpenSettings: () => void; close: () => void }) {
  const t = useT();
  const user = useStore((s) => s.user);
  const connection = useStore((s) => s.status);
  const refreshUser = useStore((s) => s.refreshUser);
  const logout = useStore((s) => s.logout);

  const [frase, setFrase] = useState(user?.custom_status ?? "");
  const [copiado, setCopiado] = useState(false);
  const guardado = useRef(user?.custom_status ?? "");

  useEffect(() => {
    setFrase(user?.custom_status ?? "");
    guardado.current = user?.custom_status ?? "";
  }, [user?.custom_status]);

  if (!user) return null;

  async function guardar(cambios: { status?: UserStatus; custom_status?: string }) {
    // Optimista: el estado propio tiene que responder al instante o parece roto.
    const antes = user!;
    refreshUser({ ...antes, ...cambios } as typeof antes);
    try {
      const actualizado = await api<typeof antes>("PATCH", "/api/v1/users/me", cambios);
      refreshUser(actualizado);
    } catch {
      refreshUser(antes);
    }
  }

  const etiquetas: Record<UserStatus, string> = {
    online: t("status.online"),
    idle: t("status.idle"),
    dnd: t("status.dnd"),
    invisible: t("status.invisible"),
  };
  const pistas: Partial<Record<UserStatus, string>> = {
    dnd: t("status.dndHint"),
    invisible: t("status.invisibleHint"),
  };

  return (
    <div
      className="w-[21rem] max-w-[92vw] overflow-hidden"
      style={{ background: profileSurfaceBackground(user.profile_style, user.accent_color) }}
    >
      {/* Portada: la imagen de quien la tenga, y si no su color de acento. Nunca
          un hueco gris, que es lo que hace que un perfil parezca incompleto. */}
      <div className="h-20 w-full" style={{ background: cardBackground(user.profile_style, user.accent_color, user.banner_url) }}>
        {/* El efecto va en un hijo a pantalla completa y no en el propio div de
            la portada: `overflow: hidden` sobre el que lleva el fondo recortaria
            tambien el avatar, que sube por encima del borde a proposito. */}
        <div className={`h-full w-full ${effectClass(user.profile_style)}`} />
      </div>

      <div className="-mt-10 px-4">
        <span className="inline-block">
          <Avatar
            name={user.display_name}
            url={user.avatar_url}
            id={user.id}
            size={84}
            ring={ringOf(user.status, connection === "online")}
            profile={user.profile_style}
            cutout={4}
          />
        </span>

        <p className="mt-2 truncate text-lg font-bold">
          <DisplayName name={user.display_name} style={user.profile_style} accent={null} />
        </p>
        <p className="flex items-center gap-1.5 truncate text-xs text-muted">
          {user.kind === "guest" ? t("members.guest") : `@${user.username}`}
          {user.pronouns ? <span className="opacity-70">· {user.pronouns}</span> : null}
        </p>
      </div>

      <div className="mt-3 flex flex-col gap-1 border-t border-line p-2">
        <label className="flex flex-col gap-1 px-1 pb-1">
          <span className="text-[0.7rem] font-semibold tracking-wider text-muted uppercase">{t("status.custom")}</span>
          <input
            value={frase}
            onChange={(e) => setFrase(e.target.value)}
            /* Se guarda al salir del campo o con Enter, no en cada tecla: cada
               letra sería una petición y un evento a toda la comunidad. */
            onBlur={() => {
              if (frase !== guardado.current) void guardar({ custom_status: frase.trim() });
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              e.currentTarget.blur();
            }}
            maxLength={120}
            placeholder={t("status.customPlaceholder")}
            className="field text-sm"
          />
        </label>

        {USER_STATUSES.map((value) => (
          <button
            key={value}
            onClick={() => void guardar({ status: value })}
            aria-current={user.status === value ? "true" : undefined}
            className={`flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm transition-colors ${
              user.status === value ? "bg-accent-soft" : "hover:bg-raise"
            }`}
          >
            <StatusDot status={value === "invisible" ? "offline" : value} size={12} className="relative shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block font-medium">{etiquetas[value]}</span>
              {pistas[value] ? <span className="block text-[0.7rem] text-muted">{pistas[value]}</span> : null}
            </span>
            {user.status === value ? <Check size={15} className="shrink-0 text-accent" /> : null}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-0.5 border-t border-line p-2">
        <button
          onClick={() => {
            close();
            onOpenSettings();
          }}
          className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm hover:bg-raise"
        >
          <Pencil size={15} className="shrink-0 text-muted" />
          {t("profile.edit")}
        </button>

        <button
          onClick={() => {
            void navigator.clipboard?.writeText(user.username).then(() => {
              setCopiado(true);
              setTimeout(() => setCopiado(false), 1500);
            });
          }}
          className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm hover:bg-raise"
        >
          {copiado ? <Check size={15} className="shrink-0 text-ok" /> : <Copy size={15} className="shrink-0 text-muted" />}
          {copiado ? t("common.copied") : t("profile.copyUser")}
        </button>

        <button
          onClick={() => {
            close();
            void logout();
          }}
          className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm text-danger hover:bg-danger/10"
        >
          <LogOut size={15} className="shrink-0" />
          {t("settings.logout")}
        </button>
      </div>
    </div>
  );
}
