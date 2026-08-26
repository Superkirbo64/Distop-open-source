/**
 * Reuniones (V1, §8 del plan).
 *
 * Una reunión **no** es un tipo de sala de voz nuevo: es un canal con
 * `kind="meeting"` más una fila en `meetings`. Mensajes, adjuntos, permisos,
 * overwrites, búsqueda, fijados, el registro de salas y el relay binario
 * funcionan sin una línea de cambio, y las salas de voz de siempre quedan
 * exactamente como estaban.
 *
 * Lo que una reunión tiene y un canal de voz no: **termina**. Principio, final,
 * quién mandaba, quién estuvo y cuánto.
 *
 * Dos ejes de autoridad, y hacen falta los dos:
 *
 * - La jerarquía de la reunión gobierna lo ordinario: quién admite, quién
 *   presenta, quién cierra.
 * - La comunidad conserva **poderes de seguridad** —terminar una reunión
 *   abusiva, expulsar— visibles y auditados. Quitárselos permitiría a
 *   cualquiera crear, dentro del servidor de otra persona, una zona imposible
 *   de moderar.
 *
 * Un administrador no se convierte en organizador en silencio, y un organizador
 * no gana ningún poder sobre el servidor.
 */
import {
  MEETING_RANK,
  PERMISSIONS,
  canTransition,
  has,
  meetingCanModerate,
  uuidv7,
  type Meeting,
  type MeetingRole,
  type MeetingState,
  type MeetingWaiting,
  type Snowflake,
} from "@distop/protocol";
import { audit, db } from "./db.ts";
import { getChannel } from "./entities.ts";
import { channelPermissions, communityPermissions, memberState } from "./permissions.ts";
import { findUserById } from "./auth.ts";
import * as voice from "./voice.ts";

export class MeetingError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface FilaReunion {
  id: string;
  channel_id: string;
  community_id: string;
  title: string;
  agenda: string | null;
  organizer_id: string;
  state: MeetingState;
  starts_at: number | null;
  ends_at: number | null;
  opened_at: number | null;
  closed_at: number | null;
  lobby: number;
  mute_on_entry: number;
  guests_allowed: number;
  created_at: number;
}

function comoReunion(fila: FilaReunion): Meeting {
  return {
    ...fila,
    lobby: fila.lobby === 1,
    mute_on_entry: fila.mute_on_entry === 1,
    guests_allowed: fila.guests_allowed === 1,
  };
}

export function meetingById(id: Snowflake): Meeting | null {
  const fila = db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as FilaReunion | undefined;
  return fila ? comoReunion(fila) : null;
}

export function meetingOf(channelId: Snowflake): Meeting | null {
  const fila = db.prepare("SELECT * FROM meetings WHERE channel_id = ?").get(channelId) as FilaReunion | undefined;
  return fila ? comoReunion(fila) : null;
}

export function meetingsOf(communityId: Snowflake): Meeting[] {
  const filas = db
    .prepare("SELECT * FROM meetings WHERE community_id = ? ORDER BY COALESCE(starts_at, created_at) DESC")
    .all(communityId) as FilaReunion[];
  return filas.map(comoReunion);
}

/* ── convocar ──────────────────────────────────────────────────────────── */

