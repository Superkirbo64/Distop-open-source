import { BrowserWindow, screen } from "electron";
import { join } from "node:path";

export interface VoiceOverlayParticipant {
  id: string;
  name: string;
  avatarUrl: string | null;
  speaking: boolean;
  muted: boolean;
}

export interface VoiceOverlayState {
  channelId: string | null;
  channelName: string;
  participants: VoiceOverlayParticipant[];
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanAvatar(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_048) return null;
  return /^(https?:\/\/|app:\/\/distop\/|data:image\/(?:png|jpe?g|webp|gif);base64,)/i.test(value)
    ? value
    : null;
}

function cleanState(raw: unknown): VoiceOverlayState {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const list = Array.isArray(source.participants) ? source.participants.slice(0, 24) : [];
  const participants = list.flatMap((item): VoiceOverlayParticipant[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const id = cleanText(value.id, 80);
    const name = cleanText(value.name, 80);
    if (!id || !name) return [];
    return [{
      id,
      name,
      avatarUrl: cleanAvatar(value.avatarUrl),
      speaking: value.speaking === true,
      muted: value.muted === true,
    }];
  });

  return {
    channelId: cleanText(source.channelId, 80) || null,
    channelName: cleanText(source.channelName, 80),
    participants,
  };
}

export interface VoiceOverlayHandle {
  update(raw: unknown): void;
  destroy(): void;
}

/**
 * Widget de llamada para Windows. Es otra ventana en vez de inyectarse dentro
 * del juego: así no toca procesos ajenos ni dispara anticheats. Funciona encima
 * de juegos en ventana o ventana sin bordes, que es también el modo compatible
 * documentado por Discord para su overlay.
 *
 * Nace con la primera llamada y muere al colgar (destroy): su renderer solo
 * existe mientras hay algo que mostrar.
 */
export function createVoiceOverlay(host: BrowserWindow): VoiceOverlayHandle {
  const overlay = new BrowserWindow({
    width: 284,
    height: 120,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    focusable: false,
    movable: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: join(__dirname, "voice-overlay-preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: false,
    },
  });

  overlay.setIgnoreMouseEvents(true);
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  overlay.webContents.on("will-navigate", (event) => event.preventDefault());
  void overlay.loadFile(join(__dirname, "..", "src", "voice-overlay.html"));

  let current: VoiceOverlayState = { channelId: null, channelName: "", participants: [] };

  const shouldShow = (): boolean =>
    Boolean(current.channelId && current.participants.length && (host.isMinimized() || !host.isVisible()));

  const place = (): void => {
    const display = screen.getDisplayMatching(host.getBounds());
    const { x, y, width, height } = display.workArea;
    const overlayHeight = Math.min(Math.max(80, 28 + current.participants.length * 54), Math.max(80, height - 72));
    overlay.setBounds({ x: x + 22, y: y + 48, width: Math.min(284, width - 44), height: overlayHeight });
  };

  const refresh = (): void => {
    if (overlay.isDestroyed()) return;
    if (!shouldShow()) {
      overlay.hide();
      return;
    }
    place();
    overlay.webContents.send("voice-overlay:state", current);
    overlay.showInactive();
  };

  // Al crearse en plena llamada, el primer update llega antes de que termine
  // loadFile y su webContents.send se perdería: al cargar se reenvía el último.
  overlay.webContents.on("did-finish-load", () => {
    overlay.webContents.send("voice-overlay:state", current);
  });

  /* Con nombre para poder quitarlos: el overlay se crea y destruye por llamada,
     y unos listeners anónimos sobre host/screen se acumularían en cada ciclo. */
  const onMinimize = (): void => {
    setTimeout(refresh, 120);
  };
  const onHide = refresh;
  const onRestore = (): void => overlay.hide();
  const onShow = (): void => overlay.hide();

  host.on("minimize", onMinimize);
  host.on("hide", onHide);
  host.on("restore", onRestore);
  host.on("show", onShow);
  screen.on("display-metrics-changed", refresh);

  const destroy = (): void => {
    host.off("minimize", onMinimize);
    host.off("hide", onHide);
    host.off("restore", onRestore);
    host.off("show", onShow);
    host.off("closed", destroy);
    screen.removeListener("display-metrics-changed", refresh);
    if (!overlay.isDestroyed()) overlay.destroy();
  };
  host.on("closed", destroy);

  return {
    update(raw: unknown): void {
      current = cleanState(raw);
      if (!overlay.isDestroyed()) {
        overlay.webContents.send("voice-overlay:state", current);
        refresh();
      }
    },
    destroy,
  };
}
