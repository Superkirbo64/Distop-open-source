/**
 * Prueba de humo del APK en un emulador de verdad (shells.yml).
 *
 * Existe porque el navegador no es el teléfono: la app pasaba en Chrome
 * simulando Capacitor y en el móvil Explorar decía "algo falló". Aquí se abre
 * el APK instalado, se entra en su WebView por DevTools y se recorre lo que hace
 * una persona: crear el usuario, abrir Explorar y ver comunidades.
 *
 *   node scripts/apk-smoke.mjs <apk> [salida.png]
 *
 * Sin dependencias: WebSocket es global desde Node 22.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const [apk, shot = "apk-smoke.png"] = process.argv.slice(2);
const DIRECTORY = "https://distop-open-source.superkirbo64.deno.net/v1/explore?limit=50";
const adb = (...args) => execFileSync("adb", args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

adb("install", "-r", apk);
adb("shell", "am", "start", "-n", "com.distop.app/.MainActivity");

/* La WebView anuncia su DevTools en un socket abstracto con el pid del proceso:
   hay que esperar a que exista para poder reenviarlo a un puerto local. */
let socket = "";
for (let i = 0; i < 60 && !socket; i++) {
  await sleep(1000);
  socket = /@(webview_devtools_remote_\d+)/.exec(adb("shell", "cat", "/proc/net/unix"))?.[1] ?? "";
}
if (!socket) throw new Error("La WebView no abrió DevTools: ¿APK de depuración?");
adb("forward", "tcp:9222", `localabstract:${socket}`);

let target;
for (let i = 0; i < 30 && !target; i++) {
  await sleep(1000);
  const pages = await fetch("http://127.0.0.1:9222/json").then((r) => r.json()).catch(() => []);
  target = pages.find((p) => p.type === "page" && p.url.startsWith("http://localhost"));
}
if (!target) throw new Error("No apareció la página de la app en DevTools");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => ws.addEventListener("open", ok, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
  if (msg.method === "Runtime.exceptionThrown") console.log("EXCEPCIÓN:", msg.params.exceptionDetails.exception?.description?.split("\n")[0]);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error")
    console.log("console.error:", msg.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 300));
});
const send = (method, params = {}) =>
  new Promise((ok) => {
    const id = nextId++;
    pending.set(id, ok);
    ws.send(JSON.stringify({ id, method, params }));
  });
const run = async (expression) =>
  (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.value;

await send("Runtime.enable");
await sleep(3000);

console.log("WebView:", await run("navigator.userAgent"));
// La misma petición que hace Explorar, a pelo: si falla, aquí sale el error real.
console.log("Directorio desde la WebView:", await run(
  `fetch(${JSON.stringify(DIRECTORY)}, { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } })
     .then(async (r) => r.status + " " + (await r.text()).slice(0, 120))
     .catch((e) => "FALLO " + e.name + ": " + e.message)`,
));

console.log("Pantalla inicial:", await run("document.querySelector('h1')?.textContent"));
await run(`(() => {
  const input = document.querySelector("input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "Humo");
  input.dispatchEvent(new Event("input", { bubbles: true }));
})()`);
await sleep(300);
await run(`document.querySelector("form button[type=submit]").click()`);
await sleep(2500);
// Por el botón principal del aviso y no por su texto: el emulador no está en español.
await run(`void document.querySelector("dialog[open] .btn-primary")?.click()`);
await sleep(10000);

const explore = await run(`(() => {
  const main = document.querySelector("main[data-pane=main]");
  return { texto: main?.innerText.slice(0, 600) ?? "", tarjetas: main?.querySelectorAll("ul li").length ?? 0 };
})()`);
console.log("Explorar:", JSON.stringify(explore, null, 2));

const { data } = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(shot, Buffer.from(data, "base64"));
ws.close();

if (!explore || explore.tarjetas === 0 || /falló|failed|falhou/i.test(explore.texto)) {
  console.error("Explorar no enseña comunidades en el APK.");
  process.exit(1);
}
console.log("OK: el APK abre, crea el usuario y Explorar enseña comunidades.");
