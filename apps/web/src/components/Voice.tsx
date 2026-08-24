/**
 * Interfaz de voz (§9.4).
 * Dos piezas: la gente que ya está dentro se ve colgando del canal en la lista,
 * y quien está conectada tiene un panel fijo encima de su barra de usuario con
 * lo que se usa cada dos minutos: callar, ensordecer y colgar.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Clock3,
  Lock,
  Maximize2,
  MicOff,
  Music,
  MoreVertical,
  Minimize2,
  MonitorUp,
  Orbit,
  PhoneOff,
  Search,
  Signal,
  Trophy,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { Headset, Microphone, PartyPopper } from "./icons.tsx";
import {
  PERMISSIONS,
  has,
  toBits,
  type Member,
  type VoiceState,
} from "@distop/protocol";
import { useStore } from "../store.ts";
import { sendCommand } from "../lib/gateway.ts";
/* En diferido: el panel de la carrera (y su física en lib/marbleRace.ts) solo
   se descarga cuando alguien de la llamada abre una sala, no en el chunk
   inicial que paga todo el mundo al entrar. El import de Racer es solo de
   tipos, así que no lo devuelve al bundle. */
const MarbleRace = lazy(() => import("./MarbleRace.tsx").then((m) => ({ default: m.MarbleRace })));
import * as audio from "../lib/relay.ts";
import type { Racer } from "../lib/marbleRace.ts";
import type { MessageKey } from "../i18n.ts";
import {
  canShareScreen,
  leaveVoice,
  onVoice,
  playSound,
  setDeafened,
  setMuted,
  setShareMuted,
  setVideoSource,
  moderateVoice,
  setSoundError,
  voiceSnapshot,
  type VoiceLocalState,
} from "../lib/voice.ts";
import {
  Avatar,
  ErrorNote,
  IconButton,
  Menu,
  MenuItem,
  Range,
  SpeakingRing,
  hueOf,
  useT,
} from "./ui.tsx";

/**
 * Tabla de sonidos de la sala de voz (§9.4).
 *
 * Solo lista lo que ya es de ESTA comunidad: la galeria de MyInstants se
 * rebusca en los ajustes, y aqui dentro solo aparece lo que alguien decidio
 * anadir. Asi el sonido esta en el disco del anfitrion antes de que nadie lo
 * dispare, y no hay una descarga a un tercero en mitad de una llamada.
 *
 * El menu NO se cierra al pulsar: una tabla de sonidos es para encadenar
 * varios, y cerrarse en el primero obligaria a reabrirla cada vez.
 */
export function VoiceSoundboard({
  communityId,
  communityName,
  muted,
}: {
  communityId: string;
  communityName: string;
  muted: boolean;
}) {
  const t = useT();
  const expressions = useStore((s) => s.expressions);
  const sonidos = useMemo(
    () => expressions.filter((e) => e.kind === "sound" && e.community_id === communityId),
    [expressions, communityId],
  );
  const [query, setQuery] = useState("");
  const [plays, setPlays] = useState<Record<string, number>>(() => {
    try {
      return JSON.parse(localStorage.getItem("distop.soundboard.plays") ?? "{}") as Record<string, number>;
    } catch {
      return {};
    }
  });
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? sonidos.filter((sound) => sound.name.toLocaleLowerCase().includes(needle)) : sonidos;
  }, [sonidos, query]);
  const frequent = useMemo(
    () => [...filtered].filter((sound) => (plays[sound.id] ?? 0) > 0).sort((a, b) => (plays[b.id] ?? 0) - (plays[a.id] ?? 0)).slice(0, 6),
    [filtered, plays],
  );

  function trigger(soundId: string): void {
    playSound(soundId);
    setPlays((current) => {
      const next = { ...current, [soundId]: (current[soundId] ?? 0) + 1 };
      try {
        localStorage.setItem("distop.soundboard.plays", JSON.stringify(next));
      } catch {
        // El historial frecuente es una mejora opcional: el sonido debe seguir
        // funcionando incluso si el navegador bloquea o llena localStorage.
      }
      return next;
    });
  }

  const grid = (list: typeof sonidos) => (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {list.map((sound) => (
        <button
          key={sound.id}
          role="menuitem"
          onClick={() => trigger(sound.id)}
          className="group flex min-h-12 min-w-0 items-center gap-2 rounded-[10px] bg-raise px-3 py-2 text-left transition-colors hover:bg-accent-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
        >
          <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-surface text-base text-muted group-hover:text-accent">
            {sound.icon_url ? (
              <img src={sound.icon_url} alt="" className="h-full w-full object-cover" loading="lazy" />
            ) : sound.icon_emoji ? (
              <span aria-hidden="true">{sound.icon_emoji}</span>
            ) : (
              <Volume2 size={15} />
            )}
          </span>
          <span className="truncate text-xs font-semibold">{sound.name}</span>
        </button>
      ))}
    </div>
  );

  return (
    <Menu
      flush
      floating
      trigger={(props) => (
        <button {...props} className="btn btn-ghost rounded-full border-transparent px-3 text-xs">
          <Music size={15} />
          {t("voice.soundboard")}
        </button>
      )}
    >
      {() => (
        <section className="flex w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden" aria-label={t("voice.soundboard")}>
          <div className="flex items-center gap-2 border-b border-line p-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line bg-sunken px-3 focus-within:border-accent">
              <Search size={15} className="shrink-0 text-muted" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("voice.soundboardSearch")}
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none"
                autoFocus
              />
            </label>
            <Volume2 size={18} className="shrink-0 text-muted" />
          </div>

          <div className="max-h-[min(30rem,65vh)] overflow-y-auto p-3">
            {muted ? (
              <p className="px-2 py-3 text-xs leading-relaxed text-muted">{t("voice.soundboardMuted")}</p>
            ) : sonidos.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-relaxed text-muted">{t("voice.soundboardEmpty")}</p>
            ) : filtered.length === 0 ? (
              <p className="px-2 py-3 text-xs leading-relaxed text-muted">{t("voice.soundboardNoResults")}</p>
            ) : (
              <div className="flex flex-col gap-5">
                {frequent.length > 0 ? (
                  <section>
                    <h3 className="mb-2 flex items-center gap-2 text-[0.7rem] font-bold tracking-wide text-muted uppercase">
                      <Clock3 size={13} />
                      {t("voice.soundboardFrequent")}
                    </h3>
                    {grid(frequent)}
                  </section>
                ) : null}
                <section>
                  <h3 className="mb-2 flex items-center gap-2 text-[0.7rem] font-bold tracking-wide text-muted uppercase">
                    <Music size={13} />
                    {t("voice.soundboardCommunity", { name: communityName })}
                  </h3>
                  {grid(filtered)}
                </section>
              </div>
            )}
          </div>
        </section>
      )}
    </Menu>
  );
}

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];
const SOUND_ERROR_KEYS: Record<NonNullable<VoiceLocalState["soundError"]>, MessageKey> = {
  not_in_voice: "voice.soundError.not_in_voice",
  muted: "voice.soundError.muted",
  rate_limited: "voice.soundError.rate_limited",
  not_available: "voice.soundError.not_available",
  unsupported: "voice.soundError.unsupported",
  blocked: "voice.soundError.blocked",
  download: "voice.soundError.download",
  decode: "voice.soundError.decode",
  too_long: "voice.soundError.too_long",
};

