/**
 * Selector de pantalla para Electron (§15).
 * getDisplayMedia en Electron no trae selector propio: sin esta ventana,
 * "Compartir pantalla" se queda colgado esperando una elección que nunca
 * llega. Esta es una ventana modal con miniaturas reales de cada pantalla y
 * ventana, el mismo nivel de elección que da el selector del navegador.
 */
import { BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import { join } from "node:path";

export interface PickResult {
  source: Electron.DesktopCapturerSource;
  audio: boolean;
}

export async function pickSource(parent: BrowserWindow | null): Promise<PickResult | null> {
  const display = screen.getPrimaryDisplay().workAreaSize;
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: PickResult | null) => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners("picker-choose");
      ipcMain.removeAllListeners("picker-cancel");
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    const win = new BrowserWindow({
      width: Math.min(820, display.width - 40),
      height: Math.min(620, display.height - 40),
      ...(parent ? { parent, modal: true } : {}),
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      autoHideMenuBar: true,
      backgroundColor: "#0d0e12",
      title: "Compartir pantalla",
      webPreferences: {
        preload: join(__dirname, "picker-preload.js"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });

    ipcMain.once("picker-choose", (_event, sourceId: string, audio: boolean) => {
      const source = sources.find((s) => s.id === sourceId);
      settle(source ? { source, audio } : null);
    });
    ipcMain.once("picker-cancel", () => settle(null));
    win.on("closed", () => settle(null));

    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderHtml(sources))}`);
  });
}

function renderHtml(sources: Electron.DesktopCapturerSource[]): string {
  const items = sources.map((s) => ({
    id: s.id,
    name: s.name || "—",
    type: s.id.startsWith("screen:") ? "screen" : "window",
    thumb: s.thumbnail.isEmpty() ? "" : s.thumbnail.toDataURL(),
  }));
  // Los nombres vienen del sistema operativo (título de ventana ajena): nunca
  // se interpolan como HTML, solo como texto dentro de un JSON para <script>.
  const itemsJson = JSON.stringify(items).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    background: #0d0e12; color: #e8eaf2;
    font: 13px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif;
  }
  h1 { font-size: 15px; font-weight: 600; margin: 16px 20px 0; }
  .tabs { display: flex; gap: 8px; margin: 12px 20px 0; }
  .tab {
    background: transparent; border: 1px solid #272b36; color: #98a0b3;
    border-radius: 8px; padding: 6px 14px; font: inherit; cursor: pointer;
  }
  .tab.active { background: #1e2340; border-color: #7b90ff; color: #e8eaf2; }
  .grid {
    flex: 1; overflow-y: auto; display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    align-content: start;
    gap: 12px; padding: 14px 20px;
  }
  .card {
    display: flex; flex-direction: column;
    border: 2px solid #272b36; border-radius: 10px; background: #15171e;
    cursor: pointer; padding: 8px; text-align: left;
  }
  .card.selected { border-color: #7b90ff; background: #1e2340; }
  .thumb {
    width: 100%; aspect-ratio: 16 / 10; background: #0a0b0e;
    border-radius: 6px; object-fit: contain; display: block;
  }
  .name {
    margin-top: 6px; font-size: 12px; color: #e8eaf2; white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis;
  }
  .empty { color: #98a0b3; padding: 40px; text-align: center; grid-column: 1 / -1; }
  .audio { display: flex; align-items: center; gap: 8px; padding: 0 20px 14px; color: #98a0b3; }
  .actions { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 20px; border-top: 1px solid #272b36; }
  button.action {
    font: inherit; border-radius: 8px; padding: 8px 18px; cursor: pointer; border: 1px solid #272b36;
  }
  #cancel { background: transparent; color: #e8eaf2; }
  #share { background: #7b90ff; color: #0b0d16; border-color: #7b90ff; font-weight: 600; }
  #share:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
</head>
<body>
  <h1>Elige qué quieres compartir</h1>
  <div class="tabs">
    <button class="tab active" data-type="screen">Pantallas</button>
    <button class="tab" data-type="window">Ventanas</button>
  </div>
  <div class="grid" id="grid"></div>
  <label class="audio"><input type="checkbox" id="audio" checked> Compartir también el audio</label>
  <div class="actions">
    <button class="action" id="cancel">Cancelar</button>
    <button class="action" id="share" disabled>Compartir</button>
  </div>
<script>
(function () {
  var items = ${itemsJson};
  var grid = document.getElementById("grid");
  var shareBtn = document.getElementById("share");
  var selected = null;
  var activeType = "screen";

  function render() {
    grid.innerHTML = "";
    var visible = items.filter(function (i) { return i.type === activeType; });
    if (visible.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Nada que mostrar aquí.";
      grid.appendChild(empty);
      return;
    }
    visible.forEach(function (item) {
      var card = document.createElement("button");
      card.type = "button";
      card.className = "card" + (selected === item.id ? " selected" : "");
      var img = document.createElement("img");
      img.className = "thumb";
      img.src = item.thumb;
      var name = document.createElement("div");
      name.className = "name";
      name.textContent = item.name;
      card.appendChild(img);
      card.appendChild(name);
      card.addEventListener("click", function () {
        selected = item.id;
        shareBtn.disabled = false;
        render();
      });
      grid.appendChild(card);
    });
  }

  document.querySelectorAll(".tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      document.querySelectorAll(".tab").forEach(function (t) { t.classList.remove("active"); });
      tab.classList.add("active");
      activeType = tab.getAttribute("data-type");
      render();
    });
  });

  document.getElementById("cancel").addEventListener("click", function () {
    window.picker.cancel();
  });
  shareBtn.addEventListener("click", function () {
    if (!selected) return;
    window.picker.choose(selected, document.getElementById("audio").checked);
  });
  window.addEventListener("keydown", function (e) {
    if (e.key === "Escape") window.picker.cancel();
  });

  render();
})();
</script>
</body>
</html>`;
}
