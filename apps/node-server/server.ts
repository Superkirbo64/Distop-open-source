/**
 * Arranque de la instancia self-hosted.
 * Un solo proceso: API v1 + gateway en tiempo real + (si existe el build) el
 * cliente web. Así self-hostear es "docker compose up", no orquestar tres cosas.
 */
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { extname, join, resolve, sep } from "node:path";
import { config } from "./config.ts";
import { countOwners, hostUserId, pruneSessions } from "./auth.ts";
import { closeDatabase } from "./db.ts";
import { handleRequest, strictTransport } from "./http.ts";
import { closeGateway, handleUpgrade } from "./gateway.ts";
import { setState, VERSION } from "./instance.ts";
import { startIntegrityWork, stopIntegrityWork } from "./integrity.ts";
import { startBackupScheduler, stopBackupScheduler } from "./backup-scheduler.ts";
import { announceStartup, startPushHeartbeat } from "./push.ts";
import { sweepGuests } from "./meetings.ts";
import { freezeWrites, registerShutdownHandler, waitForRequests } from "./lifecycle.ts";
import { sweepIncoming } from "./storage.ts";
import { autostartTunnel } from "./tunnel.ts";
import { restoreTailscale, stopTailscale } from "./tailscale.ts";
import { startDirectoryPublisher, stopDirectoryPublisher } from "./directory-publisher.ts";
import "./api.ts"; // registra las rutas

/* Junto al servidor por convención (repo y paquetes de escritorio/Termux); la
   variable existe para los entornos donde esa convención no puede cumplirse,
   como el motor Node embebido en el APK de Android. */
const WEB_DIST = process.env.WEB_DIST_PATH ? resolve(process.env.WEB_DIST_PATH) : resolve(import.meta.dirname, "..", "web", "dist");
const hasClient = existsSync(join(WEB_DIST, "index.html"));

/**
 * Cabeceras del documento que ejecuta todo el cliente (§22).
 *
 * La API ya las mandaba; la página que corre el JavaScript, no: salía con
 * `nosniff` y nada más. Sin `frame-ancestors` cualquier web podía meter Distop
 * en un iframe invisible y cazar clics sobre «expulsar» o «borrar comunidad».
 *
 * El hash del script en línea —el que evita el parpadeo de tema— se calcula al
 * arrancar leyendo el propio index.html, para que la política no caduque cada
 * vez que ese script cambie.
 *
 * `connect-src` queda abierto a propósito y no por descuido: el cliente habla
 * con la instancia que elija cada persona, con otras instancias del índice y
 * con las galerías de la propia instancia. Una lista cerrada aquí sería falsa.
 */
function documentPolicy(): string {
  const hashes: string[] = [];
  try {
    const html = readFileSync(join(WEB_DIST, "index.html"), "utf8");
    for (const found of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
      /* El navegador normaliza los saltos de línea del script antes de calcular
         su hash. Con un index.html en CRLF —lo normal en Windows— el hash del
         fichero no coincide con el suyo y bloquea el script sin decir por qué. */
      const cuerpo = (found[1] ?? "").replace(/\r\n?/g, "\n");
      hashes.push(`'sha256-${createHash("sha256").update(cuerpo, "utf8").digest("base64")}'`);
    }
  } catch {
    /* Sin cliente compilado no hay documento que proteger. */
  }
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    /* Sin 'wasm-unsafe-eval': el fondo de cámara —lo único que compilaba WASM—
       se retiró, y en el cliente construido no queda ni una llamada a
       WebAssembly, solo las cadenas de traducción que anunciaban que faltaba.
       Vuelve a ponerse el día que vuelva la función, no antes. */
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src * data: blob:",
  ].join("; ");
}

const DOCUMENT_HEADERS: Record<string, string> = {
  "content-security-policy": documentPolicy(),
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  /* Permissions-Policy manda sobre el CONTEXTO DE NAVEGACIÓN, así que solo
     sirve de algo en el documento: en una respuesta JSON no gobierna nada.
     Cámara y micrófono siguen abiertos para este origen —son la voz y el
     vídeo de las salas—, pero no los hereda un iframe de terceros.
     Geolocalización y pagos se cierran: la plataforma no los usa (§2).
     display-capture no se nombra a propósito, o se rompería compartir
     pantalla. */
  "permissions-policy": "camera=(self), microphone=(self), geolocation=(), payment=()",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

/** Devuelve true si sirvió el fichero; si no, deja pasar a la API. */
/**
 * Formatos de texto: los que gzip encoge de verdad. Los binarios (imágenes,
 * woff2) ya vienen comprimidos a su manera, y volver a comprimirlos gasta CPU
 * del anfitrión por nada: a veces el resultado hasta pesa más.
 */
const COMPRESIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".webmanifest"]);

