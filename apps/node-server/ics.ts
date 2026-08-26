/**
 * Calendario `.ics` (V4, §8.11 del plan).
 *
 * Sin OAuth y sin integración directa con nadie. Un fichero `.ics` lo entienden
 * Google Calendar, Outlook, Apple, Thunderbird y cualquier otra cosa que
 * respete el RFC 5545, y no exige que este proyecto pida permisos a la agenda
 * de nadie ni guarde credenciales de terceros.
 *
 * El formato tiene cuatro detalles que casi todo el mundo se salta y que hacen
 * que un `.ics` se importe mal en silencio:
 *
 * 1. **Las líneas terminan en CRLF.** No es cosmético: hay clientes que
 *    rechazan el fichero entero con LF.
 * 2. **Las líneas se pliegan a 75 octetos**, contando bytes y no caracteres —
 *    una tilde ocupa dos—, y la continuación empieza por un espacio.
 * 3. **Coma, punto y coma, barra invertida y salto de línea se escapan.** Un
 *    título con una coma parte el campo en dos sin avisar.
 * 4. **El UID es estable y `SEQUENCE` sube al modificar.** Sin eso, cambiar la
 *    hora de una reunión crea un evento nuevo y deja el viejo en la agenda de
 *    todo el mundo.
 */

/** Escapa lo que el RFC 5545 §3.3.11 obliga a escapar, y en este orden. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Plegado a 75 octetos (RFC 5545 §3.1).
 *
 * Se cuenta en **bytes**: una tilde son dos, y un emoji cuatro. Contar
 * caracteres produce líneas que pasan del límite y clientes que se quejan. Y no
 * se parte nunca por la mitad de un carácter multibyte, que sería peor que la
 * línea larga.
 */
export function foldIcsLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  const trozos: string[] = [];
  let inicio = 0;
  let limite = 75;
  while (inicio < bytes.length) {
    let fin = Math.min(inicio + limite, bytes.length);
    /* Retroceder hasta el principio de un carácter: 10xxxxxx es continuación. */
    while (fin > inicio && fin < bytes.length && (bytes[fin]! & 0b1100_0000) === 0b1000_0000) fin -= 1;
    trozos.push(bytes.subarray(inicio, fin).toString("utf8"));
    inicio = fin;
    /* Las siguientes llevan un espacio delante, que también ocupa. */
    limite = 74;
  }
  return trozos.join("\r\n ");
}

/** `20260826T173000Z`. Siempre en UTC dentro del fichero. */
export function icsStamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export type IcsStatus = "CONFIRMED" | "TENTATIVE" | "CANCELLED";

export interface IcsEvent {
  /** Estable de por vida. Cambiarlo crea un evento nuevo en la agenda ajena. */
  uid: string;
  summary: string;
  description?: string | null;
  /** En epoch ms. Dentro del fichero viaja en UTC. */
  startsAt: number;
  endsAt: number;
  /** Sube en cada modificación, con el mismo UID. */
  sequence: number;
  status: IcsStatus;
  /** Dónde se celebra: el enlace de la reunión. */
  url?: string | null;
  /**
   * Zona horaria original, solo para que el cliente pueda enseñarla.
   *
   * Se guarda aparte y no se usa para calcular: el instante se almacena en UTC
   * porque una zona cambia de reglas —un país mueve su horario de verano— y una
   * hora guardada como "18:00 en Madrid" se desplaza sola cuando eso pasa.
   */
  timezone?: string | null;
}

function propiedad(nombre: string, valor: string): string {
  return foldIcsLine(`${nombre}:${valor}`);
}

/**
 * Un `VEVENT`. `DTSTAMP` es cuándo se generó este fichero, no cuándo es la
 * reunión: los clientes lo usan para saber qué versión es más nueva.
 */
export function icsEvent(event: IcsEvent, now: number): string[] {
  const lineas = [
    "BEGIN:VEVENT",
    propiedad("UID", event.uid),
    propiedad("DTSTAMP", icsStamp(now)),
    propiedad("DTSTART", icsStamp(event.startsAt)),
    propiedad("DTEND", icsStamp(event.endsAt)),
    propiedad("SEQUENCE", String(Math.max(0, Math.floor(event.sequence)))),
    propiedad("STATUS", event.status),
    propiedad("SUMMARY", escapeIcsText(event.summary)),
  ];
  if (event.description) lineas.push(propiedad("DESCRIPTION", escapeIcsText(event.description)));
  if (event.url) lineas.push(propiedad("URL", escapeIcsText(event.url)));
  /* Informativo: el instante ya va en UTC. Sirve para que la interfaz pueda
     decir "esto se convocó a las seis, hora de Madrid". */
  if (event.timezone) lineas.push(propiedad("X-DISTOP-TZ", escapeIcsText(event.timezone)));
  lineas.push("END:VEVENT");
  return lineas;
}

/**
 * El calendario entero.
 *
 * `PUBLISH` y no `REQUEST`: esto es una agenda a la que alguien se suscribe, no
 * una invitación que espera respuesta. Mandar `REQUEST` haría que los clientes
 * enseñaran botones de aceptar y rechazar que no llevan a ninguna parte.
 */
export function buildIcs(events: IcsEvent[], now = Date.now()): string {
  const lineas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    propiedad("PRODID", "-//Distop//Reuniones//ES"),
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...events.flatMap((event) => icsEvent(event, now)),
    "END:VCALENDAR",
  ];
  /* CRLF, incluido el final: hay clientes que rechazan el fichero entero sin él. */
  return `${lineas.join("\r\n")}\r\n`;
}
