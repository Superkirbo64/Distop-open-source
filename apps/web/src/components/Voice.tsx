/**
 * Interfaz de voz (§9.4).
 * Dos piezas: la gente que ya está dentro se ve colgando del canal en la lista,
 * y quien está conectada tiene un panel fijo encima de su barra de usuario con
 * lo que se usa cada dos minutos: callar, ensordecer y colgar.
 */
import { useEffect, useRef, useState } from "react";
import {
  Lock,
  Maximize2,
  MicOff,
  MoreVertical,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Signal,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Headset, Microphone } from "./icons.tsx";
import { PERMISSIONS, has, toBits, type Member, type VoiceState } from "@distop/protocol";
import { useStore } from "../store.ts";
import {
  canShareScreen,
  leaveVoice,
  onVoice,
  setDeafened,
  setMuted,
  setShareMuted,
  setVideoSource,
  moderateVoice,
  type VoiceLocalState,
} from "../lib/voice.ts";
import { Avatar, ErrorNote, IconButton, Menu, MenuItem, useT } from "./ui.tsx";

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];

export function useVoiceLocal(): VoiceLocalState {
  const [state, setState] = useState<VoiceLocalState>({
    channelId: null,
    muted: false,
    deafened: false,
    speaking: new Set(),
    video: null,
    localVideo: null,
    videos: new Map(),
    videoFps: null,
    shareAudio: false,
    shareMuted: false,
    peerStates: new Map(),
    reflexive: false,
    route: null,
    error: null,
    videoError: null,
  });
  useEffect(() => onVoice(setState), []);
  return state;
}

