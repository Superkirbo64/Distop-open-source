/**
 * Prueba de una llamada de verdad, entre dos navegadores.
 * Los tests de node cubren la señalización del servidor, pero la parte que se
 * rompe —la negociación WebRTC entre dos clientes— solo se ve levantando dos
 * navegadores y mirando en qué estado se queda la conexión de cada par.
 *
 *   node scripts/voice-check.mjs [url]
 *
 * Chrome entra con micrófono y cámara falsos, así que no pide permisos ni
 * necesita hardware. Deja los dos usuarios invitados que crea: son de usar y
 * tirar y los borra al terminar.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const base = process.argv[2] ?? "http://localhost:5000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CHROME = [
  `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
  `${process.env["ProgramFiles(x86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
  "/usr/bin/google-chrome",
].find((p) => existsSync(p));
if (!CHROME) throw new Error("sin Chrome ni Edge");

/* ── sesiones de prueba ──────────────────────────────────────────────── */

async function post(path, body, token) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
  // Un 204 no trae cuerpo: pedirle JSON revienta la limpieza del final.
  const texto = await res.text();
  return texto ? JSON.parse(texto) : {};
}

const anfitrion = await post("/api/v1/auth/recover", { username: process.env.HOST_USER ?? "kirbo" });
if (!anfitrion.access_token) throw new Error("no pude entrar como anfitrión: " + JSON.stringify(anfitrion));

const comunidades = await fetch(`${base}/api/v1/communities`, {
  headers: { authorization: `Bearer ${anfitrion.access_token}` },
}).then((r) => r.json());
const comunidad = comunidades[0];
const invitacion = await post(`/api/v1/communities/${comunidad.id}/invites`, {}, anfitrion.access_token);

const gente = [];
for (const nombre of ["PruebaUno", "PruebaDos"]) {
  const sesion = await post("/api/v1/auth/guest", { display_name: nombre });
  await post(`/api/v1/invites/${invitacion.code}/join`, {}, sesion.access_token);
  gente.push(sesion);
}
console.log(`comunidad: ${comunidad.name} · dos invitados dentro`);

/* ── navegador ───────────────────────────────────────────────────────── */

const browser = spawn(CHROME, [
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "distop-voz-"))}`,
  "--window-size=1280,900",
  // Micrófono y cámara de mentira: ni permisos ni hardware.
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  // Con SHARE=pantalla se prueba getDisplayMedia, que no pasa por la cámara
  // falsa: elige origen solo, sin el diálogo que en automático nadie pulsa.
  "--auto-select-desktop-capture-source=Entire screen",
  "--auto-accept-this-tab-capture",
  "--disable-gpu",
  "about:blank",
]);

const endpoint = await new Promise((done, fail) => {
  const timer = setTimeout(() => fail(new Error("Chrome no anunció su puerto")), 20_000);
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

async function abrirPagina(token) {
  const { result } = await chrome.send("Target.createTarget", { url: "about:blank" });
  const lista = await fetch(`http://${new URL(endpoint).host}/json/list`).then((r) => r.json());
  const page = connect(lista.find((t) => t.id === result.targetId).webSocketDebuggerUrl);
  await page.ready;
  await page.send("Page.enable");

  await page.send("Page.navigate", { url: new URL(base).origin });
  await sleep(1200);
  await page.send("Runtime.evaluate", {
    expression: `localStorage.setItem("distop.session", ${JSON.stringify(JSON.stringify({ access_token: token, refresh_token: token }))})`,
  });
  await page.send("Page.navigate", { url: base });
  await sleep(3500);
  return page;
}

async function evaluar(page, expression) {
  const { result } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  return result.result?.value;
}

const paginas = [];
for (const sesion of gente) paginas.push(await abrirPagina(sesion.access_token));

/** Vuelve a cargar una pestaña, como quien pulsa F5 en mitad de una llamada. */
async function recargar(page) {
  await page.send("Page.navigate", { url: base });
  await sleep(4000);
}