export function VoiceSoundError({ error }: { error: VoiceLocalState["soundError"] }) {
  const t = useT();
  if (!error) return null;
  return (
    <ErrorNote>
      {t(SOUND_ERROR_KEYS[error])}
      <button
        type="button"
        onClick={() => setSoundError(null)}
        className="ml-2 underline underline-offset-2"
      >
        {t("common.close")}
      </button>
    </ErrorNote>
  );
}

export function useVoiceLocal(): VoiceLocalState {
  // El estado real, no uno vacío: montarse en mitad de una llamada pintaba el
  // micro abierto durante un fotograma aunque estuviera cerrado.
  const [state, setState] = useState<VoiceLocalState>(voiceSnapshot);
  useEffect(() => onVoice(setState), []);
  return state;
}

/** Lista de quién está en una sala, para colgar debajo del canal en la barra. */
export function VoiceParticipants({
  states,
  members,
}: {
  states: VoiceState[];
  members: Member[];
}) {
  const local = useVoiceLocal();
  if (states.length === 0) return null;

  return (
    <ul className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-6">
      {states.map((state) => {
        const member = members.find((m) => m.user.id === state.user_id);
        const name = member?.nickname ?? member?.user.display_name ?? "…";
        const speaking = local.speaking.has(state.user_id);

        return (
          <li
            key={state.user_id}
            className="flex items-center gap-2 rounded-lg px-2 py-1"
          >
            <SpeakingRing
              speaking={speaking}
              profile={member?.user.profile_style}
              size={22}
            >
              <Avatar
                name={name}
                url={member?.user.avatar_url}
                id={state.user_id}
                size={22}
                profile={member?.user.profile_style}
              />
            </SpeakingRing>
            <span
              className={`truncate text-xs ${speaking ? "text-ink" : "text-muted"}`}
            >
              {name}
            </span>
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
  const states = useStore((s) =>
    local.channelId ? (s.voice[local.channelId] ?? EMPTY) : EMPTY,
  );

  if (local.error) {
    const reason =
      local.error === "denied"
        ? "voice.denied"
        : local.error === "unsupported"
          ? "voice.unsupported"
          : "voice.noDevice";
    return (
      <div className="rounded-card border border-line/60 bg-raise/55 px-3 py-2 shadow-[var(--shadow)] backdrop-blur-md">
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
    /* Tarjeta propia, igual que la barra de perfil: la llamada ya no es la cola
       de la lista de canales, es un panel aparte que se posa debajo. */
    <div className="flex flex-col gap-2 rounded-card border border-line/60 bg-raise/55 px-3 py-2.5 shadow-[var(--shadow)] backdrop-blur-md">
      <div className="flex items-center gap-2">
        <Signal size={16} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ok">
            {t("voice.connected")}
          </span>
          <span className="block truncate text-xs text-muted">
            {channel?.name} · {data?.community.name}
          </span>
        </span>
        <IconButton
          label={t("voice.disconnect")}
          onClick={leaveVoice}
          className="text-danger hover:bg-danger/10"
        >
          <PhoneOff size={16} />
        </IconButton>
      </div>

      <div className="flex gap-1">
        {/* Estado real, no solo el botón: lo que impone la instancia manda. */}
        <button
          onClick={() => setMuted(!local.muted)}
          aria-pressed={local.muted || local.forcedMuted}
          disabled={local.forcedMuted}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.muted || local.forcedMuted ? "btn-danger" : "btn-ghost"}`}
        >
          <Microphone size={14} muted={local.muted || local.forcedMuted} />
          {local.forcedMuted ? t("voice.cannotSpeak") : local.muted ? t("voice.unmute") : t("voice.mute")}
        </button>
        <button
          onClick={() => setDeafened(!local.deafened)}
          aria-pressed={local.deafened || local.forcedDeafened}
          disabled={local.forcedDeafened}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.deafened || local.forcedDeafened ? "btn-danger" : "btn-ghost"}`}
        >
          <Headset size={14} muted={local.deafened || local.forcedDeafened} />
          {local.forcedDeafened ? t("voice.forcedDeafened") : local.deafened ? t("voice.undeafen") : t("voice.deafen")}
        </button>
      </div>

      {canCamera || canScreen ? (
        <div className="flex gap-1">
          {canCamera ? (
            <button
              onClick={() =>
                void setVideoSource(local.video === "camera" ? null : "camera")
              }
              aria-pressed={local.video === "camera"}
              className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.video === "camera" ? "btn-primary" : "btn-ghost"}`}
            >
              {local.video === "camera" ? (
                <VideoOff size={14} />
              ) : (
                <Video size={14} />
              )}
              {local.video === "camera"
                ? t("voice.cameraOff")
                : t("voice.camera")}
            </button>
          ) : null}
          {canScreen ? (
            <button
              onClick={() =>
                void setVideoSource(local.video === "screen" ? null : "screen")
              }
              aria-pressed={local.video === "screen"}
              className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.video === "screen" ? "btn-primary" : "btn-ghost"}`}
            >
              <MonitorUp size={14} />
              {local.video === "screen"
                ? t("voice.screenOff")
                : t("voice.screen")}
            </button>
          ) : null}
        </div>
      ) : null}

      {/* La voz ya no depende de esto: solo el vídeo, que sí va directo. Cuando
          no hay camino entre las dos redes se dice, en vez de dejar un recuadro
          negro sin explicación. */}
      {[...local.peerStates.values()].some((s) => s === "failed") ? (
        <ErrorNote>
          {local.reflexive ? t("voice.needsTurn") : t("voice.needsStun")}
        </ErrorNote>
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
        <p className="text-[0.65rem] text-muted">
          {t("voice.videoFps", { fps: local.videoFps })}
        </p>
      ) : null}

      {local.videoError ? (
        <ErrorNote>
          {local.videoError === "denied"
            ? t("voice.videoDenied")
            : local.videoError === "unsupported"
              ? t("voice.videoUnsupported")
            : t("voice.noCamera")}
        </ErrorNote>
      ) : null}

      {/* Por dónde va cada cosa. La voz siempre por la instancia; el vídeo,
          directo, y si acabó pasando por un relevo ajeno se dice. */}
      <p className="text-[0.65rem] text-muted">
        {t("voice.throughHost", { count: Math.max(states.length - 1, 0) })}
      </p>
      {local.video && local.route ? (
        <p className="text-[0.65rem] text-muted">
          {t(local.route === "relay" ? "voice.viaRelay" : "voice.videoDirect")}
        </p>
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
function ModerateMenu({
  channelId,
  state,
}: {
  channelId: string;
  state: VoiceState;
}) {
  const t = useT();
  const selfId = useStore((s) => s.user?.id);
  const [level, setLevel] = useState(() => audio.userVolume(state.user_id));
  const permissions = toBits(
    useStore((s) =>
      s.activeCommunityId
        ? s.data[s.activeCommunityId]?.channel_permissions[channelId]
        : undefined,
    ) ?? "0",
  );

  const canMute = has(permissions, PERMISSIONS.MUTE_MEMBERS);
  const canDeafen = has(permissions, PERMISSIONS.DEAFEN_MEMBERS);
  const canMove = has(permissions, PERMISSIONS.MOVE_MEMBERS);
  const puedeModerar = canMute || canDeafen || canMove;

  // El menú existe para todo el mundo aunque no haya nada que moderar: el
  // volumen de cada persona no es un permiso, es un mando de mi altavoz.
  if (state.user_id === selfId) return null;

  return (
    /* Flotante a propósito: el botón vive en una capa que solo existe mientras el
       ratón está encima del recuadro, y un menú con una barra que arrastrar es más
       alto que el propio recuadro. Sin sacarlo de ahí, se cerraba solo al mover el
       ratón para ajustar el volumen. */
    <Menu
      floating
      trigger={({ onClick }) => (
        <IconButton
          label={puedeModerar ? t("voice.person") : t("voice.userVolume", { value: Math.round(level * 100) })}
          onClick={onClick}
          className="h-7 w-7 bg-bg/70"
        >
          <MoreVertical size={14} />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {/* Solo cambia lo que oigo YO. No pide permiso porque no se lo hace a
              nadie: bajarle el volumen a alguien para toda la sala sería
              moderación, y esa está debajo con sus permisos. */}
          <label className="flex flex-col gap-1 px-3 py-2">
            <span className="text-[0.7rem] font-semibold tracking-wider text-muted uppercase">
              {t("voice.userVolume", { value: Math.round(level * 100) })}
            </span>
            <Range
              min={0}
              max={200}
              step={5}
              value={Math.round(level * 100)}
              onChange={(e) => {
                const value = Number(e.target.value) / 100;
                setLevel(value);
                audio.setUserVolume(state.user_id, value);
              }}
              className="w-full"
              style={{ accentColor: "var(--accent)" }}
            />
            <span className="text-[0.7rem] leading-snug text-muted">{t("voice.userVolumeHint")}</span>
          </label>

          {puedeModerar ? <div className="my-1 h-px bg-line" /> : null}

          {canMute ? (
            <MenuItem
              onClick={() => {
                close();
                moderateVoice(
                  channelId,
                  state.user_id,
                  state.force_muted ? "unmute" : "mute",
                );
              }}
            >
              {state.force_muted
                ? t("voice.forceUnmute")
                : t("voice.forceMute")}
            </MenuItem>
          ) : null}
          {canDeafen ? (
            <MenuItem
              onClick={() => {
                close();
                moderateVoice(
                  channelId,
                  state.user_id,
                  state.force_deafened ? "undeafen" : "deafen",
                );
              }}
            >
              {state.force_deafened
                ? t("voice.forceUndeafen")
                : t("voice.forceDeafen")}
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
    const sync = () =>
      setFull(document.fullscreenElement === ref.current?.closest("figure"));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const label = full ? t("voice.exitFullscreen") : t("voice.fullscreen");
  return (
    <button
      ref={ref}
      onClick={() => {
        if (document.fullscreenElement)
          void document.exitFullscreen().catch(() => {});
        else
          void ref.current
            ?.closest("figure")
            ?.requestFullscreen()
            .catch(() => {});
      }}
      aria-label={label}
      title={label}
      className="absolute top-2 right-2 z-10 grid h-8 w-8 place-items-center rounded-lg bg-bg/70 text-ink transition-colors hover:bg-bg"
    >
      {full ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
    </button>
  );
}

/** Una esfera física por integrante: posición, velocidad y radio, nada de estilo. */
type GravityBall = {
  userId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  mass: number;
};

/** Lo que hace falta para dibujar la esfera, recalculado cada render (no cuesta nada). */
type GravityMeta = {
  name: string;
  muted: boolean;
  deafened: boolean;
};

const GRAVITY_ACCEL = 1480;
const GRAVITY_RESTITUTION = 0.68;
const GRAVITY_AIR_DRAG = 0.997;
/** Diámetros de 48 a 164 px: diferencia visible sin volver una bola inmanejable. */
const GRAVITY_MIN_RADIUS = 24;
const GRAVITY_MAX_RADIUS = 82;

/**
 * Pide permiso para el giroscopio en iOS 13+.
 * Debe llamarse desde un gesto del usuario (click/tap): sin gesto Safari
 * rechaza la petición sin preguntar.
 * Android y desktop no necesitan permiso: devuelve true directamente.
 */
async function requestGyroPermission(): Promise<boolean> {
  const DOE = DeviceOrientationEvent as unknown as {
    requestPermission?: () => Promise<string>;
  };
  if (typeof DOE.requestPermission === "function") {
    try {
      return (await DOE.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return true;
}

/** La ventana de la transmisión: ancho respecto a la sala y altura máxima, para
    que siempre quede suelo y aire alrededor por donde caigan las esferas. */
const SCREEN_FILL = 0.62;
const SCREEN_MAX_H = 0.46;

/** Dónde va la ventana de quien transmite, con la forma real de su vídeo. */
function screenBox(width: number, height: number, aspect: number) {
  let w = Math.min(width * SCREEN_FILL, 760);
  let h = w / aspect;
  const maxH = height * SCREEN_MAX_H;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { x: (width - w) / 2, y: (height - h) / 2, w, h };
}

/** Aleatorio visual pero estable por usuario: no cambia de tamaño en cada render. */
function gravityRadius(userId: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < userId.length; i += 1) {
    hash ^= userId.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  const unit = (hash >>> 0) / 0xffff_ffff;
  return Math.round(GRAVITY_MIN_RADIUS + unit * (GRAVITY_MAX_RADIUS - GRAVITY_MIN_RADIUS));
}

/**
 * La sala como si fuera una caja de físicas: cada integrante es una esfera
 * que cae, rebota contra las paredes y contra las demás, y se puede arrastrar
 * y lanzar. Puramente cosmético — quien modera vuelve a la cuadrícula para
 * silenciar o expulsar, aquí no hay menú por esfera.
 *
 * Lo que alguien transmite entra en la caja como una ventana sólida: se queda
 * en medio, con su tamaño, y las esferas rebotan contra ella y se le posan
 * encima. NO ocupa el fondo — quien mira sigue en su sala de bolas, que es de lo
 * que va esta vista; la pantalla es un objeto más ahí dentro. Doble clic encima
 * para verla a pantalla completa.
 *
 * Encender la cámara o la pantalla propia sigue sacándote a TI de aquí, a la
 * cuadrícula, sin tocar lo que ven los demás: ellos siguen en bolas.
 */
function GravityStage({
  states,
  members,
  speaking,
  video,
}: {
  states: VoiceState[];
  members: Member[];
  speaking: Set<string>;
  video: MediaStream | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ballsRef = useRef<GravityBall[]>([]);
  const metaRef = useRef(new Map<string, GravityMeta>());
  const avatarNodesRef = useRef(new Map<string, HTMLDivElement>());
  const screenRef = useRef<HTMLDivElement>(null);
  /** La ventana de la transmisión en coordenadas de la caja, o null si nadie emite. */
  const screenRectRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const speakingRef = useRef(speaking);
  const sizeRef = useRef({ width: 0, height: 0 });

  speakingRef.current = speaking;
  metaRef.current = new Map(
    states.map((state) => {
      const member = members.find((m) => m.user.id === state.user_id);
      const name = member?.nickname ?? member?.user.display_name ?? "…";
      return [
        state.user_id,
        {
          name,
          muted: state.force_muted || state.muted,
          deafened: state.force_deafened || state.deafened,
        },
      ];
    }),
  );

  const rosterKey = states
    .map((s) => s.user_id)
    .slice()
    .sort()
    .join(",");
  useEffect(() => {
    const existing = new Map(ballsRef.current.map((b) => [b.userId, b]));
    const { width } = sizeRef.current;
    ballsRef.current = states.map((state, index) => {
      const prev = existing.get(state.user_id);
      if (prev) return prev;
      const radius = gravityRadius(state.user_id);
      return {
        userId: state.user_id,
        radius,
        mass: radius * radius,
        x: Math.max(
          radius,
          (width || 400) * (0.15 + (index % 4) * 0.2),
        ),
        y: radius + 4,
        vx: (index % 2 ? -1 : 1) * 60,
        vy: 0,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rosterKey]);

  useEffect(() => {
    const canvasNode = canvasRef.current;
    const containerNode = containerRef.current;
    if (!canvasNode || !containerNode) return;
    const ctxNode = canvasNode.getContext("2d");
    if (!ctxNode) return;
    // Rebindings con tipo no-nulo fijo: las funciones anidadas de más abajo
    // (draw, step, los handlers de puntero) capturan estas, y TS no arrastra
    // el estrechamiento de `canvasNode`/`ctxNode` dentro de un closure.
    const canvas = canvasNode;
    const container = containerNode;
    const ctx = ctxNode;

    const colors = {
      ok: "#4ecf9b",
      danger: "#ff7a86",
      line: "#272b36",
      bg: "#0d0e12",
      ink: "#e8eaf2",
    };
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      colors.ok = cs.getPropertyValue("--ok").trim() || colors.ok;
      colors.danger = cs.getPropertyValue("--danger").trim() || colors.danger;
      colors.line = cs.getPropertyValue("--line").trim() || colors.line;
      colors.bg = cs.getPropertyValue("--bg").trim() || colors.bg;
      colors.ink = cs.getPropertyValue("--ink").trim() || colors.ink;
    };
    readColors();
    const themeObserver = new MutationObserver(readColors);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const clampAxis = (value: number, extent: number, radius: number) =>
      extent <= radius * 2
        ? extent / 2
        : Math.min(extent - radius, Math.max(radius, value));
    const resize = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      sizeRef.current = { width, height };
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const ball of ballsRef.current) {
        ball.x = clampAxis(ball.x, width, ball.radius);
        ball.y = clampAxis(ball.y, height, ball.radius);
      }
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    /* ── Giroscopio: en móvil la gravedad sigue la inclinación del teléfono ──
       Sin giroscopio (desktop, o sin permiso) `gyro` se queda en su valor
       inicial y la gravedad apunta hacia abajo como siempre. El listener no
       se dispara en un ordenador, así que no hay coste alguno. */
    const gyro = { gx: 0, gy: GRAVITY_ACCEL };
    function onOrientation(event: DeviceOrientationEvent) {
      const beta = event.beta ?? 0;   // Inclinación adelante/atrás, -180° a 180°
      const gamma = event.gamma ?? 0; // Inclinación izquierda/derecha, -90° a 90°
      // Se limita beta a [-90, 90] para que la gravedad no se invierta al
      // pasar el teléfono boca abajo: simplemente llega al máximo y para.
      const clampedBeta = Math.max(-90, Math.min(90, beta));
      const betaRad = (clampedBeta * Math.PI) / 180;
      const gammaRad = (gamma * Math.PI) / 180;
      gyro.gx = Math.sin(gammaRad) * GRAVITY_ACCEL;
      gyro.gy = Math.sin(betaRad) * GRAVITY_ACCEL;
    }
    window.addEventListener("deviceorientation", onOrientation);

    /* La ventana se mide cada cuadro en vez de al cambiar el tamaño: su forma
       depende del vídeo, que llega tarde y puede cambiar de resolución a mitad
       de emisión. Solo se escribe estilo cuando de verdad se mueve. */
    let screenKey = "";
    function layoutScreen() {
      const node = screenRef.current;
      if (!node) {
        screenRectRef.current = null;
        screenKey = "";
        return;
      }
      const { width, height } = sizeRef.current;
      const media = node.querySelector("video");
      const aspect = media && media.videoWidth > 0 ? media.videoWidth / media.videoHeight : 16 / 9;
      const rect = screenBox(width, height, aspect);
      screenRectRef.current = rect;
      const key = [rect.x, rect.y, rect.w, rect.h].map(Math.round).join("|");
      if (key === screenKey) return;
      screenKey = key;
      node.style.transform = `translate3d(${rect.x}px, ${rect.y}px, 0)`;
      node.style.width = `${rect.w}px`;
      node.style.height = `${rect.h}px`;
    }

    /** Esfera contra la ventana: un obstáculo con sus cuatro lados. */
    function hitScreen(ball: GravityBall) {
      const rect = screenRectRef.current;
      if (!rect) return;
      const nearX = Math.min(Math.max(ball.x, rect.x), rect.x + rect.w);
      const nearY = Math.min(Math.max(ball.y, rect.y), rect.y + rect.h);
      const dx = ball.x - nearX;
      const dy = ball.y - nearY;
      const distance = Math.hypot(dx, dy);
      if (distance > ball.radius) return;

      if (distance === 0) {
        // El centro acabó DENTRO (un lanzamiento fuerte, o la ventana que crece
        // encima): sale por el lado que tenga más cerca.
        const salidas = [
          {
            hueco: ball.x - rect.x,
            sacar: () => {
              ball.x = rect.x - ball.radius;
              ball.vx = -Math.abs(ball.vx) * GRAVITY_RESTITUTION;
            },
          },
          {
            hueco: rect.x + rect.w - ball.x,
            sacar: () => {
              ball.x = rect.x + rect.w + ball.radius;
              ball.vx = Math.abs(ball.vx) * GRAVITY_RESTITUTION;
            },
          },
          {
            hueco: ball.y - rect.y,
            sacar: () => {
              ball.y = rect.y - ball.radius;
              ball.vy = -Math.abs(ball.vy) * GRAVITY_RESTITUTION;
            },
          },
          {
            hueco: rect.y + rect.h - ball.y,
            sacar: () => {
              ball.y = rect.y + rect.h + ball.radius;
              ball.vy = Math.abs(ball.vy) * GRAVITY_RESTITUTION;
            },
          },
        ].sort((a, b) => a.hueco - b.hueco);
        salidas[0]?.sacar();
        return;
      }

      const nx = dx / distance;
      const ny = dy / distance;
      ball.x = nearX + nx * ball.radius;
      ball.y = nearY + ny * ball.radius;
      const along = ball.vx * nx + ball.vy * ny;
      if (along >= 0) return;
      ball.vx -= (1 + GRAVITY_RESTITUTION) * along * nx;
      ball.vy -= (1 + GRAVITY_RESTITUTION) * along * ny;
      // Posada encima: el mismo rozamiento que en el suelo, o se queda
      // temblando sobre la ventana para siempre.
      if (ny < -0.9) {
        ball.vx *= 0.985;
        if (Math.abs(ball.vy) < 14) ball.vy = 0;
      }
    }

    function solveCollisions() {
      const balls = ballsRef.current;
      for (let i = 0; i < balls.length; i += 1) {
        for (let j = i + 1; j < balls.length; j += 1) {
          const a = balls[i];
          const b = balls[j];
          if (!a || !b || a === dragged || b === dragged) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const minDistance = a.radius + b.radius;
          const distanceSquared = dx * dx + dy * dy;
          if (
            distanceSquared >= minDistance * minDistance ||
            distanceSquared === 0
          )
            continue;

          const distance = Math.sqrt(distanceSquared);
          const nx = dx / distance;
          const ny = dy / distance;
          const overlap = minDistance - distance;
          const totalMass = a.mass + b.mass;
          a.x -= nx * overlap * (b.mass / totalMass);
          a.y -= ny * overlap * (b.mass / totalMass);
          b.x += nx * overlap * (a.mass / totalMass);
          b.y += ny * overlap * (a.mass / totalMass);

          const rvx = b.vx - a.vx;
          const rvy = b.vy - a.vy;
          const velocityAlongNormal = rvx * nx + rvy * ny;
          if (velocityAlongNormal > 0) continue;

          const impulse =
            (-(1 + GRAVITY_RESTITUTION) * velocityAlongNormal) /
            (1 / a.mass + 1 / b.mass);
          a.vx -= (impulse * nx) / a.mass;
          a.vy -= (impulse * ny) / a.mass;
          b.vx += (impulse * nx) / b.mass;
          b.vy += (impulse * ny) / b.mass;
        }
      }
    }

    function step(dt: number) {
      const { width, height } = sizeRef.current;
      const safeDt = Math.min(dt, 1 / 30);
      for (const ball of ballsRef.current) {
        if (ball === dragged) continue;
        ball.vx += gyro.gx * safeDt;
        ball.vy += gyro.gy * safeDt;
        ball.vx *= GRAVITY_AIR_DRAG;
        ball.vy *= GRAVITY_AIR_DRAG;
        ball.x += ball.vx * safeDt;
        ball.y += ball.vy * safeDt;

        if (width <= ball.radius * 2) {
          ball.x = width / 2;
          ball.vx = 0;
        } else if (ball.x - ball.radius < 0) {
          ball.x = ball.radius;
          ball.vx = Math.abs(ball.vx) * GRAVITY_RESTITUTION;
        } else if (ball.x + ball.radius > width) {
          ball.x = width - ball.radius;
          ball.vx = -Math.abs(ball.vx) * GRAVITY_RESTITUTION;
        }
        if (height <= ball.radius * 2) {
          ball.y = height / 2;
          ball.vy = 0;
        } else if (ball.y - ball.radius < 0) {
          ball.y = ball.radius;
          ball.vy = Math.abs(ball.vy) * GRAVITY_RESTITUTION;
        } else if (ball.y + ball.radius > height) {
          ball.y = height - ball.radius;
          ball.vy = -Math.abs(ball.vy) * GRAVITY_RESTITUTION;
          ball.vx *= 0.985;
          if (Math.abs(ball.vy) < 14) ball.vy = 0;
        }
        hitScreen(ball);
      }
      solveCollisions();
    }

    function draw(ball: GravityBall) {
      const meta = metaRef.current.get(ball.userId);
      if (!meta) return;
      const { width, height } = sizeRef.current;
      const isSpeaking = speakingRef.current.has(ball.userId);

      ctx.save();
      ctx.translate(ball.x, ball.y);

      ctx.lineWidth = isSpeaking ? 3 : 1.5;
      ctx.strokeStyle = isSpeaking ? colors.ok : colors.line;
      ctx.beginPath();
      ctx.arc(0, 0, ball.radius, 0, Math.PI * 2);
      ctx.stroke();

      if (meta.muted || meta.deafened) {
        const badge = ball.radius * 0.26;
        const bx = ball.radius * 0.68;
        const by = ball.radius * 0.68;
        ctx.beginPath();
        ctx.arc(bx, by, badge, 0, Math.PI * 2);
        ctx.fillStyle = colors.danger;
        ctx.fill();
        ctx.strokeStyle = colors.bg;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(bx - badge * 0.5, by - badge * 0.5);
        ctx.lineTo(bx + badge * 0.5, by + badge * 0.5);
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.restore();

      ctx.save();
      ctx.font = "600 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const labelWidth = ctx.measureText(meta.name).width + 16;
      const labelX = Math.max(
        2,
        Math.min(width - labelWidth - 2, ball.x - labelWidth / 2),
      );
      const labelY = Math.min(height - 12, ball.y + ball.radius + 12);
      const r = 6;
      ctx.beginPath();
      ctx.moveTo(labelX + r, labelY - 9);
      ctx.arcTo(
        labelX + labelWidth,
        labelY - 9,
        labelX + labelWidth,
        labelY + 9,
        r,
      );
      ctx.arcTo(labelX + labelWidth, labelY + 9, labelX, labelY + 9, r);
      ctx.arcTo(labelX, labelY + 9, labelX, labelY - 9, r);
      ctx.arcTo(labelX, labelY - 9, labelX + labelWidth, labelY - 9, r);
      ctx.closePath();
      ctx.fillStyle = `${colors.bg}e6`;
      ctx.fill();
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = colors.ink;
      ctx.fillText(meta.name, labelX + labelWidth / 2, labelY + 1);
      ctx.restore();
    }

    function canvasPoint(event: PointerEvent) {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    let dragged: GravityBall | null = null;
    let pointer = { lastX: 0, lastY: 0, time: 0 };

    function onPointerDown(event: PointerEvent) {
      const point = canvasPoint(event);
      dragged =
        [...ballsRef.current]
          .reverse()
          .find(
            (b) => Math.hypot(point.x - b.x, point.y - b.y) <= b.radius + 6,
          ) ?? null;
      if (!dragged) return;
      canvas.setPointerCapture(event.pointerId);
      pointer = { lastX: point.x, lastY: point.y, time: performance.now() };
      dragged.vx = 0;
      dragged.vy = 0;
    }
    function onPointerMove(event: PointerEvent) {
      if (!dragged) return;
      const point = canvasPoint(event);
      const now = performance.now();
      const elapsed = Math.max(8, now - pointer.time) / 1000;
      dragged.vx = (point.x - pointer.lastX) / elapsed;
      dragged.vy = (point.y - pointer.lastY) / elapsed;
      const { width, height } = sizeRef.current;
      dragged.x = clampAxis(point.x, width, dragged.radius);
      dragged.y = clampAxis(point.y, height, dragged.radius);
      pointer = { lastX: point.x, lastY: point.y, time: now };
    }
    function onPointerUp(event: PointerEvent) {
      if (!dragged) return;
      dragged.vx = Math.max(-1600, Math.min(1600, dragged.vx));
      dragged.vy = Math.max(-1600, Math.min(1600, dragged.vy));
      dragged = null;
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    }
    /* Doble clic para verla en grande, como en cualquier videollamada. Va en el
       lienzo porque es quien recibe los punteros: la ventana está debajo. */
    function onDoubleClick(event: MouseEvent) {
      const rect = screenRectRef.current;
      const node = screenRef.current;
      if (!rect || !node) return;
      const bounds = canvas.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      if (x < rect.x || x > rect.x + rect.w || y < rect.y || y > rect.y + rect.h) return;
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
      else void node.requestFullscreen().catch(() => {});
    }
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);

    let raf = 0;
    let lastTime = performance.now();
    function frame(time: number) {
      const dt = (time - lastTime) / 1000;
      lastTime = time;
      layoutScreen();
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < steps; i += 1) step(dt / steps);
      for (const ball of ballsRef.current) {
        const node = avatarNodesRef.current.get(ball.userId);
        if (!node) continue;
        node.style.transform = `translate3d(${ball.x - ball.radius}px, ${ball.y - ball.radius}px, 0)`;
        node.style.zIndex = String(Math.max(1, Math.round(ball.y)));
      }
      ctx.clearRect(0, 0, sizeRef.current.width, sizeRef.current.height);
      [...ballsRef.current].sort((a, b) => a.y - b.y).forEach(draw);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    // Pestaña oculta: nada que mirar, nada que calcular. Al volver se reinicia
    // lastTime para no integrar de golpe todo el dt acumulado durante el parón.
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        lastTime = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("deviceorientation", onOrientation);
    };
  }, []);

  return (
    <div ref={containerRef} className="relative isolate flex-1">
      {/* Sin z y primero en el DOM: las esferas (z por su altura) y el lienzo van
          por encima, así una bola posada sobre la ventana se ve delante. La caja
          la coloca el bucle de física, que es quien sabe dónde está. */}
      {video ? (
        <div
          ref={screenRef}
          className="absolute top-0 left-0 overflow-hidden rounded-card border border-line bg-black shadow-[var(--shadow)]"
          style={{ width: 0, height: 0, transform: "translate3d(-9999px,-9999px,0)" }}
        >
          <VideoTile stream={video} self={false} />
        </div>
      ) : null}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
        {states.map((state) => {
          const member = members.find((candidate) => candidate.user.id === state.user_id);
          const name = member?.nickname ?? member?.user.display_name ?? "…";
          const profile = member?.user.profile_style;
          const radius = gravityRadius(state.user_id);
          const diameter = radius * 2;
          // El atlas del aro ocupa 1,67 veces su caja y la decoración propia
          // 1,32 veces. Reducimos solo la cara para que el adorno entero siga
          // perteneciendo a la esfera física y no atraviese paredes o vecinos.
          const avatarSize = profile?.avatar_ring
            ? Math.round(diameter * 0.6)
            : profile?.avatar_deco_url
              ? Math.round(diameter / 1.32)
              : diameter;
          return (
            <div
              key={state.user_id}
              ref={(node) => {
                if (node) avatarNodesRef.current.set(state.user_id, node);
                else avatarNodesRef.current.delete(state.user_id);
              }}
              className="absolute top-0 left-0 grid place-items-center rounded-full drop-shadow-[3px_8px_6px_rgba(0,0,0,0.35)] will-change-transform"
              style={{ width: diameter, height: diameter, transform: "translate3d(-9999px,-9999px,0)" }}
            >
              <Avatar
                name={name}
                url={member?.user.avatar_url}
                id={state.user_id}
                size={avatarSize}
                profile={profile}
              />
            </div>
          );
        })}
      </div>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 z-20 h-full w-full touch-none"
      />
    </div>
  );
}

/**
 * Los juegos de la sala —gravedad y carrera— viven en la cabecera, dentro de un
 * solo botón. Flotando sobre las caras estorbaban la vista y se comían los toques
 * en móvil, y son cosas que se encienden una vez, no mandos de la llamada.
 */
export function VoiceFunMenu({ channelId }: { channelId: string }) {
  const t = useT();
  const local = useVoiceLocal();
  const selfId = useStore((s) => s.user?.id);
  const gravity = useStore((s) => s.gravity);
  const setGravity = useStore((s) => s.setGravity);
  const lobby = useStore((s) => s.races[channelId]) ?? null;

  // La carrera es de quien está en la sala, y un botón que la instancia va a
  // rechazar no es un botón. La gravedad, en cambio, no necesita llamada.
  const canRace = local.channelId === channelId && !(selfId && lobby?.members.includes(selfId));
  const canGravity = !local.video;
  if (!canRace && !canGravity) return null;

  return (
    <Menu
      trigger={({ onClick }) => (
        <IconButton label={t("voice.fun")} onClick={onClick} pressed={gravity}>
          <PartyPopper size={17} />
        </IconButton>
      )}
    >
      {(close) => (
        <>
          {canRace ? (
            <MenuItem
              onClick={() => {
                close();
                sendCommand({ t: "RACE_OPEN", d: { channel_id: channelId } });
              }}
            >
              <Trophy size={15} />
              {lobby ? t("race.join", { count: lobby.members.length }) : t("race.open")}
            </MenuItem>
          ) : null}
          {canGravity ? (
            <MenuItem
              onClick={async () => {
                close();
                if (!gravity) await requestGyroPermission();
                setGravity(!gravity);
              }}
            >
              <Orbit size={15} />
              {t("voice.gravity")}
              {/* Encendido o apagado se ve con una marca, no solo con el color. */}
              {gravity ? <Check size={15} className="ml-auto text-accent" /> : null}
            </MenuItem>
          ) : null}
        </>
      )}
    </Menu>
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
  const gravity = useStore((s) => s.gravity);
  const setGravity = useStore((s) => s.setGravity);

  /* Carrera de canicas (§9.4). La sala la lleva la instancia: quien pulsa la
     abre, los demás se apuntan desde el mismo botón, y solo quien la abrió da
     la salida. El panel se abre para quien está apuntado y para nadie más. */
  const lobby = useStore((s) => s.races[channelId]) ?? null;
  const members = data?.members;
  const inRace = Boolean(selfId && lobby?.members.includes(selfId));
  // Quienes corren son las personas apuntadas, con su cara y su color: una
  // carrera entre los de la llamada.
  const racers = useMemo<Racer[]>(() => {
    const ids = lobby ? (lobby.seed === null ? lobby.members : lobby.runners) : [];
    return ids.map((id) => {
      const member = members?.find((m) => m.user.id === id);
      const name = member?.nickname ?? member?.user.display_name ?? "…";
      return {
        id,
        name,
        hue: hueOf(id),
        initials: name.trim().slice(0, 2).toUpperCase(),
        avatarUrl: member?.user.avatar_url ?? undefined,
      };
    });
  }, [lobby, members]);

  /* Lo que se está enseñando, para el fondo de la gravedad. La pantalla manda
     sobre la cámara: si alguien comparte algo, es lo que se está mirando. Lo
     propio no entra aquí porque emitir te saca de esta vista. */
  const sharedVideo = useMemo(() => {
    const sharing = states.filter(
      (state) => state.user_id !== selfId && state.video && local.videos.has(state.user_id),
    );
    const source = sharing.find((state) => state.video === "screen") ?? sharing[0];
    return source ? local.videos.get(source.user_id) ?? null : null;
  }, [states, selfId, local.videos]);

  // Encender la propia cámara o pantalla te saca a TI de la gravedad, para que
  // puedas ver tu vídeo: no le toca la vista a nadie más, que se queda como
  // estaba (en gravedad o en cuadrícula, según lo tuviera cada cual).
  useEffect(() => {
    if (local.video) setGravity(false);
  }, [local.video, setGravity]);

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
    /* min-h-0 + scroll en la rejilla: con varias personas en móvil las fichas
       empujaban los mandos fuera de la pantalla y no había forma de colgar. */
    <div className="relative flex min-h-0 flex-1 flex-col">
      {lobby && inRace ? (
        /* fallback null: mientras baja el chunk se sigue viendo la llamada
           tal cual; el panel aparece entero cuando está listo. */
        <Suspense fallback={null}>
          <MarbleRace
            lobby={lobby}
            racers={racers}
            isHost={lobby.host_id === selfId}
            racing={Boolean(selfId && (lobby.seed === null || lobby.runners.includes(selfId)))}
            onWorld={(world) => sendCommand({ t: "RACE_WORLD", d: { channel_id: channelId, world } })}
            onStart={() => sendCommand({ t: "RACE_START", d: { channel_id: channelId } })}
            onLeave={() => sendCommand({ t: "RACE_LEAVE", d: { channel_id: channelId } })}
          />
        </Suspense>
      ) : null}
      {gravity ? (
        <GravityStage
          states={states}
          members={data?.members ?? EMPTY}
          speaking={local.speaking}
          video={sharedVideo}
        />
      ) : (
        <div className="grid flex-1 content-center gap-4 overflow-y-auto p-6 sm:grid-cols-2 lg:grid-cols-3">
          {states.map((state) => {
            const member = data?.members.find(
              (m) => m.user.id === state.user_id,
            );
            const name = member?.nickname ?? member?.user.display_name ?? "…";
            const speaking = local.speaking.has(state.user_id);
            const self = state.user_id === selfId;
            // La pista existe desde que se conecta el par, pero solo se pinta si el
            // servidor dice que esa persona está emitiendo: es lo que convierte el
            // permiso de cámara en algo visible, y evita mostrar un cuadro negro.
            const stream = self
              ? local.localVideo
              : local.videos.get(state.user_id);
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
                    <VideoTile
                      stream={video}
                      self={self && state.video === "camera"}
                    />
                    <FullscreenButton />
                  </>
                ) : (
                  <SpeakingRing
                    speaking={speaking}
                    profile={member?.user.profile_style}
                    size={72}
                  >
                    <Avatar
                      name={name}
                      url={member?.user.avatar_url}
                      id={state.user_id}
                      size={72}
                      profile={member?.user.profile_style}
                    />
                  </SpeakingRing>
                )}
                <figcaption className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg bg-bg/80 px-2 py-1 text-xs">
                  {/* Callado por decisión propia y callado por moderación se ven
                  distinto: quien lo mira necesita saber si esa persona puede
                  volver a hablar sola o no. */}
                  {state.force_deafened || state.force_muted ? (
                    <Lock
                      size={12}
                      className="text-danger"
                      aria-label={t(
                        state.force_deafened
                          ? "voice.forcedDeafened"
                          : "voice.forcedMuted",
                      )}
                    />
                  ) : state.deafened ? (
                    <VolumeX size={12} className="text-danger" />
                  ) : state.muted ? (
                    <MicOff size={12} className="text-danger" />
                  ) : null}
                  {state.video === "screen" ? (
                    <MonitorUp size={12} className="text-accent" />
                  ) : null}
                  <span className="max-w-40 truncate font-medium">{name}</span>
                  {/* Sin conexión con esa persona no hay vídeo que valga, y conviene
                  distinguirlo de "tiene la cámara apagada". */}
                  {!self && link && link !== "connected" ? (
                    <span
                      className={
                        link === "failed" ? "text-danger" : "text-warn"
                      }
                    >
                      {t(`voice.link.${link}`)}
                    </span>
                  ) : null}
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}
    </div>
  );
}
