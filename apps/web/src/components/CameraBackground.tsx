/**
 * Elegir el fondo de la cámara (§9.5, §10.1).
 *
 * El mismo selector sirve en tres sitios —la pastilla de la llamada, la barra
 * lateral y los ajustes— porque es una sola decisión: qué se ve detrás de mí.
 * Duplicarlo por sitio habría dejado tres listas que se separan a la primera
 * opción nueva.
 *
 * Todo lo de aquí es gratis y sin tope artificial (§10): tantas imágenes propias
 * como quepan en este navegador, sin cuenta, sin suscripción y sin subir nada a
 * ninguna parte.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Image as ImageIcon, ImagePlus, Sparkles, Trash2, VideoOff, X } from "lucide-react";
import {
  PRESETS,
  addCustomBackground,
  cameraEffect,
  customBackgroundUrl,
  customBackgrounds,
  effectStatus,
  effectSupported,
  onCameraEffect,
  onEffectStatus,
  removeCustomBackground,
  renderPreset,
  setCameraEffect,
  startCameraEffect,
  type AddImageIssue,
  type CameraEffect,
  type CustomBackground,
  type EffectStatus,
  type PresetId,
} from "../lib/cameraBackground.ts";
import type { MessageKey } from "../i18n.ts";
/* Directo del motor de voz y no del hook de Voice.tsx: ese componente va a
   montar este botón, y cruzar los imports entre los dos deja un ciclo. */
import { onVoice, voiceSnapshot } from "../lib/voice.ts";
import { Button, ErrorNote, IconButton, Menu, useConfirm, useT } from "./ui.tsx";

/** El efecto elegido, en vivo: cambiarlo en un sitio se ve en los otros dos. */
export function useCameraEffect(): { effect: CameraEffect; status: EffectStatus } {
  const [effect, setEffect] = useState<CameraEffect>(cameraEffect);
  const [status, setStatus] = useState<EffectStatus>(effectStatus);
  useEffect(() => onCameraEffect(setEffect), []);
  useEffect(() => onEffectStatus(setStatus), []);
  return { effect, status };
}

function sameEffect(a: CameraEffect, b: CameraEffect): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "blur" && b.kind === "blur") return a.strength === b.strength;
  if (a.kind === "preset" && b.kind === "preset") return a.id === b.id;
  if (a.kind === "image" && b.kind === "image") return a.id === b.id;
  return true;
}

/** Una opción de la rejilla: miniatura grande, nombre debajo y marca si está puesta. */
function Option({
  label,
  active,
  onClick,
  children,
  onRemove,
  removeLabel,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  onRemove?: (() => void) | undefined;
  removeLabel?: string | undefined;
}) {
  return (
    <div className="group/opt relative">
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={label}
        className={`flex w-full flex-col gap-1 rounded-[10px] p-1 text-left transition-colors ${
          active ? "bg-accent-soft" : "hover:bg-raise"
        }`}
      >
        <span
          className={`relative grid aspect-video w-full place-items-center overflow-hidden rounded-lg border bg-sunken text-muted ${
            active ? "border-accent" : "border-line"
          }`}
        >
          {children}
        </span>
        <span className={`truncate px-0.5 text-[0.7rem] font-semibold ${active ? "text-accent" : "text-muted"}`}>
          {label}
        </span>
      </button>
      {onRemove && removeLabel ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          title={removeLabel}
          className="absolute top-1.5 right-1.5 hidden h-7 w-7 place-items-center rounded-lg bg-bg/80 text-danger group-hover/opt:grid focus-visible:grid"
        >
          <Trash2 size={14} />
        </button>
      ) : null}
    </div>
  );
}

/** Miniatura de una imagen propia: la dirección local llega de IndexedDB. */
function CustomThumb({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void customBackgroundUrl(id).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [id]);
  return url ? (
    <img src={url} alt="" className="h-full w-full object-cover" />
  ) : (
    <ImageIcon size={18} aria-label={name} />
  );
}

const ISSUE_KEYS: Record<AddImageIssue, MessageKey> = {
  too_big: "camBg.error.too_big",
  not_image: "camBg.error.not_image",
  too_many: "camBg.error.too_many",
  no_storage: "camBg.error.no_storage",
};

const PRESET_KEYS: Record<PresetId, MessageKey> = {
  aurora: "camBg.preset.aurora",
  studio: "camBg.preset.studio",
  dusk: "camBg.preset.dusk",
  grove: "camBg.preset.grove",
};

/**
 * La rejilla de fondos.
 *
 * No pregunta si la cámara está encendida: elegir aquí con la cámara apagada
 * deja el fondo listo para la próxima vez, y con la cámara puesta entra al
 * momento (lo aplica lib/voice.ts al escuchar el cambio).
 */