/** Lista de quién está en una sala, para colgar debajo del canal en la barra. */
export function VoiceParticipants({ states, members }: { states: VoiceState[]; members: Member[] }) {
  const local = useVoiceLocal();
  if (states.length === 0) return null;

  return (
    <ul className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-6">
      {states.map((state) => {
        const member = members.find((m) => m.user.id === state.user_id);
        const name = member?.nickname ?? member?.user.display_name ?? "…";
        const speaking = local.speaking.has(state.user_id);

        return (
          <li key={state.user_id} className="flex items-center gap-2 rounded-lg px-2 py-1">
            <span
              className="rounded-full transition-shadow duration-150"
              style={{ boxShadow: speaking ? "0 0 0 2px var(--ok)" : "0 0 0 2px transparent" }}
            >
              <Avatar name={name} url={member?.user.avatar_url} id={state.user_id} size={22} />
            </span>
            <span className={`truncate text-xs ${speaking ? "text-ink" : "text-muted"}`}>{name}</span>
            {state.force_deafened || state.force_muted ? (
              <Lock size={12} className="ml-auto shrink-0 text-danger" />
            ) : state.deafened ? (
              <VolumeX size={12} className="ml-auto shrink-0 text-danger" />
            ) : state.muted ? (
              <MicOff size={12} className="ml-auto shrink-0 text-danger" />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Panel fijo mientras estás en una llamada. */
export function VoiceBar() {
  const t = useT();
  const local = useVoiceLocal();
  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const states = useStore((s) => (local.channelId ? (s.voice[local.channelId] ?? EMPTY) : EMPTY));

  if (local.error) {
    const reason =
      local.error === "denied" ? "voice.denied" : local.error === "unsupported" ? "voice.unsupported" : "voice.noDevice";
    return (
      <div className="border-t border-line px-3 py-2">
        <ErrorNote>{t(reason)}</ErrorNote>
      </div>
    );
  }

  if (!local.channelId) return null;
  const channel = data?.channels.find((c) => c.id === local.channelId);
  const permissions = toBits(data?.channel_permissions[local.channelId] ?? "0");
  const canCamera = has(permissions, PERMISSIONS.USE_CAMERA);
  // Compartir pantalla necesita permiso y un navegador que sepa hacerlo: en
  // móvil no existe, y un botón que nunca funciona es peor que ningún botón.
  const canScreen = has(permissions, PERMISSIONS.STREAM) && canShareScreen();

  return (
    /* Sin tarjeta propia: los botones flotan como píldoras sueltas sobre el
       fondo de la barra lateral, en vez de ir metidos en otro panel. */
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Signal size={16} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ok">{t("voice.connected")}</span>
          <span className="block truncate text-xs text-muted">
            {channel?.name} · {data?.community.name}
          </span>
        </span>
        <IconButton label={t("voice.disconnect")} onClick={leaveVoice} className="text-danger hover:bg-danger/10">
          <PhoneOff size={16} />
        </IconButton>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => setMuted(!local.muted)}
          aria-pressed={local.muted}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.muted ? "btn-danger" : "btn-ghost"}`}
        >
          <Microphone size={14} muted={local.muted} />
          {local.muted ? t("voice.unmute") : t("voice.mute")}
        </button>
        <button
          onClick={() => setDeafened(!local.deafened)}
          aria-pressed={local.deafened}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.deafened ? "btn-danger" : "btn-ghost"}`}
        >
          <Headset size={14} muted={local.deafened} />
          {local.deafened ? t("voice.undeafen") : t("voice.deafen")}
        </button>
      </div>

      {canCamera || canScreen ? (
        <div className="flex gap-1">
          {canCamera ? (
            <button
              onClick={() => void setVideoSource(local.video === "camera" ? null : "camera")}
              aria-pressed={local.video === "camera"}
              className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.video === "camera" ? "btn-primary" : "btn-ghost"}`}
            >
              {local.video === "camera" ? <VideoOff size={14} /> : <Video size={14} />}
              {local.video === "camera" ? t("voice.cameraOff") : t("voice.camera")}
            </button>
          ) : null}
          {canScreen ? (
            <button
              onClick={() => void setVideoSource(local.video === "screen" ? null : "screen")}
              aria-pressed={local.video === "screen"}
              className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.video === "screen" ? "btn-primary" : "btn-ghost"}`}
            >
              <MonitorUp size={14} />
              {local.video === "screen" ? t("voice.screenOff") : t("voice.screen")}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* La voz ya no depende de esto: solo el vídeo, que sí va directo. Cuando
          no hay camino entre las dos redes se dice, en vez de dejar un recuadro
          negro sin explicación. */}
      {[...local.peerStates.values()].some((s) => s === "failed") ? (
        <ErrorNote>{local.reflexive ? t("voice.needsTurn") : t("voice.needsStun")}</ErrorNote>
      ) : null}

      {/* Solo aparece si de verdad hay sonido que silenciar: compartir una ventana
          suelta, o ciertos escritorios de Linux, no lo entregan. */}
      {local.shareAudio ? (
        <button
          onClick={() => setShareMuted(!local.shareMuted)}
          aria-pressed={local.shareMuted}
          className={`btn h-9 min-h-9 px-2 text-xs ${local.shareMuted ? "btn-danger" : "btn-ghost"}`}
        >
          {local.shareMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          {local.shareMuted ? t("voice.shareUnmute") : t("voice.shareMute")}
        </button>
      ) : null}

      {local.video && local.videoFps !== null ? (
        <p className="text-[0.65rem] text-muted">{t("voice.videoFps", { fps: local.videoFps })}</p>
      ) : null}

      {local.videoError ? (
        <ErrorNote>{local.videoError === "denied" ? t("voice.videoDenied") : t("voice.noCamera")}</ErrorNote>
      ) : null}

      {/* Por dónde va cada cosa. La voz siempre por la instancia; el vídeo,
          directo, y si acabó pasando por un relevo ajeno se dice. */}
      <p className="text-[0.65rem] text-muted">{t("voice.throughHost", { count: Math.max(states.length - 1, 0) })}</p>
      {local.video && local.route ? (
        <p className="text-[0.65rem] text-muted">{t(local.route === "relay" ? "voice.viaRelay" : "voice.videoDirect")}</p>
      ) : null}
    </div>
  );
}

/**
 * Lo que un moderador puede hacer con quien está en la sala (§11, §23).
 *
 * Solo aparece si esta persona tiene de verdad alguno de los tres permisos EN
 * ESTE canal, y nunca sobre uno mismo. Un menú lleno de opciones que la
 * instancia va a rechazar no es una interfaz, es una trampa: se pulsa, no pasa
 * nada, y nadie sabe si falló el permiso o la conexión.
 */
function ModerateMenu({ channelId, state }: { channelId: string; state: VoiceState }) {
  const t = useT();
  const selfId = useStore((s) => s.user?.id);
  const permissions = toBits(
    useStore((s) => (s.activeCommunityId ? s.data[s.activeCommunityId]?.channel_permissions[channelId] : undefined)) ??
      "0",
  );

  const canMute = has(permissions, PERMISSIONS.MUTE_MEMBERS);
  const canDeafen = has(permissions, PERMISSIONS.DEAFEN_MEMBERS);
  const canMove = has(permissions, PERMISSIONS.MOVE_MEMBERS);

  if (state.user_id === selfId) return null;
  if (!canMute && !canDeafen && !canMove) return null;

  return (
    <Menu
      trigger={({ onClick }) => (
        <IconButton label={t("voice.moderate")} onClick={onClick} className="h-7 w-7 bg-bg/70">
          <MoreVertical size={14} />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {canMute ? (
            <MenuItem
              onClick={() => {
                close();
                moderateVoice(channelId, state.user_id, state.force_muted ? "unmute" : "mute");
              }}
            >
              {state.force_muted ? t("voice.forceUnmute") : t("voice.forceMute")}
            </MenuItem>
          ) : null}
          {canDeafen ? (
            <MenuItem
              onClick={() => {
                close();
                moderateVoice(channelId, state.user_id, state.force_deafened ? "undeafen" : "deafen");
              }}
            >
              {state.force_deafened ? t("voice.forceUndeafen") : t("voice.forceDeafen")}
            </MenuItem>
          ) : null}
          {canMove ? (
            <MenuItem
              danger
              onClick={() => {
                close();
                moderateVoice(channelId, state.user_id, "disconnect");
              }}
            >
              {t("voice.forceDisconnect")}
            </MenuItem>
          ) : null}
        </>
      )}
    </Menu>
  );
}

/**
 * Un `<video>` no acepta el stream por props: hay que asignarlo al nodo.
 * El propio vídeo va silenciado (oírse a uno mismo con retardo es insoportable)
 * y `playsInline` evita que iOS lo abra a pantalla completa.
 */
function VideoTile({ stream, self }: { stream: MediaStream; self: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || node.srcObject === stream) return;
    node.srcObject = stream;
    void node.play().catch(() => {
      // Autoplay bloqueado hasta que haya un gesto: entrar a la llamada ya lo es.
    });
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted
      // La cámara propia se ve en espejo, como en cualquier videollamada.
      className={`absolute inset-0 h-full w-full rounded-card bg-black object-contain ${self ? "-scale-x-100" : ""}`}
    />
  );
}

/**
 * Entrar y salir de pantalla completa con el mismo botón.
 * Antes solo entraba: para volver había que saber que existe Escape, y con el
 * ratón no había ninguna salida. Un botón que solo hace la mitad del viaje.
 */
function FullscreenButton() {
  const t = useT();
  const [full, setFull] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // El estado también cambia por Escape o por F11, no solo por este botón.
    const sync = () => setFull(document.fullscreenElement === ref.current?.closest("figure"));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const label = full ? t("voice.exitFullscreen") : t("voice.fullscreen");
  return (
    <button
      ref={ref}
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        else void ref.current?.closest("figure")?.requestFullscreen().catch(() => {});
      }}
      aria-label={label}
      title={label}
      className="absolute top-2 right-2 z-10 grid h-8 w-8 place-items-center rounded-lg bg-bg/70 text-ink transition-colors hover:bg-bg"
    >
      {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}

/** Vista principal cuando el canal abierto es de voz: cuadrícula de participantes. */
export function VoiceStage({ channelId }: { channelId: string }) {
  const t = useT();
  const local = useVoiceLocal();
  const selfId = useStore((s) => s.user?.id);
  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const states = useStore((s) => s.voice[channelId] ?? EMPTY);

  if (states.length === 0) {
    return (
      <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <Volume2 size={32} className="text-muted" />
        <h3 className="display text-lg font-bold">{t("voice.emptyRoom")}</h3>
        <p className="text-sm text-muted">{t("voice.emptyRoomHint")}</p>
      </div>
    );
  }

  return (
    <div className="grid flex-1 content-center gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
      {states.map((state) => {
        const member = data?.members.find((m) => m.user.id === state.user_id);
        const name = member?.nickname ?? member?.user.display_name ?? "…";
        const speaking = local.speaking.has(state.user_id);
        const self = state.user_id === selfId;
        // La pista existe desde que se conecta el par, pero solo se pinta si el
        // servidor dice que esa persona está emitiendo: es lo que convierte el
        // permiso de cámara en algo visible, y evita mostrar un cuadro negro.
        const stream = self ? local.localVideo : local.videos.get(state.user_id);
        const video = state.video && stream ? stream : null;
        const link = local.peerStates.get(state.user_id);

        return (
          <figure
            key={state.user_id}
            /* El estado va también en atributos y no solo en el color del borde:
               "¿me está llegando su voz?" se responde mirando esto, sin tener que
               adivinar por una sombra. */
            data-user={state.user_id}
            data-speaking={speaking}
            data-link={link ?? "none"}
            className="group relative grid aspect-video place-items-center overflow-hidden rounded-card border bg-surface transition-colors duration-150"
            style={{ borderColor: speaking ? "var(--ok)" : "var(--line)" }}
          >
            {/* Arriba a la izquierda: la derecha ya la ocupa el botón de pantalla
                completa cuando hay vídeo. */}
            <div className="absolute top-2 left-2 z-10 hidden group-hover:block group-focus-within:block">
              <ModerateMenu channelId={channelId} state={state} />
            </div>

            {video ? (
              <>
                <VideoTile stream={video} self={self && state.video === "camera"} />
                <FullscreenButton />
              </>
            ) : (
              <span
                className="rounded-full transition-shadow duration-150"
                style={{ boxShadow: speaking ? "0 0 0 4px color-mix(in oklab, var(--ok) 45%, transparent)" : "none" }}
              >
                <Avatar name={name} url={member?.user.avatar_url} id={state.user_id} size={72} />
              </span>
            )}
            <figcaption className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg bg-bg/80 px-2 py-1 text-xs">
              {/* Callado por decisión propia y callado por moderación se ven
                  distinto: quien lo mira necesita saber si esa persona puede
                  volver a hablar sola o no. */}
              {state.force_deafened || state.force_muted ? (
                <Lock
                  size={12}
                  className="text-danger"
                  aria-label={t(state.force_deafened ? "voice.forcedDeafened" : "voice.forcedMuted")}
                />
              ) : state.deafened ? (
                <VolumeX size={12} className="text-danger" />
              ) : state.muted ? (
                <MicOff size={12} className="text-danger" />
              ) : null}
              {state.video === "screen" ? <MonitorUp size={12} className="text-accent" /> : null}
              <span className="max-w-40 truncate font-medium">{name}</span>
              {/* Sin conexión con esa persona no hay vídeo que valga, y conviene
                  distinguirlo de "tiene la cámara apagada". */}
              {!self && link && link !== "connected" ? (
                <span className={link === "failed" ? "text-danger" : "text-warn"}>{t(`voice.link.${link}`)}</span>
              ) : null}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