/**
 * Devuelve true si sirvió el fichero; si no, deja pasar a la API.
 *
 * Comprime sobre la marcha, no en el build: el catálogo de emojis animados
 * (§10.2) son 878 JSON, 68 MB sin comprimir, y sin esto cada uno se plantaría
 * en el navegador de cada miembro a su peso completo. Gzip nativo de Node, sin
 * dependencia nueva; ni el propio bundle del cliente se comprimía hasta ahora.
 */
function serveStatic(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): boolean {
  if (!hasClient) return false;
  const pathname = (req.url ?? "/").split("?")[0]!;

  const candidate = resolve(WEB_DIST, `.${decodeURIComponent(pathname)}`);
  /* Con `startsWith` a secas, una carpeta hermana llamada `dist-viejo` o un
     `dist.zip` cumplían el prefijo y se servían enteros sin pedir nada. El
     separador es lo que convierte el prefijo en «dentro de». */
  const dentro = candidate === WEB_DIST || candidate.startsWith(WEB_DIST + sep);
  const isAsset = dentro && existsSync(candidate) && statSync(candidate).isFile();
  // SPA: cualquier ruta desconocida devuelve el shell y el router del cliente decide.
  const file = isAsset ? candidate : join(WEB_DIST, "index.html");
  const ext = extname(file);

  const aceptaGzip = COMPRESIBLE.has(ext) && (req.headers["accept-encoding"] ?? "").includes("gzip");

  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    ...(ext === ".html" ? { ...DOCUMENT_HEADERS, ...strictTransport(req) } : {}),
    "cache-control": isAsset && ext !== ".html" ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
    vary: "accept-encoding",
    ...(aceptaGzip ? { "content-encoding": "gzip" } : {}),
  });

  const source = createReadStream(file);
  if (aceptaGzip) source.pipe(createGzip()).pipe(res);
  else source.pipe(res);
  return true;
}

export const server = createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0]!;
  /* /.well-known/ y /nodeinfo/ van a la API como prefijos enteros: son
     direcciones para máquinas, y contestarlas con el shell del SPA —que es lo
     que hacía el fallback— confunde a cualquier rastreador que pregunte (§19).
     Una ruta well-known que no exista debe ser un 404 de verdad, no un 200 con
     HTML dentro. */
  const isApi = pathname.startsWith("/api/") || pathname === "/health" || pathname.startsWith("/.well-known/") || pathname.startsWith("/nodeinfo/");

  if (!isApi && (req.method === "GET" || req.method === "HEAD") && serveStatic(req, res)) return;
  void handleRequest(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname !== "/realtime") {
    socket.destroy();
    return;
  }
  handleUpgrade(req, socket, head);
});

const pruneTimer = setInterval(() => {
  pruneSessions();
  /* Invitados de reunión que abrieron el enlace, escribieron su nombre y nunca
     llegaron a entrar: cuentas que no pertenecen a ninguna comunidad y a las
     que nadie va a volver. Sin esto se acumulan en el disco de quien hospeda. */
  const idas = sweepGuests();
  if (idas > 0) console.log(`Limpiados ${idas} invitados de reunión que nunca entraron.`);
}, 60 * 60_000);
pruneTimer.unref();