export function CameraBackgroundPicker({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { effect, status } = useCameraEffect();
  const { confirm, element: confirmElement } = useConfirm();
  const [images, setImages] = useState<CustomBackground[]>(customBackgrounds);
  const [issue, setIssue] = useState<AddImageIssue | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const supported = useMemo(effectSupported, []);

  // Las miniaturas de los fondos dibujados se pintan una vez y se quedan: son
  // degradados, no cambian nunca.
  const thumbs = useMemo(
    () =>
      Object.fromEntries(
        PRESETS.map((id) => [id, renderPreset(id, 240, 135).toDataURL("image/png")]),
      ) as Record<PresetId, string>,
    [],
  );

  async function onFile(file: File | undefined): Promise<void> {
    if (!file) return;
    setIssue(null);
    const result = await addCustomBackground(file);
    if ("error" in result) {
      setIssue(result.error);
      return;
    }
    setImages(customBackgrounds());
    setCameraEffect({ kind: "image", id: result.id });
  }

  const grid = `grid gap-2 ${compact ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`;

  return (
    <div className="flex flex-col gap-3">
      {supported ? null : (
        <p className="rounded-[10px] border border-line bg-sunken px-3 py-2 text-xs leading-relaxed text-muted">
          {t("camBg.unsupported")}
        </p>
      )}
      {status === "failed" ? <ErrorNote>{t("camBg.failed")}</ErrorNote> : null}
      {status === "loading" ? (
        <p className="flex items-center gap-2 rounded-[10px] border border-line bg-sunken px-3 py-2 text-xs text-muted">
          <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />
          {t("camBg.loading")}
        </p>
      ) : null}

      <section>
        <h4 className="mb-1.5 text-[0.7rem] font-bold tracking-wide text-muted uppercase">{t("camBg.blurTitle")}</h4>
        <div className={grid}>
          <Option label={t("camBg.none")} active={effect.kind === "off"} onClick={() => setCameraEffect({ kind: "off" })}>
            <VideoOff size={18} />
          </Option>
          <Option
            label={t("camBg.blurLight")}
            active={sameEffect(effect, { kind: "blur", strength: "light" })}
            onClick={() => setCameraEffect({ kind: "blur", strength: "light" })}
          >
            <span className="h-full w-full bg-gradient-to-br from-accent/25 to-ok/20 blur-[2px]" />
          </Option>
          <Option
            label={t("camBg.blurStrong")}
            active={sameEffect(effect, { kind: "blur", strength: "strong" })}
            onClick={() => setCameraEffect({ kind: "blur", strength: "strong" })}
          >
            <span className="h-full w-full bg-gradient-to-br from-accent/30 to-ok/25 blur-[6px]" />
          </Option>
        </div>
      </section>

      <section>
        <h4 className="mb-1.5 text-[0.7rem] font-bold tracking-wide text-muted uppercase">{t("camBg.presetsTitle")}</h4>
        <div className={grid}>
          {PRESETS.map((id) => (
            <Option
              key={id}
              label={t(PRESET_KEYS[id])}
              active={sameEffect(effect, { kind: "preset", id })}
              onClick={() => setCameraEffect({ kind: "preset", id })}
            >
              <img src={thumbs[id]} alt="" className="h-full w-full object-cover" />
            </Option>
          ))}
        </div>
      </section>

      <section>
        <h4 className="mb-1.5 text-[0.7rem] font-bold tracking-wide text-muted uppercase">{t("camBg.customTitle")}</h4>
        <div className={grid}>
          {images.map((image) => (
            <Option
              key={image.id}
              label={image.name}
              active={sameEffect(effect, { kind: "image", id: image.id })}
              onClick={() => setCameraEffect({ kind: "image", id: image.id })}
              removeLabel={t("camBg.remove")}
              onRemove={() => {
                void (async () => {
                  if (!(await confirm(t("camBg.removeConfirm", { name: image.name })))) return;
                  await removeCustomBackground(image.id);
                  setImages(customBackgrounds());
                })();
              }}
            >
              <CustomThumb id={image.id} name={image.name} />
            </Option>
          ))}
          <Option label={t("camBg.upload")} active={false} onClick={() => fileInput.current?.click()}>
            <ImagePlus size={18} />
          </Option>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            void onFile(event.target.files?.[0]);
            // Sin esto, volver a elegir el MISMO archivo no dispara el evento.
            event.target.value = "";
          }}
        />
        {issue ? <ErrorNote>{t(ISSUE_KEYS[issue])}</ErrorNote> : null}
      </section>

      <p className="text-[0.7rem] leading-relaxed text-muted">{t("camBg.local")}</p>
      <p className="text-[0.7rem] leading-relaxed text-muted">{t("camBg.cost")}</p>
      {confirmElement}
    </div>
  );
}

/**
 * El botón de la llamada.
 *
 * Vale igual en una sala de voz y en una reunión: el fondo es de la cámara de
 * quien lo pulsa, no de la sala, así que no hay nada que cambiar entre las dos.
 */