/** Entra al canal de voz pulsando lo mismo que pulsaría una persona. */
const ENTRAR = `(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const canal = [...document.querySelectorAll('[data-pane="sidebar"] button')].find(b => /voz/i.test(b.textContent));
  if (!canal) return 'sin canal de voz';
  canal.click();
  await sleep(1000);
  const entrar = [...document.querySelectorAll('button')].find(b => /entrar a la voz/i.test(b.textContent));
  if (!entrar) return 'sin botón de entrar';
  entrar.click();
  await sleep(1500);
  return 'dentro';
})()`;

for (const page of paginas) console.log("entrar:", await evaluar(page, ENTRAR));

// Margen para que ICE termine: en la misma máquina son milisegundos, pero entre
// redes distintas la negociación tarda.
await sleep(9000);

/* La prueba que de verdad importa ahora: ¿me llega la VOZ del otro?
   El micrófono falso de Chrome emite un pitido intermitente, así que se vigila
   unos segundos y basta con pillarlo sonando una vez. Esto recorre el camino
   entero —capturar, codificar, socket, instancia, socket, decodificar— sin
   negociar nada entre navegadores. */
const ESCUCHAR = (otro) => `(async () => {
  let oido = false;
  for (let i = 0; i < 40; i++) {
    const f = [...document.querySelectorAll('figure[data-user]')]
      .find(f => f.querySelector('figcaption')?.innerText.startsWith(${JSON.stringify(otro)}));
    if (f?.dataset.speaking === 'true') { oido = true; break; }
    await new Promise(r => setTimeout(r, 250));
  }
  return oido;
})()`;

const mudos = [];
for (const [i, page] of paginas.entries()) {
  const otro = gente[1 - i].user.display_name;
  const oye = await evaluar(page, ESCUCHAR(otro));
  console.log(`voz: navegador ${i + 1} ${oye ? "oye" : "NO oye"} a ${otro}`);
  if (!oye) mudos.push(`el navegador ${i + 1} no recibe la voz de ${otro}`);
}

/* Ensordecer y volver a oír (§9.4).
   El estado de voz lo guarda la instancia, y quien deja de reenviar el audio es
   ella: si al quitarse el ensordecimiento el cliente no se lo cuenta, la sala se
   queda muda para siempre aunque el botón diga lo contrario. Solo se ve
   probando el ciclo entero contra una llamada de verdad. */
const PULSAR = (texto) => `(async () => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(texto)});
  if (!b) return 'sin botón';
  b.click();
  await new Promise(r => setTimeout(r, 1500));
  return 'pulsado';
})()`;

{
  const [page] = paginas;
  const otro = gente[1].user.display_name;

  console.log("ensordecer:", await evaluar(page, PULSAR("Ensordecer")));
  if (await evaluar(page, ESCUCHAR(otro))) mudos.push(`ensordecido, el navegador 1 sigue oyendo a ${otro}`);

  console.log("volver a oír:", await evaluar(page, PULSAR("Escuchar")));
  if (await evaluar(page, ESCUCHAR(otro))) console.log(`voz: el navegador 1 vuelve a oír a ${otro}`);
  else mudos.push(`tras quitar el ensordecimiento, el navegador 1 no vuelve a oír a ${otro}`);
}

/* El volumen de cada persona (§10.2). Es local: ni pide permiso ni viaja, así
   que lo que hay que comprobar es que el mando existe para quien NO modera
   —estos dos son invitados sin permisos— y que lo que se mueve se guarda. */
const VOLUMEN = (otro) => `(async () => {
  try {
    const s = (ms) => new Promise(r => setTimeout(r, ms));
    const figura = [...document.querySelectorAll('figure[data-user]')]
      .find(f => f.querySelector('figcaption')?.innerText.startsWith(${JSON.stringify(otro)}));
    if (!figura) return 'no encuentro su recuadro';
    figura.querySelector('button')?.click();
    await s(600);
    const barra = document.querySelector('[role="menu"] input[type=range]');
    if (!barra) return 'el menú no trae mando de volumen';
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(barra, '35');
    barra.dispatchEvent(new Event('input', { bubbles: true }));
    await s(400);
    document.body.click();
    return localStorage.getItem('distop.userVolumes') ?? 'no se guardó nada';
  } catch (e) { return 'ERROR: ' + e.message; }
})()`;

