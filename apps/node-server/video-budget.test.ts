/**
 * Presupuesto de vídeo y grabación (V3).
 *
 * El reparto es aritmética pura y se prueba como tal. Lo que hay que demostrar
 * no es que la suma esté bien, sino dos cosas que son fáciles de estropear:
 *
 * - **Prioridad no es inmunidad.** Una pantalla compartida entra la primera; la
 *   sexta pantalla compartida espera igual que todo lo demás.
 * - **El cliente no declara su prioridad.** Sale del papel y del tipo de
 *   fuente, calculados aquí.
 *
 * De la grabación se prueba lo único que el servidor puede prometer: que la
 * sala se entera, que se entera **antes**, y que nada se marca como disponible
 * sin que alguien lo confirme.
 *
 *   node --test "*.test.ts"
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  COSTE_KBPS,
  FACTOR_PRESION,
  MINIMO_FUENTES,
  PRIORIDAD,
  TECHO_POR_DEFECTO_KBPS,
  admitir,
  explicacion,
  ordenar,
  prioridadDe,
  repartir,
  type Emisor,
} from "./video-budget.ts";
import { RECORDING_TRANSITIONS, canRecordingTransition, recordingIsLive } from "@distop/protocol";

const emisor = (id: string, cambios: Partial<Emisor> = {}): Emisor => ({
  userId: id,
  source: "camera",
  role: "attendee",
  speaking: false,
  since: 1_000,
  ...cambios,
});

/* ── prioridad ────────────────────────────────────────────────────────── */

test("la prioridad sale del papel y de la fuente, nunca de lo que diga el cliente", () => {
  assert.equal(prioridadDe(emisor("a", { source: "screen", role: "viewer" })), PRIORIDAD.PANTALLA);
  assert.equal(prioridadDe(emisor("b", { role: "presenter" })), PRIORIDAD.CAMARA_PRESENTADOR);
  assert.equal(prioridadDe(emisor("c", { role: "host", speaking: true })), PRIORIDAD.MODERADOR_HABLANDO);
  assert.equal(prioridadDe(emisor("d", { role: "host", speaking: false })), PRIORIDAD.DINAMICO, "callado no es hablando");
  assert.equal(prioridadDe(emisor("e", { role: "attendee" })), PRIORIDAD.DINAMICO);
});

test("una pantalla compartida gana aunque la comparta quien menos manda", () => {
  /* El contenido de la reunión es el contenido, lo enseñe quien lo enseñe. */
  const orden = ordenar([
    emisor("anfitriona", { role: "host", speaking: true, since: 1 }),
    emisor("espectador", { source: "screen", role: "viewer", since: 9 }),
  ]);
  assert.equal(orden[0]!.userId, "espectador");
});

test("fuera de una reunión no hay jerarquía y no se inventa una", () => {
  /* En una sala de voz normal `role` es null: solo cuentan la pantalla y el
     orden de llegada. */
  const orden = ordenar([
    emisor("tercera", { role: null, since: 30 }),
    emisor("primera", { role: null, since: 10 }),
    emisor("segunda", { role: null, since: 20 }),
  ]);
  assert.deepEqual(orden.map((e) => e.userId), ["primera", "segunda", "tercera"]);
});

/* ── el techo físico ──────────────────────────────────────────────────── */

test("el coste crece con la gente que recibe, que es de donde venía el problema", () => {
  /* Una cámara entre ocho personas se copia siete veces. Ese factor es la razón
     entera de que exista este módulo. */
  const dos = repartir({ emisores: [emisor("a")], participantes: 2, modo: "host" });
  const ocho = repartir({ emisores: [emisor("a")], participantes: 8, modo: "host" });
  assert.equal(dos.coste_kbps, COSTE_KBPS.camera * 1);
  assert.equal(ocho.coste_kbps, COSTE_KBPS.camera * 7);
});

test("con ocho personas no caben cuatro cámaras, y se dice cuáles esperan", () => {
  const gente = 8;
  const emisores = ["a", "b", "c", "d"].map((id, i) => emisor(id, { since: i }));
  const reparto = repartir({ emisores, participantes: gente, modo: "host" });

  const porCamara = COSTE_KBPS.camera * (gente - 1);
  assert.equal(reparto.cabidas, Math.floor(TECHO_POR_DEFECTO_KBPS / porCamara));
  assert.ok(reparto.cola.length > 0, "el resto espera turno en vez de saturar a todo el mundo");
  assert.ok(reparto.coste_kbps <= TECHO_POR_DEFECTO_KBPS);
  assert.match(explicacion(reparto)!, /conexión del anfitrión/);
});

test("prioridad no es inmunidad: la sexta pantalla compartida también espera", () => {
  const pantallas = Array.from({ length: 6 }, (_, i) => emisor(`p${i}`, { source: "screen", since: i }));
  const reparto = repartir({ emisores: pantallas, participantes: 8, modo: "host" });

  assert.ok(reparto.cola.length > 0, "seis presentadores saturan igual que seis asistentes");
  assert.ok(reparto.coste_kbps <= TECHO_POR_DEFECTO_KBPS, "ninguna reserva rompe el techo físico");
  assert.deepEqual(
    reparto.activos.map((e) => e.userId),
    pantallas.slice(0, reparto.cabidas).map((e) => e.userId),
    "y a igualdad de prioridad manda el orden de llegada",
  );
});

