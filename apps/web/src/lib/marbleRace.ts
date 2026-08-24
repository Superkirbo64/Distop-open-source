/**
 * Simulación de la carrera de canicas (§29.1 módulos pequeños y verificables).
 *
 * Aquí no hay lienzo ni React: entra una semilla y sale una carrera. Está
 * separado del componente porque así se puede correr entera sin navegador y
 * comprobar lo único que de verdad puede romperse — que las doce canicas
 * lleguen a la meta y ninguna se quede encajada para siempre en un embudo.
 *
 * El modelo es el mismo que la vista de gravedad de la sala de voz: círculo
 * contra círculo, separación por solape e impulso a lo largo de la normal. Las
 * barras son ese mismo choque medido contra el punto más cercano del segmento.
 *
 * Y es determinista a propósito: solo usa +, -, *, / y `Math.sqrt`, que la
 * norma IEEE-754 obliga a redondear igual en todos los motores. Nada de
 * `Math.sin`, `Math.cos` ni `Math.hypot`, cuyo último bit cambia entre Chrome y
 * Firefox: en un pachinko esa diferencia crece hasta cambiar el ganador, y la
 * carrera es compartida — todas las pantallas simulan la misma semilla y tienen
 * que llegar al mismo podio.
 */

/** Ancho de la pista en unidades del mundo. La cámara escala esto al lienzo. */
export const TRACK_W = 360;
export const MARBLE_R = 10;
export const STEP = 1 / 180;
const GRAVITY = 980;
/** Tope de velocidad: por debajo de MARBLE_R por paso, así nada atraviesa nada. */
const MAX_SPEED = 1250;
const DRAG = 0.9995;
/** Altura de las franjas del índice de obstáculos. */
const BAND = 100;

/**
 * Quien corre: una persona de la sala de voz. La carrera se juega con quien
 * esté en la llamada, así que la lista cambia en cada partida y no hay nada
 * que guardar.
 */
export type Racer = {
  id: string;
  name: string;
  /** El mismo tono que usa su avatar cuando no tiene imagen (§25 identidad propia). */
  hue: number;
  initials: string;
  avatarUrl?: string | undefined;
};

/**
 * Un obstáculo: clavo (círculo) o barra (segmento con grosor).
 *
 * La barra guarda medio vector en vez de dos extremos porque así girar es
 * rotar ese vector; una barra quieta es simplemente `spin: 0`, y el mismo
 * código sirve para las dos.
 */
type Obstacle =
  | { peg: true; x: number; y: number; r: number }
  /**
   * Barra: centro más medio vector, que es lo que la hace girar sin
   * trigonometría — se multiplica ese vector por otro unitario cada paso.
   *
   * `spin` no son radianes: es el denominador del giro por paso (ángulo
   * ≈ 1/|spin| radianes) y su signo da el sentido. 0 es una barra quieta.
   */
  | { peg: false; x: number; y: number; hx: number; hy: number; r: number; spin: number };

/** Una barra girando, con su rotación por paso ya preparada. */
type Spinner = {
  obs: Extract<Obstacle, { peg: false }>;
  cs: number;
  sn: number;
  len: number;
  /** Velocidad angular en rad/s, para el empujón que da al golpear. */
  omega: number;
};

export type World = {
  /** Clave de traducción del nombre del mundo (§32: ningún texto en el código). */
  key: string;
  length: number;
  bounce: number;
  build: (rnd: () => number) => Obstacle[];
};

type Marble = {
  racer: Racer;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Puesto final, o 0 mientras corre. */
  place: number;
};

export type Race = {
  spec: World;
  bands: Map<number, Obstacle[]>;
  spinners: Spinner[];
  marbles: Marble[];
  finished: number;
};

