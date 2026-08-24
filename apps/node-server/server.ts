/**
 * Arranque de la instancia self-hosted.
 * Un solo proceso: API v1 + gateway en tiempo real + (si existe el build) el
 * cliente web. Así self-hostear es "docker compose up", no orquestar tres cosas.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createGzip } from "node:zlib";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { config } from "./config.ts";
import { countOwners, pruneSessions } from "./auth.ts";
import { handleRequest } from "./http.ts";
import { handleUpgrade } from "./gateway.ts";
import { setState, VERSION } from "./instance.ts";
import { autostartTunnel } from "./tunnel.ts";
import { restoreTailscale } from "./tailscale.ts";
import "./api.ts"; // registra las rutas

/* Junto al servidor por convención (repo y paquetes de escritorio/Termux); la
   variable existe para los entornos donde esa convención no puede cumplirse,
   como el motor Node embebido en el APK de Android. */
const WEB_DIST = process.env.WEB_DIST_PATH ? resolve(process.env.WEB_DIST_PATH) : resolve(import.meta.dirname, "..", "web", "dist");
const hasClient = existsSync(join(WEB_DIST, "index.html"));

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
  const isAsset = candidate.startsWith(WEB_DIST) && existsSync(candidate) && statSync(candidate).isFile();
  // SPA: cualquier ruta desconocida devuelve el shell y el router del cliente decide.
  const file = isAsset ? candidate : join(WEB_DIST, "index.html");
  const ext = extname(file);

  const aceptaGzip = COMPRESIBLE.has(ext) && (req.headers["accept-encoding"] ?? "").includes("gzip");

  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
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
  const isApi = pathname.startsWith("/api/") || pathname === "/health";

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

setInterval(pruneSessions, 60 * 60_000).unref();

server.listen(config.port, config.host, () => {
  setState("ONLINE");
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
  void autostartTunnel(countOwners() > 0);
  restoreTailscale();
});

/** Cierre limpio: sin esto, docker stop deja WAL a medio escribir. */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    setState("MAINTENANCE");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
