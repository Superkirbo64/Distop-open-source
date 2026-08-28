/**
 * Fondo de cámara: difuminar la habitación o sustituirla (§9.5, §10.1).
 *
 * Todo pasa en el equipo de quien enciende la cámara. La imagen que sale por la
 * red ya viene compuesta, así que ni la instancia ni el resto de la sala reciben
 * nunca el fondo original — y no hay ningún servicio externo de por medio, que
 * es la única forma de que esto sea gratis de verdad (§3).
 *
 * Piezas:
 *   - Un modelo de segmentación de persona (MediaPipe Selfie Segmenter), que
 *     vive en `public/models/` y se sirve desde la propia instancia.
 *   - El runtime WebAssembly que lo ejecuta, que viene del paquete npm y lo
 *     empaqueta Vite. Pesa lo suyo (~12 MB sin comprimir), así que NO se
 *     descarga al abrir la aplicación: solo la primera vez que alguien enciende
 *     un fondo, y el navegador lo cachea a partir de ahí.
 *   - Un lienzo que mezcla persona y fondo y se vuelve a convertir en pista de
 *     vídeo, igual que hace la cámara sobre pantalla compartida en lib/voice.ts.
 *
 * Límites dichos claro (§29.3): el recorte gasta CPU/GPU del equipo local, en
 * portátiles modestos puede costar fotogramas, y un navegador sin WebAssembly
 * SIMD no puede con ello. En ese caso se dice, no se enciende la cámara sin
 * fondo por detrás — que sería enseñar la habitación de alguien que pidió
 * justamente lo contrario.
 */
import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { NO_CATEGORY, backgroundValueFor, coverRect, isPerson } from "./cameraMask.ts";
/* Solo la dirección de los archivos, no su contenido: `?url` deja el runtime
   fuera del paquete inicial y Vite lo publica como un recurso más. */
import wasmLoaderUrl from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryUrl from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

const MODEL_URL = "/models/selfie_segmenter_landscape.tflite";

/* ── qué fondo está puesto ─────────────────────────────────────────────── */

/** Fondos dibujados por código: ni una imagen que descargar ni derechos que pedir. */
export const PRESETS = ["aurora", "studio", "dusk", "grove"] as const;
export type PresetId = (typeof PRESETS)[number];

export type CameraEffect =
  | { kind: "off" }
  /** Difuminado de la propia habitación, en dos intensidades. */
  | { kind: "blur"; strength: "light" | "strong" }
  /** Uno de los fondos dibujados por código. */
  | { kind: "preset"; id: PresetId }
  /** Una imagen que alguien subió; vive en este navegador y en ningún otro sitio. */
  | { kind: "image"; id: string };

const EFFECT_KEY = "distop.cameraBackground";
const IMAGES_KEY = "distop.cameraBackground.images";

function readEffect(): CameraEffect {
  try {
    const raw = localStorage.getItem(EFFECT_KEY);
    if (!raw) return { kind: "off" };
    const value = JSON.parse(raw) as CameraEffect;
    if (value?.kind === "blur" && (value.strength === "light" || value.strength === "strong")) return value;
    if (value?.kind === "preset" && (PRESETS as readonly string[]).includes(value.id)) return value;
    if (value?.kind === "image" && typeof value.id === "string") return value;
    return { kind: "off" };
  } catch {
    return { kind: "off" };
  }
}

let effect: CameraEffect = readEffect();
const effectListeners = new Set<(effect: CameraEffect) => void>();

export function cameraEffect(): CameraEffect {
  return effect;
}

export function effectActive(): boolean {
  return effect.kind !== "off";
}

/**
 * Cambia el fondo.
 *
 * Con la cámara ya encendida no hay que rehacer nada mientras el efecto siga
 * activo: el lienzo lee este valor en cada fotograma, así que pasar de difuminar
 * a una imagen es instantáneo y no renegocia la llamada. Encenderlo o apagarlo
 * sí cambia la pista que sale, y de eso se encarga lib/voice.ts al escuchar.
 */
