/**
 * Presupuesto de vídeo (V3, §8.7 del plan).
 *
 * No hay SFU y no se va a construir ahora. Con el vídeo pasando por la
 * instancia, `relayMedia` copia cada fotograma y lo reenvía una vez por cada
 * persona menos el emisor: cuatro cámaras a 4 Mbps entre ocho personas son
 * ~112 Mbps de subida en el PC de quien hospeda. Eso no cabe en una conexión
 * doméstica, y fingir que sí produce una llamada en la que **todos** se ven mal.
 *
 * Así que se decide antes de aceptar la fuente, no después de que se caiga.
 *
 * Dos principios que el resto del módulo solo desarrolla:
 *
 * 1. **Los presentadores tienen prioridad, no inmunidad.** Seis presentadores
 *    saturan igual que seis asistentes. Ninguna reserva rompe el techo físico.
 * 2. **El cliente no declara su propia prioridad.** Sale de su papel en la
 *    reunión y del tipo de fuente, los dos calculados aquí. Si la declarase él,
 *    "prioridad" sería una palabra que cualquiera puede escribir en un JSON.
 */
import type { VideoSource } from "@distop/protocol";

/**
 * Cuánto ocupa una fuente, en kbps, por cada persona que la recibe.
 *
 * La pantalla compartida pesa menos de lo que parece cuando no se mueve, pero
 * un desplazamiento o un vídeo dentro la disparan; se presupuesta por lo alto,
 * porque quedarse corto se nota y sobrar no.
 */
export const COSTE_KBPS: Record<VideoSource, number> = {
  screen: 1800,
  camera: 1200,
};

/**
 * Techo de subida del anfitrión, en kbps.
 *
 * Estimación conservadora de una conexión doméstica corriente. Se puede
 * cambiar: quien hospeda sabe lo que tiene mejor que nosotros.
 */
export const TECHO_POR_DEFECTO_KBPS = 20_000;

/** Nadie se queda sin poder enseñar nada: siempre cabe una fuente. */
export const MINIMO_FUENTES = 1;

/**
 * Prioridad, de más a menos. El orden es el del plan y no es arbitrario:
 *
 * - La **pantalla compartida** es casi siempre el contenido de la reunión. Si
 *   algo tiene que caerse, no es lo que todo el mundo está mirando.
 * - La **cámara de quien presenta** va después: ver la cara de quien explica
 *   cambia una reunión; ver la de quien escucha, mucho menos.
 * - Después quien **modera y está hablando**.
 * - Después el resto, por orden de llegada.
 */
export const PRIORIDAD = {
  PANTALLA: 0,
  CAMARA_PRESENTADOR: 1,
  MODERADOR_HABLANDO: 2,
  DINAMICO: 3,
} as const;

export type Prioridad = (typeof PRIORIDAD)[keyof typeof PRIORIDAD];

export interface Emisor {
  userId: string;
  source: VideoSource;
  /** Papel en la reunión, o null en una sala de voz normal. */
  role: "host" | "cohost" | "presenter" | "attendee" | "viewer" | null;
  /** Si está mudo, no está hablando. */
  speaking: boolean;
  /** Desde cuándo transmite: desempata por orden de llegada. */
  since: number;
}

/**
 * Qué prioridad le toca. **Calculada aquí**, nunca recibida.
 *
 * Fuera de una reunión (`role === null`) no hay presentadores ni organizadores,
 * así que solo cuentan la pantalla y el orden de llegada: una sala de voz de
 * siempre no tiene jerarquía y no se le inventa una.
 */
export function prioridadDe(emisor: Emisor): Prioridad {
  if (emisor.source === "screen") return PRIORIDAD.PANTALLA;
  if (emisor.role === "presenter") return PRIORIDAD.CAMARA_PRESENTADOR;
  if ((emisor.role === "host" || emisor.role === "cohost") && emisor.speaking) return PRIORIDAD.MODERADOR_HABLANDO;
  return PRIORIDAD.DINAMICO;
}

/** Más prioritario primero; a igualdad, quien llegó antes. */
export function ordenar(emisores: Emisor[]): Emisor[] {
  return [...emisores].sort((a, b) => {
    const pa = prioridadDe(a);
    const pb = prioridadDe(b);
    return pa !== pb ? pa - pb : a.since - b.since;
  });
}

export type Modo = "host" | "direct";

export interface Presupuesto {
  /** Cuántas fuentes caben a la vez. */
  cabidas: number;
  /** Coste estimado de lo aceptado, en kbps de subida del anfitrión. */
  coste_kbps: number;
  /** Quién transmite y quién espera turno. */
  activos: Emisor[];
  cola: Emisor[];
  /** El techo que se aplicó, para poder explicarlo en la interfaz. */
  techo_kbps: number;
  modo: Modo;
}