test("siempre cabe una fuente, aunque el techo sea ridículo", () => {
  /* Una reunión en la que nadie puede enseñar nada no es una reunión, y una
     conexión mala no debe convertirla en un teléfono. */
  const reparto = repartir({
    emisores: [emisor("a"), emisor("b", { since: 2 })],
    participantes: 20,
    modo: "host",
    techoKbps: 10,
  });
  assert.equal(reparto.cabidas, MINIMO_FUENTES);
  assert.equal(reparto.cola.length, 1);
});

test("con la instancia apretada se reserva margen antes de que la voz se rompa", () => {
  const normal = repartir({ emisores: [], participantes: 4, modo: "host" });
  const apretada = repartir({ emisores: [], participantes: 4, modo: "host", presion: true });
  assert.equal(apretada.techo_kbps, Math.round(normal.techo_kbps * FACTOR_PRESION));
});

test("los dos modos se miden por separado, porque no son la misma medida", () => {
  const emisores = Array.from({ length: 5 }, (_, i) => emisor(`x${i}`, { since: i }));
  const porLaInstancia = repartir({ emisores, participantes: 8, modo: "host" });
  const directo = repartir({ emisores, participantes: 8, modo: "direct" });

  assert.ok(porLaInstancia.cola.length > 0, "en `host` el servidor sabe lo que cuesta y lo limita");
  assert.equal(directo.cola.length, 0, "en `direct` no hay subida del anfitrión que gastar");
  assert.equal(directo.coste_kbps, 0, "y el servidor no ve el bitrate real: fingir un número sería mentir");
  assert.deepEqual(
    directo.activos.map((e) => e.userId),
    porLaInstancia.activos.concat(porLaInstancia.cola).map((e) => e.userId),
    "lo que sí se conserva es el orden de prioridad, para que las dos vistas coincidan",
  );
});

/* ── admitir una fuente nueva ─────────────────────────────────────────── */

test("una pantalla compartida desplaza a una cámara en vez de ponerse a la cola", () => {
  /* Se calcula CON el candidato dentro. Preguntarlo como "¿queda hueco?"
     dejaría el contenido de la reunión esperando detrás de tres caras. */
  const gente = 8;
  const camaras = ["a", "b"].map((id, i) => emisor(id, { since: i }));
  const veredicto = admitir(
    { emisores: camaras, participantes: gente, modo: "host", techoKbps: COSTE_KBPS.camera * (gente - 1) * 2 },
    emisor("pantalla", { source: "screen", since: 99 }),
  );

  assert.equal(veredicto.admitido, true, "el contenido de la reunión entra");
  assert.ok(veredicto.desplazados.length > 0, "y sale quien menos prioridad tiene");
  assert.ok(!veredicto.desplazados.includes("pantalla"));
});

test("una cámara más no echa a nadie: espera su turno", () => {
  const gente = 8;
  const techo = COSTE_KBPS.camera * (gente - 1) * 2;
  const veredicto = admitir(
    {
      emisores: ["a", "b"].map((id, i) => emisor(id, { since: i })),
      participantes: gente,
      modo: "host",
      techoKbps: techo,
    },
    emisor("tarde", { since: 99 }),
  );
  assert.equal(veredicto.admitido, false);
  assert.deepEqual(veredicto.desplazados, [], "quien ya transmitía no pierde su sitio por alguien que llega después");
});

/* ── grabación ────────────────────────────────────────────────────────── */

test("no se puede empezar a grabar sin pasar por el aviso", () => {
  /* Avisar después no es avisar: el estado intermedio existe para que la sala
     se entere ANTES del primer fotograma. */
  assert.equal(canRecordingTransition("REQUESTED", "RECORDING"), false);
  assert.equal(canRecordingTransition("REQUESTED", "CONSENTING"), true);
  assert.equal(canRecordingTransition("CONSENTING", "RECORDING"), true);
});

test("nada se marca disponible sin que alguien cierre el fichero", () => {
  assert.equal(canRecordingTransition("RECORDING", "AVAILABLE"), false, "cerrar un vídeo puede fallar");
  assert.equal(canRecordingTransition("RECORDING", "FINALIZING"), true);
  assert.equal(canRecordingTransition("FINALIZING", "AVAILABLE"), true);
  assert.equal(canRecordingTransition("FINALIZING", "FAILED"), true);
});

test("una grabación terminada no se reanuda, y una borrada no vuelve", () => {
  assert.equal(canRecordingTransition("AVAILABLE", "RECORDING"), false);
  assert.deepEqual(RECORDING_TRANSITIONS.DELETED, []);
});

test("mientras hay aviso en pantalla es exactamente mientras se puede estar grabando", () => {
  assert.equal(recordingIsLive("CONSENTING"), true, "el aviso empieza antes que la grabación");
  assert.equal(recordingIsLive("RECORDING"), true);
  for (const estado of ["REQUESTED", "FINALIZING", "AVAILABLE", "FAILED", "DELETED"] as const) {
    assert.equal(recordingIsLive(estado), false, `${estado} no debería tener aviso permanente`);
  }
});