export function setCameraEffect(next: CameraEffect): void {
  const before = effect.kind !== "off";
  effect = next;
  try {
    localStorage.setItem(EFFECT_KEY, JSON.stringify(next));
  } catch {
    // Sin almacenamiento el fondo vale para esta sesión y se olvida al cerrar:
    // molesto, pero mejor que no dejar elegirlo.
  }
  const after = next.kind !== "off";
  for (const listener of effectListeners) listener(next);
  if (before !== after) for (const listener of toggleListeners) listener();
}

export function onCameraEffect(listener: (effect: CameraEffect) => void): () => void {
  effectListeners.add(listener);
  return () => effectListeners.delete(listener);
}

/** Solo se avisa al cruzar de apagado a encendido (o al revés): ahí sí hay que rehacer la pista. */
const toggleListeners = new Set<() => void>();

export function onCameraEffectToggle(listener: () => void): () => void {
  toggleListeners.add(listener);
  return () => toggleListeners.delete(listener);
}

/* ── estado de carga, para que la interfaz pueda contarlo ──────────────── */

export type EffectStatus = "idle" | "loading" | "ready" | "unsupported" | "failed";

let status: EffectStatus = "idle";
const statusListeners = new Set<(status: EffectStatus) => void>();

export function effectStatus(): EffectStatus {
  return status;
}

export function onEffectStatus(listener: (status: EffectStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function setStatus(next: EffectStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of statusListeners) listener(next);
}

/**
 * ¿Puede este navegador recortar a la persona?
 *
 * El modelo se ejecuta con WebAssembly SIMD. Sin él, MediaPipe ofrece una
 * variante lenta que aquí no se incluye a propósito: son otros 11 MB de
 * descarga para un resultado que no da los fotogramas de una videollamada.
 */
export function effectSupported(): boolean {
  if (typeof document === "undefined") return false;
  if (typeof HTMLCanvasElement.prototype.captureStream !== "function") return false;
  try {
    // Módulo mínimo con una instrucción SIMD (v128.const): valida o no según soporte.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 9, 1, 7, 0, 65, 0, 253, 15, 26, 11]),
    );
  } catch {
    return false;
  }
}

/* ── fondos dibujados por código ───────────────────────────────────────── */

const presetCache = new Map<string, HTMLCanvasElement>();

/**
 * Dibuja uno de los fondos incorporados.
 *
 * Son degradados y formas, no fotografías: no hay archivo que descargar, ni
 * licencia de imagen que arrastrar, ni peso que sumarle a quien hospeda (§24).
 */
