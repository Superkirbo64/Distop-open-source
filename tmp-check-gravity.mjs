/**
 * Comprobación con navegadores de verdad: en gravedad, lo que otro transmite
 * es una ventana dentro de la sala, no el fondo. Crea dos invitados y una
 * comunidad de usar y tirar, y los borra al terminar.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const api = "http://localhost:5000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b, t) => {
  const r = await fetch(api + p, {
    method: "POST",
    headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: JSON.stringify(b ?? {}),
  });
  const x = await r.text();
  return x ? JSON.parse(x) : {};
};

const uno = await post("/api/v1/auth/guest", { display_name: "PruebaUno" });
const dos = await post("/api/v1/auth/guest", { display_name: "PruebaDos" });
const comunidad = await post("/api/v1/communities", { name: "Prueba ventana" }, uno.access_token);
const invitacion = await post(`/api/v1/communities/${comunidad.id}/invites`, {}, uno.access_token);
await post(`/api/v1/invites/${invitacion.code}/join`, {}, dos.access_token);
console.log("comunidad de prueba lista:", uno.user.username, dos.user.username);

async function limpiar() {
  await fetch(`${api}/api/v1/communities/${comunidad.id}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${uno.access_token}` },
  });
  for (const s of [uno, dos])
    await fetch(`${api}/api/v1/users/me`, {
      method: "DELETE",
      headers: { "content-type": "application/json", authorization: `Bearer ${s.access_token}` },
      body: JSON.stringify({ username: s.user.username }),
    });
  console.log("limpieza hecha");
}
process.on("uncaughtException", async (error) => {
  console.error(error);
  await limpiar();
  process.exit(1);
});

const CHROME = [
  `${process.env.ProgramFiles}/Google/Chrome/Application/chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}/Microsoft/Edge/Application/msedge.exe`,
  `${process.env.ProgramFiles}/Microsoft/Edge/Application/msedge.exe`,
].find((p) => existsSync(p));
const browser = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "distop-grav-"))}`,
  "--window-size=1280,820",
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--hide-scrollbars",
  "--no-first-run",
  "--disable-gpu",
  "about:blank",
]);
const endpoint = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("sin puerto de depuración")), 20_000);
  browser.stderr.on("data", (chunk) => {
    const found = /ws:\/\/[^\s]+/.exec(String(chunk));
    if (found) {
      clearTimeout(timer);
      done(found[0]);
    }
  });
});

let nextId = 1;
function connect(target) {
  const socket = new WebSocket(target);
  const pending = new Map();
  socket.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  return {
    ready: new Promise((done) => socket.once("open", done)),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((done) => pending.set(id, done));
    },
    close: () => socket.close(),
  };
}
const chrome = connect(endpoint);
await chrome.ready;

// Cada pestaña en su propio origen: mismo perfil de Chrome = mismo
// localStorage, y la segunda sesión pisaba a la primera.
async function abrir(token, origen) {
  const { result } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const lista = await fetch(`http://${new URL(endpoint).host}/json/list`).then((r) => r.json());
  const page = connect(lista.find((t) => t.id === result.targetId).webSocketDebuggerUrl);
  await page.ready;
  await page.send("Page.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 820, deviceScaleFactor: 1, mobile: false });
  await page.send("Page.navigate", { url: origen });
  await sleep(1500);
  await page.send("Runtime.evaluate", {
    expression: `localStorage.setItem("distop.session", ${JSON.stringify(JSON.stringify({ access_token: token, refresh_token: token }))})`,
  });
  await page.send("Page.navigate", { url: origen + "/" });
  await sleep(4000);
  return page;
}
const ev = async (page, expression) => {
  const { result } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) return { error: result.exceptionDetails.text };
  return result.result?.value;
};

const p1 = await abrir(uno.access_token, "http://localhost:5173");
const p2 = await abrir(dos.access_token, "http://[::1]:5173");

const ENTRAR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let canal = null;
  for (let i = 0; i < 30 && !canal; i++) {
    canal = [...document.querySelectorAll("button")].find(b => b.textContent.trim().startsWith("voz"));
    if (!canal) await sleep(500);
  }
  if (!canal) return "sin canal";
  canal.click();
  await sleep(2500);
  return "dentro";
})()`;
console.log("uno:", await ev(p1, ENTRAR), "· dos:", await ev(p2, ENTRAR));
await sleep(4000);

console.log("cámara de uno:", await ev(p1, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const boton = [...document.querySelectorAll("button")].find(b => /^Cámara$/.test(b.textContent.trim()));
  if (!boton) return "sin botón de cámara";
  boton.click();
  await sleep(3000);
  return "encendida";
})()`));
await sleep(3000);

console.log("gravedad de dos:", await ev(p2, `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const menu = [...document.querySelectorAll("main header button")].find(b => /Juegos/i.test(b.getAttribute("aria-label") || ""));
  if (!menu) return "sin botón de juegos";
  menu.click();
  await sleep(400);
  const item = [...document.querySelectorAll("[role=menuitem]")].find(i => /Gravedad/.test(i.textContent));
  if (!item) return "sin gravedad en el menú";
  item.click();
  await sleep(4000);
  const video = document.querySelector("main video");
  const sala = document.querySelector("main canvas");
  const caja = sala ? sala.getBoundingClientRect() : null;
  const ventana = video ? video.getBoundingClientRect() : null;
  return {
    hayVentana: !!video,
    sala: caja ? Math.round(caja.width) + "x" + Math.round(caja.height) : null,
    ventana: ventana ? Math.round(ventana.width) + "x" + Math.round(ventana.height) : null,
    pintando: video ? video.videoWidth + "x" + video.videoHeight : null,
    proporcionAncho: caja && ventana ? +(ventana.width / caja.width).toFixed(2) : null,
    centrada: caja && ventana ? Math.round((ventana.left + ventana.width / 2) - (caja.left + caja.width / 2)) : null,
  };
})()`));

// Dos capturas separadas: si las esferas se mueven y rebotan contra la
// ventana, no salen en el mismo sitio en las dos.
for (const [i, nombre] of [process.argv[2], process.argv[3]].entries()) {
  if (!nombre) continue;
  if (i > 0) await sleep(2500);
  const captura = await p2.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(nombre, Buffer.from(captura.result.data, "base64"));
  console.log("captura:", nombre);
}

await limpiar();
p1.close();
p2.close();
chrome.close();
browser.kill();
process.exit(0);