/** Semilla reproducible: la misma semilla da exactamente la misma carrera. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const WORLDS: [World, World, World] = [
  {
    // Bosque de clavos: pachinko puro. Cae despacio y el azar manda.
    key: "race.world.pegs",
    length: 7600,
    bounce: 0.34,
    build: (rnd) => {
      const obs: Obstacle[] = [];
      for (let y = 420, row = 0; y < 7200; y += 74, row += 1) {
        // Un embudo cada diez filas: sin ellos las canicas se estiran por toda
        // la pista y no se ve una carrera, se ven doce caídas sueltas.
        //
        // La franja del embudo va SIN clavos y las barras entran en la pared:
        // cualquier rendija más estrecha que una canica es una carrera que no
        // termina nunca, y con clavos alrededor de la barra salen solas.
        if (row > 0 && row % 10 === 0) {
          obs.push({ peg: false, x: 70, y, hx: 90, hy: 30, r: 6, spin: 0 });
          obs.push({ peg: false, x: TRACK_W - 70, y, hx: -90, hy: 30, r: 6, spin: 0 });
          continue;
        }
        // Las filas pares llevan un clavo montado sobre cada pared y las
        // impares van desplazadas media casilla. Cualquier otra retícula deja
        // contra la pared una rendija de menos de una canica y ahí se quedan
        // encajadas: es el atasco que mata la carrera, no los rebotes.
        const offset = row % 2 ? 45 : 0;
        for (let x = offset; x <= TRACK_W; x += 90) {
          obs.push({ peg: true, x: x + (rnd() - 0.5) * 10, y: y + (rnd() - 0.5) * 12, r: 8 });
        }
      }
      return obs;
    },
  },
  {
    // Rampas en zigzag: se desliza, no rebota. Es la más rápida de las tres.
    key: "race.world.ramps",
    length: 8800,
    bounce: 0.22,
    build: (rnd) => {
      const obs: Obstacle[] = [];
      for (let y = 380, i = 0; y < 8400; y += 360, i += 1) {
        const left = i % 2 === 0;
        const half = TRACK_W * 0.36 + 12;
        obs.push({
          peg: false,
          x: left ? TRACK_W * 0.36 : TRACK_W * 0.64,
          y,
          hx: left ? half : -half,
          hy: 62 + rnd() * 22,
          r: 7,
          spin: 0,
        });
        // Un par de clavos sueltos en la caída para que no lleguen en fila.
        obs.push({ peg: true, x: left ? TRACK_W - 60 : 60, y: y + 180, r: 9 });
      }
      return obs;
    },
  },
  {
    // Aspas: embudo y una hélice girando en la boca que reparte suerte.
    key: "race.world.spinners",
    length: 7800,
    bounce: 0.42,
    build: (rnd) => {
      const obs: Obstacle[] = [];
      for (let y = 460, i = 0; y < 7400; y += 500, i += 1) {
        obs.push({ peg: false, x: 84, y, hx: 74, hy: 54, r: 7, spin: 0 });
        obs.push({ peg: false, x: TRACK_W - 84, y, hx: -74, hy: 54, r: 7, spin: 0 });
        obs.push({
          peg: false,
          x: TRACK_W / 2,
          y: y + 190,
          hx: 68,
          hy: 0,
          r: 7,
          // ~1,7 a 3 rad/s: 1/(k · STEP) con STEP = 1/180.
          spin: (i % 2 ? 1 : -1) * (60 + Math.floor(rnd() * 45)),
        });
        obs.push({ peg: true, x: 40, y: y + 300, r: 10 });
        obs.push({ peg: true, x: TRACK_W - 40, y: y + 300, r: 10 });
      }
      return obs;
    },
  },
];

/** Punto del segmento más cercano a (px, py). */
export function closestOnSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): [number, number] {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  if (len === 0) return [ax, ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  return [ax + dx * t, ay + dy * t];
}

/** Prepara una carrera: mundo, obstáculos indexados y una canica por persona. */
export function createRace(worldIndex: number, seed: number, racers: Racer[]): Race {
  const spec = WORLDS[worldIndex] ?? WORLDS[0];
  const rnd = mulberry32(seed);

  // Índice por franjas: cada obstáculo se apunta en todas las franjas que
  // llega a tocar, así una canica solo consulta la franja donde está.
  const bands = new Map<number, Obstacle[]>();
  const spinners: Spinner[] = [];
  for (const obs of spec.build(rnd)) {
    if (!obs.peg && obs.spin !== 0) {
      // Rotación por paso como vector unitario (k, ±1) normalizado: girar es
      // multiplicar complejos, y eso son productos y sumas — mismo resultado
      // bit a bit en cualquier navegador.
      const k = Math.abs(obs.spin);
      const sign = Math.sign(obs.spin);
      const inv = 1 / Math.sqrt(k * k + 1);
      spinners.push({
        obs,
        cs: k * inv,
        sn: sign * inv,
        len: Math.sqrt(obs.hx * obs.hx + obs.hy * obs.hy),
        omega: sign / (k * STEP),
      });
    }
    const reach = obs.peg ? obs.r : obs.r + Math.sqrt(obs.hx * obs.hx + obs.hy * obs.hy);
    for (
      let b = Math.floor((obs.y - reach) / BAND);
      b <= Math.floor((obs.y + reach) / BAND);
      b += 1
    ) {
      const list = bands.get(b);
      if (list) list.push(obs);
      else bands.set(b, [obs]);
    }
  }

  // La salida se baraja: quien esté primero en la lista de la sala no puede
  // salir siempre desde el mismo sitio de la parrilla.
  const pool = [...racers];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const a = pool[i];
    const b = pool[j];
    if (a && b) {
      pool[i] = b;
      pool[j] = a;
    }
  }
  const perRow = Math.min(6, Math.max(1, pool.length));
  const marbles = pool.map((racer, i) => ({
    racer,
    x: MARBLE_R + 16 + ((i % perRow) * (TRACK_W - 2 * (MARBLE_R + 16))) / Math.max(1, perRow - 1),
    y: 40 + Math.floor(i / perRow) * 30,
    vx: (rnd() - 0.5) * 40,
    vy: 0,
    place: 0,
  }));

  return { spec, bands, spinners, marbles, finished: 0 };
}