export function renderPreset(id: PresetId, width = 1280, height = 720): HTMLCanvasElement {
  const key = `${id}@${width}x${height}`;
  const cached = presetCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  /** Mancha de luz suave, la pieza con la que se construyen casi todos. */
  const glow = (x: number, y: number, radius: number, color: string) => {
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, color);
    gradient.addColorStop(1, "transparent");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  };

  if (id === "aurora") {
    const base = ctx.createLinearGradient(0, 0, width, height);
    base.addColorStop(0, "#131a2e");
    base.addColorStop(1, "#0b0f1a");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    glow(width * 0.22, height * 0.28, width * 0.5, "rgba(126, 88, 255, 0.55)");
    glow(width * 0.78, height * 0.72, width * 0.45, "rgba(45, 212, 191, 0.4)");
    glow(width * 0.6, height * 0.1, width * 0.35, "rgba(236, 72, 153, 0.22)");
  } else if (id === "studio") {
    const base = ctx.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, "#2b2b30");
    base.addColorStop(1, "#141417");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    glow(width / 2, height * 0.34, width * 0.42, "rgba(255, 245, 224, 0.22)");
    // Viñeta: sin ella el gris plano parece un fallo de la cámara, no un fondo.
    const vignette = ctx.createRadialGradient(width / 2, height / 2, height * 0.2, width / 2, height / 2, width * 0.72);
    vignette.addColorStop(0, "transparent");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.55)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  } else if (id === "dusk") {
    const base = ctx.createLinearGradient(0, height, 0, 0);
    base.addColorStop(0, "#1b1033");
    base.addColorStop(0.55, "#7b3f6b");
    base.addColorStop(1, "#f0a35e");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    glow(width * 0.72, height * 0.24, width * 0.3, "rgba(255, 214, 141, 0.75)");
  } else {
    const base = ctx.createLinearGradient(0, 0, 0, height);
    base.addColorStop(0, "#0f2019");
    base.addColorStop(1, "#08110d");
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, width, height);
    /* Bandas verticales muy difusas: sugieren troncos a contraluz sin pretender
       ser una foto, que es justo lo que aguanta bien detrás de una persona. */
    for (let i = 0; i < 9; i += 1) {
      const x = (width / 9) * (i + 0.5) + Math.sin(i * 2.1) * width * 0.03;
      const band = ctx.createLinearGradient(x - width * 0.05, 0, x + width * 0.05, 0);
      band.addColorStop(0, "transparent");
      band.addColorStop(0.5, i % 2 ? "rgba(96, 168, 122, 0.16)" : "rgba(52, 118, 88, 0.22)");
      band.addColorStop(1, "transparent");
      ctx.fillStyle = band;
      ctx.fillRect(0, 0, width, height);
    }
    glow(width * 0.5, height * 0.18, width * 0.45, "rgba(178, 235, 190, 0.2)");
  }

  presetCache.set(key, canvas);
  return canvas;
}

/* ── imágenes propias ──────────────────────────────────────────────────── */

export interface CustomBackground {
  id: string;
  name: string;
}

const DB_NAME = "distop-backgrounds";
const DB_STORE = "images";
/** Ocho megas por imagen y doce imágenes: un fondo, no un álbum de fotos. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 12;

function database(): Promise<IDBDatabase | null> {
  if (!("indexedDB" in globalThis)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

export function customBackgrounds(): CustomBackground[] {
  try {
    const raw = localStorage.getItem(IMAGES_KEY);
    const value = raw ? (JSON.parse(raw) as CustomBackground[]) : [];
    return Array.isArray(value) ? value.filter((item) => item?.id && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

function writeIndex(list: CustomBackground[]): void {
  try {
    localStorage.setItem(IMAGES_KEY, JSON.stringify(list));
  } catch {
    // Igual que con el efecto: el fondo sigue funcionando en esta sesión.
  }
}

export type AddImageIssue = "too_big" | "not_image" | "too_many" | "no_storage";

/** Guarda una imagen del disco. No sube nada: se queda en este navegador. */
export async function addCustomBackground(file: File): Promise<{ id: string } | { error: AddImageIssue }> {
  if (!file.type.startsWith("image/")) return { error: "not_image" };
  if (file.size > MAX_IMAGE_BYTES) return { error: "too_big" };
  const list = customBackgrounds();
  if (list.length >= MAX_IMAGES) return { error: "too_many" };

  const db = await database();
  if (!db) return { error: "no_storage" };
  const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const stored = await new Promise<boolean>((resolve) => {
    const transaction = db.transaction(DB_STORE, "readwrite");
    transaction.objectStore(DB_STORE).put(file, id);
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
  });
  db.close();
  if (!stored) return { error: "no_storage" };

  writeIndex([...list, { id, name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || id }]);
  return { id };
}

export async function removeCustomBackground(id: string): Promise<void> {
  writeIndex(customBackgrounds().filter((item) => item.id !== id));
  const url = objectUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    objectUrls.delete(id);
  }
  bitmaps.delete(id);
  const db = await database();
  if (db) {
    await new Promise<void>((resolve) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).delete(id);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
    });
    db.close();
  }
  // El fondo puesto acaba de desaparecer: no se puede seguir apuntando a él.
  if (effect.kind === "image" && effect.id === id) setCameraEffect({ kind: "off" });
}

