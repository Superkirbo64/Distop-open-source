/**
 * Movimiento del sitio: obertura, scroll inercial, revelados y el campo de puntos.
 *
 * Todo lo de aquí es decoración. Si este archivo no carga, la página se lee igual:
 * el estado inicial de `.reveal` lo neutraliza un <noscript> en el layout, y el
 * campo de puntos es un lienzo vacío detrás del titular.
 */
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ── Campo de puntos ──────────────────────────────────────────────────────
 * La idea es de DotGrid (ReactBits): una malla que se aparta del cursor y
 * vuelve con rebote. Allí el rebote lo pone InertiaPlugin de GSAP; aquí es un
 * muelle de tres líneas dentro del propio bucle, porque no merece la pena
 * arrastrar un plugin para amortiguar un número. Los puntos son cuadrados
 * enteros, no círculos: es un sitio de 8 bits.
 */
type Dot = { x: number; y: number; ox: number; oy: number; vx: number; vy: number };

const GAP = 26;
const DOT = 3;
const RADIUS = 108;
const STIFF = 0.11;
const DAMP = 0.82;

function dotField(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const css = getComputedStyle(document.documentElement);
  const idle = css.getPropertyValue("--dot").trim() || "#4a4490";
  const live = css.getPropertyValue("--accent").trim() || "#5b6cff";

  let dots: Dot[] = [];
  let w = 0;
  let h = 0;
  const pointer = { x: -1e5, y: -1e5 };

  const build = (): void => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dots = [];
    for (let y = GAP / 2; y < h; y += GAP) {
      for (let x = GAP / 2; x < w; x += GAP) {
        dots.push({ x, y, ox: 0, oy: 0, vx: 0, vy: 0 });
      }
    }
  };

  const paint = (): void => {
    ctx.clearRect(0, 0, w, h);
    for (const d of dots) {
      const px = d.x + d.ox;
      const py = d.y + d.oy;
      const dist = Math.hypot(px - pointer.x, py - pointer.y);
      const near = dist < RADIUS ? 1 - dist / RADIUS : 0;
      ctx.fillStyle = near > 0.35 ? live : idle;
      ctx.globalAlpha = 0.55 + near * 0.45;
      ctx.fillRect(Math.round(px), Math.round(py), DOT, DOT);
    }
    ctx.globalAlpha = 1;
  };

  const step = (): void => {
    for (const d of dots) {
      const dx = d.x + d.ox - pointer.x;
      const dy = d.y + d.oy - pointer.y;
      const dist = Math.hypot(dx, dy);
      if (dist < RADIUS && dist > 0.01) {
        const push = ((RADIUS - dist) / RADIUS) * 2.4;
        d.vx += (dx / dist) * push;
        d.vy += (dy / dist) * push;
      }
      // Muelle de vuelta al sitio: sin esto el campo se deforma para siempre.
      d.vx = (d.vx - d.ox * STIFF) * DAMP;
      d.vy = (d.vy - d.oy * STIFF) * DAMP;
      d.ox += d.vx;
      d.oy += d.vy;
    }
    paint();
  };

  build();
  new ResizeObserver(() => {
    build();
    paint();
  }).observe(canvas);

  if (reduced) {
    paint();
    return;
  }

  window.addEventListener(
    "pointermove",
    (e) => {
      const rect = canvas.getBoundingClientRect();
      pointer.x = e.clientX - rect.left;
      pointer.y = e.clientY - rect.top;
    },
    { passive: true },
  );
  window.addEventListener("pointerleave", () => {
    pointer.x = -1e5;
    pointer.y = -1e5;
  });

  gsap.ticker.add(step);
}

const canvas = document.querySelector<HTMLCanvasElement>(".dotfield");
if (canvas) dotField(canvas);

/* ── Scroll, obertura y revelados ─────────────────────────────────────── */
if (!reduced) {
  gsap.registerPlugin(ScrollTrigger);

  const lenis = new Lenis({ lerp: 0.085, wheelMultiplier: 0.9 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((time) => lenis.raf(time * 1000));
  gsap.ticker.lagSmoothing(0);

  // Lenis se salta el salto nativo de las anclas; hay que llevarlo a mano.
  document.addEventListener("click", (event) => {
    const link = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>('a[href*="#"]');
    const hash = link?.hash;
    if (!link || !hash || link.pathname !== window.location.pathname) return;
    const target = document.querySelector(hash);
    if (!target) return;
    event.preventDefault();
    lenis.scrollTo(target as HTMLElement, { offset: -64 });
    history.pushState(null, "", hash);
  });

  const reveal = (): void => {
    for (const el of gsap.utils.toArray<HTMLElement>(".reveal")) {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 0.66,
        ease: "power3.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      });
    }
  };

  const intro = document.getElementById("intro");
  if (intro) {
    lenis.stop();
    gsap
      .timeline({
        onComplete: () => {
          intro.hidden = true;
          lenis.start();
          ScrollTrigger.refresh();
        },
      })
      .from("#intro-word span", {
        opacity: 0,
        y: -18,
        duration: 0.24,
        stagger: 0.055,
        ease: "steps(3)",
      })
      .to("#intro-bar", { width: "100%", duration: 0.45, ease: "steps(9)" }, "-=0.08")
      .to(intro, { opacity: 0, duration: 0.32, ease: "power2.in" }, "+=0.1");
    reveal();
  } else {
    reveal();
  }
}
