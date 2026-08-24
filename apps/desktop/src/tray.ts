/**
 * Bandeja del sistema (§15): cerrar la ventana no mata la app.
 * Con "Hospedar aquí" esto deja de ser comodidad y pasa a ser importante:
 * cerrar la ventana no debe apagar la comunidad de nadie sin avisar.
 */
import { BrowserWindow, Menu, Tray, app, nativeImage } from "electron";
import { join } from "node:path";

let tray: Tray | null = null;
let quitting = false;

export function setupTray(win: BrowserWindow): void {
  app.on("before-quit", () => {
    quitting = true;
  });

  const icon = nativeImage.createFromPath(join(__dirname, "..", "build", "tray.png"));
  tray = new Tray(icon);
  tray.setToolTip("Distop");

  const show = () => {
    win.show();
    win.focus();
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir Distop", click: show },
      { type: "separator" },
      {
        label: "Iniciar con Windows",
        type: "checkbox",
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
    ]),
  );

  tray.on("click", show);

  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    win.hide();
  });
}
