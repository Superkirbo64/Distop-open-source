/**
 * Service worker mínimo (§14).
 * Cachea el cascarón para que abrir la aplicación sin red muestre la interfaz y
 * su estado real de conexión, en vez del dinosaurio del navegador. Los datos
 * NUNCA se cachean: un mensaje viejo mostrado como actual es peor que un error.
 */
const SHELL = "distop-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(["/", "/icon.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isData = url.pathname.startsWith("/api/") || url.pathname === "/health" || url.pathname === "/realtime";
  if (event.request.method !== "GET" || isData || url.origin !== location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(SHELL).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/"))),
  );
});
