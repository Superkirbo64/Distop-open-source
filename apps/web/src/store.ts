/**
 * Estado de la aplicación.
 * El gateway es la fuente de la verdad en caliente: las acciones llaman a la API
 * y el estado se actualiza cuando vuelve el evento, así dos pestañas del mismo
 * usuario ven exactamente lo mismo.
 */
import { create } from "zustand";
import { mentionsUser } from "@distop/protocol";
import { BRAND } from "./brand.ts";
import type {
  Category,
  Channel,
  Community,
  CustomEmoji,
  GamePresence,
  InstanceHealth,
  Meeting,
  MeetingRecording,
  MeetingRole,
  MeetingWaiting,
  Member,
  Message,
  RaceLobby,
  Role,
  SelfUser,
  ServerEvent,
  Unread,
  VideoBudget,
  VoiceState,
} from "@distop/protocol";
import { api, getTokens, setTokens, type Tokens } from "./lib/api.ts";
import { connect, disconnect, onEvent, onStatus, sendCommand, type ConnectionStatus } from "./lib/gateway.ts";
import { detectLocale, loadLocale, translate, type Locale, type MessageKey } from "./i18n.ts";
import { notify, setSoundsEnabled, type NotifyLevel } from "./lib/notify.ts";
import { addNotice, loadNotices, saveNotices, type Notice, type NoticeKind } from "./lib/notices.ts";
import { configureVoice, currentChannel, handleSignal, leaveVoice, rejectVoiceJoin, resumeVoice, setSoundError, setVideoMode, setVoiceMode, syncPeers } from "./lib/voice.ts";
import { playClip } from "./lib/relay.ts";
import { onRecordingUpdate } from "./lib/record.ts";
import { forgetCommunity, instanceBase, peekPendingInvite, rememberCommunities, setDesktopAvailabilityStatus, trustInstanceIdentity, type InstanceIdentityInfo } from "./lib/instance.ts";
import { portableAuthPayload, syncPortableMedia } from "./lib/portable.ts";

export type ThemeChoice = "light" | "dark" | "system";
export type Density = "compact" | "cozy";

export interface CommunityData {
  community: Community;
  categories: Category[];
  channels: Channel[];
  roles: Role[];
  members: Member[];
  online: string[];
  /** Quién está jugando a qué ahora mismo, de los que lo comparten (§9.1). */
  game_presences: GamePresence[];
  voice_states: VoiceState[];
  /** Permisos en la comunidad, como bitfield decimal. */
  permissions: string;
  /** Permisos ya resueltos canal por canal, con sus overwrites aplicados. */
  channel_permissions: Record<string, string>;
  /** Emojis y stickers propios de esta comunidad (§10.3). */
  emojis: CustomEmoji[];
  /** Qué queda sin leer en cada canal, calculado por la instancia. */
  unread: Record<string, Unread>;
  /** Último mensaje leído por canal: es dónde va la línea de "mensajes nuevos". */
  read_state: Record<string, string>;
}

export type FontChoice = "default" | "system" | "serif" | "mono";
export type BackdropChoice = "plain" | "soft" | "dots";

interface Prefs {
  theme: ThemeChoice;
  scale: number;
  density: Density;
  locale: Locale;
  /** Vacío = el color de la marca. Cualquier otro valor manda sobre los dos temas. */
  accent: string;
  radius: number;
  font: FontChoice;
  backdrop: BackdropChoice;
  /** URL de una imagen de fondo, o vacío. Es de este dispositivo, no de la cuenta. */
  wallpaper: string;
  /** Cuánto tapa el velo del tema, en %. A 0 la foto va limpia y el texto sufre. */
  wallpaperVeil: number;
  wallpaperBlur: number;
  wallpaperBright: number;
  wallpaperContrast: number;
  wallpaperSaturate: number;
  motion: boolean;
  /** Qué merece interrumpir: todo, solo lo que me nombra, o nada. */
  notify: NotifyLevel;
  sounds: boolean;
}

/** Pilas tipográficas locales: ninguna descarga nada ni delata al usuario. */
const FONTS: Record<FontChoice, string | null> = {
  default: null,
  system: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif",
  serif: 'Iowan Old Style, Palatino, Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
};

/** Blanco o negro encima del acento, según lo claro que sea el color elegido. */
function inkOver(hex: string): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return "#ffffff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) > 0.4 ? "#0b0d16" : "#ffffff";
}

interface State {
  ready: boolean;
  user: SelfUser | null;
  status: ConnectionStatus;
  instance: InstanceHealth | null;
  /** Instancia recién instalada, todavía sin nadie que la haya reclamado. */
  setup: { required: boolean; requiresCode: boolean } | null;
  /** Frase de las copias que la instancia enseña al reclamarla, una sola vez.
      Se muestra y se olvida: no se guarda en disco ni vuelve a pedirse. */
  backupPassphrase: string | null;
  /** Quién está en cada canal de voz, por canal. */
  voice: Record<string, VoiceState[]>;
  /** canal → sala de la carrera de canicas, o ausente si no hay ninguna (§9.4). */
  races: Record<string, RaceLobby | null>;

  /* ── reuniones (V1–V4) ────────────────────────────────────────────────
     Todo va por canal y no por reunión: la interfaz siempre parte del canal
     abierto, y un canal tiene como mucho una reunión. Cinco mapas separados y
     no un objeto por canal porque cada uno llega en su propio evento y
     mezclarlos obligaría a rehacer el objeto entero por cada cambio suelto. */

