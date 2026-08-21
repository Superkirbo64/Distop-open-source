/**
 * Efectos de tarjeta con partículas de verdad, tomados hechos de tsParticles
 * (github.com/tsparticles/tsparticles, MIT): snow, fireworks y bubbles.
 *
 * Este archivo solo se importa con `lazy()` desde ProfileStyle: el engine y
 * los presets pesan, y quien nunca elige un efecto de canvas no descarga nada
 * de esto. Los presets viajan dentro del bundle —ningún CDN—, así que una
 * instancia sin salida a internet tiene el catálogo completo igualmente.
 */
import { useId, useMemo } from "react";
import Particles, { ParticlesProvider } from "@tsparticles/react";
import type { Engine, ISourceOptions } from "@tsparticles/engine";
import { loadSnowPreset } from "@tsparticles/preset-snow";
import { loadFireworksPreset } from "@tsparticles/preset-fireworks";
import { loadBubblesPreset } from "@tsparticles/preset-bubbles";

/* A nivel de módulo porque ParticlesProvider exige la MISMA función en toda
   la vida de la aplicación: con una flecha en línea, el segundo perfil con
   efecto tiraría un Error del wrapper. */
async function registerPresets(engine: Engine): Promise<void> {
  await Promise.all([
    loadSnowPreset(engine),
    loadFireworksPreset(engine),
    loadBubblesPreset(engine),
  ]);
}

export default function ParticleEffect({ effect, className }: { effect: string; className: string }) {
  /* tsParticles localiza su contenedor por id del DOM y su valor por defecto
     es fijo: dos tarjetas a la vez (barra de usuario + perfil abierto) se
     pisarían el canvas sin un id único por instancia. */
  const id = useId();

  const options = useMemo<ISourceOptions>(
    () => ({
      preset: effect,
      /* Los presets vienen pensados como fondo de página entera: traen color
         de fondo propio (blanco, negro), fullScreen y hasta sonido en el de
         fireworks. Todo eso sobra dentro de una tarjeta que ya pinta su
         degradado debajo. */
      fullScreen: { enable: false },
      background: { opacity: 0 },
      sounds: { enable: false },
      fpsLimit: 60,
      detectRetina: true,
    }),
    [effect],
  );

  return (
    <ParticlesProvider init={registerPresets}>
      <Particles id={id} className={className} options={options} />
    </ParticlesProvider>
  );
}
