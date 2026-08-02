/**
 * Estado de la aplicación.
 * El gateway es la fuente de la verdad en caliente: las acciones llaman a la API
 * y el estado se actualiza cuando vuelve el evento, así dos pestañas del mismo
 * usuario ven exactamente lo mismo.
 */
import { create } from "zustand";
import type {
  Category,
  Channel,
  Community,
  InstanceHealth,
  Member,
  Message,
  Role,
  SelfUser,
  ServerEvent,
  VoiceState,
} from "@distop/protocol";
import { api, getTokens, setTokens, type Tokens } from "./lib/api.ts";
import { connect, disconnect, onEvent, onStatus, sendCommand, type ConnectionStatus } from "./lib/gateway.ts";
import { detectLocale, type Locale } from "./i18n.ts";
import { configureVoice, handleSignal, syncPeers } from "./lib/voice.ts";

export type ThemeChoice = "light" | "dark" | "system";
export type Density = "compact" | "cozy";

export interface CommunityData {
  community: Community;
  categories: Category[];
  channels: Channel[];
  roles: Role[];
  members: Member[];
  online: string[];
  voice_states: VoiceState[];
  /** Permisos en la comunidad, como bitfield decimal. */
  permissions: string;
  /** Permisos ya resueltos canal por canal, con sus overwrites aplicados. */
  channel_permissions: Record<string, string>;
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
  motion: boolean;
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
  /** Quién está en cada canal de voz, por canal. */
  voice: Record<string, VoiceState[]>;
  /** Dirección pública de la instancia, para que los enlaces sirvan fuera de casa. */
  publicUrl: string;

  communities: Community[];
  data: Record<string, CommunityData>;
  messages: Record<string, Message[]>;
  hasMore: Record<string, boolean>;
  typing: Record<string, Record<string, number>>;

  activeCommunityId: string | null;
  activeChannelId: string | null;
  prefs: Prefs;

  boot: () => Promise<void>;
  authenticate: (path: string, body: unknown) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: (user: SelfUser) => void;

  openCommunity: (communityId: string) => Promise<void>;
  openChannel: (channelId: string) => Promise<void>;
  loadOlder: (channelId: string) => Promise<void>;
  send: (channelId: string, content: string, attachmentIds: string[], replyToId: string | null) => Promise<void>;
  notifyTyping: (channelId: string) => void;
  reloadCommunities: () => Promise<void>;

  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
}

function loadPrefs(): Prefs {
  const theme = (localStorage.getItem("distop.theme") as ThemeChoice | null) ?? "system";
  const scale = Number(localStorage.getItem("distop.scale") ?? 1) || 1;
  const density = (localStorage.getItem("distop.density") as Density | null) ?? "cozy";
  const accent = localStorage.getItem("distop.accent") ?? "";
  const radius = Number(localStorage.getItem("distop.radius") ?? 14) || 14;
  const font = (localStorage.getItem("distop.font") as FontChoice | null) ?? "default";
  const backdrop = (localStorage.getItem("distop.backdrop") as BackdropChoice | null) ?? "plain";
  const motion = localStorage.getItem("distop.motion") !== "false";
  return { theme, scale, density, accent, radius, font, backdrop, motion, locale: detectLocale() };
}

/**
 * El tema se aplica al documento, no a un contenedor: cubre diálogos y scrollbars.
 * Todo lo de aquí es gratis y reversible; no hay ninguna opción que dependa de
 * pagar, ni ninguna que se guarde para "una versión mejor" (§10).
 */
export function applyPrefs(prefs: Prefs): void {
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
  root.dataset.motion = prefs.motion ? "on" : "off";
}

const MESSAGE_PAGE = 50;

/** Se aprenden en /info y se aplican en READY, cuando ya se sabe quién soy. */
let iceServers: RTCIceServer[] = [];