  /** canal → la reunión, tal como la manda `MEETING_UPDATE`. */
  meetings: Record<string, Meeting>;
  /** canal → quién espera fuera. Solo lo recibe quien modera. */
  lobby: Record<string, MeetingWaiting[]>;
  /** canal → grabación viva, o null si no hay ninguna. */
  recording: Record<string, MeetingRecording | null>;
  /** canal → quién tiene el turno de palabra ahora mismo. */
  floor: Record<string, string | null>;
  /** canal → reparto de vídeo. Llega solo cuando alguien enciende o apaga. */
  budget: Record<string, VideoBudget | null>;
  /** reunión → mi papel en ella. Lo fija `GET /meetings/:id` y lo corrige `MEETING_ROLE`. */
  meetingRole: Record<string, MeetingRole>;
  /** canal → estoy en la sala de espera de esta reunión, todavía sin admitir. */
  meetingWaiting: Record<string, boolean>;
  /** Carga (o recarga) la reunión de un canal desde la API. */
  loadMeeting: (channelId: string) => Promise<void>;
  /** Los estados de todas las reuniones de una comunidad, para la barra lateral. */
  loadMeetings: (communityId: string) => Promise<void>;
  /**
   * Entré por un enlace de reunión y mi sesión solo sirve para ella.
   *
   * No es "soy invitado": es "esta sesión está acotada". La instancia rechaza
   * cualquier otra ruta, así que la aplicación entera —barra de comunidades,
   * canales, ajustes— no tiene nada que enseñar y se sustituye por la reunión.
   */
  guestMeeting: Meeting | null;
  /** Dirección pública de la instancia, para que los enlaces sirvan fuera de casa. */
  publicUrl: string;
  /** El anfitrión encendió el directorio (PUBLIC_DISCOVERY_ENABLED). Apagado de
      fábrica: nada se anuncia sin que quien hospeda lo decida (§19). */
  publicDiscoveryEnabled: boolean;
  /** Índice global opcional. Vacío = Explorar solo consulta esta instancia. */
  directoryUrl: string;
  /** El anfitrión configuró clave de Giphy. Sin esto la pestaña de GIF no se enseña. */
  gifEnabled: boolean;
  /** Y la de Klipy, que es la de la galería de stickers. Van por separado. */
  stickerGalleryEnabled: boolean;
  /** Gestión de la comunidad abierta. En el store y no en App porque el
      selector de stickers también necesita poder llevarte ahí. */
  manageOpen: boolean;
  setManageOpen: (open: boolean) => void;
  /** Vista de gravedad de la sala de voz. En el store porque el interruptor
      vive en la cabecera del canal y el lienzo dentro de la sala. */
  gravity: boolean;
  setGravity: (on: boolean) => void;
  /**
   * Cómo se colocan las caras en una reunión (§8.8).
   *
   * `auto` no es una cuarta disposición: es "todavía no he elegido", y mientras
   * nadie elija, compartir pantalla pone la presentación sola. En cuanto
   * alguien elige, su elección manda — una vista que se cambia sola después de
   * que la hayas puesto a mano es de las cosas más molestas que existen.
   */
  stageLayout: "auto" | "gallery" | "speaker" | "presentation";
  setStageLayout: (layout: State["stageLayout"]) => void;

  communities: Community[];
  /** Historial de avisos, del más nuevo al más viejo. */
  notices: Notice[];
  data: Record<string, CommunityData>;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, Record<string, number>>;
  /* Plano por canal y no por comunidad: la barra lateral, la de comunidades y el
     título de la pestaña preguntan por lo mismo desde tres sitios distintos. */
  unread: Record<string, Unread>;
  lastRead: Record<string, string>;
  /* Todo lo que puedo usar, de todas mis comunidades a la vez. Va plano y no por
     comunidad porque el selector los enseña juntos y el renderizador solo tiene
     un id: sin esta lista habría que adivinar de qué comunidad salió cada uno. */
  expressions: CustomEmoji[];
  /* Canal → comunidad. El contador es por canal, pero la barra de comunidades
     necesita sumarlos, y un canal cuya comunidad no has abierto todavía no
     aparece en ningún otro sitio del estado. */
  channelOwner: Record<string, string>;
  /* Dónde va la línea de "mensajes nuevos": se congela al abrir el canal y no
     se mueve mientras estés dentro. Si siguiera a lastRead desaparecería en el
     mismo instante en que abres, que es cuando hace falta. */
  divider: Record<string, string | null>;

  activeCommunityId: string | null;
  activeChannelId: string | null;
  prefs: Prefs;
  /** Sube cuando llega el chunk del idioma activo: los textos ya montados se
      repintan sin que cambie prefs.locale (que se fijó antes de la descarga). */
  localeEpoch: number;

  boot: () => Promise<void>;
  authenticate: (path: string, body: unknown) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: (user: SelfUser) => void;

