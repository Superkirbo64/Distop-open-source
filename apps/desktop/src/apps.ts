/**
 * Las tres aplicaciones dentro del cascarón (§15).
 * Distop, WhatsApp y Telegram son vistas hermanas del proceso principal, no
 * pestañas del cliente: el código web de Distop no sabe que las otras existen
 * y cada una corre en su propia sesión. Windows no deja añadir nada a su barra
 * de título, así que la franja para cambiar entre ellas la dibuja la app
 * (shell.html) y el sistema solo pinta encima sus tres botones.
 */
import { BrowserWindow, WebContentsView, session, shell } from "electron";
import { GUESTS, type Guest, type GuestId, type TabId, allowed } from "./apps-policy";

/** Permisos que estas webs usan de verdad; el resto se deniega sin preguntar. */
const GRANTED = new Set(["media", "notifications", "fullscreen", "clipboard-sanitized-write"]);

export interface AppViews {
  /** La vista del cliente: destino del preload, del IPC y del arranque. */
  distop: WebContentsView;
  show(id: TabId): void;
  /** Apaga un huésped: fuera de la ventana y su proceso renderer liberado. */
  disable(id: GuestId): void;
  layout(): void;
}

export function createAppViews(
  win: BrowserWindow,
  stripHeight: number,
  distopUrl: string,
  preload: string,
): AppViews {
  const views = new Map<TabId, WebContentsView>();

  const distop = new WebContentsView({
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // El throttling queda activo: los mensajes del WebSocket despiertan al
      // renderer igualmente. Solo durante una llamada el proceso principal lo
      // desactiva a mano (setBackgroundThrottling) para que el audio y los
      // medidores no se duerman mirando WhatsApp o con la ventana en bandeja.
    },
  });
  views.set("distop", distop);
  win.contentView.addChildView(distop);
  void distop.webContents.loadURL(distopUrl);

  const layout = (): void => {
    const size = win.getContentSize();
    const width = size[0] ?? 0;
    const height = size[1] ?? 0;
    // En fullscreen la vista tapa el shell entero, incluida su franja superior.
    const top = win.isFullScreen() ? 0 : stripHeight;
    const bounds = { x: 0, y: top, width, height: Math.max(0, height - top) };
    for (const view of views.values()) view.setBounds(bounds);
  };

  /** Los huéspedes se crean al primer clic: quien no los use no los carga nunca. */
  const create = (id: GuestId): WebContentsView => {
    const guest = GUESTS[id];
    hardenGuestSession(guest);

    const view = new WebContentsView({
      webPreferences: {
        partition: guest.partition,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    // Una web ajena nunca abre ventanas de nuestro proceso: los enlaces salen fuera.
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    view.webContents.on("will-navigate", (event, url) => {
      if (allowed(guest, url)) return;
      event.preventDefault();
      if (url.startsWith("https://")) void shell.openExternal(url);
    });

    views.set(id, view);
    win.contentView.addChildView(view);
    void view.webContents.loadURL(guest.url);
    return view;
  };

  let activeId: TabId = "distop";

  const show = (id: TabId): void => {
    const view = views.get(id) ?? (id === "distop" ? distop : create(id));
    activeId = id;
    for (const [key, other] of views) other.setVisible(key === id);
    layout();
    view.webContents.focus();
  };

  /* Apagar libera el proceso renderer completo del huésped. Su sesión
     (partition persist:) queda en disco: al reactivarlo se entra sin volver a
     vincular. La política de la partition no se toca: la próxima creación pasa
     por hardenGuestSession igual que la primera. */
  const disable = (id: GuestId): void => {
    const view = views.get(id);
    if (!view) return;
    views.delete(id);
    if (activeId === id) show("distop");
    win.contentView.removeChildView(view);
    view.webContents.close();
  };

  layout();
  return { distop, show, disable, layout };
}

function hardenGuestSession(guest: Guest): void {
  const guestSession = session.fromPartition(guest.partition);
  guestSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(GRANTED.has(permission));
  });
  // WhatsApp Web rechaza los navegadores que no reconoce, y el token Electron
  // (con el nombre de la app) sobra en la cadena: debajo es el mismo Chrome.
  guestSession.setUserAgent(guestSession.getUserAgent().replace(/\s(?:Distop|Electron)\/\S+/g, ""));
}
