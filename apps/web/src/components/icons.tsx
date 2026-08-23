/**
 * Iconos animados de interacción.
 *
 * Geometría y coreografías portadas de Animate UI
 * (MIT + Commons Clause; ver THIRD_PARTY_NOTICES.md):
 * https://github.com/imskyleen/animate-ui/tree/main/apps/www/registry/icons
 *
 * Animate UI anima el propio SVG al recibir hover. En Distop el objetivo
 * interactivo suele ser un botón bastante mayor que el dibujo, así que este
 * adaptador dispara sus mismos variants desde el ancestro interactivo. También
 * respeta prefers-reduced-motion y deja todos los iconos quietos en ese caso.
 */
import { useEffect, useRef } from "react";
import { motion, useAnimation, useReducedMotion, type Variants } from "motion/react";

interface IconProps {
  size?: number;
  className?: string;
}

const svgProps = {
  xmlns: "http://www.w3.org/2000/svg",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

/** Une la animación al botón completo, no solo a los 16 px del SVG. */
function useInteractiveAnimation() {
  const ref = useRef<SVGSVGElement>(null);
  const controls = useAnimation();
  const reduced = useReducedMotion();

  useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    if (reduced) {
      controls.set("initial");
      return;
    }
    const target = svg.closest("button, a, label, summary, [role='menuitem'], [role='button']") ?? svg;
    let pointerInside = false;
    let focusInside = false;
    const sync = () => void controls.start(pointerInside || focusInside ? "animate" : "initial");
    const enterPointer = () => {
      pointerInside = true;
      sync();
    };
    const leavePointer = () => {
      pointerInside = false;
      sync();
    };
    const enterFocus = () => {
      focusInside = true;
      sync();
    };
    const leaveFocus = () => {
      focusInside = false;
      sync();
    };
    target.addEventListener("pointerenter", enterPointer);
    target.addEventListener("pointerleave", leavePointer);
    target.addEventListener("focusin", enterFocus);
    target.addEventListener("focusout", leaveFocus);
    return () => {
      target.removeEventListener("pointerenter", enterPointer);
      target.removeEventListener("pointerleave", leavePointer);
      target.removeEventListener("focusin", enterFocus);
      target.removeEventListener("focusout", leaveFocus);
    };
  }, [controls, reduced]);

  return { ref, controls, reduced };
}

/** Animate UI: settings. */
const gearVariants: Variants = {
  initial: { rotate: 0 },
  animate: { rotate: [0, 90, 180], transition: { duration: 1.25, ease: "easeInOut" } },
};

export function Gear({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={gearVariants} initial="initial" animate={controls}>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx={12} cy={12} r={3} />
      </motion.g>
    </motion.svg>
  );
}

/** Animate UI: users. */
const peopleVariants = {
  near: {
    initial: { y: 0 },
    animate: { y: [0, 2, -2, 0], transition: { duration: 0.6, ease: "easeInOut", delay: 0.1 } },
  } satisfies Variants,
  far: {
    initial: { y: 0 },
    animate: { y: [0, 4, -2, 0], transition: { duration: 0.6, ease: "easeInOut" } },
  } satisfies Variants,
};

export function People({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" variants={peopleVariants.near} initial="initial" animate={controls} />
      <motion.path d="M16 3.128a4 4 0 0 1 0 7.744" variants={peopleVariants.far} initial="initial" animate={controls} />
      <motion.path d="M22 21v-2a4 4 0 0 0-3-3.87" variants={peopleVariants.far} initial="initial" animate={controls} />
      <motion.circle cx={9} cy={7} r={4} variants={peopleVariants.near} initial="initial" animate={controls} />
    </motion.svg>
  );
}

/** Animate UI: X, animación `plus` invertida para que el estado base sea +. */
const plusLineOne: Variants = {
  initial: { rotate: 45, x1: 7.1, y1: 16.9, x2: 16.9, y2: 7.1 },
  animate: { rotate: 0, x1: 6, y1: 18, x2: 18, y2: 6, transition: { duration: 0.3, ease: "easeInOut" } },
};
const plusLineTwo: Variants = {
  initial: { rotate: 45, x1: 7.1, y1: 7.1, x2: 16.9, y2: 16.9 },
  animate: { rotate: 0, x1: 6, y1: 6, x2: 18, y2: 18, transition: { duration: 0.3, ease: "easeInOut", delay: 0.1 } },
};

export function Cross({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.line variants={plusLineOne} initial="initial" animate={controls} />
      <motion.line variants={plusLineTwo} initial="initial" animate={controls} />
    </motion.svg>
  );
}