  openCommunity: (communityId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  send: (channelId: string, content: string, attachmentIds: string[], replyToId: string | null) => Promise<void>;
  notifyTyping: (channelId: string) => void;
  markRead: (channelId: string) => void;
  pushNotice: (input: { kind: NoticeKind; title: string; body: string; target?: Notice["target"] }) => void;
  readNotices: () => void;
  clearNotices: () => void;
  /** Poner al día un canal que quizá ni se ha abierto (menú de la barra lateral). */
  catchUp: (channelId: string) => Promise<void>;
  loadExpressions: () => Promise<void>;
  reloadCommunities: () => Promise<void>;
  /** Borrado real: quita la comunidad del estado Y de la caché de instancias. */
  removeCommunity: (communityId: string) => void;

  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  /** Panel flotante de ajuste del fondo. No se guarda: es "lo tengo abierto ahora". */
  tuner: boolean;
  setTuner: (open: boolean) => void;
}

function loadPrefs(): Prefs {
  const theme = (localStorage.getItem("distop.theme") as ThemeChoice | null) ?? "system";
  const scale = Number(localStorage.getItem("distop.scale") ?? 1) || 1;
  const density = (localStorage.getItem("distop.density") as Density | null) ?? "cozy";
  const accent = localStorage.getItem("distop.accent") ?? "";
  const radius = Number(localStorage.getItem("distop.radius") ?? 14) || 14;
  const font = (localStorage.getItem("distop.font") as FontChoice | null) ?? "default";
  const backdrop = (localStorage.getItem("distop.backdrop") as BackdropChoice | null) ?? "plain";
  const wallpaper = localStorage.getItem("distop.wallpaper") ?? "";
  const num = (key: string, fallback: number) => Number(localStorage.getItem(`distop.${key}`) ?? fallback) || fallback;
  const motion = localStorage.getItem("distop.motion") !== "false";
  const notify = (localStorage.getItem("distop.notify") as NotifyLevel | null) ?? "mentions";
  const sounds = localStorage.getItem("distop.sounds") !== "false";
  return {
    theme,
    scale,
    density,
    accent,
    radius,
    font,
    backdrop,
    wallpaper,
    // `num` descarta el 0 al caer en ||, y un velo a 0 es una elección válida:
    // significa "la foto tal cual". Por eso este no pasa por ahí.
    wallpaperVeil: Number(localStorage.getItem("distop.wallpaperVeil") ?? 78),
    wallpaperBlur: Number(localStorage.getItem("distop.wallpaperBlur") ?? 0),
    wallpaperBright: num("wallpaperBright", 100),
    wallpaperContrast: num("wallpaperContrast", 100),
    wallpaperSaturate: num("wallpaperSaturate", 100),
    motion,
    notify,
    sounds,
    locale: detectLocale(),
  };
}

/**
 * El tema se aplica al documento, no a un contenedor: cubre diálogos y scrollbars.
 * Todo lo de aquí es gratis y reversible; no hay ninguna opción que dependa de
 * pagar, ni ninguna que se guarde para "una versión mejor" (§10).
 */
function applyPrefs(prefs: Prefs): void {
  const root = document.documentElement;
  const dark = prefs.theme === "dark" || (prefs.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  root.dataset.theme = dark ? "dark" : "light";
  root.style.setProperty("--ui-scale", String(prefs.scale));
  root.style.setProperty("--row-gap", prefs.density === "compact" ? "0.15rem" : "0.5rem");
  root.lang = prefs.locale;

  // Acento: se escribe encima de la paleta del tema, así que vale para los dos.
  if (prefs.accent) {
    root.style.setProperty("--accent", prefs.accent);
    root.style.setProperty("--accent-soft", `color-mix(in oklab, ${prefs.accent} 18%, transparent)`);
    root.style.setProperty("--accent-ink", inkOver(prefs.accent));
  } else {
    for (const name of ["--accent", "--accent-soft", "--accent-ink"]) root.style.removeProperty(name);
  }

  root.style.setProperty("--radius-card", `${prefs.radius}px`);
  root.style.setProperty("--radius-field", `${Math.max(4, Math.round(prefs.radius * 0.7))}px`);

  const font = FONTS[prefs.font];
  if (font) {
    root.style.setProperty("--font-body", font);
    root.style.setProperty("--font-display", font);
  } else {
    root.style.removeProperty("--font-body");
    root.style.removeProperty("--font-display");
  }

  root.dataset.backdrop = prefs.backdrop;

  // La URL acaba dentro de un url() de CSS, así que pasa por una lista blanca
  // de caracteres: un `)` o unas comillas en la ruta cerrarían la función, y lo
  // que viniera detrás lo leería el motor de estilos como declaraciones.
  if (prefs.wallpaper) root.style.setProperty("--wallpaper", `url("${prefs.wallpaper.replace(/[^\w:/.\-?=&%~]/g, "")}")`);
  else root.style.removeProperty("--wallpaper");
  root.dataset.wallpaper = prefs.wallpaper ? "on" : "off";
  root.style.setProperty("--wallpaper-veil", `${prefs.wallpaperVeil}%`);
  root.style.setProperty("--wallpaper-blur", `${prefs.wallpaperBlur}px`);
  root.style.setProperty(
    "--wallpaper-filter",
    `brightness(${prefs.wallpaperBright}%) contrast(${prefs.wallpaperContrast}%) saturate(${prefs.wallpaperSaturate}%)`,
  );
  root.dataset.motion = prefs.motion ? "on" : "off";
  setSoundsEnabled(prefs.sounds);
}

const MESSAGE_PAGE = 50;

/** Se aprenden en /info y se aplican en READY, cuando ya se sabe quién soy. */
let iceServers: RTCIceServer[] = [];
let pendingIdentityInfo: InstanceIdentityInfo | null = null;

/* Pide en segundo plano el diccionario del idioma (solo el español viene en el
   bundle). Al resolver, si sigue siendo el activo —pudo cambiar durante la
   descarga—, sube el contador para que los textos ya pintados se repinten. */
function ensureLocale(locale: Locale): void {
  void loadLocale(locale)
    .then(() => {
      if (useStore.getState().prefs.locale === locale)
        useStore.setState((state) => ({ localeEpoch: state.localeEpoch + 1 }));
    })
    .catch(() => {
      // Sin red queda el fallback en español; el próximo cambio de idioma reintenta.
    });
}

export const useStore = create<State>()((set, get) => ({
  ready: false,
  user: null,
  status: "offline",
  instance: null,
  setup: null,
  backupPassphrase: null,
  voice: {},
  races: {},
  meetings: {},
  lobby: {},
  recording: {},
  floor: {},
  budget: {},
  meetingRole: {},
  meetingWaiting: {},
  guestMeeting: null,
  publicUrl: "",
  publicDiscoveryEnabled: false,
  directoryUrl: "",
  gifEnabled: false,
  stickerGalleryEnabled: false,
  manageOpen: false,
  setManageOpen: (manageOpen) => set({ manageOpen }),
  gravity: false,
  setGravity: (gravity) => set({ gravity }),
  stageLayout: "auto",
  setStageLayout: (stageLayout) => set({ stageLayout }),
  tuner: false,

  communities: [],
  notices: loadNotices(),
  data: {},
  messages: {},
  hasMore: {},
  typing: {},
  unread: {},
  lastRead: {},
  expressions: [],
  channelOwner: {},
  divider: {},

  activeCommunityId: null,
  activeChannelId: null,
  prefs: loadPrefs(),
  localeEpoch: 0,

  async boot() {
    applyPrefs(get().prefs);
    // El idioma detectado puede necesitar su chunk; no se espera a la descarga.
    ensureLocale(get().prefs.locale);

    // Se pregunta siempre, antes que nada: una instancia sin dueño enseña la
    // puesta en marcha, no un formulario de acceso a un sitio que es tuyo.
    try {
      const info = await api<InstanceIdentityInfo & {
        setup_required: boolean;
        setup_requires_code: boolean;
        ice_servers: RTCIceServer[];
        video: { mode: "host" | "direct" };
        /** Por dónde va la voz. Ausente en instancias anteriores a este cambio:
            el `?? "host"` de abajo las deja funcionando exactamente igual. */
        voice?: { mode: "host" | "direct" };
        public_url: string;
        public_discovery_enabled: boolean;
        directory_url?: string;
        gif_enabled: boolean;
        sticker_gallery_enabled: boolean;
      }>("GET", "/api/v1/info");
      set({
        setup: { required: info.setup_required, requiresCode: info.setup_requires_code },
        publicUrl: info.public_url,
        publicDiscoveryEnabled: Boolean(info.public_discovery_enabled),
        directoryUrl: typeof info.directory_url === "string" ? info.directory_url : "",
        gifEnabled: Boolean(info.gif_enabled),
        stickerGalleryEnabled: Boolean(info.sticker_gallery_enabled),
      });
      pendingIdentityInfo = info;
      iceServers = info.ice_servers ?? [];
      setVideoMode(info.video?.mode ?? "host");
      setVoiceMode(info.voice?.mode ?? "host");
    } catch {
      // Instancia inalcanzable: el propio cliente lo dirá al intentar entrar.
    }

    if (getTokens()) {
      try {
        const user = await api<SelfUser>("GET", "/api/v1/users/me");
        set({ user, ready: true });
        if (pendingIdentityInfo) void trustInstanceIdentity(pendingIdentityInfo);
        connect();
        return;
      } catch {
        setTokens(null);
      }
    }

    /* Al saltar a la PC de otra persona no se abre un registro ni se inventa
       un invitado: la identidad secreta de la app recupera (o, con invitación,
       crea) la cuenta portable de esta instancia. */
    const portable = portableAuthPayload(peekPendingInvite());
    if (portable) {
      try {
        const result = await api<Tokens & { user: SelfUser }>("POST", "/api/v1/auth/portable", portable);
        setTokens({ access_token: result.access_token, refresh_token: result.refresh_token });
        const user = await syncPortableMedia(result.user);
        set({ user, ready: true });
        if (pendingIdentityInfo) void trustInstanceIdentity(pendingIdentityInfo);
        connect();
        return;
      } catch {
        // Puede ser una instancia vieja, apagada o una identidad aún no
        // registrada sin invitación. La pantalla de recuperación decide qué
        // enseñar; aquí no se degrada silenciosamente a invitado.
      }
    }

    set({ ready: true, user: null });
  },

  async authenticate(path, body) {
    const result = await api<Tokens & { user: SelfUser; backup_passphrase?: string }>("POST", path, body);
    setTokens({ access_token: result.access_token, refresh_token: result.refresh_token });
    // Con alguien dentro, la instancia deja de estar sin dueño.
    set({ user: result.user, setup: { required: false, requiresCode: false } });
    /* Solo llega al reclamar una instancia con copias programadas (la nube).
       Es la única vez que la instancia la enseña: se pone delante al entrar. */
    if (result.backup_passphrase) set({ backupPassphrase: result.backup_passphrase });
    if (result.user.theme !== "system") {
      const prefs = { ...get().prefs, theme: result.user.theme as ThemeChoice };
      set({ prefs });
      applyPrefs(prefs);
    }
    if (pendingIdentityInfo) void trustInstanceIdentity(pendingIdentityInfo);
    connect();

    /* Una instalación nueva arrancó sin dueño y, por seguridad, no abrió el
       túnel. En cuanto quien hospeda la reclama ya se puede publicar. Se hace
       en segundo plano: crear el usuario no espera a que la primera descarga
       de cloudflared termine, pero el panel y la invitación compartirán este
       mismo arranque si se abren mientras tanto. */
    if (path === "/api/v1/auth/bootstrap" && !get().publicUrl) {
      void api<{ status: string; url: string; public_url: string }>("POST", "/api/v1/instance/tunnel")
        .then((tunnel) => {
          if (tunnel.status === "on" && tunnel.public_url) set({ publicUrl: tunnel.public_url });
        })
        .catch(() => {
          // La cuenta ya está creada. El panel del servidor muestra el fallo y
          // permite reintentar sin convertirlo en un fallo de autenticación.
        });
    }
  },

  async logout() {
    try {
      await api("POST", "/api/v1/auth/logout");
    } catch {
      // Cerrar sesión en local no puede depender de que la instancia responda.
    }
    disconnect();
    setTokens(null);
    set({
      user: null,
      communities: [],
      data: {},
      messages: {},
      activeCommunityId: null,
      activeChannelId: null,
      /* Sin esto, cerrar la sesión de invitado dejaba la pantalla de la reunión
         puesta encima de la de entrar: la sesión ya no valía y la reunión
         seguía dibujada. */
      guestMeeting: null,
    });
  },

  refreshUser(user) {
    set({ user });
  },

  async reloadCommunities() {
    set({ communities: await api<Community[]>("GET", "/api/v1/communities") });
  },

  removeCommunity(communityId) {
    const state = get();
    const { [communityId]: _removed, ...rest } = state.data;
    set({
      communities: state.communities.filter((community) => community.id !== communityId),
      data: rest,
      activeCommunityId: state.activeCommunityId === communityId ? null : state.activeCommunityId,
      activeChannelId: state.activeCommunityId === communityId ? null : state.activeChannelId,
    });
    /* También la caché local: era lo que resucitaba comunidades borradas. */
    if (instanceBase) forgetCommunity(instanceBase, communityId);
  },

  async openCommunity(communityId) {
    set({ activeCommunityId: communityId });
    sendCommand({ t: "SUBSCRIBE", d: { community_id: communityId } });

    const data = await api<CommunityData>("GET", `/api/v1/communities/${communityId}/bootstrap`);
    const voice: Record<string, VoiceState[]> = { ...get().voice };
    for (const channel of data.channels) if (channel.kind === "voice") voice[channel.id] = [];
    for (const state of data.voice_states) voice[state.channel_id] = [...(voice[state.channel_id] ?? []), state];
    set((state) => ({
      data: { ...state.data, [communityId]: data },
      voice,
      unread: { ...state.unread, ...data.unread },
      lastRead: { ...state.lastRead, ...data.read_state },
      channelOwner: {
        ...state.channelOwner,
        ...Object.fromEntries(data.channels.map((channel) => [channel.id, communityId])),
      },
    }));

    const first = data.channels.find((channel) => channel.kind !== "voice") ?? data.channels[0];
    if (first) await get().openChannel(first.id);
    else set({ activeChannelId: null });
  },

  async openChannel(channelId) {
    /* Al abandonar un canal, su historial vuelve a la última página: el resto
       sigue en el servidor y loadOlder lo repagina igual que siempre. Sin esta
       poda, una sesión larga retiene los historiales completos de cada canal
       visitado, y MESSAGE_CREATE los sigue engordando en segundo plano. */
    const previous = get().activeChannelId;
    if (previous && previous !== channelId) {
      const left = get().messages[previous];
      if (left && left.length > MESSAGE_PAGE) {
        set((state) => ({
          messages: { ...state.messages, [previous]: left.slice(-MESSAGE_PAGE) },
          hasMore: { ...state.hasMore, [previous]: true },
        }));
      }
    }

    set({ activeChannelId: channelId });

    if (!get().messages[channelId]) {
      const page = await api<Message[]>("GET", `/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE}`);
      set((state) => ({
        messages: { ...state.messages, [channelId]: page },
        hasMore: { ...state.hasMore, [channelId]: page.length === MESSAGE_PAGE },
      }));
    }

    /* La línea de "mensajes nuevos" se dibuja con lo que había ANTES de abrir,
       así que se guarda primero y se marca leído después. */
    set((state) => ({ divider: { ...state.divider, [channelId]: state.lastRead[channelId] ?? null } }));
    get().markRead(channelId);
  },

  /**
   * La reunión de un canal, con su detalle.
   *
   * No hay ruta "dame la reunión de este canal": la API indexa por reunión, no
   * por canal. Así que primero se pide la lista de la comunidad —son pocas y la
   * sección de la barra lateral la quiere igualmente— y se indexa por canal;
   * después se pide el detalle, que es lo único que trae mi papel, la sala de
   * espera y la grabación viva.
   */
  async loadMeetings(communityId) {
    const lista = await api<Meeting[]>("GET", `/api/v1/communities/${communityId}/meetings`);
    const porCanal: Record<string, Meeting> = {};
    for (const item of lista) porCanal[item.channel_id] = item;
    set((state) => ({ meetings: { ...state.meetings, ...porCanal } }));
  },

  async loadMeeting(channelId) {
    const communityId = get().channelOwner[channelId] ?? get().activeCommunityId;
    if (!communityId) return;

    let reunion = get().meetings[channelId];
    if (!reunion) {
      await get().loadMeetings(communityId);
      reunion = get().meetings[channelId];
      if (!reunion) return;
    }

    const detalle = await api<{
      meeting: Meeting;
      my_role: MeetingRole;
      roles: Array<{ user_id: string; role: MeetingRole }>;
      waiting: MeetingWaiting[];
      moderator_present: boolean;
      recording: MeetingRecording | null;
    }>("GET", `/api/v1/meetings/${reunion.id}`);

    set((state) => ({
      meetings: { ...state.meetings, [detalle.meeting.channel_id]: detalle.meeting },
      meetingRole: { ...state.meetingRole, [detalle.meeting.id]: detalle.my_role },
      lobby: { ...state.lobby, [detalle.meeting.channel_id]: detalle.waiting },
      recording: { ...state.recording, [detalle.meeting.channel_id]: detalle.recording },
    }));
  },

  async loadOlder(channelId) {
    const current = get().messages[channelId] ?? [];
    const oldest = current[0];
    if (!oldest) return;

    const page = await api<Message[]>(
      "GET",
      `/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE}&before=${oldest.id}`,
    );
    set((state) => ({
      messages: { ...state.messages, [channelId]: [...page, ...(state.messages[channelId] ?? [])] },
      hasMore: { ...state.hasMore, [channelId]: page.length === MESSAGE_PAGE },
    }));
  },

  async send(channelId, content, attachmentIds, replyToId) {
    await api("POST", `/api/v1/channels/${channelId}/messages`, {
      content,
      attachment_ids: attachmentIds,
      reply_to_id: replyToId,
    });
    // El mensaje entra por MESSAGE_CREATE, igual que el de cualquier otra persona.
  },

  notifyTyping(channelId) {
    sendCommand({ t: "TYPING", d: { channel_id: channelId } });
  },

  async loadExpressions() {
    try {
      set({ expressions: await api<CustomEmoji[]>("GET", "/api/v1/expressions") });
    } catch {
      // Sin emojis propios la aplicación funciona igual: no es motivo de error.
    }
  },

  /**
   * Deja el canal al día hasta el último mensaje que hay cargado.
   * El contador se apaga aquí sin esperar a la instancia —la barra lateral tiene
   * que responder al instante—, y READ_UPDATE lo confirma para las demás pestañas.
   */
  /**
   * Deja constancia de algo que ha pasado y lo asoma en pantalla.
   *
   * Todo lo que avisa pasa por aquí: así el historial no se queda a medias y
   * añadir un aviso nuevo no obliga a tocar la interfaz.
   */
  pushNotice(input) {
    const notice: Notice = {
      id: crypto.randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      at: Date.now(),
      read: false,
      target: input.target,
    };
    const notices = addNotice(get().notices, notice);
    saveNotices(notices);
    set({ notices });
  },

  readNotices() {
    const notices = get().notices.map((notice) => (notice.read ? notice : { ...notice, read: true }));
    saveNotices(notices);
    set({ notices });
  },

  clearNotices() {
    saveNotices([]);
    set({ notices: [] });
  },
  markRead(channelId) {
    const state = get();
    const list = state.messages[channelId];
    const last = list?.[list.length - 1];
    if (!last) return;
    if (state.lastRead[channelId] === last.id) return;

    set({
      lastRead: { ...state.lastRead, [channelId]: last.id },
      unread: { ...state.unread, [channelId]: { count: 0, mentions: 0 } },
    });
    void api("POST", `/api/v1/channels/${channelId}/read`, { message_id: last.id }).catch(() => {
      // Sin red se queda leído en local; al reconectar, el bootstrap manda.
    });
  },

  /**
   * Como `markRead`, pero sirve para un canal que nunca se ha abierto.
   *
   * `markRead` marca "hasta el último mensaje CARGADO", así que en un canal sin
   * abrir no tenía nada que marcar y no hacía nada — un menú que se pulsa y no
   * pasa nada es peor que no tener el menú. Aquí se pide el último mensaje (uno
   * solo) y se marca hasta ahí.
   */
  async catchUp(channelId) {
    const state = get();
    if (state.messages[channelId]?.length) {
      state.markRead(channelId);
      return;
    }
    try {
      const [last] = await api<Message[]>("GET", `/api/v1/channels/${channelId}/messages?limit=1`);
      if (!last) return;
      set({
        lastRead: { ...get().lastRead, [channelId]: last.id },
        unread: { ...get().unread, [channelId]: { count: 0, mentions: 0 } },
      });
      await api("POST", `/api/v1/channels/${channelId}/read`, { message_id: last.id });
    } catch {
      // Sin red no se marca nada: el contador sigue como estaba, que es la verdad.
    }
  },

  setTuner: (open) => set({ tuner: open }),
  setPref(key, value) {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    applyPrefs(prefs);
    localStorage.setItem(`distop.${key}`, String(value));

    // Un idioma nuevo puede no tener su diccionario aún; mientras baja se ve español.
    if (key === "locale") ensureLocale(value as Locale);

    // Tema e idioma acompañan a la persona entre dispositivos; escala y densidad
    // son de este dispositivo y se quedan en su almacenamiento local.
    if (get().user && (key === "theme" || key === "locale"))
      void api("PATCH", "/api/v1/users/me", { [key]: value });
  },
}));

/** Traducir fuera de React: el store avisa, y un aviso en inglés fijo sería peor. */
function mensaje(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(useStore.getState().prefs.locale, key, vars);
}

/* ── el gateway alimenta el estado ─────────────────────────────────── */

onStatus((status) => {
  const anterior = useStore.getState().status;
  useStore.setState({ status });
  if (status !== "online") void setDesktopAvailabilityStatus(false);
  /* Solo los dos bordes: perder el servidor y recuperarlo. Avisar de cada
     intento de reconexión sería ruido en mitad de un problema. */
  if (anterior === "online" && status === "offline") {
    useStore.getState().pushNotice({
      kind: "instance",
      title: mensaje("notice.offlineTitle"),
      body: mensaje("notice.offlineBody"),
    });
  }
  if (anterior !== "online" && anterior !== "connecting" && status === "online") {
    useStore.getState().pushNotice({
      kind: "instance",
      title: mensaje("notice.onlineTitle"),
      body: mensaje("notice.onlineBody"),
    });
  }
});

onEvent((event: ServerEvent) => {
  const state = useStore.getState();

  switch (event.t) {
    case "READY": {
      useStore.setState({
        user: event.d.user,
        communities: event.d.communities,
        instance: event.d.instance,
      });
      if (instanceBase) rememberCommunities(instanceBase, event.d.communities);
      void setDesktopAvailabilityStatus(true);
      configureVoice(event.d.user.id, iceServers);

      /* A TODAS las comunidades, no solo a la abierta: si solo llegaran los
         mensajes de la que estás mirando, el resto de la barra jamás se
         encendería y habría que entrar una por una para descubrir que hay algo.
         La instancia sigue filtrando por canal, así que esto no enseña nada que
         no se pudiera ver. */
      for (const community of event.d.communities) sendCommand({ t: "SUBSCRIBE", d: { community_id: community.id } });
      void useStore.getState().loadExpressions();

      // Tras reconectar hay que refrescar lo que se perdió mientras no había socket.
      const active = state.activeCommunityId;
      if (active) void useStore.getState().openCommunity(active);
      // Y volver a anunciarse en la llamada: el servidor te dio por ido al caerse
      // el socket, y quien quedara dentro seguiría hablándole a una conexión muerta.
      resumeVoice();
      return;
    }

    case "MESSAGE_CREATE": {
      const message = event.d;
      const list = state.messages[message.channel_id];

      /* Un canal sin abrir no guarda mensajes, pero sí tiene que contar: si no,
         el único canal que avisa es el que ya estás mirando. */
      if (list && !list.some((m) => m.id === message.id)) {
        useStore.setState({
          messages: { ...state.messages, [message.channel_id]: [...list, message] },
          typing: {
            ...state.typing,
            [message.channel_id]: Object.fromEntries(
              Object.entries(state.typing[message.channel_id] ?? {}).filter(([id]) => id !== message.author_id),
            ),
          },
        });
      } else if (list) {
        return; // duplicado
      }

      if (message.author_id === state.user?.id) return;

      // "Lo estoy viendo" es tener el canal abierto Y la ventana delante. Con la
      // pestaña en segundo plano el mensaje sigue sin leerse, aunque el canal
      // esté seleccionado.
      const looking = state.activeChannelId === message.channel_id && !document.hidden;
      if (looking) {
        useStore.getState().markRead(message.channel_id);
        return;
      }

      const mention = mentionsUser(message.content, state.user?.id ?? "") || message.mentions_everyone;
      const previous = state.unread[message.channel_id] ?? { count: 0, mentions: 0 };
      useStore.setState({
        channelOwner: { ...state.channelOwner, [message.channel_id]: message.community_id },
        unread: {
          ...state.unread,
          [message.channel_id]: {
            count: previous.count + 1,
            mentions: previous.mentions + (mention ? 1 : 0),
          },
        },
      });

      const data = state.data[message.community_id];
      const channel = data?.channels.find((c) => c.id === message.channel_id);
      const author = data?.members.find((m) => m.user.id === message.author_id);
      notify({
        title: channel ? `#${channel.name}` : (data?.community.name ?? ""),
        body: `${author?.nickname ?? author?.user.display_name ?? "…"}: ${message.content || "…"}`,
        tag: message.channel_id,
        mention,
        level: state.prefs.notify,
        sound: state.prefs.sounds,
        onClick: () => void useStore.getState().openChannel(message.channel_id),
      });

      /* El mismo criterio que la notificación del sistema: si tienes puesto
         «solo menciones», el historial tampoco se llena de todo lo demás. */
      if (state.prefs.notify === "all" || mention) {
        useStore.getState().pushNotice({
          kind: mention ? "mention" : "message",
          title: channel ? `#${channel.name}` : (data?.community.name ?? ""),
          body: `${author?.nickname ?? author?.user.display_name ?? "…"}: ${message.content || "…"}`,
          target: { channelId: message.channel_id, communityId: message.community_id },
        });
      }
      return;
    }

    case "MESSAGE_UPDATE": {
      const list = state.messages[event.d.channel_id];
      if (!list) return;
      useStore.setState({
        messages: {
          ...state.messages,
          [event.d.channel_id]: list.map((m) => (m.id === event.d.id ? event.d : m)),
        },
      });
      return;
    }

    case "MESSAGE_DELETE": {
      const list = state.messages[event.d.channel_id];
      if (!list) return;
      useStore.setState({
        messages: { ...state.messages, [event.d.channel_id]: list.filter((m) => m.id !== event.d.id) },
      });
      return;
    }

    case "REACTION_UPDATE": {
      const list = state.messages[event.d.channel_id];
      if (!list) return;
      useStore.setState({
        messages: {
          ...state.messages,
          [event.d.channel_id]: list.map((m) => (m.id === event.d.message_id ? { ...m, reactions: event.d.reactions } : m)),
        },
      });
      return;
    }

    case "VOICE_STATE_UPDATE": {
      useStore.setState({ voice: { ...state.voice, [event.d.channel_id]: event.d.states } });
      // Si es la sala donde estoy, hay que abrir, rehacer o cerrar conexiones.
      // Va la hora de entrada, no solo el id: al recargar una pestaña el id sigue
      // siendo el mismo y sin esa fecha nadie sabría que hay que reconectar.
      void syncPeers(event.d.channel_id, event.d.states);
      return;
    }

    case "VOICE_JOIN_RESULT": {
      if (event.d.outcome === "closed" || event.d.outcome === "denied") {
        rejectVoiceJoin(event.d.channel_id, event.d.outcome);
      }
      return;
    }

    /* ── reuniones ─────────────────────────────────────────────────────
       Los seis eventos son de reemplazo, no de delta: cada uno trae el valor
       completo de lo suyo. Es a propósito — una reunión donde la sala de espera
       se reconstruye a base de altas y bajas queda desincronizada para siempre
       en cuanto se pierde un mensaje, y quien se quedó fuera no aparece. */

    case "MEETING_UPDATE": {
      useStore.setState({ meetings: { ...state.meetings, [event.d.channel_id]: event.d } });
      /* Terminada o cancelada no hay a quién admitir ni turno que repartir: se
         limpia para que la interfaz no enseñe una cola de una reunión cerrada. */
      if (event.d.state === "ENDED" || event.d.state === "CANCELLED") {
        if (currentChannel() === event.d.channel_id) leaveVoice();
        useStore.setState({
          lobby: { ...state.lobby, [event.d.channel_id]: [] },
          floor: { ...state.floor, [event.d.channel_id]: null },
          meetingWaiting: { ...state.meetingWaiting, [event.d.channel_id]: false },
        });
      }
      return;
    }

    /* Solo lo recibo yo, y solo sobre mí. `admitted:false` llega tanto al
       ponerse a esperar como al ser rechazado: el servidor no los distingue a
       propósito, para no publicar a quién culpar. Aquí tampoco se inventa la
       diferencia — se dice "estás fuera", que es lo cierto en ambos casos. */
    case "MEETING_WAITING": {
      useStore.setState({
        meetingWaiting: { ...state.meetingWaiting, [event.d.channel_id]: !event.d.admitted },
      });
      return;
    }

    case "MEETING_LOBBY": {
      useStore.setState({ lobby: { ...state.lobby, [event.d.channel_id]: event.d.waiting } });
      return;
    }

    case "MEETING_ROLE": {
      useStore.setState({ meetingRole: { ...state.meetingRole, [event.d.meeting_id]: event.d.role } });
      return;
    }

    case "RECORDING_UPDATE": {
      useStore.setState({ recording: { ...state.recording, [event.d.channel_id]: event.d.recording } });
      /* El módulo de grabación decide si le toca: arrancar la captura cuando la
         instancia confirma mi aviso, o cortarla si un moderador la marcó caída. */
      onRecordingUpdate(event.d.channel_id, event.d.recording, state.user?.id);
      return;
    }

    case "MEETING_FLOOR": {
      useStore.setState({ floor: { ...state.floor, [event.d.channel_id]: event.d.user_id } });
      return;
    }

    case "VIDEO_BUDGET": {
      useStore.setState({ budget: { ...state.budget, [event.d.channel_id]: event.d } });
      return;
    }

    /* La sala de la carrera llega entera: quién está apuntado, qué mundo, y la
       semilla en cuanto arranca. Con eso cada cliente calcula la misma carrera
       sin que la instancia simule nada. */
    case "RACE_UPDATE": {
      useStore.setState({ races: { ...state.races, [event.d.channel_id]: event.d.lobby } });
      return;
    }

    case "VOICE_SIGNAL": {
      void handleSignal(event.d.from_user_id, event.d.payload);
      return;
    }

    /* Un sonido de la tabla. Llega el id, no el audio: el archivo se pide a la
       instancia y se guarda decodificado, asi que pulsarlo diez veces cuesta una
       sola descarga. A quien esta ensordecido el servidor ya no se lo manda. */
    case "VOICE_SOUND": {
      // El servidor emite a todas las sesiones de una persona. Solo la pestaña
      // que está realmente en esta sala debe reproducirlo.
      if (currentChannel() !== event.d.channel_id) return;
      void (async () => {
        let sonido = useStore.getState().expressions.find((e) => e.id === event.d.sound_id && e.kind === "sound");
        if (!sonido) {
          // Cubre una reconexión o un EMOJI_UPDATE que llegó justo después: el
          // evento no se pierde solo porque el catálogo local iba un paso atrás.
          await useStore.getState().loadExpressions();
          sonido = useStore.getState().expressions.find((e) => e.id === event.d.sound_id && e.kind === "sound");
        }
        if (currentChannel() !== event.d.channel_id) return;
        if (!sonido) {
          setSoundError("not_available");
          return;
        }

        const result = await playClip(sonido.url);
        if (currentChannel() !== event.d.channel_id) return;
        if (result.ok) setSoundError(null);
        else if (result.reason !== "deafened") setSoundError(result.reason);
      })();
      return;
    }

    case "VOICE_SOUND_ERROR": {
      if (currentChannel() === event.d.channel_id) setSoundError(event.d.reason);
      return;
    }

    case "TYPING_START": {
      if (event.d.user_id === state.user?.id) return;
      useStore.setState({
        typing: {
          ...state.typing,
          [event.d.channel_id]: { ...(state.typing[event.d.channel_id] ?? {}), [event.d.user_id]: event.d.until },
        },
      });
      ensureTypingSweep();
      return;
    }

    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      const channels = data.channels.some((c) => c.id === event.d.id)
        ? data.channels.map((c) => (c.id === event.d.id ? event.d : c))
        : [...data.channels, event.d];
      useStore.setState({ data: { ...state.data, [event.d.community_id]: { ...data, channels } } });
      return;
    }

    case "CHANNEL_DELETE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: {
          ...state.data,
          [event.d.community_id]: { ...data, channels: data.channels.filter((c) => c.id !== event.d.id) },
        },
        activeChannelId: state.activeChannelId === event.d.id ? null : state.activeChannelId,
      });
      return;
    }

    case "CATEGORY_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: { ...state.data, [event.d.community_id]: { ...data, categories: event.d.categories } },
      });
      return;
    }

    case "COMMUNITY_UPDATE": {
      const data = state.data[event.d.id];
      useStore.setState({
        communities: state.communities.map((c) => (c.id === event.d.id ? event.d : c)),
        ...(data ? { data: { ...state.data, [event.d.id]: { ...data, community: event.d } } } : {}),
      });
      return;
    }

    case "MEMBER_JOIN":
    case "MEMBER_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      /* Que alguien acepte tu invitación es la razón por la que la mandaste:
         enterarte al volver, y no solo si mirabas la lista, es el mínimo. */
      if (event.t === "MEMBER_JOIN" && event.d.user.id !== state.user?.id) {
        useStore.getState().pushNotice({
          kind: "member",
          title: mensaje("notice.memberTitle"),
          body: mensaje("notice.memberBody", {
            name: event.d.nickname ?? event.d.user.display_name,
            community: data.community.name,
          }),
          target: { communityId: event.d.community_id },
        });
      }
      const members = data.members.some((m) => m.user.id === event.d.user.id)
        ? data.members.map((m) => (m.user.id === event.d.user.id ? event.d : m))
        : [...data.members, event.d];
      useStore.setState({ data: { ...state.data, [event.d.community_id]: { ...data, members } } });
      return;
    }

    case "COMMUNITY_DELETE": {
      // Dejó de existir para TODOS los conectados, no solo para quien la borró.
      useStore.getState().removeCommunity(event.d.community_id);
      return;
    }

    case "MEMBER_LEAVE": {
      // Si el que sale soy yo, la comunidad desaparece de mi lista.
      if (event.d.user_id === state.user?.id) {
        const { [event.d.community_id]: _removed, ...rest } = state.data;
        useStore.setState({
          communities: state.communities.filter((c) => c.id !== event.d.community_id),
          data: rest,
          activeCommunityId: state.activeCommunityId === event.d.community_id ? null : state.activeCommunityId,
          activeChannelId: state.activeCommunityId === event.d.community_id ? null : state.activeChannelId,
        });
        return;
      }
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: {
          ...state.data,
          [event.d.community_id]: {
            ...data,
            members: data.members.filter((m) => m.user.id !== event.d.user_id),
            online: data.online.filter((id) => id !== event.d.user_id),
          },
        },
      });
      return;
    }

    case "PRESENCE_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: { ...state.data, [event.d.community_id]: { ...data, online: event.d.online } },
      });
      return;
    }

    case "GAME_PRESENCE_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: { ...state.data, [event.d.community_id]: { ...data, game_presences: event.d.presences } },
      });
      return;
    }

    case "ROLE_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      const roles = data.roles.some((r) => r.id === event.d.id)
        ? data.roles.map((r) => (r.id === event.d.id ? event.d : r))
        : [...data.roles, event.d];
      useStore.setState({ data: { ...state.data, [event.d.community_id]: { ...data, roles } } });
      return;
    }

    /* Otra sesión mía leyó ese canal: aquí solo se apaga el contador. No se
       toca la línea de "mensajes nuevos" del canal abierto, porque estoy
       leyéndolo y moverla me borraría el sitio por donde iba. */
    case "READ_UPDATE": {
      useStore.setState({
        lastRead: { ...state.lastRead, [event.d.channel_id]: event.d.last_read_id },
        unread: { ...state.unread, [event.d.channel_id]: { count: 0, mentions: 0 } },
      });
      return;
    }

    case "EMOJI_UPDATE": {
      const data = state.data[event.d.community_id];
      useStore.setState({
        ...(data ? { data: { ...state.data, [event.d.community_id]: { ...data, emojis: event.d.emojis } } } : {}),
        // La lista plana se rehace entera: mezclar a mano lo de una comunidad
        // dentro de la mezcla de todas es justo donde aparecen los duplicados.
        expressions: [
          ...state.expressions.filter((e) => e.community_id !== event.d.community_id),
          ...event.d.emojis,
        ],
      });
      return;
    }

    /* Quien hospeda vació el historial (§28.4): fuera los mensajes, contadores
       y la línea de "nuevos" de esa comunidad. Canales, miembros y roles se
       quedan — fue una limpieza de disco, no un cierre. */
    case "MESSAGES_PURGED": {
      const data = state.data[event.d.community_id];
      const ids = new Set(data?.channels.map((c) => c.id) ?? []);
      for (const [channelId, owner] of Object.entries(state.channelOwner)) {
        if (owner === event.d.community_id) ids.add(channelId);
      }
      const wipe = <T,>(record: Record<string, T>, empty: T): Record<string, T> =>
        Object.fromEntries(Object.entries(record).map(([id, value]) => [id, ids.has(id) ? empty : value]));
      useStore.setState({
        messages: wipe(state.messages, []),
        hasMore: wipe(state.hasMore, false),
        unread: wipe(state.unread, { count: 0, mentions: 0 }),
        divider: wipe(state.divider, null),
      });
      return;
    }

    case "ROLE_DELETE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      useStore.setState({
        data: { ...state.data, [event.d.community_id]: { ...data, roles: data.roles.filter((r) => r.id !== event.d.id) } },
      });
      return;
    }
  }
});

