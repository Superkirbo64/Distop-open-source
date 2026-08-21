/**
 * Iconos de la app desde la marca oficial (apps/marketing/src/components/Mark.astro),
 * sin ninguna dependencia: el bocadillo es pixel-art sobre una rejilla de 12×12,
 * así que rasterizarlo es pintar rectángulos, y un PNG es zlib + CRC32, que ya
 * vienen con Node. Genera:
 *   apps/desktop/build/icon.ico   (256 px, PNG embebido — instalador y ventana)
 *   apps/desktop/build/tray.png   (32 px, marca blanca sobre transparente)
 *   apps/web/public/icon-192.png  y icon-512.png (manifest PWA / Android)
 *
 *   node scripts/make-icons.mjs
 */
import { deflateSync, crc32 } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* La misma geometría que Mark.astro, rectángulo a rectángulo. */
const MARK = [
  [2, 1, 8, 1],
  [1, 2, 1, 6],
  [10, 2, 1, 6],
  [2, 8, 8, 1],
  [3, 9, 2, 1],
  [3, 10, 1, 1],
  [3, 4, 2, 1],
  [6, 4, 3, 1],
];
const GRID = 12;

/* Colores del favicon del site oficial (Base.astro). */
const BG = [0x0b, 0x0a, 0x14, 255];
const FG = [0x5b, 0x6c, 0xff, 255];
const NONE = [0, 0, 0, 0];

function inMark(gx, gy) {
  return MARK.some(([x, y, w, h]) => gx >= x && gx < x + w && gy >= y && gy < y + h);
}

/**
 * @param {number} size lado en píxeles
 * @param {object} opts fondo redondeado o transparente, color de la marca
 */
function raster(size, { rounded = true, background = BG, foreground = FG, pad = size * 0.08 } = {}) {
  const pixels = Buffer.alloc(size * size * 4);
  const cell = (size - 2 * pad) / GRID;
  const radius = rounded ? size * 0.2 : 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let color = background;
      if (radius > 0) {
        // Fuera de la esquina redondeada no hay nada: es la silueta del icono.
        const cx = Math.max(radius - x, x - (size - 1 - radius), 0);
        const cy = Math.max(radius - y, y - (size - 1 - radius), 0);
        if (cx * cx + cy * cy > radius * radius) color = NONE;
      }
      if (color !== NONE) {
        const gx = Math.floor((x - pad) / cell);
        const gy = Math.floor((y - pad) / cell);
        if (inMark(gx, gy)) color = foreground;
      }
      pixels.set(color, (y * size + x) * 4);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([head, body, tail]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits por canal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtro "none" por fila
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** ICO moderno: un solo tamaño de 256 px con el PNG embebido tal cual. */
function ico(pngData) {
  const header = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 0 = 256 px
  entry[1] = 0;
  entry[4] = 1; // planos
  entry[6] = 32; // bits
  entry.writeUInt32LE(pngData.length, 8);
  entry.writeUInt32LE(22, 12); // offset: 6 + 16
  return Buffer.concat([header, entry, pngData]);
}

function save(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log(`${path}  (${data.length} bytes)`);
}

save(join(root, "apps", "desktop", "build", "icon.ico"), ico(png(256, raster(256))));
/* Fuente de @capacitor/assets (Android): 1024 px, cuadrado a sangre — el
   recorte redondo/squircle lo decide cada launcher, no nosotros. */
save(join(root, "apps", "mobile", "assets", "icon.png"), png(1024, raster(1024, { rounded: false, pad: 1024 * 0.16 })));
save(
  join(root, "apps", "desktop", "build", "tray.png"),
  png(32, raster(32, { rounded: false, background: NONE, foreground: [255, 255, 255, 255], pad: 1 })),
);
save(join(root, "apps", "web", "public", "icon-192.png"), png(192, raster(192)));
save(join(root, "apps", "web", "public", "icon-512.png"), png(512, raster(512)));