/** Animate UI: volume-2 / volume-off. */
const wave = (delay: number): Variants => ({
  initial: { opacity: 1, scale: 1 },
  animate: {
    opacity: [1, 0, 1],
    scale: [1, 0, 1],
    transition: { duration: 0.6, ease: "easeInOut", delay },
  },
});
const shake: Variants = {
  initial: { x: 0 },
  animate: { x: [0, "-7%", "7%", "-7%", "7%", 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

export function Speaker({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  const { ref, controls, reduced } = useInteractiveAnimation();
  if (muted) {
    return (
      <motion.svg ref={ref} width={size} height={size} className={className} variants={shake} initial="initial" animate={controls} {...svgProps}>
        <path d="M16 9a5 5 0 0 1 .95 2.293" />
        <path d="M19.364 5.636a9 9 0 0 1 1.889 9.96" />
        <motion.path d="m2 2 20 20" initial={reduced ? false : { opacity: 0, pathLength: 0 }} animate={{ opacity: 1, pathLength: 1 }} transition={{ duration: 0.6, ease: "easeInOut" }} />
        <path d="m7 7-.587.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298V11" />
        <path d="M9.828 4.172A.686.686 0 0 1 11 4.657v.686" />
      </motion.svg>
    );
  }
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.path d="M16 9a5 5 0 0 1 0 6" variants={wave(0)} initial="initial" animate={controls} />
      <motion.path d="M19.364 18.364a9 9 0 0 0 0-12.728" variants={wave(0.2)} initial="initial" animate={controls} />
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    </motion.svg>
  );
}

/** Canales de texto: las dos barras se cruzan como una pequeña señal. */
const hashBars: Variants = {
  initial: { x: 0 },
  animate: { x: [0, -1.25, 1.25, 0], transition: { duration: 0.55, ease: "easeInOut" } },
};
const hashStems: Variants = {
  initial: { y: 0 },
  animate: { y: [0, 1, -1, 0], transition: { duration: 0.55, ease: "easeInOut" } },
};

export function ChannelHash({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={hashStems} initial="initial" animate={controls}>
        <path d="M10 3 8 21" />
        <path d="m16 3-2 18" />
      </motion.g>
      <motion.g variants={hashBars} initial="initial" animate={controls}>
        <path d="M4 9h16" />
        <path d="M3 15h16" />
      </motion.g>
    </motion.svg>
  );
}

/** Canales de anuncios: el megáfono da un golpe corto y emite dos ondas. */
const announcementBody: Variants = {
  initial: { rotate: 0, x: 0 },
  animate: { rotate: [0, -4, 3, 0], x: [0, -0.5, 0.5, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};
const announcementWave = (delay: number): Variants => ({
  initial: { opacity: 1, pathLength: 1 },
  animate: { opacity: [0, 1, 0.35, 1], pathLength: [0, 1, 1, 1], transition: { duration: 0.6, delay, ease: "easeInOut" } },
});

export function Announcement({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={announcementBody} initial="initial" animate={controls} style={{ transformOrigin: "8px 12px" }}>
        <path d="m3 11 18-5v12L3 14v-3Z" />
        <path d="m7.2 15.2.8 5.3a1 1 0 0 0 1 .8h2a1 1 0 0 0 1-1.2l-.8-3.3" />
      </motion.g>
      <motion.path d="M21 9.5c1 .7 1 4.3 0 5" variants={announcementWave(0)} initial="initial" animate={controls} />
      <motion.path d="M23 8c1.3 1.2 1.3 6.8 0 8" variants={announcementWave(0.1)} initial="initial" animate={controls} />
    </motion.svg>
  );
}

/** Animate UI: send. */
const sendVariants: Variants = {
  initial: { scale: 1, x: 0, y: 0 },
  animate: {
    scale: [1, 0.8, 1, 1, 1],
    x: [0, "-10%", "100%", "-125%", 0],
    y: [0, "10%", "-100%", "125%", 0],
    transition: { duration: 1.2, ease: "easeInOut", times: [0, 0.25, 0.5, 0.5, 1] },
  },
};

export function Send({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={sendVariants} initial="initial" animate={controls}>
        <path d="M14.5,21.7c.1.3.4.4.7.3.1,0,.2-.2.3-.3L22,2.7c0-.3,0-.5-.3-.6-.1,0-.2,0-.3,0L2.3,8.5c-.3,0-.4.4-.3.6,0,.1.2.2.3.3l7.9,3.2c.5.2.9.6,1.1,1.1l3.2,7.9Z" />
        <path d="M21.9,2.1l-10.9,10.9" />
      </motion.g>
    </motion.svg>
  );
}

/** Animate UI: upload. */
const uploadVariants: Variants = {
  initial: { y: 0, transition: { duration: 0.3, ease: "easeInOut" } },
  animate: { y: -2, transition: { duration: 0.3, ease: "easeInOut" } },
};

export function Upload({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={uploadVariants} initial="initial" animate={controls}>
        <path d="M12 3v12" />
        <path d="m17 8-5-5-5 5" />
      </motion.g>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </motion.svg>
  );
}

/**
 * Animate UI todavía no publica micrófono ni auriculares. Se conserva la
 * geometría de Lucide que usa el resto de la aplicación y se aplica el patrón
 * oficial `default-loop` + `off`: elevación en hover y tachado dibujado.
 */
const voiceLift: Variants = {
  initial: { y: 0 },
  animate: { y: [0, -2, 0], transition: { duration: 0.6, ease: "easeInOut" } },
};

function VoiceStrike({ reduced }: { reduced: boolean | null }) {
  return (
    <motion.line
      x1={3}
      y1={3}
      x2={21}
      y2={21}
      initial={reduced ? false : { opacity: 0, pathLength: 0 }}
      animate={{ opacity: 1, pathLength: 1 }}
      transition={{ duration: 0.6, ease: "easeInOut" }}
    />
  );
}

export function Microphone({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  const { ref, controls, reduced } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.g variants={voiceLift} initial="initial" animate={controls}>
        <rect x={9} y={2} width={6} height={11} rx={3} />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1={12} y1={19} x2={12} y2={22} />
      </motion.g>
      {muted ? <VoiceStrike reduced={reduced} /> : null}
    </motion.svg>
  );
}

export function Headset({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  const { ref, controls, reduced } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.path
        d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"
        variants={voiceLift}
        initial="initial"
        animate={controls}
      />
      {muted ? <VoiceStrike reduced={reduced} /> : null}
    </motion.svg>
  );
}

/** Animate UI: party-popper. */
const popperCone: Variants = {
  initial: { x: 0, y: 0 },
  animate: { x: [-1.5, 0], y: [1.5, 0], transition: { duration: 0.7 } },
};
const popperDots: Variants = {
  initial: { opacity: 1, scale: 1, x: 0, y: 0 },
  animate: {
    opacity: [0, 1],
    scale: [0.5, 0.8, 1, 1.1, 1],
    x: [-5, 0],
    y: [5, 0],
    transition: { duration: 0.7 },
  },
};
const popperStreamers: Variants = {
  initial: { opacity: 1, pathLength: 1, scale: 1, x: 0, y: 0 },
  animate: {
    opacity: [0, 1],
    scale: [0.3, 0.8, 1, 1.1, 1],
    pathLength: [0, 0.5, 1],
    x: [-5, 0],
    y: [5, 0],
    transition: { duration: 0.7 },
  },
};

export function PartyPopper({ size = 18, className }: IconProps) {
  const { ref, controls } = useInteractiveAnimation();
  return (
    <motion.svg ref={ref} width={size} height={size} className={className} {...svgProps}>
      <motion.path d="M5.8 11.3 2 22l10.7-3.79" variants={popperCone} initial="initial" animate={controls} />
      <motion.path
        d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z"
        variants={popperCone}
        initial="initial"
        animate={controls}
      />
      <motion.path d="M4 3h.01" variants={popperDots} initial="initial" animate={controls} />
      <motion.path d="M22 8h.01" variants={popperDots} initial="initial" animate={controls} />
      <motion.path d="M15 2h.01" variants={popperDots} initial="initial" animate={controls} />
      <motion.path d="M22 20h.01" variants={popperDots} initial="initial" animate={controls} />
      <motion.path
        d="m14 10 1.21-1.06c.16-.84.9-1.44 1.76-1.44h.38c.88 0 1.55-.77 1.45-1.63a2.9 2.9 0 0 1 1.96-3.12L22 2"
        variants={popperStreamers}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M17 15h.77c.71 0 1.32-.52 1.43-1.22.16-.91 1.12-1.45 1.98-1.11L22 13"
        variants={popperStreamers}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M9 7V6.23c0-.71.52-1.33 1.22-1.43.91-.16 1.45-1.12 1.11-1.98L11 2"
        variants={popperStreamers}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