/* Los indicadores de escritura caducan solos: si alguien cierra la pestaña a
   mitad de un mensaje, su "está escribiendo" no se queda para siempre. El
   barrido solo corre mientras alguien escribe: en reposo no hay ningún timer
   despierto (importa en el escritorio, donde una llamada desactiva el
   throttling y los intervalos corren a ritmo de primer plano). */
let typingSweep: ReturnType<typeof setInterval> | null = null;

function sweepTyping(): void {
  const { typing } = useStore.getState();
  const now = Date.now();
  let changed = false;
  let empty = true;
  const next: typeof typing = {};

  for (const [channelId, users] of Object.entries(typing)) {
    const alive = Object.fromEntries(Object.entries(users).filter(([, until]) => until > now));
    if (Object.keys(alive).length !== Object.keys(users).length) changed = true;
    if (Object.keys(alive).length > 0) empty = false;
    next[channelId] = alive;
  }
  if (changed) useStore.setState({ typing: next });
  if (empty && typingSweep) {
    clearInterval(typingSweep);
    typingSweep = null;
  }
}

function ensureTypingSweep(): void {
  typingSweep ??= setInterval(sweepTyping, 2000);
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const { prefs } = useStore.getState();
  if (prefs.theme === "system") applyPrefs(prefs);
});

