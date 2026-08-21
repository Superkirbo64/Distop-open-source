/**
 * Carrera de canicas de la sala de voz (§10 personalización gratuita, §29.1).
 *
 * Cada persona apuntada es una canica. Quien pulsa el botón abre una sala de
 * espera, los demás se apuntan desde el mismo botón, y quien la abrió elige
 * mundo y da la salida. Nadie controla su canica: la gracia es apostar en voz
 * alta mientras caen.
 *
 * La carrera es la MISMA en todas las pantallas y aun así por la instancia solo
 * viaja un puñado de bytes: la semilla y la parrilla. La física de
 * `lib/marbleRace.ts` es determinista, así que cada cliente la calcula entera
 * por su cuenta y llega al mismo podio. Mandar posiciones sesenta veces por
 * segundo habría sido más tráfico que la propia llamada de voz.
 *
 * Para que sea barato de verdad:
 *  - Solo se dibujan los obstáculos de las franjas que se ven.
 *  - El bucle se detiene solo al terminar y cuando la pestaña deja de verse.
 *  - Sin imágenes ni fuentes propias: la cara de cada canica es el avatar que
 *    ya está cargado en la sala, y si no hay, sus iniciales sobre su color.
 */
import { useEffect, useRef, useState } from "react";
import { Flag, Trophy, X } from "lucide-react";
import type { RaceLobby } from "@distop/protocol";
import { Avatar, useT } from "./ui.tsx";
import type { MessageKey } from "../i18n.ts";
import {
  MARBLE_R,
  STEP,
  TRACK_W,
  WORLDS,
  createRace,
  stepRace,
  type Racer,
} from "../lib/marbleRace.ts";

/** Cuánta pista cabe en pantalla: la cámara se aleja para no perder al pelotón. */
const MIN_VIEW = 560;
const MAX_VIEW = 820;
/** Altura de las franjas del índice de obstáculos, igual que en la simulación. */
const BAND = 100;
/** Tope de lo que se adelanta al entrar tarde. Ninguna carrera dura tanto. */
const CATCHUP_MAX = 120;

/** El color de una persona, el mismo que le pone su avatar sin imagen. */
function colorOf(racer: Racer): string {
  return `oklch(0.55 0.13 ${racer.hue})`;
}