export function CameraBackgroundButton({ label = false }: { label?: boolean }) {
  const t = useT();
  const { effect } = useCameraEffect();
  const [composing, setComposing] = useState(() => voiceSnapshot().backgroundOn);
  useEffect(() => onVoice((state) => setComposing(state.backgroundOn)), []);
  const on = effect.kind !== "off";

  return (
    <Menu
      floating
      trigger={(props) =>
        label ? (
          <button
            {...props}
            aria-pressed={on}
            className={`btn rounded-full border-transparent px-3 text-xs ${on ? "btn-primary" : "btn-ghost"}`}
          >
            <Sparkles size={15} />
            {t("camBg.button")}
          </button>
        ) : (
          <IconButton {...props} label={t("camBg.button")} pressed={on}>
            <Sparkles size={17} />
          </IconButton>
        )
      }
    >
      {() => (
        <section className="flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2 p-1" aria-label={t("camBg.title")}>
          {/* Con el fondo elegido pero la cámara apagada, dar por hecho que ya
              está puesto sería mentir: se aplica en cuanto se encienda. */}
          {on && !composing ? (
            <p className="rounded-[10px] border border-line bg-sunken px-3 py-2 text-xs text-muted">
              {t("camBg.willApply")}
            </p>
          ) : null}
          <CameraBackgroundPicker compact />
        </section>
      )}
    </Menu>
  );
}

/**
 * El panel de Ajustes, con prueba en vivo.
 *
 * La prueba abre la cámara solo cuando se pide y la cierra al salir: dejarla
 * encendida "por comodidad" mientras alguien navega por los ajustes sería justo
 * el tipo de cosa que este proyecto no hace.
 */
export function CameraBackgroundSetup() {
  const t = useT();
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<"denied" | "failed" | "unsupported" | null>(null);
  const [busy, setBusy] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const alive = useRef<{ raw: MediaStream; pipeline: { stream: MediaStream; stop: () => void } | null } | null>(null);
  const { effect } = useCameraEffect();

  const stop = useCallback(() => {
    const current = alive.current;
    if (current) {
      current.pipeline?.stop();
      for (const track of current.raw.getTracks()) track.stop();
      alive.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setTesting(false);
  }, []);

  // Salir de Ajustes (o del todo) apaga la cámara de la prueba.
  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const raw = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      const pipeline = cameraEffect().kind === "off" ? null : await startCameraEffect(raw, 24);
      if (cameraEffect().kind !== "off" && !pipeline) {
        for (const track of raw.getTracks()) track.stop();
        setError(effectSupported() ? "failed" : "unsupported");
        return;
      }
      alive.current = { raw, pipeline };
      const node = videoRef.current;
      if (node) {
        node.srcObject = pipeline ? pipeline.stream : raw;
        void node.play().catch(() => {
          // Vídeo propio y en silencio: si aun así el navegador lo frena, el
          // recuadro se queda quieto pero nada más se rompe.
        });
      }
      setTesting(true);
    } catch {
      setError("denied");
    } finally {
      setBusy(false);
    }
  }, []);

  /* Cambiar entre "sin fondo" y "con fondo" durante la prueba cambia la fuente:
     se rehace, igual que hace la llamada de verdad. Cambiar de un fondo a otro
     no toca nada — el lienzo ya lo lee en cada fotograma. */
  const wanted = effect.kind !== "off";
  useEffect(() => {
    if (!testing) return;
    const current = alive.current;
    if (!current || wanted === (current.pipeline !== null)) return;
    let cancelled = false;
    void (async () => {
      const pipeline = wanted ? await startCameraEffect(current.raw, 24) : null;
      if (cancelled) {
        pipeline?.stop();
        return;
      }
      if (wanted && !pipeline) {
        setError("failed");
        return;
      }
      current.pipeline?.stop();
      current.pipeline = pipeline;
      const node = videoRef.current;
      if (node) {
        node.srcObject = pipeline ? pipeline.stream : current.raw;
        void node.play().catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wanted, testing]);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="display text-base font-bold">{t("camBg.title")}</h3>
        <p className="mt-1 text-sm text-muted">{t("camBg.intro")}</p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="relative grid aspect-video w-full max-w-md place-items-center overflow-hidden rounded-card border border-line bg-sunken">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            // Espejo, como cualquier vista previa de la propia cámara.
            className={`h-full w-full -scale-x-100 object-cover ${testing ? "" : "hidden"}`}
          />
          {testing ? (
            <IconButton label={t("camBg.previewStop")} onClick={stop} className="absolute top-2 right-2 bg-bg/70">
              <X size={15} />
            </IconButton>
          ) : (
            <p className="px-6 text-center text-xs text-muted">{t("camBg.previewHint")}</p>
          )}
        </div>
        <div>
          <Button variant="ghost" disabled={busy} onClick={() => (testing ? stop() : void start())}>
            {testing ? t("camBg.previewStop") : t("camBg.preview")}
          </Button>
        </div>
        {error === "denied" ? <ErrorNote>{t("voice.videoDenied")}</ErrorNote> : null}
        {error === "failed" ? <ErrorNote>{t("camBg.failed")}</ErrorNote> : null}
        {error === "unsupported" ? <ErrorNote>{t("camBg.unsupported")}</ErrorNote> : null}
      </div>

      <CameraBackgroundPicker />
    </div>
  );
}
