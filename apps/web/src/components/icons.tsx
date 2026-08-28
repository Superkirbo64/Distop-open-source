/**
 * Iconos animados de interacción.
 *
 * Geometría y coreografías portadas de Animate UI
 * (MIT + Commons Clause; ver THIRD_PARTY_NOTICES.md):
 * https://github.com/imskyleen/animate-ui/tree/main/apps/www/registry/icons
 *
 * Las coreografías viven en styles.css (bloque "Iconos animados"), no aquí:
 * antes las orquestaba motion/react con listeners sobre el botón ancestro, y
 * este fichero era su único importador en todo el repo — moverlas a CSS saca
 * la librería entera del bundle. El disparador es el mismo ancestro
 * interactivo que buscaba el closest() de antes, ahora vía :hover /
 * :focus-within, así que aquí solo queda geometría: cada parte animable lleva
 * data-anim y el CSS decide qué keyframes le tocan. De regalo, los iconos
 * ahora obedecen también data-motion="off" además de prefers-reduced-motion,
 * porque el kill-switch global de styles.css alcanza a cualquier animación.
 */

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

/** `ai` (animated icon) + la clase del icono + lo que traiga el consumidor. */
function cls(base: string, extra?: string): string {
  return extra ? `${base} ${extra}` : base;
}

/** Animate UI: settings. */
export function Gear({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-gear", className)} {...svgProps}>
      <g data-anim="gear">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx={12} cy={12} r={3} />
      </g>
    </svg>
  );
}

/** Animate UI: users. */
export function People({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-people", className)} {...svgProps}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" data-anim="near" />
      <path d="M16 3.128a4 4 0 0 1 0 7.744" data-anim="far" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" data-anim="far" />
      <circle cx={9} cy={7} r={4} data-anim="near" />
    </svg>
  );
}

/**
 * Animate UI: X, animación `plus` invertida para que el estado base sea +.
 *
 * El original morfaba los atributos x1..y2 de dos <line> (los brazos crecían
 * de 13.86 a 16.97 unidades al pasar de + a ×), y atributos no se pueden
 * animar desde CSS. Aproximación transform-only: el + es geometría fija y el
 * hover gira el grupo 0→90° —pasa por la × a mitad de camino y aterriza otra
 * vez en +, sin salto final— con una micro-escala que insinúa el alargamiento
 * del morph. La diferencia de longitud de brazo queda bajo el píxel a los
 * 15-20 px a los que se pinta este icono.
 */
export function Cross({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-cross", className)} {...svgProps}>
      <g data-anim="glyph">
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </g>
    </svg>
  );
}