/** La cara de quien corre, recortada en un círculo del radio pedido. */
function drawFace(
  ctx: CanvasRenderingContext2D,
  racer: Racer,
  x: number,
  y: number,
  r: number,
  avatars: Map<string, HTMLImageElement>,
): void {
  const image = avatars.get(racer.id);
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.clip();
  if (image) {
    ctx.drawImage(image, x - r, y - r, r * 2, r * 2);
  } else {
    ctx.fillStyle = colorOf(racer);
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.font = `700 ${(r * 8) / MARBLE_R}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.fillText(racer.initials, x, y + 0.5);
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = "rgba(0,0,0,0.45)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

/**
 * La pista. Solo se monta cuando la carrera ya arrancó; mientras se espera
 * gente no existe ni el lienzo ni el bucle.
 *
 * Se reinicia con la semilla: cada `RACE_START` trae una nueva y eso es lo que
 * arranca la carrera siguiente, a la vez en todas las pantallas.
 */
function RaceTrack({
  world,
  seed,
  startedAt,
  racers,
  onPodium,
}: {
  world: number;
  seed: number;
  /** Cuándo dio la salida la instancia: es lo que sitúa la carrera en el tiempo. */
  startedAt: number;
  racers: Racer[];
  onPodium: (podium: Racer[]) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const racersRef = useRef(racers);
  racersRef.current = racers;
  const onPodiumRef = useRef(onPodium);
  onPodiumRef.current = onPodium;

  useEffect(() => {
    const canvasNode = canvasRef.current;
    const containerNode = containerRef.current;
    if (!canvasNode || !containerNode) return;
    const ctxNode = canvasNode.getContext("2d");
    if (!ctxNode) return;
    const canvas = canvasNode;
    const container = containerNode;
    const ctx = ctxNode;

    const race = createRace(world, seed, racersRef.current);
    const { marbles, bands, spec } = race;
    const podiumSoFar = () =>
      marbles
        .filter((m) => m.place)
        .sort((a, b) => a.place - b.place)
        .map((m) => m.racer);

    /* Entrar tarde es entrar EN la carrera, no en otra.
       Quien se apunta a mitad, quien se sale y vuelve, o quien recarga la
       página, arrancaba la simulación desde la salida: la misma semilla, sí,
       pero un minuto por detrás del resto, que es exactamente la sensación de
       estar viendo otra partida. Como la física es determinista, ponerse al día
       es repetir los mismos pasos muy rápido hasta el momento en el que va.
       ponytail: se fía del reloj del equipo; con un desfase gordo contra la
       instancia entraría desplazado. Sincronizar relojes, si eso pasa. */
    let ahead = Math.min(Math.max(0, (Date.now() - startedAt) / 1000), CATCHUP_MAX);
    while (ahead > STEP && race.finished < marbles.length) {
      stepRace(race, STEP);
      ahead -= STEP;
    }

    // Los avatares se cargan una vez y se dibujan cuando estén; mientras tanto
    // la canica lleva iniciales, que es lo mismo que hace la lista de la sala.
    const avatars = new Map<string, HTMLImageElement>();
    for (const marble of marbles) {
      const { racer } = marble;
      if (!racer.avatarUrl) continue;
      const image = new Image();
      image.src = racer.avatarUrl;
      image.decode().then(
        () => avatars.set(racer.id, image),
        () => undefined,
      );
    }

    const colors = {
      line: "#272b36",
      bg: "#0d0e12",
      track: "#15171e",
      ink: "#e8eaf2",
      accent: "#7c8cff",
      muted: "#98a0b3",
    };
    const readColors = () => {
      const cs = getComputedStyle(document.documentElement);
      colors.line = cs.getPropertyValue("--line").trim() || colors.line;
      colors.bg = cs.getPropertyValue("--bg").trim() || colors.bg;
      colors.track = cs.getPropertyValue("--surface").trim() || colors.track;
      colors.ink = cs.getPropertyValue("--ink").trim() || colors.ink;
      colors.accent = cs.getPropertyValue("--accent").trim() || colors.accent;
      colors.muted = cs.getPropertyValue("--muted").trim() || colors.muted;
    };
    readColors();
    const themeObserver = new MutationObserver(readColors);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    let dpr = 1;
    let cssW = 1;
    let cssH = 1;
    let scale = 1;
    let offsetX = 0;
    let viewH = MIN_VIEW;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let camY = 0;
    let idleAfterEnd = 0;
    // El bucle solo avisa de los cambios; si al entrar ya hay podio, este no lo
    // vería y el marcador de abajo se quedaría en "corriendo" para siempre.
    let announced = race.finished;
    if (announced > 0) onPodiumRef.current(podiumSoFar());

    function draw() {
      // La cámara encuadra al pelotón entero, no solo a quien va primero: en un
      // pachinko las canicas se estiran mucho y seguir solo a la cabeza deja
      // fuera de pantalla a casi todas. Con tope, para que una rezagada no
      // aleje la vista hasta lo inservible.
      let lead = 0;
      let tail = spec.length;
      let running = 0;
      for (const m of marbles) {
        if (m.place) continue;
        running += 1;
        if (m.y > lead) lead = m.y;
        if (m.y < tail) tail = m.y;
      }
      if (running === 0) tail = lead;
      const wanted = Math.max(MIN_VIEW, Math.min(lead - tail + 220, MAX_VIEW));
      viewH += (wanted - viewH) * 0.06;
      scale = Math.min(cssW / TRACK_W, cssH / viewH);
      offsetX = (cssW - TRACK_W * scale) / 2;
      viewH = cssH / scale;

      // El líder va en el tercio bajo: lo que importa en una carrera es ver lo
      // que viene por delante, no el tramo que ya quedó atrás.
      const target = Math.max(0, Math.min(lead - viewH * 0.62, spec.length + 120 - viewH));
      camY += (target - camY) * 0.14;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = colors.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Terminada, la pista se queda vacía y sin esto la última imagen —la que
      // se queda fija cuando el bucle se apaga— no diría quién ganó.
      if (race.finished === marbles.length) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const podio = [...marbles].sort((a, b) => a.place - b.place).slice(0, 3);
        podio.forEach((m, i) => {
          const y = cssH / 2 + (i - 1) * 52;
          const r = i === 0 ? 24 : 17;
          drawFace(ctx, m.racer, cssW / 2 - 104, y, r, avatars);
          ctx.textAlign = "left";
          ctx.textBaseline = "middle";
          ctx.fillStyle = i === 0 ? colors.accent : colors.ink;
          ctx.font = `700 ${i === 0 ? 26 : 17}px system-ui, sans-serif`;
          ctx.fillText(`${m.place}. ${m.racer.name}`, cssW / 2 - 66, y + 1);
        });
        return;
      }

      ctx.setTransform(dpr * scale, 0, 0, dpr * scale, offsetX * dpr, -camY * scale * dpr);

      // Todo lo del mundo se recorta a la pista: las rampas están empotradas en
      // las paredes y sin esto asoman por fuera, sobre el fondo de los lados.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, camY, TRACK_W, viewH);
      ctx.clip();

      // La pista tiene su propio fondo: si no, se confunde con el hueco de los
      // lados y no se ve por dónde se puede caer una canica.
      ctx.fillStyle = colors.track;
      ctx.fillRect(0, camY, TRACK_W, viewH);

      // Marcas de distancia: sin una referencia fija no se nota que la pista
      // avanza, parece que las canicas tiemblan en el sitio.
      ctx.strokeStyle = colors.line;
      ctx.globalAlpha = 0.25;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let y = Math.floor(camY / 200) * 200; y < camY + viewH; y += 200) {
        ctx.moveTo(0, y);
        ctx.lineTo(TRACK_W, y);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      const drawn = new Set<unknown>();
      for (let b = Math.floor(camY / BAND); b <= Math.floor((camY + viewH) / BAND); b += 1) {
        for (const obs of bands.get(b) ?? []) {
          if (drawn.has(obs)) continue;
          drawn.add(obs);
          if (obs.peg) {
            ctx.fillStyle = colors.ink;
            ctx.beginPath();
            ctx.arc(obs.x, obs.y, obs.r, 0, Math.PI * 2);
            ctx.fill();
            continue;
          }
          ctx.lineWidth = obs.r * 2;
          ctx.lineCap = "round";
          ctx.strokeStyle = obs.spin ? colors.accent : colors.ink;
          ctx.beginPath();
          ctx.moveTo(obs.x - obs.hx, obs.y - obs.hy);
          ctx.lineTo(obs.x + obs.hx, obs.y + obs.hy);
          ctx.stroke();
        }
      }

      if (spec.length > camY - 40 && spec.length < camY + viewH) {
        ctx.fillStyle = colors.accent;
        for (let x = 0; x < TRACK_W; x += 24) {
          ctx.fillRect(x, spec.length, 12, 6);
          ctx.fillRect(x + 12, spec.length + 6, 12, 6);
        }
      }

      const drawR = Math.max(MARBLE_R, 9 / scale);
      for (const m of marbles) {
        if (m.place) continue;
        if (m.y < camY + drawR) {
          // Rezagada fuera de cuadro: se queda pegada al borde de arriba. Sin
          // esto la carrera parece de tres canicas y hay nueve peleando detrás.
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = colorOf(m.racer);
          ctx.beginPath();
          ctx.arc(m.x, camY + drawR * 0.7, drawR * 0.7, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
          continue;
        }
        drawFace(ctx, m.racer, m.x, m.y, drawR, avatars);
      }
      ctx.restore();

      // Marcador en el hueco que deja la pista. Quien mira quiere saber quién
      // va tercero, no solo quién va primero; y sin esto los lados son dos
      // franjas negras vacías.
      if (offsetX >= 108) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const order = [...marbles].sort((a, b) => (a.place || 99) - (b.place || 99) || b.y - a.y);
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        order.forEach((m, i) => {
          const y = 22 + i * 26;
          ctx.globalAlpha = m.place ? 1 : 0.85;
          ctx.textAlign = "right";
          ctx.fillStyle = m.place === 1 ? colors.accent : colors.muted;
          ctx.fillText(String(i + 1), 26, y);
          drawFace(ctx, m.racer, 45, y, 10, avatars);
          ctx.textAlign = "left";
          ctx.fillStyle = m.place ? colors.ink : colors.muted;
          ctx.fillText(m.racer.name, 62, y);
        });
        ctx.globalAlpha = 1;
      }
    }

    let raf = 0;
    let last = performance.now();
    let carry = 0;
    function frame(now: number) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (race.finished < marbles.length) {
        carry += dt;
        // Paso fijo con tope: si la pestaña se atasca no se recupera a saltos
        // gigantes, que es como una canica acaba dentro de un clavo.
        let steps = Math.min(Math.floor(carry / STEP), 12);
        carry -= steps * STEP;
        while (steps > 0) {
          stepRace(race, STEP);
          steps -= 1;
        }
        // El podio sale de React, no del lienzo, y solo se toca cuando cambia:
        // tres renders por carrera en vez de sesenta por segundo.
        if (race.finished !== announced && race.finished <= 3) {
          announced = race.finished;
          onPodiumRef.current(podiumSoFar());
        }
      } else {
        // Terminada: unos segundos para ver el podio y el bucle se apaga.
        idleAfterEnd += dt;
        if (idleAfterEnd > 5) {
          cancelAnimationFrame(raf);
          return;
        }
      }
      draw();
    }
    raf = requestAnimationFrame(frame);

    // Pestaña oculta: nada que mirar, nada que calcular.
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        carry = 0;
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [world, seed, startedAt]);

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1">
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
}

/**
 * El panel: sala de espera hasta que hay semilla, pista a partir de ahí.
 *
 * Solo quien abrió la sala elige mundo y da la salida; los demás ven a quién
 * están esperando. Es lo que evita que dos personas reinicien la carrera a la
 * vez y nadie llegue a ver el final.
 */
export function MarbleRace({
  lobby,
  racers,
  isHost,
  racing,
  onWorld,
  onStart,
  onLeave,
}: {
  lobby: RaceLobby;
  /** Quienes corren, en el orden que manda la instancia. */
  racers: Racer[];
  isHost: boolean;
  /** Falso si te apuntaste con la carrera ya en marcha: miras esta, corres la siguiente. */
  racing: boolean;
  onWorld: (world: number) => void;
  onStart: () => void;
  onLeave: () => void;
}) {
  const t = useT();
  const [podium, setPodium] = useState<Racer[]>([]);
  const waiting = lobby.seed === null;
  const host = racers.find((r) => r.id === lobby.host_id);

  // El podio es de esta carrera: al arrancar otra hay que dejarlo en blanco.
  useEffect(() => setPodium([]), [lobby.seed]);

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg/95 backdrop-blur-sm">
      <header className="flex flex-wrap items-center gap-2 border-b border-line/60 px-3 py-2">
        <Trophy size={16} className="text-accent" />
        <h3 className="display mr-auto text-sm font-bold">{t("race.title")}</h3>
        {WORLDS.map((spec, i) => (
          <button
            key={spec.key}
            onClick={() => onWorld(i)}
            disabled={!isHost || !waiting}
            aria-pressed={i === lobby.world}
            className={`btn h-8 min-h-8 px-3 text-xs ${i === lobby.world ? "btn-primary" : "btn-ghost"}`}
          >
            {t(spec.key as MessageKey)}
          </button>
        ))}
        {isHost ? (
          <button onClick={onStart} className="btn btn-primary h-8 min-h-8 px-3 text-xs">
            <Flag size={14} />
            {waiting ? t("race.start") : t("race.again")}
          </button>
        ) : null}
        <button
          onClick={onLeave}
          className="btn btn-ghost h-8 min-h-8 px-2 text-xs"
          aria-label={t("race.leave")}
        >
          <X size={16} />
        </button>
      </header>

      {waiting ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-y-auto p-6 text-center">
          <h4 className="display text-lg font-bold">
            {t("race.lobbyTitle", { count: racers.length })}
          </h4>
          <p className="max-w-sm text-sm text-muted">
            {isHost ? t("race.lobbyHostHint") : t("race.lobbyGuestHint", { name: host?.name ?? "…" })}
          </p>
          <ul className="flex flex-wrap justify-center gap-4">
            {racers.map((racer) => (
              <li key={racer.id} className="flex w-20 flex-col items-center gap-1">
                <Avatar name={racer.name} url={racer.avatarUrl} id={racer.id} size={48} />
                <span className="w-full truncate text-xs font-medium">{racer.name}</span>
                {racer.id === lobby.host_id ? (
                  <span className="text-[0.65rem] text-accent">{t("race.host")}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <RaceTrack
          world={lobby.world}
          seed={lobby.seed ?? 0}
          startedAt={lobby.started_at}
          racers={racers}
          onPodium={setPodium}
        />
      )}

      <footer className="flex min-h-9 items-center gap-3 overflow-x-auto border-t border-line/60 px-3 py-2 text-xs">
        {waiting ? (
          <span className="text-muted">{t("race.waiting")}</span>
        ) : !racing ? (
          <span className="text-muted">{t("race.nextRound")}</span>
        ) : podium.length === 0 ? (
          <span className="text-muted">{t("race.running")}</span>
        ) : (
          podium.map((racer, i) => (
            <span key={racer.id} className="flex shrink-0 items-center gap-1.5">
              <span className="font-semibold text-muted">{i + 1}.</span>
              <Avatar name={racer.name} url={racer.avatarUrl} id={racer.id} size={18} />
              <span className={i === 0 ? "font-bold text-accent" : ""}>{racer.name}</span>
            </span>
          ))
        )}
      </footer>
    </div>
  );
}