server.listen(config.port, config.host, () => {
  setState("ONLINE");
  /* Lo primero, antes de aceptar una sola subida nueva: tirar lo que quedó a
     medias. Si el equipo se apagó de golpe con una subida en curso, ese trozo
     de fichero no le sirve a nadie y ocupa disco hasta que alguien lo mire. */
  const barrido = sweepIncoming();
  if (barrido.removed > 0) console.log(`Limpiadas ${barrido.removed} subidas a medias del arranque anterior.`);
  startIntegrityWork();
  startBackupScheduler();

  /* "Tu comunidad volvió", con la aplicación cerrada (A2).
     Va aquí y no antes: solo cuando ya se escucha es verdad que volvió. Si no
     hay suscripciones —lo normal, porque hay que pedirlo— no manda nada. */
  void announceStartup()
    .then((enviados) => {
      if (enviados > 0) console.log(`Aviso de vuelta enviado a ${enviados} navegador(es).`);
    })
    .catch(() => {
      /* Que falle el aviso no puede impedir que la instancia sirva. */
    });
  startPushHeartbeat();
  console.log(
    [
      `Distop instancia ${VERSION} — ${config.instanceName}`,
      `  http     http://localhost:${config.port}`,
      `  api      /api/v1  ·  salud /health`,
      `  gateway  ws://localhost:${config.port}/realtime`,
      `  cliente  ${hasClient ? "servido desde apps/web/dist" : "no compilado (usa el dev server de Vite en :5173)"}`,
      `  datos    ${config.databasePath}`,
    ].join("\n"),
  );

  // Instancia sin dueño: se dice aquí, en el sitio donde ya está mirando quien
  // la acaba de arrancar, con lo único que hace falta para reclamarla.
  if (countOwners() === 0) {
    console.log(
      [
        "",
        "  ┌─ Instancia nueva, todavía sin dueño ─────────────────────────",
        `  │  Ábrela en http://localhost:${config.port} y pon tu nombre.`,
        "  │  Desde este equipo no se pide nada más.",
        `  │  Si la reclamas desde otro sitio, el código es:  ${config.setupCode}`,
        "  └──────────────────────────────────────────────────────────────",
        "",
      ].join("\n"),
    );
  }

  /* El enlace publico se abre solo, para que quien hospeda solo tenga que
     crear la invitacion. Nunca en una instancia sin duenno: publicarla antes
     de que alguien la reclame es regalarsela al primero que pase. */
  const hasHostAuthority = hostUserId() !== null;
  void autostartTunnel(hasHostAuthority);
  if (hasHostAuthority) restoreTailscale();
  else stopTailscale(false);
  startDirectoryPublisher();
});

/** Cierre coordinado e idempotente para Docker, escritorio y la API local. */
let shutdownPromise: Promise<void> | null = null;

export function shutdown(reason = "signal"): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    console.log(`Apagando instancia (${reason})...`);
    setState("MAINTENANCE");
    freezeWrites();
    clearInterval(pruneTimer);
    await closeGateway(1001, "instancia en mantenimiento");
    /* El trabajo de fondo se para antes que nada más: es el único que puede
       estar leyendo un fichero del disco por su cuenta, sin una petición que
       lo sostenga, y por tanto el único al que `waitForRequests` no ve. */
    await stopIntegrityWork();
    await stopBackupScheduler();
    stopDirectoryPublisher();

    const httpClosed = new Promise<void>((resolveClosed) => {
      server.close(() => resolveClosed());
      server.closeIdleConnections();
    });
    /* Se cortan los clientes que no terminaron de enviar, pero SQLite no se
       cierra hasta que los handlers hayan abandonado de verdad.
     *
     * Los 2,5 s no son un número redondo cualquiera: la app de escritorio pide
     * el apagado y mata el utilityProcess a los 3,2 s (host.ts). Si esperásemos
     * más, cerrar Distop con una subida en marcha significaría morir a mitad del
     * checkpoint, y la base tendría que recuperarse del WAL en el arranque
     * siguiente. Quien cambie uno de los dos números tiene que mirar el otro. */
    const abortSlowClients = setTimeout(() => server.closeAllConnections(), 2_500);
    abortSlowClients.unref();
    await httpClosed;
    clearTimeout(abortSlowClients);
    await waitForRequests();
    closeDatabase();
  })();
  return shutdownPromise;
}

function shutdownAndExit(reason: string): void {
  void shutdown(reason).then(() => process.exit(0), () => process.exit(1));
}

registerShutdownHandler(shutdownAndExit);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => shutdownAndExit(signal));
}

/* Electron utilityProcess dispone de un canal privado con su proceso padre. */
type UtilityParentPort = { on(event: "message", listener: (event: unknown) => void): void };
const utilityParentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;
utilityParentPort?.on("message", (event) => {
  const payload = event && typeof event === "object" && "data" in event
    ? (event as { data: unknown }).data
    : event;
  if (payload && typeof payload === "object" && (payload as { type?: string }).type === "DISTOP_SHUTDOWN") {
    shutdownAndExit("desktop");
  }
});