async function loadBlob(id: string): Promise<Blob | null> {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    const transaction = db.transaction(DB_STORE, "readonly");
    const request = transaction.objectStore(DB_STORE).get(id);
    request.onsuccess = () => {
      const value = request.result;
      resolve(value instanceof Blob ? value : null);
      db.close();
    };
    request.onerror = () => {
      resolve(null);
      db.close();
    };
  });
}

const objectUrls = new Map<string, string>();

/** Dirección local para enseñar la miniatura en el selector. */
export async function customBackgroundUrl(id: string): Promise<string | null> {
  const cached = objectUrls.get(id);
  if (cached) return cached;
  const blob = await loadBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  objectUrls.set(id, url);
  return url;
}

/** Las imágenes ya decodificadas, para no volver a hacerlo en cada fotograma. */
const bitmaps = new Map<string, ImageBitmap>();

async function imageFor(id: string): Promise<ImageBitmap | null> {
  const cached = bitmaps.get(id);
  if (cached) return cached;
  const blob = await loadBlob(id);
  if (!blob) return null;
  try {
    const bitmap = await createImageBitmap(blob);
    bitmaps.set(id, bitmap);
    return bitmap;
  } catch {
    return null;
  }
}

/* ── el segmentador ────────────────────────────────────────────────────── */

let segmenter: ImageSegmenter | null = null;
let loading: Promise<ImageSegmenter | null> | null = null;
/** Qué valor de la máscara significa "fondo" en el modelo cargado (ver cameraMask.ts). */
let backgroundValue = NO_CATEGORY;
/** Cuántos lienzos están usando el modelo ahora mismo. */
let users = 0;

