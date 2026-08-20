/**
 * Iconos que reaccionan (§10.2).
 * Geometría y coreografía portadas de animate-ui (github.com/imskyleen/animate-ui,
 * MIT): el engranaje gira, las ondas del volumen laten, la gente da un saltito,
 * el panel empuja su línea. Allí cada icono es un componente de `motion`; aquí
 * los mismos movimientos son @keyframes de styles.css disparados por el :hover
 * del botón que los contiene, así no entra un motor de animación entero en el
 * paquete para mover seis trazos.
 *
 * Cambiar a los componentes originales es instalar `motion` y sustituir este
 * archivo: el resto de la aplicación solo ve <Gear size={17} />.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({ size = 18, className = "", children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={`ai ${className}`}
    >
      {children}
    </svg>
  );
}

/** Engranaje que gira medio giro al pasar por encima. */
export function Gear(props: IconProps) {
  return (
    <Svg {...props}>
      <g className="ai-spin">
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
        <circle cx={12} cy={12} r={3} />
      </g>
    </Svg>
  );
}

/**
 * Panel lateral. Abierto, la banda va rellena; cerrado, vacía: el estado se ve
 * por la forma y no solo por el color (§31). Al pasar el ratón, la línea se
 * acerca al borde, que es justo lo que hará el panel al plegarse.
 */
export function Panel({ side = "left", open = false, ...props }: IconProps & { side?: "left" | "right"; open?: boolean }) {
  return (
    <Svg {...props} className={side === "right" ? "ai-flip" : ""}>
      <rect width={18} height={18} x={3} y={3} rx={2} ry={2} />
      {/* La banda llega hasta el centro de la línea divisoria (x=9) y no hasta
          su borde (x=8): si no, el trazo de 2px de la línea y el relleno se
          sumaban en un bloque grueso a la izquierda. El radio 1 de las esquinas
          es el del marco (2) menos el medio trazo, así que encajan en vez de
          dejar un escalón. */}
      {open ? (
        <path className="ai-slide" d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4z" fill="currentColor" stroke="none" />
      ) : null}
      <line className="ai-slide" x1={9} y1={3} x2={9} y2={21} />
    </Svg>
  );
}

/** Cada figura da su saltito, con un desfase entre ellas. */
export function People(props: IconProps) {
  return (
    <Svg {...props}>
      <path className="ai-hop-1" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle className="ai-hop-2" cx={9} cy={7} r={4} />
      <path className="ai-hop-3" d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path className="ai-hop-4" d="M16 3.13a4 4 0 0 1 0 7.75" />
    </Svg>
  );
}

/** El más y la equis son el mismo icono: girar 45° lo convierte en cerrar. */
export function Cross({ open = false, ...props }: IconProps & { open?: boolean }) {
  return (
    <Svg {...props} className={open ? "ai-cross-open" : ""}>
      <g className="ai-quarter">
        <line x1={5} y1={12} x2={19} y2={12} />
        <line x1={12} y1={5} x2={12} y2={19} />
      </g>
    </Svg>
  );
}

/** Las ondas laten hacia fuera, una detrás de otra. */
export function Speaker({ muted = false, ...props }: IconProps & { muted?: boolean }) {
  return (
    <Svg {...props}>
      <path d="M11 5 6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l5 4z" />
      {muted ? (
        <>
          <line x1={22} y1={9} x2={16} y2={15} />
          <line x1={16} y1={9} x2={22} y2={15} />
        </>
      ) : (
        <>
          <path className="ai-wave-1" d="M16 9a5 5 0 0 1 0 6" />
          <path className="ai-wave-2" d="M19.4 6.3a9 9 0 0 1 0 11.4" />
        </>
      )}
    </Svg>
  );
}

/** El micrófono sube y baja un pelo; tachado, la barra se dibuja sola. */
export function Microphone({ muted = false, ...props }: IconProps & { muted?: boolean }) {
  return (
    <Svg {...props}>
      <g className="ai-lift">
        <rect x={9} y={2} width={6} height={11} rx={3} />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1={12} y1={19} x2={12} y2={22} />
      </g>
      {muted ? <line className="ai-strike" x1={3} y1={3} x2={21} y2={21} /> : null}
    </Svg>
  );
}

export function Headset({ muted = false, ...props }: IconProps & { muted?: boolean }) {
  return (
    <Svg {...props}>
      <path className="ai-lift" d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
      {muted ? <line className="ai-strike" x1={3} y1={3} x2={21} y2={21} /> : null}
    </Svg>
  );
}

/** El avión sale disparado y vuelve. */
export function Send(props: IconProps) {
  return (
    <Svg {...props}>
      <g className="ai-launch">
        <path d="m3 3 3 9-3 9 19-9Z" />
        <path d="M6 12h10" />
      </g>
    </Svg>
  );
}

/**
 * La flecha sube al pasar el ratón, como si el archivo acabara de salir.
 * Geometría y coreografía: icono "Upload" de animate-ui, mismo trazo que ya
 * traíamos con lucide-react bajo otro nombre (createLucideIcon("Upload", ...)).
 * El grupo que sube es la flecha; la bandeja de abajo se queda quieta.
 */
export function Upload(props: IconProps) {
  return (
    <Svg {...props}>
      <g className="ai-lift">
        <path d="M12 3v12" />
        <path d="m7 8 5-5 5 5" />
      </g>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    </Svg>
  );
}
