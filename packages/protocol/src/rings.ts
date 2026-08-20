/**
 * Generado desde community-rings/rings.json. No editar a mano.
 *
 * Aros de "Original Lab" (SillyTavern Avatar Decorations Community Project),
 * CC BY 4.0 — creados para ese proyecto, sin pixeles de Discord. La licencia
 * viaja con las imagenes en apps/web/public/rings/LICENSE.md (§24).
 *
 * Cada PNG es un atlas de 960x320: tres celdas de 320 —base, acentos y
 * particulas— que el cliente apila como tres capas y anima por CSS. Los PNG no
 * llevan fotogramas: el movimiento lo pone el navegador, asi que 39 aros
 * animados pesan 1,6 MB en vez de lo que pesarian 39 GIF.
 *
 * `motion` es la coreografia que el autor asigno a cada pieza, tal cual. No se
 * resume: es lo que distingue un engranaje que gira 360 grados de un panda
 * dormido que solo respira. La tabla de movimientos vive en styles.css.
 */
export type RingMotion =
  | "breathe"
  | "bubble"
  | "crawl"
  | "drift"
  | "equalizer"
  | "flicker"
  | "flow"
  | "flutter"
  | "hover"
  | "impact"
  | "mechanical"
  | "orbit"
  | "pulse"
  | "rain"
  | "shimmer"
  | "sleep"
  | "steady"
  | "sway";

export interface Ring {
  id: string;
  name: string;
  motion: RingMotion;
}

export const RINGS: readonly Ring[] = [
  { id: "aurora-weave", name: "Aurora Weave", motion: "drift" },
  { id: "ember-filament", name: "Ember Filament", motion: "pulse" },
  { id: "tidal-current", name: "Tidal Current", motion: "flow" },
  { id: "verdant-orbit", name: "Verdant Orbit", motion: "breathe" },
  { id: "lunar-lattice", name: "Lunar Lattice", motion: "orbit" },
  { id: "solar-thread", name: "Solar Thread", motion: "pulse" },
  { id: "cloud-pulse", name: "Cloud Pulse", motion: "breathe" },
  { id: "crystal-bloom", name: "Crystal Bloom", motion: "shimmer" },
  { id: "void-echo", name: "Void Echo", motion: "orbit" },
  { id: "petal-drift", name: "Petal Drift", motion: "drift" },
  { id: "copper-mechanism", name: "Copper Mechanism", motion: "mechanical" },
  { id: "frost-signal", name: "Frost Signal", motion: "shimmer" },
  { id: "dune-mirage", name: "Dune Mirage", motion: "flow" },
  { id: "neon-relay", name: "Neon Relay", motion: "mechanical" },
  { id: "coral-loop", name: "Coral Loop", motion: "breathe" },
  { id: "thunder-trace", name: "Thunder Trace", motion: "pulse" },
  { id: "glass-garden", name: "Glass Garden", motion: "shimmer" },
  { id: "ink-ripple", name: "Ink Ripple", motion: "flow" },
  { id: "honey-circuit", name: "Honey Circuit", motion: "mechanical" },
  { id: "midnight-dew", name: "Midnight Dew", motion: "drift" },
  { id: "quartz-pulse", name: "Quartz Pulse", motion: "shimmer" },
  { id: "comet-stitch", name: "Comet Stitch", motion: "orbit" },
  { id: "moss-lantern", name: "Moss Lantern", motion: "breathe" },
  { id: "spectrum-knot", name: "Spectrum Knot", motion: "flow" },
  { id: "lynx-signal", name: "Lynx Signal", motion: "flicker" },
  { id: "pressure-spike", name: "Pressure Spike", motion: "impact" },
  { id: "analog-orbit", name: "Analog Orbit", motion: "equalizer" },
  { id: "stone-sentinel", name: "Stone Sentinel", motion: "breathe" },
  { id: "alchemy-conduit", name: "Alchemy Conduit", motion: "bubble" },
  { id: "paper-glow-gate", name: "Paper Glow Gate", motion: "sway" },
  { id: "terrarium-ledge", name: "Terrarium Ledge", motion: "breathe" },
  { id: "dreaming-red-panda", name: "Dreaming Red Panda", motion: "sleep" },
  { id: "rain-canopy", name: "Rain Canopy", motion: "rain" },
  { id: "glasswing-pair", name: "Glasswing Pair", motion: "flutter" },
  { id: "ember-crescent", name: "Ember Crescent", motion: "impact" },
  { id: "tempest-thread", name: "Tempest Thread", motion: "flow" },
  { id: "nectar-automaton", name: "Nectar Automaton", motion: "crawl" },
  { id: "abyss-diver-helmet", name: "Abyss Diver Helmet", motion: "steady" },
  { id: "cloud-skimmer", name: "Cloud Skimmer", motion: "hover" },
];

export const RING_IDS: readonly string[] = RINGS.map((r) => r.id);
