/**
 * Service worker mínimo (§14).
 * Cachea el cascarón para que abrir la aplicación sin red muestre la interfaz y
 * su estado real de conexión, en vez del dinosaurio del navegador. Los datos
 * NUNCA se cachean: un mensaje viejo mostrado como actual es peor que un error.
 *
 * Solo entra lo listado en SHELL_PREFIXES: subidas y adjuntos quedan fuera
 * (privacidad y disco), y lo variable (emojis animados) se acota con un tope
 * FIFO — antes se cacheaba TODO GET del origen sin límite y la Cache Storage
 * crecía sin cota. El bump a -v2 purga lo acumulado por la versión anterior.
 */
const SHELL = "distop-shell-v2";

/* El cascarón y sus assets: los de /assets/ llevan hash de Vite (inmutables),
   rings y sounds son catálogo fijo, emoji-animated es grande pero finito y de
   uso repetido — este último es el que vigila el tope de abajo. */
const SHELL_PREFIXES = ["/assets/", "/rings/", "/sounds/", "/emoji-animated/"];
const SHELL_PAGES = ["/", "/icon.svg", "/manifest.webmanifest"];
const MAX_ENTRIES = 400;

function cacheable(pathname) {
  if (SHELL_PAGES.includes(pathname)) return true;
  return SHELL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/* FIFO simple: la Cache API no da LRU y para un cascarón basta con no crecer. */
function trim(cache) {
  return cache.keys().then((keys) => {
    if (keys.length <= MAX_ENTRIES) return undefined;
    return Promise.all(keys.slice(0, keys.length - MAX_ENTRIES).map((key) => cache.delete(key)));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_PAGES)));
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
  if (event.request.method !== "GET" || url.origin !== location.origin || !cacheable(url.pathname)) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        void caches.open(SHELL).then((cache) => cache.put(event.request, copy).then(() => trim(cache)));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/"))),
  );
});