/* ── el bulto sin leer, fuera de la aplicación ─────────────────────────
   El título de la pestaña es el único sitio donde el aviso sobrevive a tener la
   ventana tapada. Las menciones van entre paréntesis y el resto como punto,
   porque no es lo mismo "hay movimiento" que "te están hablando". */

function paintTitle(): void {
  const { unread } = useStore.getState();
  const totals = Object.values(unread).reduce(
    (acc, entry) => ({ count: acc.count + entry.count, mentions: acc.mentions + entry.mentions }),
    { count: 0, mentions: 0 },
  );

  const prefix = totals.mentions > 0 ? `(${totals.mentions}) ` : totals.count > 0 ? "• " : "";
  document.title = `${prefix}${BRAND.name}`;
}

/* unread se reemplaza por referencia en cada mutación que lo toca, así que el
   diff por identidad basta: el resto de setState (typing, presencias, voz…) ya
   no paga el reduce del título. */
useStore.subscribe((state, previous) => {
  if (state.unread !== previous.unread) paintTitle();
});

/* Volver a la ventana con el canal abierto delante es haberlo leído. Sin esto,
   el contador se queda encendido sobre mensajes que ya tienes a la vista. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  const { activeChannelId } = useStore.getState();
  if (activeChannelId) useStore.getState().markRead(activeChannelId);
});

/**
 * A qué está jugando alguien, mirando en las comunidades ya cargadas. Cota
 * inferior honesta, como `mutual` en la tarjeta de perfil: no se pregunta al
 * servidor por cada fila pintada.
 */
export function gameOf(data: Record<string, CommunityData>, userId: string): GamePresence | undefined {
  for (const community of Object.values(data)) {
    const found = community.game_presences?.find((presence) => presence.user_id === userId);
    if (found) return found;
  }
  return undefined;
}