/** Choque contra un cuerpo inmóvil: separa y refleja a lo largo de la normal. */
function hit(
  m: Marble,
  cx: number,
  cy: number,
  radius: number,
  bounce: number,
  surfVx: number,
  surfVy: number,
): void {
  const dx = m.x - cx;
  const dy = m.y - cy;
  const min = radius + MARBLE_R;
  const d2 = dx * dx + dy * dy;
  if (d2 >= min * min) return;
  const d = Math.sqrt(d2) || 0.001;
  const nx = dx / d;
  const ny = dy / d;
  m.x = cx + nx * min;
  m.y = cy + ny * min;
  const rvx = m.vx - surfVx;
  const rvy = m.vy - surfVy;
  const along = rvx * nx + rvy * ny;
  if (along >= 0) return;
  m.vx = rvx - (1 + bounce) * along * nx + surfVx;
  m.vy = rvy - (1 + bounce) * along * ny + surfVy;
}

/** Un paso de física. `dt` fijo: con paso variable el rebote deja de ser justo. */
export function stepRace(race: Race, dt: number): void {
  const { marbles, bands, spec } = race;

  // Las barras giran una vez por paso, no una vez por canica. Se renormaliza el
  // largo en cada vuelta: sin eso el producto repetido lo va encogiendo.
  for (const spinner of race.spinners) {
    const { obs, cs, sn } = spinner;
    const nx = obs.hx * cs - obs.hy * sn;
    const ny = obs.hx * sn + obs.hy * cs;
    const scale = spinner.len / Math.sqrt(nx * nx + ny * ny);
    obs.hx = nx * scale;
    obs.hy = ny * scale;
  }

  for (const m of marbles) {
    if (m.place) continue;
    m.vy += GRAVITY * dt;
    m.vx *= DRAG;
    m.vy *= DRAG;
    const speed = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
    if (speed > MAX_SPEED) {
      m.vx = (m.vx / speed) * MAX_SPEED;
      m.vy = (m.vy / speed) * MAX_SPEED;
    }
    m.x += m.vx * dt;
    m.y += m.vy * dt;

    if (m.x < MARBLE_R) {
      m.x = MARBLE_R;
      m.vx = Math.abs(m.vx) * 0.5;
    } else if (m.x > TRACK_W - MARBLE_R) {
      m.x = TRACK_W - MARBLE_R;
      m.vx = -Math.abs(m.vx) * 0.5;
    }

    for (const obs of bands.get(Math.floor(m.y / BAND)) ?? []) {
      if (obs.peg) {
        hit(m, obs.x, obs.y, obs.r, spec.bounce, 0, 0);
        continue;
      }
      const [px, py] = closestOnSegment(
        m.x,
        m.y,
        obs.x - obs.hx,
        obs.y - obs.hy,
        obs.x + obs.hx,
        obs.y + obs.hy,
      );
      // Una barra girando empuja: la velocidad de su superficie en ese punto
      // entra en el choque, que es lo que lanza la canica.
      const omega = obs.spin === 0 ? 0 : Math.sign(obs.spin) / (Math.abs(obs.spin) * STEP);
      hit(m, px, py, obs.r, spec.bounce, omega * -(py - obs.y), omega * (px - obs.x));
    }

    if (m.y >= spec.length) {
      race.finished += 1;
      m.place = race.finished;
    }
  }

  // Canica contra canica: sin esto se atraviesan y los embudos no hacen cola,
  // que es justo donde se decide la carrera. Doce canicas son 66 parejas.
  for (let i = 0; i < marbles.length; i += 1) {
    for (let j = i + 1; j < marbles.length; j += 1) {
      const a = marbles[i];
      const b = marbles[j];
      if (!a || !b || a.place || b.place) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const min = MARBLE_R * 2;
      const d2 = dx * dx + dy * dy;
      if (d2 >= min * min || d2 === 0) continue;
      const d = Math.sqrt(d2);
      const nx = dx / d;
      const ny = dy / d;
      const overlap = (min - d) / 2;
      a.x -= nx * overlap;
      a.y -= ny * overlap;
      b.x += nx * overlap;
      b.y += ny * overlap;
      const along = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      if (along > 0) continue;
      const impulse = -(1 + spec.bounce) * along * 0.5;
      a.vx -= impulse * nx;
      a.vy -= impulse * ny;
      b.vx += impulse * nx;
      b.vy += impulse * ny;
    }
  }
}