export const useStore = create<State>()((set, get) => ({
  ready: false,
  user: null,
  status: "offline",
  instance: null,
  setup: null,
  voice: {},
  publicUrl: "",

  communities: [],
  data: {},
  messages: {},
  hasMore: {},
  typing: {},

  activeCommunityId: null,
  activeChannelId: null,
  prefs: loadPrefs(),

  async boot() {
    applyPrefs(get().prefs);

    // Se pregunta siempre, antes que nada: una instancia sin dueño enseña la
    // puesta en marcha, no un formulario de acceso a un sitio que es tuyo.
    try {
      const info = await api<{
        setup_required: boolean;
        setup_requires_code: boolean;
        ice_servers: RTCIceServer[];
        public_url: string;
      }>("GET", "/api/v1/info");
      set({ setup: { required: info.setup_required, requiresCode: info.setup_requires_code }, publicUrl: info.public_url });
      iceServers = info.ice_servers ?? [];
    } catch {
      // Instancia inalcanzable: el propio cliente lo dirá al intentar entrar.
    }

    if (!getTokens()) {
      set({ ready: true });
      return;
    }
    try {
      const user = await api<SelfUser>("GET", "/api/v1/users/me");
      set({ user, ready: true });
      connect();
    } catch {
      setTokens(null);
      set({ ready: true, user: null });
    }
  },

  async authenticate(path, body) {
    const result = await api<Tokens & { user: SelfUser }>("POST", path, body);
    setTokens({ access_token: result.access_token, refresh_token: result.refresh_token });
    // Con alguien dentro, la instancia deja de estar sin dueño.
    set({ user: result.user, setup: { required: false, requiresCode: false } });
    if (result.user.theme !== "system") {
      const prefs = { ...get().prefs, theme: result.user.theme as ThemeChoice };
      set({ prefs });
      applyPrefs(prefs);
    }
    connect();
  },

  async logout() {
    try {
      await api("POST", "/api/v1/auth/logout");
    } catch {
      // Cerrar sesión en local no puede depender de que la instancia responda.
    }
    disconnect();
    setTokens(null);
    set({ user: null, communities: [], data: {}, messages: {}, activeCommunityId: null, activeChannelId: null });
  },

  refreshUser(user) {
    set({ user });
  },

  async reloadCommunities() {
    set({ communities: await api<Community[]>("GET", "/api/v1/communities") });
  },

  async openCommunity(communityId) {
    set({ activeCommunityId: communityId });
    sendCommand({ t: "SUBSCRIBE", d: { community_id: communityId } });

    const data = await api<CommunityData>("GET", `/api/v1/communities/${communityId}/bootstrap`);
    const voice: Record<string, VoiceState[]> = { ...get().voice };
    for (const channel of data.channels) if (channel.kind === "voice") voice[channel.id] = [];
    for (const state of data.voice_states) voice[state.channel_id] = [...(voice[state.channel_id] ?? []), state];
    set((state) => ({ data: { ...state.data, [communityId]: data }, voice }));

    const first = data.channels.find((channel) => channel.kind !== "voice") ?? data.channels[0];
    if (first) await get().openChannel(first.id);
    else set({ activeChannelId: null });
  },

  async openChannel(channelId) {
    set({ activeChannelId: channelId });
    if (get().messages[channelId]) return;

    const page = await api<Message[]>("GET", `/api/v1/channels/${channelId}/messages?limit=${MESSAGE_PAGE}`);
    set((state) => ({
      messages: { ...state.messages, [channelId]: page },
      hasMore: { ...state.hasMore, [channelId]: page.length === MESSAGE_PAGE },
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

  setPref(key, value) {
    const prefs = { ...get().prefs, [key]: value };
    set({ prefs });
    applyPrefs(prefs);
    localStorage.setItem(`distop.${key}`, String(value));

    // Tema e idioma acompañan a la persona entre dispositivos; escala y densidad
    // son de este dispositivo y se quedan en su almacenamiento local.
    if (get().user && (key === "theme" || key === "locale"))
      void api("PATCH", "/api/v1/users/me", { [key]: value });
  },
}));

/* ── el gateway alimenta el estado ─────────────────────────────────── */

onStatus((status) => useStore.setState({ status }));

onEvent((event: ServerEvent) => {
  const state = useStore.getState();

  switch (event.t) {
    case "READY": {
      useStore.setState({
        user: event.d.user,
        communities: event.d.communities,
        instance: event.d.instance,
      });
      configureVoice(event.d.user.id, iceServers);
      // Tras reconectar hay que rehacer la suscripción y refrescar lo perdido.
      const active = state.activeCommunityId;
      if (active) void useStore.getState().openCommunity(active);
      return;
    }

    case "MESSAGE_CREATE": {
      const list = state.messages[event.d.channel_id];
      if (!list) return; // canal aún no abierto: se cargará entero al abrirlo
      if (list.some((m) => m.id === event.d.id)) return;
      useStore.setState({
        messages: { ...state.messages, [event.d.channel_id]: [...list, event.d] },
        typing: {
          ...state.typing,
          [event.d.channel_id]: Object.fromEntries(
            Object.entries(state.typing[event.d.channel_id] ?? {}).filter(([id]) => id !== event.d.author_id),
          ),
        },
      });
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
      // Si es la sala donde estoy, hay que abrir o cerrar conexiones con los pares.
      void syncPeers(
        event.d.channel_id,
        event.d.states.map((s) => s.user_id),
      );
      return;
    }

    case "VOICE_SIGNAL": {
      void handleSignal(event.d.from_user_id, event.d.payload);
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
      const members = data.members.some((m) => m.user.id === event.d.user.id)
        ? data.members.map((m) => (m.user.id === event.d.user.id ? event.d : m))
        : [...data.members, event.d];
      useStore.setState({ data: { ...state.data, [event.d.community_id]: { ...data, members } } });
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

    case "ROLE_UPDATE": {
      const data = state.data[event.d.community_id];
      if (!data) return;
      const roles = data.roles.some((r) => r.id === event.d.id)
        ? data.roles.map((r) => (r.id === event.d.id ? event.d : r))
        : [...data.roles, event.d];
      useStore.setState({ data: { ...state.data, [event.d.community_id]: { ...data, roles } } });
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
   mitad de un mensaje, su "está escribiendo" no se queda para siempre. */
setInterval(() => {
  const { typing } = useStore.getState();
  const now = Date.now();
  let changed = false;
  const next: typeof typing = {};

  for (const [channelId, users] of Object.entries(typing)) {
    const alive = Object.fromEntries(Object.entries(users).filter(([, until]) => until > now));
    if (Object.keys(alive).length !== Object.keys(users).length) changed = true;
    next[channelId] = alive;
  }
  if (changed) useStore.setState({ typing: next });
}, 2000);

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  const { prefs } = useStore.getState();
  if (prefs.theme === "system") applyPrefs(prefs);
});
