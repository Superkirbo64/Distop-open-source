/**
 * Descarga el paquete de emojis animados de Noto (Google, CC BY 4.0) y lo
 * convierte en ficheros estáticos que la instancia sirve como cualquier otro
 * asset del cliente.
 *
 * No corre en cada instalación: es un script de una vez, como quien regenera
 * un catálogo. La salida (878 ficheros JSON + un mapa de qué emoji tiene
 * animación) se versiona en el repo, para que un self-host no dependa de que
 * GitHub o Google sigan sirviendo esto el día que alguien clona el proyecto.
 *
 *   node scripts/fetch-animated-emoji.mjs
 *
 * Fuente: github.com/quarrel/noto-emoji-dotlottie, que empaqueta en un solo
 * .lottie (zip) los Lottie JSON que Google publica en fonts.gstatic.com. Sin
 * este paquete habría que pedir 878 URLs sueltas a mano.
 *
 * El .lottie es un zip corriente (deflate, sin cifrar, sin zip64: el propio
 * fichero declara "v2.0 to extract"). Node no trae un lector de zip, pero sí
 * trae la inflación en `node:zlib`, y el formato del directorio central es
 * fijo y pequeño — así que el zip se recorre a mano en vez de sumar una
 * dependencia (`jszip`, `yauzl`…) para un script que nadie más vuelve a
 * ejecutar salvo el día que Google publique una tanda nueva de animaciones.
 */
import { inflateRawSync } from "node:zlib";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "apps", "web", "public", "emoji-animated");
const MAP_FILE = join(root, "apps", "web", "src", "lib", "animatedEmoji.generated.ts");
const SOURCE = "https://github.com/quarrel/noto-emoji-dotlottie/raw/refs/heads/main/noto-anim.lottie/all.lottie";

/** Lector mínimo del directorio central de un zip: nombre -> bytes ya inflados. */
function readZip(buf) {
  // El End Of Central Directory está al final; sin comentario (el caso normal)
  // son 22 bytes fijos con la firma PK\x05\x06.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd === -1) throw new Error("No es un zip válido (sin EOCD).");
  const total = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error(`Entrada de directorio central corrupta en ${offset}.`);
    const method = buf.readUInt16LE(offset + 10);
    const compSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.toString("utf8", offset + 46, offset + 46 + nameLen);

    // La cabecera local repite parte de esto pero con SUS propios nombre/extra,
    // que es lo que hay que saltar para llegar a los datos de verdad.
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 0 ? raw : inflateRawSync(raw));

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

console.log(`Descargando ${SOURCE} …`);
const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`No se pudo descargar el paquete: ${res.status}`);
const buffer = Buffer.from(await res.arrayBuffer());
console.log(`${(buffer.length / 1024 / 1024).toFixed(1)} MB descargados.`);

const files = readZip(buffer);
const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

/** id "1f321_fe0f" -> el emoji de verdad, para poder buscarlo por su carácter. */
const entries = [];
for (const { id } of manifest.animations) {
  const json = files.get(`a/${id}.json`);
  if (!json) continue;
  writeFileSync(join(OUT_DIR, `${id}.json`), json);
  const char = String.fromCodePoint(...id.split("_").map((h) => Number.parseInt(h, 16)));
  entries.push([char, id]);
}

const body = entries.map(([char, id]) => `  ${JSON.stringify(char)}: ${JSON.stringify(id)},`).join("\n");
writeFileSync(
  MAP_FILE,
  "/**\n * Generado por scripts/fetch-animated-emoji.mjs. No editar a mano.\n" +
    " * emoji -> nombre de fichero en /emoji-animated/<id>.json (§10.2).\n */\n" +
    `export const ANIMATED_EMOJI: Record<string, string> = {\n${body}\n};\n`,
);

console.log(`${entries.length} emojis animados escritos en ${OUT_DIR}`);
console.log(`Mapa escrito en ${MAP_FILE}`);