{
  const guardado = await evaluar(paginas[0], VOLUMEN(gente[1].user.display_name));
  console.log("volumen por persona:", guardado);
  if (!String(guardado).includes("0.35")) mudos.push(`el volumen por persona no quedó guardado: ${guardado}`);
}

/** Enciende cámara o pantalla. La cámara falsa de Chrome emite un patrón en movimiento. */
const fuente = process.env.SHARE === "pantalla" ? "Pantalla" : "Cámara";
const ENCENDER = `(async () => {
  const boton = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(fuente)});
  if (!boton) return 'sin botón de ${fuente}';
  boton.click();
  await new Promise(r => setTimeout(r, 3000));
  const aviso = document.querySelector('[role="alert"]')?.innerText;
  return aviso ? 'error: ' + aviso : 'encendida';
})()`;

for (const page of paginas) console.log(`${fuente}:`, await evaluar(page, ENCENDER));
await sleep(7000);

/* videoWidth > 0 es la prueba de que llegaron fotogramas decodificados: un
   <video> con pista pero sin imagen se queda en 0 y se ve negro, que es
   exactamente el síntoma a cazar. */
const ESTADO = `(() => ({
  fps: [...document.querySelectorAll('p')].map(p => p.innerText).find(t => /fps/.test(t)) ?? 'sin medida',
  pares: [...document.querySelectorAll('figure[data-user]')]
    .filter(f => f.dataset.link !== 'none')
    .map(f => ({ par: f.dataset.user, conexion: f.dataset.link })),
  cuadros: [...document.querySelectorAll('figure')].map(f => {
    const v = f.querySelector('video');
    let pintado = null;
    if (v && v.videoWidth) {
      /* Que lleguen fotogramas no significa que lleguen IMÁGENES: un vídeo
         completamente negro también tiene ancho. Se dibuja un fotograma en un
         lienzo y se mide cuánto varían sus píxeles; en negro puro, cero. */
      const c = document.createElement('canvas');
      c.width = 64; c.height = 36;
      const ctx = c.getContext('2d');
      ctx.drawImage(v, 0, 0, 64, 36);
      const d = ctx.getImageData(0, 0, 64, 36).data;
      let min = 255, max = 0, suma = 0;
      for (let i = 0; i < d.length; i += 4) {
        const gris = (d[i] + d[i+1] + d[i+2]) / 3;
        if (gris < min) min = gris;
        if (gris > max) max = gris;
        suma += gris;
      }
      pintado = { min: Math.round(min), max: Math.round(max), medio: Math.round(suma / (d.length / 4)) };
    }
    return {
      quien: f.querySelector('figcaption')?.innerText.replace(/\\s+/g, ' '),
      hayVideo: Boolean(v),
      ancho: v?.videoWidth ?? 0,
      alto: v?.videoHeight ?? 0,
      listo: v?.readyState ?? -1,
      pintado,
    };
  }),
}))()`;

const fallos = [...mudos];

