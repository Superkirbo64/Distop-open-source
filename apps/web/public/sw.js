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

/* ── Web Push (A2) ──────────────────────────────────────────────────────
 *
 * Lo que llega cifrado desde la instancia es un código, no una frase: ni
 * nombre de comunidad, ni texto, ni quién escribió. El texto se escribe aquí,
 * en el idioma que la aplicación dejó en la URL de registro — el service
 * worker no puede leer localStorage, y cuando llega un aviso puede no haber
 * ninguna pestaña abierta a la que preguntarle.
 */
const LANG = new URL(self.location.href).searchParams.get("lang") ?? "es";

const AVISOS = {
  es: {
    instance_online: "Tu comunidad volvió a estar disponible.",
    mention: "Te mencionaron.",
    mention_n: (n) => `Te mencionaron ${n} veces.`,
    invite: "Tienes una invitación.",
  },
  en: {
    instance_online: "Your community is back online.",
    mention: "You were mentioned.",
    mention_n: (n) => `You were mentioned ${n} times.`,
    invite: "You have an invitation.",
  },
  "pt-BR": {
    instance_online: "Sua comunidade voltou a ficar disponível.",
    mention: "Você foi mencionado.",
    mention_n: (n) => `Você foi mencionado ${n} vezes.`,
    invite: "Você tem um convite.",
  },
};

function textoDelAviso(payload) {
  const dic = AVISOS[LANG] ?? AVISOS.es;
  if (payload?.t === "mention") return payload.n > 1 ? dic.mention_n(payload.n) : dic.mention;
  return dic[payload?.t] ?? dic.instance_online;
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  /* Un aviso vacío o de una versión que no conocemos no se enseña. Inventar un
     texto para algo que no se entiende es peor que callarse: la persona
     recibiría una notificación que no corresponde a nada. */
  if (!payload || payload.v !== 1) return;

  event.waitUntil(
    self.registration.showNotification("Distop", {
      body: textoDelAviso(payload),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      /* Misma etiqueta: si llegan tres avisos seguidos se reemplazan en vez de
         apilarse. Nadie quiere doce notificaciones al encender el portátil. */
      tag: `distop-${payload.t}`,
      renotify: false,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  /* Si ya hay una pestaña de Distop, se le da el foco en vez de abrir otra. */
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientes) => {
      for (const cliente of clientes) {
        if (cliente.url.startsWith(self.location.origin) && "focus" in cliente) return cliente.focus();
      }
      return self.clients.openWindow("/");
    }),
  );
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
