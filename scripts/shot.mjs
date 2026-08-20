/**
 * Captura de la aplicación con un navegador de verdad.
 * Existe porque revisar la interfaz leyendo el código no vale: los fallos de
 * alineación, recorte y contraste solo se ven mirando. Chrome ya está instalado
 * en cualquier equipo de escritorio, y `ws` ya es dependencia del servidor, así
 * que esto no añade ni una descarga.
 *
 *   node scripts/shot.mjs <url> <salida.png> [ancho] [alto] [token]
 *
 * El token es opcional: con él se inyecta la sesión en localStorage antes de
 * cargar, que es la única forma de fotografiar lo que hay detrás del login.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const [url = "http://localhost:5000", out = "shot.png", width = "1440", height = "900", token = ""] =
  process.argv.slice(2);

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((path) => existsSync(path));

if (!CHROME) {
  console.error("No encontré Chrome ni Edge instalados.");
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), "distop-shot-"));
const browser = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`,
  // Micrófono y cámara falsos: sin esto no se puede fotografiar nada de voz,
  // porque getUserMedia se queda esperando un permiso que nadie va a dar.
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--hide-scrollbars",
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
]);

/* El puerto lo elige Chrome y lo anuncia por stderr; fijarlo a mano choca
   con cualquier otra sesión de depuración ya abierta. */
const endpoint = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("Chrome no anunció su puerto de depuración")), 20_000);
  browser.stderr.on("data", (chunk) => {
    const found = /ws:\/\/[^\s]+/.exec(String(chunk));
    if (!found) return;
    clearTimeout(timer);
    done(found[0]);
  });
});

let nextId = 1;
function connect(target) {
  const socket = new WebSocket(target);
  const pending = new Map();
  const events = new Map();

  socket.on("message", (raw) => {
    const message = JSON.parse(String(raw));
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message.result);
      pending.delete(message.id);
    }
    if (message.method && events.has(message.method)) events.get(message.method)();
  });

  return {
    ready: new Promise((done) => socket.once("open", done)),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((done) => pending.set(id, done));
    },
    once(method) {
      return new Promise((done) => events.set(method, done));
    },
    close: () => socket.close(),
  };
}

const chrome = connect(endpoint);
await chrome.ready;

const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
const list = await fetch(`http://${new URL(endpoint).host}/json/list`).then((r) => r.json());
const page = connect(list.find((t) => t.id === targetId).webSocketDebuggerUrl);
await page.ready;

await page.send("Page.enable");
await page.send("Emulation.setDeviceMetricsOverride", {
  width: Number(width),
  height: Number(height),
  deviceScaleFactor: 1,
  mobile: Number(width) < 900,
});

if (token) {
  // localStorage pertenece al origen, así que hay que estar en él antes de escribir.
  await page.send("Page.navigate", { url: new URL(url).origin });
  await page.once("Page.loadEventFired");
  await page.send("Runtime.evaluate", {
    expression: `localStorage.setItem("distop.session", ${JSON.stringify(JSON.stringify({ access_token: token, refresh_token: token }))})`,
  });
}

await page.send("Page.navigate", { url });
await page.once("Page.loadEventFired");
// Un respiro para las fuentes, el arranque de React y la primera petición.
await new Promise((r) => setTimeout(r, 2500));

/* Medir antes que opinar: con EVAL se ejecuta una expresión en la página y se
   imprime lo que devuelva. Para "está descentrado" no hace falta debate, hacen
   falta dos rectángulos. */
if (process.env.EVAL) {
  const { result } = await page.send("Runtime.evaluate", {
    expression: process.env.EVAL,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(result.value, null, 2));
}

/* HOVER="x,y" deja el ratón encima de ese punto antes de disparar. Un evento
   sintético desde la página no activa :hover; solo lo hace el ratón del propio
   navegador, así que esto tiene que pasar por CDP. */
if (process.env.HOVER) {
  const [x, y] = process.env.HOVER.split(",").map(Number);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
  await new Promise((r) => setTimeout(r, 450));
}

/* Recorte opcional "x,y,ancho,alto" con aumento: un icono descentrado por dos
   píxeles no se juzga en una captura de 1440 de ancho. */
const clip = process.env.CLIP?.split(",").map(Number);
const { data } = await page.send("Page.captureScreenshot", {
  format: "png",
  ...(clip?.length === 4 ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 6 } } : {}),
});
writeFileSync(out, Buffer.from(data, "base64"));
console.log(`captura: ${out} (${width}x${height})`);

page.close();
chrome.close();
browser.kill();
process.exit(0);