export interface Entrada {
  emisores: Emisor[];
  /** Cuánta gente hay en la sala, emisores incluidos. */
  participantes: number;
  modo: Modo;
  techoKbps?: number;
  /**
   * La instancia va apretada por otra cosa (una copia, un backfill). Se reserva
   * margen antes de que la voz empiece a entrecortarse: una voz rota es un
   * fallo visible y una cámara de menos, una molestia.
   */
  presion?: boolean;
}

/** Cuánto del techo se conserva cuando la instancia va apretada. */
export const FACTOR_PRESION = 0.6;

/**
 * Reparte el ancho de banda disponible entre quien quiere transmitir.
 *
 * En modo `direct` el servidor **no ve el bitrate real**: cada cliente sostiene
 * conexiones múltiples y el coste crece entre participantes, no en el
 * anfitrión. Ahí este cálculo no manda —el presupuesto se aplica desde los
 * clientes— y lo único que se conserva es el orden de prioridad, para que las
 * dos vistas coincidan en quién importa. Medir los dos modos con la misma vara
 * daría un número falso en uno de los dos.
 */
export function repartir(entrada: Entrada): Presupuesto {
  const techo = Math.max(0, entrada.techoKbps ?? TECHO_POR_DEFECTO_KBPS) * (entrada.presion ? FACTOR_PRESION : 1);
  const ordenados = ordenar(entrada.emisores);

  if (entrada.modo === "direct") {
    /* Sin relay no hay subida del anfitrión que gastar. El tope es el de la
       propia sala, y quien lo hace cumplir es cada cliente. */
    return {
      cabidas: ordenados.length,
      coste_kbps: 0,
      activos: ordenados,
      cola: [],
      techo_kbps: Math.round(techo),
      modo: "direct",
    };
  }

  /* Cada fuente se copia una vez por cada persona menos quien la manda. */
  const receptores = Math.max(1, entrada.participantes - 1);
  const activos: Emisor[] = [];
  const cola: Emisor[] = [];
  let coste = 0;

  for (const emisor of ordenados) {
    const suyo = COSTE_KBPS[emisor.source] * receptores;
    /* El mínimo garantiza que siempre quepa UNA fuente: una reunión en la que
       nadie puede enseñar nada no es una reunión, y una conexión mala no debe
       convertirla en un teléfono. */
    const cabe = coste + suyo <= techo || activos.length < MINIMO_FUENTES;
    if (cabe) {
      activos.push(emisor);
      coste += suyo;
    } else {
      /* Y aquí "prioridad, no inmunidad" se hace verdad: una pantalla
         compartida entra la primera, pero la sexta pantalla compartida espera
         igual que todo lo demás. */
      cola.push(emisor);
    }
  }

  return {
    cabidas: activos.length,
    coste_kbps: Math.round(coste),
    activos,
    cola,
    techo_kbps: Math.round(techo),
    modo: "host",
  };
}

export interface Veredicto {
  admitido: boolean;
  /** A quién hay que retirar para que quepa. Vacío si no hace falta. */
  desplazados: string[];
  presupuesto: Presupuesto;
}

/**
 * ¿Se acepta esta fuente nueva?
 *
 * Se calcula con el candidato dentro, no comparando contra un hueco libre: si
 * el candidato es más prioritario que alguien que ya transmite, la respuesta
 * correcta no es "no cabes" sino "cabes tú y sale el otro". Preguntarlo al
 * revés dejaría una pantalla compartida esperando detrás de tres cámaras.
 */
export function admitir(entrada: Entrada, candidato: Emisor): Veredicto {
  const antes = new Set(entrada.emisores.map((e) => e.userId));
  const conCandidato = antes.has(candidato.userId)
    ? entrada.emisores.map((e) => (e.userId === candidato.userId ? candidato : e))
    : [...entrada.emisores, candidato];

  const presupuesto = repartir({ ...entrada, emisores: conCandidato });
  const admitido = presupuesto.activos.some((e) => e.userId === candidato.userId);
  const desplazados = presupuesto.cola
    .filter((e) => e.userId !== candidato.userId && antes.has(e.userId))
    .map((e) => e.userId);

  return { admitido, desplazados, presupuesto };
}

/**
 * Lo que se le dice a la gente cuando algo no cabe.
 *
 * En texto plano y sin culpar a nadie: el problema es la conexión del
 * anfitrión, no la persona que quiso encender la cámara.
 */
export function explicacion(presupuesto: Presupuesto): string | null {
  if (presupuesto.cola.length === 0) return null;
  return "La conexión del anfitrión no puede mantener todas las cámaras. La pantalla compartida tiene prioridad.";
}
