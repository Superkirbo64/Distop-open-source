/**
 * Crea el pack adaptado de Distop a partir de SND01 "sine".
 *
 * Uso:
 *   node scripts/generate-ui-sounds.mjs <carpeta SND01_sine extraida>
 *
 * Cada salida combina varias fuentes, cambia tono y tiempo, aplica envolventes
 * nuevas, suma una capa sintetizada original y remasteriza el resultado. Los
 * WAV originales no se copian al proyecto.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 44_100;
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, "apps", "web", "public", "sounds");
const sourceDirectory = process.argv[2] ? resolve(process.argv[2]) : null;

if (!sourceDirectory) {
  throw new Error(
    "Falta la carpeta de SND01. Uso: node scripts/generate-ui-sounds.mjs <carpeta SND01_sine extraida>",
  );
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function readMonoPcm16(name) {
  const path = join(sourceDirectory, `${name}.wav`);
  if (!existsSync(path)) throw new Error(`No se encontro ${path}`);
  const bytes = readFileSync(path);
  if (bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${name}.wav no es un archivo RIFF/WAVE valido`);
  }

  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new Error(`${name}.wav contiene un bloque truncado`);
    if (id === "fmt ") {
      format = {
        codec: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = bytes.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }

  if (!format || !data) throw new Error(`${name}.wav no contiene formato o audio`);
  if (format.codec !== 1 || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
    throw new Error(`${name}.wav debe ser PCM mono, 44.1 kHz y 16-bit`);
  }

  const samples = new Float64Array(Math.floor(data.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = data.readInt16LE(index * 2) / 32_768;
  }
  return samples;
}

const sources = Object.fromEntries(
  ["notification", "select", "toggle_on", "toggle_off", "transition_up", "transition_down"].map(
    (name) => [name, readMonoPcm16(name)],
  ),
);

function addSample(target, sourceName, { at = 0, pitch = 1, gain = 1, attack = 0.004, release = 0.03 }) {
  const source = sources[sourceName];
  const start = Math.round(at * SAMPLE_RATE);
  const outputLength = Math.ceil(source.length / pitch);
  for (let index = 0; index < outputLength && start + index < target.length; index += 1) {
    const position = index * pitch;
    const left = Math.floor(position);
    if (left >= source.length) break;
    const fraction = position - left;
    const sample = source[left] * (1 - fraction) + (source[left + 1] ?? source[left]) * fraction;
    const elapsed = index / SAMPLE_RATE;
    const remaining = (outputLength - index) / SAMPLE_RATE;
    const envelope = Math.min(1, elapsed / attack, remaining / release);
    target[start + index] += sample * clamp(envelope, 0, 1) * gain;
  }
}

function addTone(target, { at = 0, duration, from, to = from, gain }) {
  const start = Math.round(at * SAMPLE_RATE);
  const frames = Math.round(duration * SAMPLE_RATE);
  for (let index = 0; index < frames && start + index < target.length; index += 1) {
    const time = index / SAMPLE_RATE;
    const sweep = to - from;
    const phase = 2 * Math.PI * (from * time + (sweep * time * time) / (2 * duration));
    const attack = clamp(time / 0.006, 0, 1);
    const release = clamp((duration - time) / 0.04, 0, 1);
    const decay = Math.exp(-time / (duration * 0.68));
    const harmonic = Math.sin(phase) + 0.13 * Math.sin(phase * 2) + 0.045 * Math.sin(phase * 3);
    target[start + index] += harmonic * attack * release * decay * gain;
  }
}

const presets = {
  message: {
    duration: 0.24,
    samples: [
      ["notification", { pitch: 1.08, gain: 0.7, release: 0.045 }],
      ["select", { at: 0.068, pitch: 0.93, gain: 0.32, release: 0.032 }],
    ],
    tones: [{ at: 0.026, duration: 0.18, from: 832, to: 1_036, gain: 0.11 }],
    echo: [0.041, 0.1],
  },
  mention: {
    duration: 0.38,
    samples: [
      ["notification", { pitch: 0.96, gain: 0.62, release: 0.052 }],
      ["transition_up", { at: 0.105, pitch: 1.18, gain: 0.48, release: 0.035 }],
      ["select", { at: 0.205, pitch: 1.31, gain: 0.24, release: 0.026 }],
    ],
    tones: [
      { at: 0.075, duration: 0.2, from: 698, to: 1_048, gain: 0.09 },
      { at: 0.16, duration: 0.19, from: 1_046, to: 1_396, gain: 0.07 },
    ],
    echo: [0.052, 0.11],
  },
  on: {
    duration: 0.2,
    samples: [
      ["toggle_on", { pitch: 0.94, gain: 0.72, release: 0.035 }],
      ["transition_up", { at: 0.034, pitch: 1.13, gain: 0.38, release: 0.03 }],
    ],
    tones: [{ at: 0.012, duration: 0.16, from: 544, to: 816, gain: 0.09 }],
    echo: [0.034, 0.08],
  },
  off: {
    duration: 0.2,
    samples: [
      ["toggle_off", { pitch: 0.97, gain: 0.7, release: 0.035 }],
      ["transition_down", { at: 0.031, pitch: 1.08, gain: 0.36, release: 0.03 }],
    ],
    tones: [{ at: 0.012, duration: 0.16, from: 816, to: 544, gain: 0.085 }],
    echo: [0.035, 0.075],
  },
  voice_join: {
    duration: 0.34,
    samples: [
      ["transition_up", { pitch: 0.84, gain: 0.58, release: 0.05 }],
      ["notification", { at: 0.035, pitch: 1.08, gain: 0.42, release: 0.055 }],
    ],
    tones: [
      { at: 0.015, duration: 0.25, from: 392, to: 587, gain: 0.1 },
      { at: 0.1, duration: 0.21, from: 587, to: 784, gain: 0.07 },
    ],
    echo: [0.048, 0.12],
  },
  voice_leave: {
    duration: 0.28,
    samples: [
      ["transition_down", { pitch: 0.82, gain: 0.65, release: 0.05 }],
      ["toggle_off", { at: 0.09, pitch: 0.9, gain: 0.38, release: 0.035 }],
    ],
    tones: [{ at: 0.018, duration: 0.23, from: 659, to: 330, gain: 0.11 }],
    echo: [0.046, 0.09],
  },
  mute_on: {
    duration: 0.14,
    samples: [
      ["toggle_off", { pitch: 1.28, gain: 0.7, release: 0.025 }],
      ["select", { at: 0.028, pitch: 0.85, gain: 0.26, release: 0.025 }],
    ],
    tones: [{ at: 0.006, duration: 0.11, from: 540, to: 360, gain: 0.07 }],
    echo: [0.027, 0.055],
  },
  mute_off: {
    duration: 0.14,
    samples: [
      ["toggle_on", { pitch: 1.3, gain: 0.68, release: 0.025 }],
      ["select", { at: 0.026, pitch: 1.22, gain: 0.25, release: 0.024 }],
    ],
    tones: [{ at: 0.006, duration: 0.11, from: 360, to: 540, gain: 0.07 }],
    echo: [0.026, 0.055],
  },
  deafen_on: {
    duration: 0.18,
    samples: [
      ["transition_down", { pitch: 1.32, gain: 0.52, release: 0.03 }],
      ["toggle_off", { at: 0.048, pitch: 0.86, gain: 0.52, release: 0.035 }],
    ],
    tones: [{ at: 0.008, duration: 0.145, from: 700, to: 350, gain: 0.08 }],
    echo: [0.032, 0.06],
  },
  deafen_off: {
    duration: 0.18,
    samples: [
      ["transition_up", { pitch: 1.3, gain: 0.52, release: 0.03 }],
      ["toggle_on", { at: 0.046, pitch: 0.88, gain: 0.5, release: 0.035 }],
    ],
    tones: [{ at: 0.008, duration: 0.145, from: 350, to: 700, gain: 0.08 }],
    echo: [0.032, 0.06],
  },
  camera_on: {
    duration: 0.18,
    samples: [
      ["toggle_on", { pitch: 1.15, gain: 0.55, release: 0.03 }],
      ["select", { at: 0.045, pitch: 1.28, gain: 0.42, release: 0.027 }],
    ],
    tones: [{ at: 0.01, duration: 0.14, from: 988, to: 1_174, gain: 0.08 }],
    echo: [0.034, 0.07],
  },
  camera_off: {
    duration: 0.17,
    samples: [
      ["toggle_off", { pitch: 1.15, gain: 0.54, release: 0.03 }],
      ["select", { at: 0.04, pitch: 1.05, gain: 0.36, release: 0.027 }],
    ],
    tones: [{ at: 0.008, duration: 0.135, from: 1_174, to: 784, gain: 0.075 }],
    echo: [0.032, 0.065],
  },
  screen_on: {
    duration: 0.26,
    samples: [
      ["transition_up", { pitch: 0.78, gain: 0.65, release: 0.045 }],
      ["notification", { at: 0.055, pitch: 0.88, gain: 0.36, release: 0.05 }],
    ],
    tones: [{ at: 0.012, duration: 0.21, from: 440, to: 880, gain: 0.085 }],
    echo: [0.043, 0.09],
  },
  screen_off: {
    duration: 0.24,
    samples: [
      ["transition_down", { pitch: 0.8, gain: 0.62, release: 0.045 }],
      ["toggle_off", { at: 0.072, pitch: 0.82, gain: 0.4, release: 0.035 }],
    ],
    tones: [{ at: 0.012, duration: 0.19, from: 880, to: 440, gain: 0.085 }],
    echo: [0.042, 0.085],
  },
};

function addEcho(samples, delay, gain) {
  const frames = Math.round(delay * SAMPLE_RATE);
  for (let index = frames; index < samples.length; index += 1) {
    samples[index] += samples[index - frames] * gain;
  }
}

function lowPass(samples, cutoff) {
  const alpha = 1 - Math.exp((-2 * Math.PI * cutoff) / SAMPLE_RATE);
  let filtered = 0;
  for (let index = 0; index < samples.length; index += 1) {
    filtered += alpha * (samples[index] - filtered);
    samples[index] = filtered;
  }
}

function writeWav(name, preset) {
  const frames = Math.ceil(preset.duration * SAMPLE_RATE);
  const samples = new Float64Array(frames);
  for (const [source, options] of preset.samples) addSample(samples, source, options);
  for (const tone of preset.tones) addTone(samples, tone);
  addEcho(samples, ...preset.echo);
  lowPass(samples, 8_400);

  const finalFadeFrames = Math.round(0.014 * SAMPLE_RATE);
  for (let index = 0; index < finalFadeFrames; index += 1) {
    const target = samples.length - finalFadeFrames + index;
    if (target >= 0) samples[target] *= 1 - index / finalFadeFrames;
  }

  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const scale = peak > 0 ? 0.74 / peak : 1;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + frames * 2, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(SAMPLE_RATE, 24);
  bytes.writeUInt32LE(SAMPLE_RATE * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let index = 0; index < frames; index += 1) {
    bytes.writeInt16LE(Math.round(clamp(samples[index] * scale, -1, 1) * 32_767), 44 + index * 2);
  }
  writeFileSync(join(output, `${name}.wav`), bytes);
}

mkdirSync(output, { recursive: true });
for (const [name, preset] of Object.entries(presets)) writeWav(name, preset);
console.log(`Pack adaptado SND01 creado en ${output}`);
