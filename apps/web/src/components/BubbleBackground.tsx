/**
 * Fondo de burbujas de las pantallas de entrada.
 *
 * Portado de Animate UI, BubbleBackground (MIT + Commons Clause; ver
 * THIRD_PARTY_NOTICES.md):
 * https://animate-ui.com/docs/components/backgrounds/bubble
 *
 * Mismas seis burbujas, colores, filtro "goo" y duraciones, pero sin
 * motion/react: igual que los iconos animados (icons.tsx), las coreografías
 * viven en styles.css (bloque "Fondo de burbujas"). Así la librería no vuelve
 * al bundle y el fondo obedece `prefers-reduced-motion` y `data-motion="off"`.
 * La burbuja interactiva sigue al puntero con dos variables CSS; el muelle de
 * motion se sustituye por una transición con la misma sensación de arrastre.
 */
import { useEffect, useRef } from "react";

export function BubbleBackground({ interactive = false, className = "" }: { interactive?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!interactive) return;
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    // En la ventana y no en el fondo: el contenido de la pantalla va encima y se quedaría los eventos.
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        el.style.setProperty("--bubble-x", `${event.clientX - rect.left - rect.width / 2}px`);
        el.style.setProperty("--bubble-y", `${event.clientY - rect.top - rect.height / 2}px`);
      });
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(frame);
    };
  }, [interactive]);

  return (
    <div ref={ref} aria-hidden="true" className={`bubble-bg ${className}`}>
      <svg xmlns="http://www.w3.org/2000/svg" className="absolute top-0 left-0 h-0 w-0">
        <defs>
          <filter id="bubble-goo">
            <feGaussianBlur in="SourceGraphic" stdDeviation="16" result="blur" />
            <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" result="goo" />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
        </defs>
      </svg>
      <div className="bubble-goo">
        <div className="bubble bubble-1" />
        <div className="bubble-orbit bubble-orbit-2">
          <div className="bubble bubble-2" />
        </div>
        <div className="bubble-orbit bubble-orbit-3">
          <div className="bubble bubble-3" />
        </div>
        <div className="bubble bubble-4" />
        <div className="bubble-orbit bubble-orbit-5">
          <div className="bubble bubble-5" />
        </div>
        {interactive ? <div className="bubble bubble-6" /> : null}
      </div>
    </div>
  );
}
