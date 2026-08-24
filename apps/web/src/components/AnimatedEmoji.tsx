/**
 * Emoji animado, del catálogo de Noto (Google, CC BY 4.0) generado por
 * scripts/fetch-animated-emoji.mjs (§10.2).
 *
 * Se pinta con `lottie-web` en su build "light" (sin el motor de expresiones
 * de After Effects, que aquí no hace falta): ~170 KB, sin WASM, contra el
 * ~1.3 MB de un reproductor de `.lottie` moderno. Los 878 JSON no llevan
 * expresiones, así que el recorte no cuesta nada.
 *
 * Carga perezosa de verdad: nada de animationData por props. Cada instancia
 * espera a que IntersectionObserver diga que está en pantalla antes de pedir
 * el JSON y arrancar el motor, y lo destruye al salir de vista. Sin esto, un
 * historial con muchos emoji animados sería tantos bucles de animación
 * corriendo a la vez como mensajes cargados, la mayoría fuera de pantalla.
 */
import { useEffect, useRef, useState } from "react";
import type { AnimationItem } from "lottie-web/build/player/lottie_light";
import { ANIMATED_EMOJI } from "../lib/animatedEmoji.generated.ts";

/* El motor (~170 KB minificado) se pide la primera vez que un emoji animado
   entra en pantalla, no al arrancar la aplicación: quien no cruza ninguno no
   lo descarga, y el primer pintado no lo espera. El import dinámico saca el
   chunk del bundle principal; una vez resuelto queda cacheado aquí. */
let lottiePromise: Promise<(typeof import("lottie-web/build/player/lottie_light"))["default"]> | null = null;

function loadLottie() {
  lottiePromise ??= import("lottie-web/build/player/lottie_light").then((m) => m.default);
  return lottiePromise;
}

/* Un JSON pedido una vez sirve para todas las instancias que usen ese emoji.
   Con tope: reinsertar al usar y desalojar el más viejo. Sin él, una sesión
   larga acumulaba en heap todos los JSON parseados que hubiera cruzado (878
   posibles, ~79 KB de media cada uno); el desalojado se vuelve a pedir y la
   caché HTTP (o el service worker) amortigua la re-descarga. */
const cache = new Map<string, Promise<object>>();
const MAX_CACHED = 64;

function fetchAnimation(id: string): Promise<object> {
  const cached = cache.get(id);
  if (cached) {
    // Reinsertar marca el acceso: el orden de inserción del Map es la antigüedad.
    cache.delete(id);
    cache.set(id, cached);
    return cached;
  }
  /* El instalador de escritorio embarca solo el set curado del picker
     (scripts/stage-curated-emoji.mjs): para el resto se cae a la fuente Noto
     original (Google, CC BY 4.0 — misma procedencia de los JSON del repo).
     Solo se contacta a un tercero cuando el asset local NO existe; instancias
     self-hosted con el pack completo nunca llegan aquí. Sin red: el catch del
     componente pinta el carácter plano. */
  const promise = fetch(`/emoji-animated/${id}.json`)
    .then((res) => {
      if (!res.ok) throw new Error(`emoji animado ${id}: ${res.status}`);
      return res.json() as Promise<object>;
    })
    .catch(() =>
      fetch(`https://fonts.gstatic.com/s/e/notoemoji/latest/${id}/lottie.json`).then((res) => {
        if (!res.ok) throw new Error(`emoji animado ${id} (upstream): ${res.status}`);
        return res.json() as Promise<object>;
      }),
    );
  // Un fallo no debe quedarse cacheado: la próxima instancia reintenta.
  promise.catch(() => cache.delete(id));
  cache.set(id, promise);
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return promise;
}

/** ¿Este carácter tiene versión animada? Lo consulta el picker y el renderizador de mensajes. */
export function animatedIdFor(char: string): string | undefined {
  return ANIMATED_EMOJI[char];
}

export function AnimatedEmoji({
  char,
  size = 22,
  className = "",
  playOn = "always",
}: {
  char: string;
  size?: number;
  className?: string;
  /** "hover": quieto en el primer frame hasta que el control que lo contiene recibe puntero o foco. */
  playOn?: "always" | "hover";
}) {
  const id = ANIMATED_EMOJI[char];
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element || !id || failed) return;

    let anim: AnimationItem | undefined;
    let cancelled = false;

    /* En "hover" el bucle solo corre mientras se señala o enfoca el ancestro
       interactivo (el botón del picker, no este span diminuto): una rejilla de
       cincuenta emoji animándose a la vez gastaba CPU sin contar nada. */
    const trigger = playOn === "hover" ? (element.closest("button") ?? element) : null;
    const play = () => anim?.play();
    const pause = () => anim?.pause();
    if (trigger) {
      trigger.addEventListener("pointerenter", play);
      trigger.addEventListener("focusin", play);
      trigger.addEventListener("pointerleave", pause);
      trigger.addEventListener("focusout", pause);
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          anim?.destroy();
          anim = undefined;
          return;
        }
        if (anim) return; // ya está corriendo
        void Promise.all([fetchAnimation(id), loadLottie()])
          .then(([animationData, lottie]) => {
            if (cancelled || !host.current) return;
            anim = lottie.loadAnimation({
              container: host.current,
              renderer: "svg",
              loop: true,
              autoplay: playOn === "always",
              animationData,
            });
            // Sin autoplay lottie no pinta nada: forzar el primer frame para
            // que el emoji se vea, quieto, hasta que llegue el hover.
            if (playOn === "hover") anim.goToAndStop(0, true);
          })
          .catch(() => {
            // Sin JSON (paquete recortado, sin red): el carácter plano, que
            // sigue siendo un emoji. Nunca un hueco vacío.
            if (!cancelled) setFailed(true);
          });
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);

    return () => {
      cancelled = true;
      if (trigger) {
        trigger.removeEventListener("pointerenter", play);
        trigger.removeEventListener("focusin", play);
        trigger.removeEventListener("pointerleave", pause);
        trigger.removeEventListener("focusout", pause);
      }
      observer.disconnect();
      anim?.destroy();
    };
  }, [id, failed, playOn]);

  // Sin versión animada (o sin forma de cargarla): el carácter tal cual, que
  // es exactamente lo que se pintaba antes de que existiera este componente.
  if (!id || failed) return <span className={className}>{char}</span>;

  return (
    <span
      ref={host}
      role="img"
      aria-label={char}
      title={char}
      style={{ width: size, height: size, display: "inline-block" }}
      className={className}
    />
  );
}
