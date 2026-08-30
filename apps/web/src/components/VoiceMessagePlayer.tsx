import { useEffect, useRef, useState } from "react";
import { Pause, Play } from "lucide-react";
import { audioWaveform, formatVoiceMessageTime } from "../lib/voice-message.ts";
import { useT } from "./ui.tsx";

const PLAYER_BARS = 36;
const LOADING_WAVE = Array.from({ length: PLAYER_BARS }, (_, index) =>
  0.2 + ((index * 7) % 9) / 22,
);

interface DecodedWave {
  duration: number;
  wave: number[];
}

/* El historial puede contener muchas notas. La caché evita volver a descargar
   y decodificar el mismo archivo al re-renderizar, y OfflineAudioContext evita
   abrir una salida de sonido por cada badge visible. */
const decodedWaves = new Map<string, Promise<DecodedWave>>();

function decodeWave(src: string): Promise<DecodedWave> {
  const cached = decodedWaves.get(src);
  if (cached) return cached;
  const pending = (async () => {
    const response = await fetch(src);
    if (!response.ok) throw new Error(`audio ${response.status}`);
    const context = new OfflineAudioContext(1, 1, 44_100);
    const decoded = await context.decodeAudioData(await response.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
    return { duration: decoded.duration, wave: audioWaveform(channels, PLAYER_BARS) };
  })();
  decodedWaves.set(src, pending);
  void pending.catch(() => decodedWaves.delete(src));
  return pending;
}

/**
 * Reproductor de una nota de voz, con la misma forma de cápsula del badge de
 * grabación. El <audio> queda sin controles nativos: así no aparecen volumen,
 * silencio, descarga ni metadatos que no ayudan a escuchar el mensaje.
 */
export function VoiceMessagePlayer({ src, label }: { src: string; label: string }) {
  const t = useT();
  const audio = useRef<HTMLAudioElement>(null);
  const badge = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [wave, setWave] = useState<number[] | null>(null);
  const [nearViewport, setNearViewport] = useState(false);

  /* Decodificar solo cuando el badge se acerca a la vista. Abrir un canal con
     cincuenta audios antiguos no debe descargar cincuenta archivos de golpe. */
  useEffect(() => {
    const element = badge.current;
    if (!element || typeof IntersectionObserver !== "function") {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: "240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /* La forma se obtiene del archivo completo una sola vez. Se muestrean hasta
     256 puntos por segmento: conserva silencios, golpes y cambios de voz sin
     bloquear la interfaz recorriendo cada muestra de una grabación larga. */
  useEffect(() => {
    if (!nearViewport) return;
    let active = true;
    setWave(null);

    void decodeWave(src).then(
      (decoded) => {
        if (!active) return;
        setWave(decoded.wave);
        if (Number.isFinite(decoded.duration)) setDuration(decoded.duration);
      },
      () => {
        if (active) setWave(Array.from({ length: PLAYER_BARS }, () => 0.16));
      },
    );

    return () => { active = false; };
  }, [src, nearViewport]);

  /* timeupdate es demasiado espaciado para una barra de progreso; mientras
     suena se lee el reloj del elemento en cada frame y al pausar no queda
     ningún bucle vivo. */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      setCurrent(audio.current?.currentTime ?? 0);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  async function toggle(): Promise<void> {
    const element = audio.current;
    if (!element) return;
    if (element.paused) await element.play().catch(() => {});
    else element.pause();
  }

  function seek(seconds: number): void {
    const element = audio.current;
    if (!element || !Number.isFinite(seconds)) return;
    element.currentTime = seconds;
    setCurrent(seconds);
  }

  const bars = wave ?? LOADING_WAVE;
  const progress = duration > 0 ? Math.min(1, current / duration) : 0;

  return (
    <div ref={badge} className="vm-playback-badge" aria-label={label}>
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onLoadedMetadata={(event) => {
          const next = event.currentTarget.duration;
          if (Number.isFinite(next)) setDuration(next);
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrent(0);
        }}
      />
      <button
        type="button"
        className="vm-play-toggle"
        onClick={() => void toggle()}
        aria-label={playing ? t("message.audioPause") : t("message.audioPlay")}
      >
        {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
      </button>
      <span className="w-9 shrink-0 text-right text-[11px] font-semibold tabular-nums">
        {formatVoiceMessageTime(current * 1000)}
      </span>
      <div className={`vm-wave-seek ${wave ? "is-ready" : "is-loading"}`}>
        <span className="vm-wave-bars" aria-hidden>
          {bars.map((height, index) => (
            <span
              key={index}
              className={(index + 0.5) / bars.length <= progress ? "is-played" : ""}
              style={{ height: `${Math.round(height * 100)}%` }}
            />
          ))}
        </span>
        <input
          type="range"
          min={0}
          max={duration || 0}
          step="0.01"
          value={Math.min(current, duration || 0)}
          onChange={(event) => seek(event.currentTarget.valueAsNumber)}
          aria-label={t("message.audioSeek")}
          aria-valuetext={`${formatVoiceMessageTime(current * 1000)} / ${formatVoiceMessageTime(duration * 1000)}`}
          disabled={duration <= 0}
        />
      </div>
    </div>
  );
}
