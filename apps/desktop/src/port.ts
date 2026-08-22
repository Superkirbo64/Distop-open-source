/**
 * Elegir dónde escucha la instancia local (§26).
 *
 * El puerto no puede darse por supuesto: 5000 es una preferencia cómoda, pero
 * en un equipo cualquiera ya puede estar ocupado —otro servidor de desarrollo,
 * un servicio de Windows, otra copia del proyecto— y eso no debe impedirle a
 * nadie hospedar su comunidad. Se comprueba abriéndolo de verdad, en la misma
 * dirección que usará el servidor, y si está tomado se pide uno al sistema.
 */
import { createServer } from "node:net";

/** ¿Se puede escuchar aquí? Devuelve el puerto real, o null si está ocupado. */
function tryListen(port: number, address: string): Promise<number | null> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(null));
    probe.listen(port, address, () => {
      const bound = probe.address();
      const real = typeof bound === "object" && bound ? bound.port : null;
      probe.close(() => done(real));
    });
  });
}

/**
 * Puerto libre, prefiriendo `preferred`. Con el puerto 0 el sistema operativo
 * escoge uno cualquiera que esté libre, así que el segundo intento solo falla
 * si no queda ninguno en todo el equipo.
 *
 * Queda una ventana mínima entre esta comprobación y el arranque del servidor;
 * si alguien se cuela en ella, el fallo aparece en el log de la instancia.
 */
export async function freePort(preferred: number, address: string): Promise<number> {
  const wanted = await tryListen(preferred, address);
  if (wanted) return wanted;

  const any = await tryListen(0, address);
  if (any) return any;

  throw new Error("No hay ningún puerto libre en este equipo.");
}
