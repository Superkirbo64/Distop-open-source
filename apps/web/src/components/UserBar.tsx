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
import { Check, ChevronLeft, ChevronRight, ChevronUp, Copy, LogOut, Pencil } from "lucide-react";
import { USER_STATUSES, type UserStatus } from "@distop/protocol";
import { gameOf, useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Gear, Headset, Microphone } from "./icons.tsx";
import { Avatar, avatarOverflow, DisplayName, IconButton, Menu, StatusDot, useT, type PresenceRing } from "./ui.tsx";
import { CardEffectLayer, profileBannerStyle, profileSurfaceBackground } from "./ProfileStyle.tsx";
import { setDeafened, setMuted } from "../lib/voice.ts";
import { useVoiceLocal } from "./Voice.tsx";
import { AudioQuickMenu } from "./AudioQuickMenu.tsx";

/**
 * Cómo se ve un estado desde fuera.
 * `invisible` se pinta como desconectado incluso para uno mismo: si en tu propia
 * barra siguieras viéndote en verde, sería fácil creer que la gente te ve, que
 * es exactamente lo contrario de lo que pediste.
 */
function ringOf(status: UserStatus, connected: boolean): PresenceRing {
  if (!connected || status === "invisible") return "offline";
  return status;
}

export function UserBar({ onOpenSettings }: { onOpenSettings: (tab?: "profile" | "voice") => void }) {
  const t = useT();
  const user = useStore((s) => s.user);
  const status = useStore((s) => s.status);
  const game = useStore((s) => (s.user ? gameOf(s.data, s.user.id) : undefined));
  const local = useVoiceLocal();

  if (!user) return null;
  const ring = ringOf(user.status, status === "online");

  /* Lo que se lee bajo el nombre, por orden de "cuanto cambia": la frase que uno
     escribe, luego el juego abierto, luego estar en una llamada, y si no, el
     estado de presencia. La frase escrita gana porque es una elección explícita;
     el juego gana a la voz porque cambia más. El `@usuario` que había antes no
     cambia nunca, así que no informaba de nada. */
  const pie = user.custom_status
    ? user.custom_status
    : game
      ? t("game.playing", { name: game.game_name })
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
      /* `overflow-hidden`: los botones (micro, auriculares, ajustes) tienen que
         quedarse dentro del banner, nunca asomar sobre el fondo de la app. El
         menú de perfil ya no se pinta aquí dentro para poder recortar esto: va
         `floating`, que lo saca por portal a document.body. */
      className="relative flex h-[var(--footer-h)] shrink-0 items-center gap-1 overflow-hidden rounded-card border border-line/60 bg-raise/55 px-2 shadow-[var(--shadow)] backdrop-blur-md"
    >
      {user.banner_url ? (
        <span
          className="profile-banner pointer-events-none absolute inset-0 overflow-hidden rounded-card"
          style={profileBannerStyle(user.profile_style, user.accent_color, user.banner_url, "bar")}
          aria-hidden
        />
      ) : null}
      <Menu
        flush
        floating
        trigger={({ onClick }) => (
          <button
            onClick={onClick}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] px-1 py-1 text-left transition-colors hover:bg-surface"
          >
            <Avatar name={user.display_name} url={user.avatar_url} id={user.id} size={34} ring={ring} profile={user.profile_style} />
            <span className="min-w-0 flex-1">
              {/* Tope duro de 15 caracteres: un nombre largo no debe ensanchar
                  la barra ni empujar los botones de voz fuera del banner. El
                  resto se lee en el tooltip nativo del `title`. */}
              <span className="block max-w-[105px] truncate text-sm font-semibold" title={user.display_name}>
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
      <div className="flex items-center">
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
          tooltip={false}
          className={`rounded-r-[6px] ${local.muted || local.forcedMuted ? "text-danger" : ""}`}
        >
          <Microphone size={16} muted={local.muted || local.forcedMuted} />
        </IconButton>
        <Menu
          flush
          trigger={({ onClick }) => (
            <button
              onClick={onClick}
              aria-label={t("voice.openInputMenu")}
              className="-ml-1 flex h-9 w-5 items-center justify-center rounded-r-[10px] text-muted hover:bg-raise hover:text-ink"
            >
              <ChevronUp size={13} />
            </button>
          )}
        >
          {(close) => <AudioQuickMenu kind="input" close={close} onOpenSettings={() => onOpenSettings("voice")} />}
        </Menu>
      </div>
      <div className="flex items-center">
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
          tooltip={false}
          className={`rounded-r-[6px] ${local.deafened || local.forcedDeafened ? "text-danger" : ""}`}
        >
          <Headset size={16} muted={local.deafened || local.forcedDeafened} />
        </IconButton>
        <Menu
          flush
          trigger={({ onClick }) => (
            <button
              onClick={onClick}
              aria-label={t("voice.openOutputMenu")}
              className="-ml-1 flex h-9 w-5 items-center justify-center rounded-r-[10px] text-muted hover:bg-raise hover:text-ink"
            >
              <ChevronUp size={13} />
            </button>
          )}
        >
          {(close) => <AudioQuickMenu kind="output" close={close} onOpenSettings={() => onOpenSettings("voice")} />}
        </Menu>
      </div>
      <IconButton label={t("settings.title")} tooltip={false} onClick={() => onOpenSettings("profile")}>
        <Gear size={16} />
      </IconButton>
    </div>
  );
}

