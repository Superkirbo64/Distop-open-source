/**
 * Calendario `.ics` (V4).
 *
 * El RFC 5545 tiene cuatro detalles que casi todo el mundo se salta y que hacen
 * que un fichero se importe **mal en silencio**: CRLF, plegado a 75 octetos,
 * escapado, y un UID estable con `SEQUENCE`. Cada uno tiene su prueba, porque
 * el síntoma de fallarlos no es un error sino una agenda con la reunión mal.
 *
 *   node --test "*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIcs, escapeIcsText, foldIcsLine, icsStamp, type IcsEvent } from "./ics.ts";

const AHORA = Date.UTC(2026, 7, 26, 17, 30, 0);

const evento = (cambios: Partial<IcsEvent> = {}): IcsEvent => ({
  uid: "01a03f2a-0000-7000-8000-000000000001@distop",
  summary: "Reunión del martes",
  startsAt: Date.UTC(2026, 7, 27, 16, 0, 0),
  endsAt: Date.UTC(2026, 7, 27, 17, 0, 0),
  sequence: 0,
  status: "CONFIRMED",
  ...cambios,
});

/* ── los cuatro detalles ──────────────────────────────────────────────── */

test("todas las líneas terminan en CRLF, incluida la última", () => {
  const ics = buildIcs([evento()], AHORA);
  assert.ok(ics.endsWith("\r\n"), "hay clientes que rechazan el fichero entero sin el CRLF final");
  /* Ni un solo LF suelto: un \n sin \r delante rompe el parseo en algunos. */
  assert.equal(ics.replace(/\r\n/g, "").includes("\n"), false);
});

test("el escapado protege lo que el RFC obliga, y en el orden correcto", () => {
  assert.equal(escapeIcsText("Junta, con café; y té"), "Junta\\, con café\\; y té");
  assert.equal(escapeIcsText("dos\nlíneas"), "dos\\nlíneas");
  /* La barra invertida se escapa PRIMERO: si se hiciera al final, se
     duplicarían las que acaban de añadir los otros reemplazos. */
  assert.equal(escapeIcsText("ruta\\con,coma"), "ruta\\\\con\\,coma");
});

test("un título con coma no parte el campo en dos", () => {
  const ics = buildIcs([evento({ summary: "Junta, presupuesto y cierre" })], AHORA);
  assert.match(ics, /SUMMARY:Junta\\, presupuesto y cierre/);
});

test("el plegado cuenta octetos, no caracteres, y no parte un carácter por la mitad", () => {
  /* Setenta y cinco "á" son 150 bytes: contando caracteres cabría en una línea
     y el fichero saldría fuera de norma. */
  const largo = `SUMMARY:${"á".repeat(75)}`;
  const plegado = foldIcsLine(largo);
  const lineas = plegado.split("\r\n");

  assert.ok(lineas.length > 1, "se plegó");
  for (const linea of lineas) {
    assert.ok(Buffer.byteLength(linea, "utf8") <= 75, `línea de ${Buffer.byteLength(linea, "utf8")} octetos`);
  }
  for (const linea of lineas.slice(1)) {
    assert.ok(linea.startsWith(" "), "la continuación empieza por espacio");
  }
  /* Y al deshacer el plegado sale exactamente lo que entró: ni un carácter
     partido, que sería peor que la línea larga. */
  assert.equal(plegado.replace(/\r\n /g, ""), largo);
});

test("una línea corta no se toca", () => {
  assert.equal(foldIcsLine("STATUS:CONFIRMED"), "STATUS:CONFIRMED");
});

test("modificar sube SEQUENCE con el MISMO uid", () => {
  /* Sin esto, cambiar la hora crea un evento nuevo y deja el viejo en la agenda
     de todo el mundo. Es el fallo más caro de esta fase. */
  const antes = buildIcs([evento()], AHORA);
  const despues = buildIcs([evento({ sequence: 1, startsAt: Date.UTC(2026, 7, 27, 18, 0, 0) })], AHORA);

  const uid = /UID:(.+)\r\n/.exec(antes)![1];
  assert.equal(/UID:(.+)\r\n/.exec(despues)![1], uid, "el mismo evento, no uno nuevo");
  assert.match(antes, /SEQUENCE:0/);
  assert.match(despues, /SEQUENCE:1/);
});

test("cancelar no borra el evento: lo marca", () => {
  /* Quitarlo del fichero deja la reunión en la agenda de quien no vuelva a
     sincronizar. `STATUS:CANCELLED` la tacha en todas partes. */
  const ics = buildIcs([evento({ status: "CANCELLED", sequence: 2 })], AHORA);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.match(ics, /SEQUENCE:2/);
});

/* ── formato y estructura ─────────────────────────────────────────────── */

test("las fechas van en UTC con la forma que espera el RFC", () => {
  assert.equal(icsStamp(Date.UTC(2026, 7, 26, 17, 30, 0)), "20260826T173000Z");
  const ics = buildIcs([evento()], AHORA);
  assert.match(ics, /DTSTAMP:20260826T173000Z/);
  assert.match(ics, /DTSTART:20260827T160000Z/);
  assert.match(ics, /DTEND:20260827T170000Z/);
});

test("la zona original viaja aparte y no se usa para calcular", () => {
  /* El instante vive en UTC porque una zona cambia de reglas: una hora guardada
     como "18:00 en Madrid" se desplaza sola cuando el país mueve su horario. */
  const ics = buildIcs([evento({ timezone: "Europe/Madrid" })], AHORA);
  assert.match(ics, /DTSTART:20260827T160000Z/, "el instante sigue en UTC");
  assert.match(ics, /X-DISTOP-TZ:Europe\/Madrid/, "y la zona solo acompaña, para poder enseñarla");
});

test("el calendario se anuncia como agenda, no como invitación", () => {
  /* `REQUEST` haría que los clientes enseñaran botones de aceptar y rechazar
     que no llevan a ninguna parte: aquí nadie responde a nada. */
  const ics = buildIcs([evento()], AHORA);
  assert.match(ics, /METHOD:PUBLISH/);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
});

test("varios eventos, cada uno en su bloque", () => {
  const ics = buildIcs([evento(), evento({ uid: "otro@distop", summary: "Retro" })], AHORA);
  assert.equal(ics.match(/BEGIN:VEVENT/g)?.length, 2);
  assert.equal(ics.match(/END:VEVENT/g)?.length, 2);
});

test("una agenda vacía sigue siendo un calendario válido", () => {
  /* Quien se suscribe antes de tener nada convocado no debe recibir un fichero
     roto: su agenda dejaría de sincronizar y no diría por qué. */
  const ics = buildIcs([], AHORA);
  assert.ok(ics.startsWith("BEGIN:VCALENDAR"));
  assert.ok(ics.trimEnd().endsWith("END:VCALENDAR"));
  assert.equal(ics.includes("BEGIN:VEVENT"), false);
});
