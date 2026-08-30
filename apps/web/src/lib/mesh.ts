/**
 * Las dos reglas que deciden si la voz directa sirve de algo (§9.4).
 *
 * Viven aquí, fuera de `voice.ts`, porque son reglas sobre datos y no sobre
 * navegadores: se prueban con `node --test` en vez de abriendo dos pestañas y
 * hablando solo. `voice.ts` las llama con su estado; aquí no se sabe nada de
 * RTCPeerConnection ni de AudioContext.
 */
import type { Snowflake } from "@distop/protocol";

/**
 * Techo de la malla, en personas dentro de la sala.
 *
 * Una malla cuesta al cuadrado: cada quien sube una copia de su voz por cada
 * oyente. Con seis son cinco copias, que una conexión doméstica aguanta; con
 * doce son once y el remedio es peor que la enfermedad. Por encima de `MAX` la
 * sala entera vuelve por la instancia, y no vuelve a directo hasta bajar de
 * `BACK`: con un umbral único, alguien entrando y saliendo cambiaría el modo de
 * toda la llamada cada pocos segundos.
 *
 * ponytail: los números salen de la aritmética, no de una medición. Hay que
 * medirlos con gente real y moverlos; lo que no se puede es no tener franja.
 */
export const MESH_MAX = 9;
export const MESH_BACK = 6;

/**
 * ¿Sigue desbordada la malla?
 *
 * Se le pasa el estado anterior porque la histéresis es justamente eso: entre
 * `BACK` y `MAX` la respuesta depende de por dónde se entró a esa franja.
 */
export function meshOverflowed(participants: number, wasOverflowed: boolean): boolean {
  if (participants >= MESH_MAX) return true;
  if (participants <= MESH_BACK) return false;
  return wasOverflowed;
}

/**
 * ¿Hace falta seguir subiendo audio a la instancia?
 *
 * Es la regla que decide si todo el trabajo de la voz directa ahorra algo. Si
 * el codificador se dejara encendido "por si acaso" —confiando en que los
 * receptores descarten los duplicados— quien hospeda pagaría exactamente el
 * mismo ancho de banda que antes, y el P2P no habría servido para nada.
 *
 * Mientras se negocia también hace falta: son un par de segundos y la
 * alternativa es empezar la llamada en silencio.
 */
export function hostAudioNeeded(
  direct: boolean,
  roster: Iterable<Snowflake>,
  routes: Map<Snowflake, "p2p" | "host">,
): boolean {
  if (!direct) return true;
  for (const id of roster) if (routes.get(id) !== "p2p") return true;
  return false;
}