function ProfileMenu({ onOpenSettings, close }: { onOpenSettings: (tab?: "profile" | "voice") => void; close: () => void }) {
  const t = useT();
  const user = useStore((s) => s.user);
  const connection = useStore((s) => s.status);
  const refreshUser = useStore((s) => s.refreshUser);
  const logout = useStore((s) => s.logout);

  const [frase, setFrase] = useState(user?.custom_status ?? "");
  const [copiado, setCopiado] = useState(false);
  const [eligiendoEstado, setEligiendoEstado] = useState(false);
  const guardado = useRef(user?.custom_status ?? "");
  const fraseRef = useRef(frase);
  fraseRef.current = frase;

  useEffect(() => {
    setFrase(user?.custom_status ?? "");
    guardado.current = user?.custom_status ?? "";
  }, [user?.custom_status]);

  async function guardar(cambios: { status?: UserStatus; custom_status?: string }) {
    // Optimista: el estado propio tiene que responder al instante o parece roto.
    const antes = user!;
    if (cambios.custom_status !== undefined) guardado.current = cambios.custom_status;
    refreshUser({ ...antes, ...cambios } as typeof antes);
    try {
      const actualizado = await api<typeof antes>("PATCH", "/api/v1/users/me", cambios);
      refreshUser(actualizado);
    } catch {
      refreshUser(antes);
    }
  }

  /* El menú se cierra al hacer clic fuera con `mousedown` (ui.tsx), y ese clic
     puede desmontar este campo antes de que llegue su `onBlur` si el objetivo
     no es enfocable. Sin esto, escribir y cerrar sin pasar por Tab/Enter
     perdía el cambio en silencio. */
  useEffect(
    () => () => {
      if (fraseRef.current !== guardado.current) void guardar({ custom_status: fraseRef.current.trim() });
    },
    [],
  );

  if (!user) return null;

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
      className="relative w-[21rem] max-w-[92vw] overflow-hidden"
      style={{ background: profileSurfaceBackground(user.profile_style, user.accent_color) }}
    >
      {/* Portada: la imagen de quien la tenga, y si no su color de acento. Nunca
          un hueco gris, que es lo que hace que un perfil parezca incompleto. */}
      <div
        className="profile-banner h-28 w-full"
        style={profileBannerStyle(user.profile_style, user.accent_color, user.banner_url)}
      />

      <div className="-mt-10 px-4">
        <span className="relative inline-block" style={{ marginBottom: avatarOverflow(user.profile_style, 84) }}>
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
        {eligiendoEstado ? (
          <>
            <button
              onClick={() => setEligiendoEstado(false)}
              aria-label={t("status.back")}
              className="flex items-center gap-2 rounded-[10px] px-2.5 py-2 text-left text-sm font-semibold hover:bg-raise"
            >
              <ChevronLeft size={16} className="shrink-0 text-muted" />
              {t("status.label")}
            </button>

            {USER_STATUSES.map((value) => (
              <button
                key={value}
                onClick={() => {
                  void guardar({ status: value });
                  setEligiendoEstado(false);
                }}
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
          </>
        ) : (
          <>
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

            <button
              onClick={() => setEligiendoEstado(true)}
              className="flex items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-sm transition-colors hover:bg-raise"
            >
              <StatusDot
                status={user.status === "invisible" ? "offline" : user.status}
                size={12}
                className="relative shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{t("status.label")}</span>
                <span className="block truncate text-[0.7rem] text-muted">{etiquetas[user.status]}</span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-muted" />
            </button>
          </>
        )}
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

      {/* El efecto cubre la tarjeta ENTERA y va al final para pintarse encima;
          sus clases llevan pointer-events: none, así que el menú, el campo de
          estado y los botones siguen recibiendo el clic. */}
      <CardEffectLayer effect={user.profile_style.profile_effect} className="absolute inset-0" />
    </div>
  );
}