async function loadSegmenter(): Promise<ImageSegmenter | null> {
  if (segmenter) return segmenter;
  if (loading) return loading;
  if (!effectSupported()) {
    setStatus("unsupported");
    return null;
  }

  setStatus("loading");
  loading = (async () => {
    try {
      const vision = await import("@mediapipe/tasks-vision");
      /* El `WasmFileset` es solo un par de direcciones. Se arma a mano en vez de
         usar FilesetResolver porque ese busca los archivos bajo una carpeta
         pública, y aquí los publica Vite con su propio nombre con hash. */
      const fileset = { wasmLoaderPath: wasmLoaderUrl, wasmBinaryPath: wasmBinaryUrl };
      const options = {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" as const },
        runningMode: "VIDEO" as const,
        outputCategoryMask: true,
        outputConfidenceMasks: false,
      };
      const created = await vision.ImageSegmenter.createFromOptions(fileset, options).catch(() =>
        // Sin WebGL utilizable (máquina virtual, driver viejo) se cae a CPU: más
        // lento, pero es la diferencia entre ir justo y no ir.
        vision.ImageSegmenter.createFromOptions(fileset, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "CPU" as const },
        }),
      );
      backgroundValue = backgroundValueFor(created.getLabels());
      segmenter = created;
      setStatus("ready");
      return created;
    } catch {
      setStatus("failed");
      return null;
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/**
 * Suelta el modelo cuando ya no queda ninguna cámara usándolo.
 * Son decenas de megas de memoria y, con delegado GPU, un contexto WebGL:
 * dejarlo vivo tras colgar es la clase de fuga que solo se nota al tercer día.
 */
function releaseSegmenter(): void {
  if (users > 0 || !segmenter) return;
  segmenter.close();
  segmenter = null;
  setStatus("idle");
}

/* ── el lienzo que mezcla ──────────────────────────────────────────────── */

export interface EffectPipeline {
  stream: MediaStream;
  stop: () => void;
}

/** Cada cuánto se vuelve a preguntar dónde está la persona. */
const MASK_INTERVAL_MS = 1000 / 20;
/** Ancho al que se reduce la imagen para difuminarla: barato y suficiente. */
const BLUR_WIDTH = 480;

/**
 * Toma la cámara tal cual y devuelve otra pista, ya con el fondo puesto.
 *
 * Devuelve `null` cuando no se puede: sin modelo no se compone nada, y quien
 * llama NO debe seguir adelante con la cámara cruda — que es exactamente el
 * fondo que esa persona pidió no enseñar.
 */
export async function startCameraEffect(source: MediaStream, fps: number): Promise<EffectPipeline | null> {
  const track = source.getVideoTracks()[0];
  if (!track) return null;
  const model = await loadSegmenter();
  if (!model) return null;

  const settings = track.getSettings();
  const width = settings.width ?? 640;
  const height = settings.height ?? 480;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  await video.play().catch(() => {
    // Vídeo propio y en silencio: si aun así no arranca, el lienzo sale en negro
    // pero la llamada no se cae.
  });

  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  const ctx = out.getContext("2d", { alpha: false });

  // Persona recortada y máscara van en lienzos aparte: el recorte necesita
  // borrar por alfa, y el de salida es opaco.
  const person = document.createElement("canvas");
  person.width = width;
  person.height = height;
  const personCtx = person.getContext("2d");

  const maskCanvas = document.createElement("canvas");
  const maskCtx = maskCanvas.getContext("2d");

  const small = document.createElement("canvas");
  const smallCtx = small.getContext("2d");

  if (!ctx || !personCtx || !maskCtx || !smallCtx) return null;

  /* `filter` no existe en todos los navegadores. Donde falta, el difuminado se
     hace reduciendo la imagen a un pañuelo y volviéndola a estirar: menos
     bonito, pero el fondo queda igual de ilegible, que es de lo que se trata. */
  ctx.filter = "blur(1px)";
  const hasFilter = ctx.filter !== "none" && ctx.filter !== "";
  ctx.filter = "none";

  users += 1;
  let lastMaskAt = 0;
  let lastTimestamp = 0;
  let maskReady = false;
  /** El fondo elegido puede tardar en decodificarse; hasta entonces, negro. */
  let pendingImage: string | null = null;

  function updateMask(now: number): void {
    if (video.videoWidth === 0) return;
    // MediaPipe exige marcas de tiempo que siempre crezcan.
    const timestamp = Math.max(lastTimestamp + 1, Math.round(now));
    lastTimestamp = timestamp;
    let mask;
    try {
      mask = model!.segmentForVideo(video, timestamp).categoryMask;
    } catch {
      // Un fotograma que el modelo no digiere no vale una llamada: se reutiliza
      // la máscara anterior y se sigue.
      return;
    }
    if (!mask) return;

    if (maskCanvas.width !== mask.width || maskCanvas.height !== mask.height) {
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
    }
    const values = mask.getAsUint8Array();
    const image = maskCtx!.createImageData(mask.width, mask.height);
    const pixels = image.data;
    for (let i = 0; i < values.length; i += 1) {
      // Blanco opaco donde hay persona, transparente donde no: así el lienzo de
      // la persona se recorta con un simple `destination-in`.
      const offset = i * 4;
      pixels[offset] = 255;
      pixels[offset + 1] = 255;
      pixels[offset + 2] = 255;
      pixels[offset + 3] = isPerson(values[i]!, backgroundValue) ? 255 : 0;
    }
    maskCtx!.putImageData(image, 0, 0);
    mask.close();
    maskReady = true;
  }

  function drawBlurred(strength: "light" | "strong"): void {
    const scale = BLUR_WIDTH / width;
    const w = Math.max(2, Math.round(width * scale));
    const h = Math.max(2, Math.round(height * scale));
    if (small.width !== w || small.height !== h) {
      small.width = w;
      small.height = h;
    }

    if (hasFilter) {
      const radius = strength === "strong" ? 14 : 7;
      /* Se dibuja algo más grande que el lienzo: si no, el difuminado toma
         transparente de fuera del borde y deja un halo claro alrededor. */
      const bleed = radius * 3;
      smallCtx!.filter = `blur(${radius}px)`;
      smallCtx!.drawImage(video, -bleed, -bleed, w + bleed * 2, h + bleed * 2);
      smallCtx!.filter = "none";
    } else {
      // Sin `filter`: una reducción brutal y el navegador suaviza al estirar. El
      // fondo queda en manchas, que es justo lo que se busca.
      const tiny = strength === "strong" ? 12 : 26;
      const th = Math.max(2, Math.round((tiny * h) / w));
      smallCtx!.imageSmoothingEnabled = true;
      smallCtx!.drawImage(video, 0, 0, tiny, th);
      smallCtx!.drawImage(small, 0, 0, tiny, th, 0, 0, w, h);
    }
    ctx!.imageSmoothingEnabled = true;
    ctx!.drawImage(small, 0, 0, w, h, 0, 0, width, height);
  }

  function drawCover(image: CanvasImageSource, sw: number, sh: number): void {
    const rect = coverRect(sw, sh, width, height);
    ctx!.drawImage(image, rect.x, rect.y, rect.w, rect.h);
  }

  function fillBlack(): void {
    ctx!.fillStyle = "#000";
    ctx!.fillRect(0, 0, width, height);
  }

  function draw(): void {
    const now = performance.now();
    if (video.videoWidth === 0) return;

    if (now - lastMaskAt >= MASK_INTERVAL_MS) {
      lastMaskAt = now;
      updateMask(now);
    }
    // Sin máscara todavía no se enseña la habitación: negro hasta el primer
    // recorte, que llega en un par de fotogramas.
    if (!maskReady) {
      fillBlack();
      return;
    }

    const current = effect;
    if (current.kind === "off") {
      // Efecto apagado mientras el lienzo sigue vivo un instante: la imagen tal cual.
      ctx!.drawImage(video, 0, 0, width, height);
      return;
    }

    if (current.kind === "blur") {
      drawBlurred(current.strength);
    } else if (current.kind === "preset") {
      const preset = renderPreset(current.id, 1280, 720);
      drawCover(preset, preset.width, preset.height);
    } else {
      const image = bitmaps.get(current.id);
      if (image) {
        drawCover(image, image.width, image.height);
      } else {
        fillBlack();
        if (pendingImage !== current.id) {
          pendingImage = current.id;
          void imageFor(current.id).then((loaded) => {
            // La imagen ya no está (borrada en otra pestaña): mejor difuminar que
            // acabar enseñando la habitación entera.
            if (!loaded && effect.kind === "image" && effect.id === current.id)
              setCameraEffect({ kind: "blur", strength: "strong" });
          });
        }
      }
    }

    // La persona, recortada con la máscara y pegada encima del fondo.
    personCtx!.globalCompositeOperation = "source-over";
    personCtx!.clearRect(0, 0, width, height);
    personCtx!.drawImage(video, 0, 0, width, height);
    personCtx!.globalCompositeOperation = "destination-in";
    /* La máscara mide 256 px de ancho y, estirada, su borde se ve a escalones.
       Un difuminado corto lo convierte en un contorno limpio. */
    if (hasFilter) personCtx!.filter = "blur(3px)";
    personCtx!.imageSmoothingEnabled = true;
    personCtx!.drawImage(maskCanvas, 0, 0, width, height);
    personCtx!.filter = "none";
    personCtx!.globalCompositeOperation = "source-over";
    ctx!.drawImage(person, 0, 0);
  }

  const timer = window.setInterval(draw, Math.max(Math.round(1000 / fps), 25));
  const stream = out.captureStream(fps);

  return {
    stream,
    stop: () => {
      window.clearInterval(timer);
      for (const item of stream.getTracks()) item.stop();
      video.srcObject = null;
      users = Math.max(0, users - 1);
      releaseSegmenter();
    },
  };
}
