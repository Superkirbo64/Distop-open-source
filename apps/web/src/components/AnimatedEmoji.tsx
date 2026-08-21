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
import { useEffect, useRef } from "react";
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

/** Un JSON pedido una vez sirve para todas las instancias que usen ese emoji. */
const cache = new Map<string, Promise<object>>();

function fetchAnimation(id: string): Promise<object> {
  let promise = cache.get(id);
  if (!promise) {
    promise = fetch(`/emoji-animated/${id}.json`).then((res) => {
      if (!res.ok) throw new Error(`emoji animado ${id}: ${res.status}`);
      return res.json() as Promise<object>;
    });
    cache.set(id, promise);
  }
  return promise;
}

/** ¿Este carácter tiene versión animada? Lo consulta el picker y el renderizador de mensajes. */
export function animatedIdFor(char: string): string | undefined {
  return ANIMATED_EMOJI[char];
}

export function AnimatedEmoji({ char, size = 22, className = "" }: { char: string; size?: number; className?: string }) {
  const id = ANIMATED_EMOJI[char];
  const host = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element || !id) return;

    let anim: AnimationItem | undefined;
    let cancelled = false;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) {
          anim?.destroy();
          anim = undefined;
          return;
        }
        if (anim) return; // ya está corriendo
        void Promise.all([fetchAnimation(id), loadLottie()]).then(([animationData, lottie]) => {
          if (cancelled || !host.current) return;
          anim = lottie.loadAnimation({ container: host.current, renderer: "svg", loop: true, autoplay: true, animationData });
        });
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);

    return () => {
      cancelled = true;
      observer.disconnect();
      anim?.destroy();
    };
  }, [id]);

  // Sin versión animada: el carácter tal cual, que es exactamente lo que se
  // pintaba antes de que existiera este componente.
  if (!id) return <span className={className}>{char}</span>;

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