/** Animate UI: volume-2 / volume-off. */
export function Speaker({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  if (muted) {
    return (
      <svg width={size} height={size} className={cls("ai ai-speaker", className)} data-anim="shake" {...svgProps}>
        <path d="M16 9a5 5 0 0 1 .95 2.293" />
        <path d="M19.364 5.636a9 9 0 0 1 1.889 9.96" />
        {/* pathLength=1 normaliza el trazo para que el patrón dasharray:1 de
            .ai-draw lo dibuje entero al montarse, como el pathLength de antes. */}
        <path d="m2 2 20 20" pathLength={1} className="ai-draw" />
        <path d="m7 7-.587.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298V11" />
        <path d="M9.828 4.172A.686.686 0 0 1 11 4.657v.686" />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} className={cls("ai ai-speaker", className)} {...svgProps}>
      <path d="M16 9a5 5 0 0 1 0 6" data-anim="wave-a" />
      <path d="M19.364 18.364a9 9 0 0 0 0-12.728" data-anim="wave-b" />
      <path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z" />
    </svg>
  );
}

/** Canales de texto: las dos barras se cruzan como una pequeña señal. */
export function ChannelHash({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-hash", className)} {...svgProps}>
      <g data-anim="stems">
        <path d="M10 3 8 21" />
        <path d="m16 3-2 18" />
      </g>
      <g data-anim="bars">
        <path d="M4 9h16" />
        <path d="M3 15h16" />
      </g>
    </svg>
  );
}

/**
 * Canales de anuncios: megáfono lu-megaphone de animateicons.in (geometría
 * Lucide, ISC). El "shout" original — rotate [0,-6,4,-2,0] + scale sutil vía
 * motion/react — vive en styles.css como ai-announce-body, igual que el resto
 * de coreografías portadas.
 */
export function Announcement({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-announce", className)} {...svgProps}>
      <g data-anim="body">
        <path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
        <path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" />
        <path d="M8 6v8" />
      </g>
    </svg>
  );
}

/**
 * Brújula de "Explorar comunidades". Geometría de Lucide (compass) con el
 * patrón de la casa: la aguja lleva data-anim y styles.css decide la
 * coreografía — oscila buscando el norte y aterriza donde estaba.
 */
export function Compass({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-compass", className)} {...svgProps}>
      <circle cx={12} cy={12} r={10} />
      <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" data-anim="needle" />
    </svg>
  );
}

/** Animate UI: send. */
export function Send({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-send", className)} {...svgProps}>
      <g data-anim="jet">
        <path d="M14.5,21.7c.1.3.4.4.7.3.1,0,.2-.2.3-.3L22,2.7c0-.3,0-.5-.3-.6-.1,0-.2,0-.3,0L2.3,8.5c-.3,0-.4.4-.3.6,0,.1.2.2.3.3l7.9,3.2c.5.2.9.6,1.1,1.1l3.2,7.9Z" />
        <path d="M21.9,2.1l-10.9,10.9" />
      </g>
    </svg>
  );
}

/** Animate UI: upload. */
export function Upload({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-upload", className)} {...svgProps}>
      <g data-anim="arrow">
        <path d="M12 3v12" />
        <path d="m17 8-5-5-5 5" />
      </g>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </svg>
  );
}

/**
 * Animate UI todavía no publica micrófono ni auriculares. Se conserva la
 * geometría de Lucide que usa el resto de la aplicación y se aplica el patrón
 * oficial `default-loop` + `off`: elevación en hover y tachado dibujado.
 */
function VoiceStrike() {
  return <line x1={3} y1={3} x2={21} y2={21} pathLength={1} className="ai-draw" />;
}

export function Microphone({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  return (
    <svg width={size} height={size} className={cls("ai ai-voice", className)} {...svgProps}>
      <g data-anim="lift">
        <rect x={9} y={2} width={6} height={11} rx={3} />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1={12} y1={19} x2={12} y2={22} />
      </g>
      {muted ? <VoiceStrike /> : null}
    </svg>
  );
}

export function Headset({ muted = false, size = 18, className }: IconProps & { muted?: boolean }) {
  return (
    <svg width={size} height={size} className={cls("ai ai-voice", className)} {...svgProps}>
      <path
        d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"
        data-anim="lift"
      />
      {muted ? <VoiceStrike /> : null}
    </svg>
  );
}

/** Animate UI: party-popper. */
export function PartyPopper({ size = 18, className }: IconProps) {
  return (
    <svg width={size} height={size} className={cls("ai ai-popper", className)} {...svgProps}>
      <path d="M5.8 11.3 2 22l10.7-3.79" data-anim="cone" />
      <path d="M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z" data-anim="cone" />
      <path d="M4 3h.01" data-anim="dot" />
      <path d="M22 8h.01" data-anim="dot" />
      <path d="M15 2h.01" data-anim="dot" />
      <path d="M22 20h.01" data-anim="dot" />
      <path d="m14 10 1.21-1.06c.16-.84.9-1.44 1.76-1.44h.38c.88 0 1.55-.77 1.45-1.63a2.9 2.9 0 0 1 1.96-3.12L22 2" pathLength={1} data-anim="streamer" />
      <path d="M17 15h.77c.71 0 1.32-.52 1.43-1.22.16-.91 1.12-1.45 1.98-1.11L22 13" pathLength={1} data-anim="streamer" />
      <path d="M9 7V6.23c0-.71.52-1.33 1.22-1.43.91-.16 1.45-1.12 1.11-1.98L11 2" pathLength={1} data-anim="streamer" />
    </svg>
  );
}