/** Mira los dos lados: cada uno tiene que VER al otro, no solo mandarle. */
async function revisar(etapa) {
  for (const [i, page] of paginas.entries()) {
    const estado = await evaluar(page, ESTADO);
    console.log(`\n── ${etapa} · navegador ${i + 1} (${gente[i].user.display_name}) ──`);
    console.log(JSON.stringify(estado, null, 2));

    const otro = gente[1 - i].user.display_name;
    const cuadro = estado.cuadros.find((c) => c.quien?.startsWith(otro));
    if (!cuadro?.hayVideo || cuadro.ancho === 0) {
      fallos.push(`[${etapa}] el navegador ${i + 1} no recibe el vídeo de ${otro} (${JSON.stringify(cuadro)})`);
    } else if (cuadro.pintado && cuadro.pintado.max === cuadro.pintado.min) {
      // Con la cámara falsa de Chrome llega un patrón de colores; un plano liso
      // significa que la imagen no está llegando de verdad.
      fallos.push(`[${etapa}] el navegador ${i + 1} recibe una imagen plana de ${otro}: ${JSON.stringify(cuadro.pintado)}`);
    }
    const par = estado.pares.find((p) => p.conexion !== "connected" && p.conexion !== undefined);
    if (par) fallos.push(`[${etapa}] el navegador ${i + 1} tiene un par en "${par.conexion}"`);
  }
}

await revisar("llamada");

/* El botón de ampliar tiene que hacer el viaje de ida Y el de vuelta. Solo hacía
   la ida: para volver había que saber que existe Escape.

   Se pulsa con el ratón de verdad, por CDP, y no con un `.click()` desde la
   página: el navegador solo concede pantalla completa a un gesto auténtico, así
   que un clic sintético siempre habría fallado y no habría demostrado nada. */
const AMPLIAR = `(async () => {
  const s = (ms) => new Promise(r => setTimeout(r, ms));
  const boton = () => [...document.querySelectorAll('figure button[aria-label]')]
    .find(b => /pantalla completa/i.test(b.getAttribute('aria-label')));
  if (!boton()) return { fallo: 'no aparece el botón' };

  /* Un navegador sin escritorio no concede pantalla completa de verdad, así que
     se finge que YA se está en ella y se comprueba lo que estaba roto: que el
     botón sepa volver. Entrar ya funcionaba; salir no existía. */
  const figura = boton().closest('figure');
  let pidioSalir = false;
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => figura });
  document.exitFullscreen = () => { pidioSalir = true; return Promise.resolve(); };
  document.dispatchEvent(new Event('fullscreenchange'));
  await s(300);

  const etiqueta = boton().getAttribute('aria-label');
  boton().click();
  await s(300);
  return { pidioSalir, etiqueta };
})()`;

const zoom = await evaluar(paginas[0], AMPLIAR);
console.log("pantalla completa:", JSON.stringify(zoom));
if (!zoom?.pidioSalir) fallos.push(`estando ampliado, el botón no devuelve al tamaño normal: ${JSON.stringify(zoom)}`);
if (zoom?.etiqueta && !/salir/i.test(zoom.etiqueta)) fallos.push(`ampliado, el botón sigue diciendo "${zoom.etiqueta}"`);

/* Recargar en mitad de una llamada es lo más normal del mundo y era justo lo que
   la dejaba muerta: al volver, el id de usuario es el mismo, así que el otro lado
   seguía usando la conexión de la pestaña anterior y no reconstruía nada. */
console.log("\n▸ recargando el navegador 2 en mitad de la llamada…");
await recargar(paginas[1]);
console.log("entrar:", await evaluar(paginas[1], ENTRAR));
await sleep(6000);
console.log(`${fuente}:`, await evaluar(paginas[1], ENCENDER));
await sleep(8000);
await revisar("tras recargar");

/* ── limpieza: no dejar cuentas de prueba por ahí ────────────────────── */

for (const sesion of gente) {
  await fetch(`${base}/api/v1/users/me`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${sesion.access_token}` },
    body: JSON.stringify({ username: sesion.user.username }),
  });
}
await fetch(`${base}/api/v1/invites/${invitacion.code}`, {
  method: "DELETE",
  headers: { authorization: `Bearer ${anfitrion.access_token}` },
});
await post("/api/v1/auth/logout", {}, anfitrion.access_token);

for (const page of paginas) page.close();
chrome.close();
browser.kill();

if (fallos.length) {
  console.error("\n✖ la llamada NO funciona:\n  " + fallos.join("\n  "));
  process.exit(1);
}
console.log("\n✔ audio y vídeo van en los dos sentidos");
process.exit(0);