export function createMeeting(opts: {
  communityId: Snowflake;
  organizerId: Snowflake;
  title: string;
  agenda?: string | null;
  startsAt?: number | null;
  endsAt?: number | null;
  lobby?: boolean;
  muteOnEntry?: boolean;
  categoryId?: string | null;
  now?: number;
}): Meeting {
  const now = opts.now ?? Date.now();
  if (opts.startsAt !== null && opts.startsAt !== undefined && opts.endsAt !== null && opts.endsAt !== undefined) {
    if (opts.endsAt <= opts.startsAt) throw new MeetingError("MEETING_BAD_WINDOW", "La reunión no puede acabar antes de empezar.");
  }

  const channelId = uuidv7();
  const meetingId = uuidv7();
  const posicion =
    (db.prepare("SELECT COALESCE(MAX(position), -1) AS p FROM channels WHERE community_id = ?").get(opts.communityId) as
      | { p: number }
      | undefined)?.p ?? -1;

  /* El canal y la reunión nacen juntos o no nacen: un canal de reunión sin su
     fila sería un canal de voz raro que nadie sabría cerrar. */
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO channels (id, community_id, category_id, name, kind, topic, position, created_at) VALUES (?, ?, ?, ?, 'meeting', ?, ?, ?)",
    ).run(
      channelId,
      opts.communityId,
      opts.categoryId ?? null,
      opts.title.slice(0, 100),
      opts.agenda ?? null,
      posicion + 1,
      now,
    );

    db.prepare(
      `INSERT INTO meetings (id, channel_id, community_id, title, agenda, organizer_id, state,
                             starts_at, ends_at, lobby, mute_on_entry, guests_allowed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      meetingId,
      channelId,
      opts.communityId,
      opts.title,
      opts.agenda ?? null,
      opts.organizerId,
      opts.startsAt ? "SCHEDULED" : "DRAFT",
      opts.startsAt ?? null,
      opts.endsAt ?? null,
      opts.lobby === false ? 0 : 1,
      opts.muteOnEntry === false ? 0 : 1,
      now,
    );
    db.prepare("INSERT INTO meeting_roles (meeting_id, user_id, role) VALUES (?, ?, 'host')").run(
      meetingId,
      opts.organizerId,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  audit(opts.communityId, opts.organizerId, "MEETING_CREATE", meetingId, { title: opts.title });
  return meetingById(meetingId)!;
}

/**
 * Cambia de estado, o explica por qué no.
 *
 * Las transiciones válidas viven en el protocolo, compartidas con el cliente:
 * si el servidor y la interfaz no estuvieran de acuerdo sobre qué se puede
 * hacer, la interfaz enseñaría botones que fallan.
 */
export function transitionMeeting(
  meetingId: Snowflake,
  to: MeetingState,
  actorId: Snowflake,
  now = Date.now(),
): Meeting {
  const reunion = meetingById(meetingId);
  if (!reunion) throw new MeetingError("MEETING_NOT_FOUND", "Reunión no encontrada.");
  if (!canTransition(reunion.state, to)) {
    throw new MeetingError("MEETING_BAD_TRANSITION", `Una reunión ${reunion.state} no puede pasar a ${to}.`);
  }

  const campos: string[] = ["state = ?"];
  const valores: Array<string | number> = [to];
  if ((to === "LOBBY" || to === "LIVE") && reunion.opened_at === null) {
    campos.push("opened_at = ?");
    valores.push(now);
  }
  if (to === "ENDED" || to === "CANCELLED") {
    campos.push("closed_at = ?");
    valores.push(now);
  }
  valores.push(meetingId);
  db.prepare(`UPDATE meetings SET ${campos.join(", ")} WHERE id = ?`).run(...valores);

  if (to === "ENDED" || to === "CANCELLED") {
    /* Cerrar completa la asistencia de quien siguiera dentro y vacía la sala:
       una reunión terminada con gente "todavía dentro" mentiría sobre cuánto
       duró para todo el mundo que no cerró su pestaña. */
    db.prepare("UPDATE meeting_attendance SET left_at = ? WHERE meeting_id = ? AND left_at IS NULL").run(now, meetingId);
    for (const userId of voice.peersOf(reunion.channel_id)) voice.leave(reunion.channel_id, userId);
    salasDeEspera.delete(reunion.channel_id);
  }

  audit(reunion.community_id, actorId, `MEETING_${to}`, meetingId, { from: reunion.state });
  return meetingById(meetingId)!;
}

export function cancelMeetingChannel(meetingId: Snowflake): void {
  const reunion = meetingById(meetingId);
  if (reunion) db.prepare("DELETE FROM channels WHERE id = ?").run(reunion.channel_id);
}

/* ── papeles ───────────────────────────────────────────────────────────── */

/**
 * Qué papel tiene alguien aquí.
 *
 * Sin fila explícita, `attendee`: quien puede ver el canal y conectarse entra
 * como asistente. Se decide por lo que ya dice el sistema de permisos en vez de
 * duplicar reglas, porque dos fuentes de verdad sobre quién puede entrar acaban
 * discrepando y la que discrepa siempre es la que deja pasar de más.
 */
export function roleOf(meetingId: Snowflake, userId: Snowflake): MeetingRole {
  const fila = db.prepare("SELECT role FROM meeting_roles WHERE meeting_id = ? AND user_id = ?").get(meetingId, userId) as
    | { role: MeetingRole }
    | undefined;
  return fila?.role ?? "attendee";
}

export function rolesOf(meetingId: Snowflake): Array<{ user_id: string; role: MeetingRole }> {
  return db.prepare("SELECT user_id, role FROM meeting_roles WHERE meeting_id = ?").all(meetingId) as Array<{
    user_id: string;
    role: MeetingRole;
  }>;
}

/**
 * Da o quita un papel.
 *
 * Nadie puede repartir un papel por encima del suyo, ni tocar a alguien de
 * rango igual o mayor. Sin esa regla, un coanfitrión podría degradar al
 * organizador y quedarse con la reunión.
 */
export function setMeetingRole(
  meetingId: Snowflake,
  actorId: Snowflake,
  targetId: Snowflake,
  role: MeetingRole,
): void {
  const reunion = meetingById(meetingId);
  if (!reunion) throw new MeetingError("MEETING_NOT_FOUND", "Reunión no encontrada.");

  const mio = roleOf(meetingId, actorId);
  const suyo = roleOf(meetingId, targetId);
  const puedeComunidad = securityOverride(reunion.community_id, actorId);

  if (!puedeComunidad) {
    if (!meetingCanModerate(mio)) throw new MeetingError("MEETING_FORBIDDEN", "No puedes repartir papeles aquí.");
    if (MEETING_RANK[role] >= MEETING_RANK[mio]) {
      throw new MeetingError("MEETING_FORBIDDEN", "No puedes dar un papel igual o superior al tuyo.");
    }
    if (MEETING_RANK[suyo] >= MEETING_RANK[mio] && targetId !== actorId) {
      throw new MeetingError("MEETING_FORBIDDEN", "No puedes cambiar el papel de alguien de tu rango o superior.");
    }
  }

  /* Sin anfitrión no queda quien cierre la reunión ni quien admita a nadie. */
  if (suyo === "host" && role !== "host" && hostCount(meetingId) <= 1) {
    throw new MeetingError("MEETING_LAST_HOST", "Es el último anfitrión: nombra a otro antes de quitarle el papel.");
  }

  db.prepare(
    "INSERT INTO meeting_roles (meeting_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(meeting_id, user_id) DO UPDATE SET role = excluded.role",
  ).run(meetingId, targetId, role);
  audit(reunion.community_id, actorId, "MEETING_ROLE", meetingId, { user_id: targetId, role });
}

function hostCount(meetingId: Snowflake): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM meeting_roles WHERE meeting_id = ? AND role = 'host'").get(meetingId) as {
    n: number;
  }).n;
}

/**
 * El poder de seguridad de la comunidad, que nunca desaparece.
 *
 * Sirve para terminar una reunión abusiva o expulsar a alguien, no para
 * apropiarse de la agenda: quien lo usa no se convierte en organizador, y cada
 * uso queda en la auditoría con su nombre.
 */
export function securityOverride(communityId: Snowflake, userId: Snowflake): boolean {
  const estado = memberState(communityId, userId);
  if (!estado.isMember || estado.banned) return false;
  const permisos = communityPermissions(communityId, userId);
  return has(permisos, PERMISSIONS.ADMINISTRATOR) || has(permisos, PERMISSIONS.MANAGE_MEETINGS);
}

/** ¿Puede esta persona admitir, expulsar y cerrar aquí? */
export function canModerate(meeting: Meeting, userId: Snowflake): boolean {
  return meetingCanModerate(roleOf(meeting.id, userId)) || securityOverride(meeting.community_id, userId);
}

/* ── sala de espera ────────────────────────────────────────────────────── */

/**
 * Quién espera fuera, por canal. En memoria a propósito, igual que las salas de
 * voz: esperar es un momento, no un registro, y una sala de espera que
 * sobrevive a un reinicio solo deja gente esperando a nada.
 *
 * **Aquí está la propiedad de seguridad entera de la sala de espera**: mientras
 * alguien esté en este mapa NO está en `voice`, y `relayMedia` reenvía
 * únicamente a quien está en `voice`. No hay una comprobación que se pueda
 * olvidar: no llega audio ni vídeo porque no hay a dónde mandárselo.
 */
const salasDeEspera = new Map<Snowflake, Map<Snowflake, number>>();

export function waitingOf(channelId: Snowflake): MeetingWaiting[] {
  const sala = salasDeEspera.get(channelId);
  if (!sala) return [];
  return [...sala.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([userId, since]) => ({
      user_id: userId,
      display_name: findUserById(userId)?.display_name ?? "",
      since,
    }));
}

export function isWaiting(channelId: Snowflake, userId: Snowflake): boolean {
  return salasDeEspera.get(channelId)?.has(userId) ?? false;
}

export type JoinOutcome = "joined" | "waiting" | "closed" | "denied";

/**
 * Entrar en una reunión: dentro, o a la sala de espera.
 *
 * `closed` cuando la reunión no está abierta. **Que llegue un invitado no abre
 * la reunión**: la abre una persona con permiso para hacerlo. Si bastara con
 * llegar pronto, cualquiera podría empezar la reunión de otro.
 */
export function joinMeeting(channelId: Snowflake, userId: Snowflake, now = Date.now()): JoinOutcome {
  const reunion = meetingOf(channelId);
  if (!reunion) return "denied";
  if (reunion.state !== "LOBBY" && reunion.state !== "LIVE") return "closed";
  if (!has(channelPermissions(channelId, userId), PERMISSIONS.VIEW_CHANNEL)) return "denied";

  /* Quien modera nunca espera fuera: si el anfitrión tuviera que esperar a que
     alguien le abriese, una reunión con la sala de espera puesta no podría
     empezar nunca. */
  const puedeEntrarSolo = !reunion.lobby || canModerate(reunion, userId);
  if (!puedeEntrarSolo) {
    const sala = salasDeEspera.get(channelId) ?? new Map<Snowflake, number>();
    if (!sala.has(userId)) sala.set(userId, now);
    salasDeEspera.set(channelId, sala);
    return "waiting";
  }

  return entrar(reunion, userId, null, now) ? "joined" : "denied";
}

/** Mete de verdad en la sala y abre su tramo de asistencia. */
function entrar(reunion: Meeting, userId: Snowflake, admittedBy: Snowflake | null, now: number): boolean {
  const resultado = voice.join(reunion.channel_id, userId);
  if (!resultado) return false;
  salasDeEspera.get(reunion.channel_id)?.delete(userId);

  if (reunion.mute_on_entry) voice.setMute(reunion.channel_id, userId, true, false);

  db.prepare(
    "INSERT OR IGNORE INTO meeting_attendance (meeting_id, user_id, joined_at, admitted_by, role_at_join) VALUES (?, ?, ?, ?, ?)",
  ).run(reunion.id, userId, now, admittedBy, roleOf(reunion.id, userId));
  return true;
}

export function admit(channelId: Snowflake, actorId: Snowflake, targetId: Snowflake, now = Date.now()): boolean {
  const reunion = meetingOf(channelId);
  if (!reunion || !canModerate(reunion, actorId)) return false;
  if (!isWaiting(channelId, targetId)) return false;
  return entrar(reunion, targetId, actorId, now);
}

export function admitAll(channelId: Snowflake, actorId: Snowflake, now = Date.now()): number {
  const reunion = meetingOf(channelId);
  if (!reunion || !canModerate(reunion, actorId)) return 0;
  let admitidos = 0;
  for (const espera of waitingOf(channelId)) {
    if (entrar(reunion, espera.user_id, actorId, now)) admitidos += 1;
  }
  return admitidos;
}

export function deny(channelId: Snowflake, actorId: Snowflake, targetId: Snowflake): boolean {
  const reunion = meetingOf(channelId);
  if (!reunion || !canModerate(reunion, actorId)) return false;
  if (!salasDeEspera.get(channelId)?.delete(targetId)) return false;
  audit(reunion.community_id, actorId, "MEETING_DENY", reunion.id, { user_id: targetId });
  return true;
}

/**
 * Salir. Cierra el tramo de asistencia abierto y, si la sala se queda vacía,
 * termina la reunión.
 *
 * Lo segundo no es cortesía: una reunión que se queda `LIVE` para siempre
 * porque el último se fue cerrando la pestaña es una reunión que nadie va a
 * cerrar nunca, y su asistencia queda abierta indefinidamente.
 */
export function leaveMeeting(channelId: Snowflake, userId: Snowflake, now = Date.now()): Meeting | null {
  const reunion = meetingOf(channelId);
  if (!reunion) return null;
  salasDeEspera.get(channelId)?.delete(userId);
  db.prepare(
    "UPDATE meeting_attendance SET left_at = ? WHERE meeting_id = ? AND user_id = ? AND left_at IS NULL",
  ).run(now, reunion.id, userId);

  if (reunion.state === "LIVE" && voice.peersOf(channelId).length === 0) {
    return transitionMeeting(reunion.id, "ENDED", userId, now);
  }
  return null;
}

/**
 * ¿Queda alguien que pueda admitir?
 *
 * Si no queda, la reunión **no se cierra sola y no se promociona a nadie**: hay
 * gente hablando, y cortarles por un tecnicismo sería peor. Lo que sí hay que
 * hacer es decírselo a quien espera fuera, en vez de dejarlo mirando una puerta
 * que ya no va a abrir nadie. Quien administra la comunidad siempre puede
 * entrar y cerrar.
 */
export function hasModeratorPresent(channelId: Snowflake): boolean {
  const reunion = meetingOf(channelId);
  if (!reunion) return false;
  return voice.peersOf(channelId).some((userId) => meetingCanModerate(roleOf(reunion.id, userId)));
}

/* ── asistencia ────────────────────────────────────────────────────────── */

export interface AttendanceRow {
  user_id: string;
  joined_at: number;
  left_at: number | null;
  admitted_by: string | null;
  role_at_join: MeetingRole;
}

export function attendanceOf(meetingId: Snowflake): AttendanceRow[] {
  return db
    .prepare("SELECT user_id, joined_at, left_at, admitted_by, role_at_join FROM meeting_attendance WHERE meeting_id = ? ORDER BY joined_at")
    .all(meetingId) as AttendanceRow[];
}

/** Cuánto estuvo cada persona, sumando tramos. Entrar y volver son dos. */
export function attendanceSummary(meetingId: Snowflake, now = Date.now()): Array<{ user_id: string; seconds: number }> {
  const total = new Map<string, number>();
  for (const tramo of attendanceOf(meetingId)) {
    const fin = tramo.left_at ?? now;
    total.set(tramo.user_id, (total.get(tramo.user_id) ?? 0) + Math.max(0, Math.round((fin - tramo.joined_at) / 1000)));
  }
  return [...total.entries()].map(([user_id, seconds]) => ({ user_id, seconds }));
}

/** Solo para las pruebas: vacía las salas de espera en memoria. */
export function resetLobbies(): void {
  salasDeEspera.clear();
}
