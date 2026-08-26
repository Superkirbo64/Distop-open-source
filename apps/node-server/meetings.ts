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
  canRecordingTransition,
  canTransition,
  has,
  meetingCanModerate,
  uuidv7,
  type Meeting,
  type MeetingRecording,
  type MeetingRole,
  type MeetingState,
  type MeetingWaiting,
  type RecordingState,
  type Snowflake,
} from "@distop/protocol";
import { createHash, randomBytes } from "node:crypto";
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
  sequence: number;
  timezone: string | null;
  push_to_talk: number;
}

function comoReunion(fila: FilaReunion): Meeting {
  return {
    ...fila,
    lobby: fila.lobby === 1,
    mute_on_entry: fila.mute_on_entry === 1,
    guests_allowed: fila.guests_allowed === 1,
    push_to_talk: fila.push_to_talk === 1,
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
    closeRecordings(meetingId, now);
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
  /* Entró de verdad: la limpieza de invitados no admitidos ya no se lo lleva. */
  db.prepare("UPDATE meeting_guests SET admitted_at = COALESCE(admitted_at, ?) WHERE user_id = ?").run(now, userId);
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

/* ── invitados (V2) ────────────────────────────────────────────────────
 *
 * Entrar por un enlace sin instalar nada y sin crear cuenta es la ventaja real
 * frente a las alternativas, y las dos piezas ya existían: canales con permisos
 * y sesiones revocables.
 *
 * Un invitado **no es miembro de la comunidad**. Meterlo en `members` sería lo
 * fácil y sería lo peor: le daría acceso a todo lo demás y lo pondría en la
 * lista de miembros de todo el mundo. Se ata a UNA reunión, y de ahí salen sus
 * permisos.
 */

const hashInvitacion = (token: string): string => createHash("sha256").update(token).digest("base64url");

export interface MeetingInvite {
  id: string;
  meeting_id: string;
  label: string | null;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/**
 * Crea un enlace. El token se devuelve **una sola vez**: de él solo se guarda
 * el hash, porque el enlace es el secreto y una base robada no debe entregar
 * las invitaciones vivas.
 */
export function createMeetingInvite(opts: {
  meetingId: Snowflake;
  creatorId: Snowflake;
  label?: string | null;
  maxUses?: number | null;
  expiresAt?: number | null;
  now?: number;
}): { invite: MeetingInvite; token: string } {
  const now = opts.now ?? Date.now();
  const token = randomBytes(24).toString("base64url");
  const id = uuidv7();
  db.prepare(
    `INSERT INTO meeting_invites (id, meeting_id, token_hash, creator_id, label, max_uses, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.meetingId,
    hashInvitacion(token),
    opts.creatorId,
    opts.label ?? null,
    opts.maxUses ?? null,
    opts.expiresAt ?? null,
    now,
  );
  return { invite: invitesOf(opts.meetingId).find((i) => i.id === id)!, token };
}

export function invitesOf(meetingId: Snowflake): MeetingInvite[] {
  return db
    .prepare(
      "SELECT id, meeting_id, label, uses, max_uses, expires_at, revoked_at, created_at FROM meeting_invites WHERE meeting_id = ? ORDER BY created_at DESC",
    )
    .all(meetingId) as MeetingInvite[];
}

export function revokeMeetingInvite(inviteId: string, now = Date.now()): boolean {
  return (
    db.prepare("UPDATE meeting_invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, inviteId)
      .changes > 0
  );
}

export type InviteRejection =
  | "INVITE_UNKNOWN"
  | "INVITE_REVOKED"
  | "INVITE_EXPIRED"
  | "INVITE_EXHAUSTED"
  | "MEETING_CLOSED"
  | "GUESTS_NOT_ALLOWED"
  | "MEETING_FULL";

export type InviteCheck =
  | { ok: true; invite: MeetingInvite; meeting: Meeting }
  | { ok: false; reason: InviteRejection };

/** Aforo de invitados por reunión: una lista sin fondo es disco de quien hospeda. */
export const MAX_INVITADOS = 100;

/**
 * Comprueba un enlace **sin crear nada**.
 *
 * El orden es la mitad del diseño de esta fase: primero el código, la reunión,
 * los invitados permitidos, la caducidad, los usos y el aforo; y solo si todo
 * eso pasa, se crea la identidad. Al revés, cualquiera probando enlaces al azar
 * dejaría un rastro de cuentas basura en la instancia de otra persona.
 */
export function checkMeetingInvite(token: string, now = Date.now()): InviteCheck {
  const fila = db.prepare("SELECT * FROM meeting_invites WHERE token_hash = ?").get(hashInvitacion(token)) as
    | (MeetingInvite & { token_hash: string })
    | undefined;
  if (!fila) return { ok: false, reason: "INVITE_UNKNOWN" };
  if (fila.revoked_at !== null) return { ok: false, reason: "INVITE_REVOKED" };
  if (fila.expires_at !== null && fila.expires_at <= now) return { ok: false, reason: "INVITE_EXPIRED" };
  if (fila.max_uses !== null && fila.uses >= fila.max_uses) return { ok: false, reason: "INVITE_EXHAUSTED" };

  const reunion = meetingById(fila.meeting_id);
  if (!reunion) return { ok: false, reason: "INVITE_UNKNOWN" };
  if (!reunion.guests_allowed) return { ok: false, reason: "GUESTS_NOT_ALLOWED" };
  if (reunion.state !== "LOBBY" && reunion.state !== "LIVE") return { ok: false, reason: "MEETING_CLOSED" };

  const invitados = (
    db.prepare("SELECT COUNT(*) AS n FROM meeting_guests WHERE meeting_id = ?").get(reunion.id) as { n: number }
  ).n;
  if (invitados >= MAX_INVITADOS) return { ok: false, reason: "MEETING_FULL" };

  return { ok: true, invite: fila, meeting: reunion };
}

/** Apunta el uso y ata al invitado a esa reunión. Después de crear la identidad. */
export function bindGuest(meetingId: Snowflake, inviteId: string, userId: Snowflake, now = Date.now()): void {
  db.prepare("UPDATE meeting_invites SET uses = uses + 1 WHERE id = ?").run(inviteId);
  db.prepare("INSERT OR REPLACE INTO meeting_guests (user_id, meeting_id, invite_id, created_at) VALUES (?, ?, ?, ?)").run(
    userId,
    meetingId,
    inviteId,
    now,
  );
}

/** A qué reunión está atado un invitado, o null si no lo es. */
export function guestMeetingOf(userId: Snowflake): Snowflake | null {
  const fila = db.prepare("SELECT meeting_id FROM meeting_guests WHERE user_id = ?").get(userId) as
    | { meeting_id: string }
    | undefined;
  return fila?.meeting_id ?? null;
}

/** El canal de la reunión a la que está atado un invitado, si lo está. */
export function guestChannelOf(userId: Snowflake): Snowflake | null {
  const fila = db
    .prepare("SELECT m.channel_id FROM meeting_guests g JOIN meetings m ON m.id = g.meeting_id WHERE g.user_id = ?")
    .get(userId) as { channel_id: string } | undefined;
  return fila?.channel_id ?? null;
}

/**
 * Lo que puede hacer un invitado, y solo en el canal de su reunión.
 *
 * Ver, entrar, hablar, encender la cámara y escribir en el chat de la reunión.
 * Nada más: ni adjuntar ficheros al disco de quien hospeda, ni mencionar a toda
 * la comunidad, ni gestionar nada.
 */
export const PERMISOS_INVITADO =
  PERMISSIONS.VIEW_CHANNEL |
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.READ_HISTORY |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.CONNECT_VOICE |
  PERMISSIONS.SPEAK |
  PERMISSIONS.STREAM |
  PERMISSIONS.USE_CAMERA;

/**
 * Limpia invitados que nunca llegaron a entrar.
 *
 * Alguien que abrió el enlace, escribió su nombre y se fue sin que le
 * admitieran deja una cuenta que no pertenece a ninguna comunidad y a la que
 * nadie va a volver. Sin esto se acumulan en el disco de quien hospeda.
 */
export function sweepGuests(maxAgeMs = 24 * 3600_000, now = Date.now()): number {
  const viejos = db
    .prepare("SELECT user_id FROM meeting_guests WHERE admitted_at IS NULL AND created_at < ?")
    .all(now - maxAgeMs) as Array<{ user_id: string }>;
  let borrados = 0;
  for (const { user_id } of viejos) {
    /* Solo se borra la cuenta si de verdad no es de nadie: quien convirtió su
       paso por una reunión en una cuenta de la comunidad no la pierde por una
       limpieza. */
    const esMiembro = (db.prepare("SELECT COUNT(*) AS n FROM members WHERE user_id = ?").get(user_id) as { n: number }).n;
    db.prepare("DELETE FROM meeting_guests WHERE user_id = ?").run(user_id);
    if (esMiembro === 0) {
      db.prepare("DELETE FROM users WHERE id = ? AND kind = 'guest'").run(user_id);
      borrados += 1;
    }
  }
  return borrados;
}

/* ── grabación (V3 §8.9) ───────────────────────────────────────────────
 *
 * **El fichero vive en el ordenador de quien graba.** El servidor no recibe ni
 * un byte de vídeo por aquí y no mezcla nada: mezclar exigiría decodificar,
 * componer y recodificar cada fotograma de cada persona en el PC de quien
 * hospeda, que es justo el trabajo que este proyecto no le puede pedir a un
 * ordenador doméstico.
 *
 * La línea honesta frente a las alternativas: **tu grabación es un fichero en
 * tu ordenador, no una nube que se alquila.**
 *
 * Lo que sí hace el servidor es lo único que un cliente no puede hacer solo:
 * que la sala entera se entere, y que quede escrito.
 */

interface FilaGrabacion {
  id: string;
  meeting_id: string;
  recorder_id: string;
  state: RecordingState;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
}

/** La grabación viva de una reunión, si la hay. */
export function liveRecording(meetingId: Snowflake): MeetingRecording | null {
  const fila = db
    .prepare(
      "SELECT * FROM meeting_recordings WHERE meeting_id = ? AND state IN ('REQUESTED','CONSENTING','RECORDING','FINALIZING') ORDER BY created_at DESC LIMIT 1",
    )
    .get(meetingId) as FilaGrabacion | undefined;
  return fila ?? null;
}

export function recordingsOf(meetingId: Snowflake): MeetingRecording[] {
  return db
    .prepare("SELECT * FROM meeting_recordings WHERE meeting_id = ? ORDER BY created_at DESC")
    .all(meetingId) as MeetingRecording[];
}

/**
 * Empieza el trámite de grabar. Todavía no graba nada: pasa por `CONSENTING`.
 *
 * Avisar después no es avisar. El estado intermedio existe para que el aviso
 * llegue a la sala **antes** de que se grabe el primer fotograma, y para que a
 * quien llegue más tarde se le pueda decir antes de admitirle.
 */
export function requestRecording(channelId: Snowflake, userId: Snowflake, now = Date.now()): MeetingRecording | null {
  const reunion = meetingOf(channelId);
  if (!reunion || reunion.state !== "LIVE") return null;
  /* Grabar una reunión ajena no lo decide cualquiera que esté dentro. */
  if (!canModerate(reunion, userId) && roleOf(reunion.id, userId) !== "presenter") return null;
  /* Una sola grabación viva: dos a la vez producen dos ficheros distintos que
     dicen ser la misma reunión, y nadie sabría cuál es "la" grabación. */
  if (liveRecording(reunion.id)) return null;

  const id = uuidv7();
  db.prepare(
    "INSERT INTO meeting_recordings (id, meeting_id, recorder_id, state, created_at) VALUES (?, ?, ?, 'CONSENTING', ?)",
  ).run(id, reunion.id, userId, now);
  audit(reunion.community_id, userId, "MEETING_RECORDING_START", reunion.id, { recording_id: id });
  return recordingById(id);
}

export function recordingById(id: string): MeetingRecording | null {
  return (db.prepare("SELECT * FROM meeting_recordings WHERE id = ?").get(id) as FilaGrabacion | undefined) ?? null;
}

/**
 * Avanza el estado de una grabación, o dice que no.
 *
 * Solo quien graba puede moverla: es su fichero y su disco, y nadie más sabe si
 * se cerró bien. La excepción es quien administra la comunidad, que puede
 * marcarla como fallida para cortar el aviso de una grabación abandonada.
 */
export function advanceRecording(
  recordingId: string,
  to: RecordingState,
  actorId: Snowflake,
  now = Date.now(),
): MeetingRecording | null {
  const actual = recordingById(recordingId);
  if (!actual) return null;
  const reunion = meetingById(actual.meeting_id);
  if (!reunion) return null;

  const suya = actual.recorder_id === actorId;
  const rescate = to === "FAILED" && securityOverride(reunion.community_id, actorId);
  if (!suya && !rescate) return null;
  if (!canRecordingTransition(actual.state, to)) return null;

  const campos: string[] = ["state = ?"];
  const valores: Array<string | number> = [to];
  if (to === "RECORDING" && actual.started_at === null) {
    campos.push("started_at = ?");
    valores.push(now);
  }
  if (to === "FINALIZING" || to === "FAILED") {
    campos.push("ended_at = COALESCE(ended_at, ?)");
    valores.push(now);
  }
  valores.push(recordingId);
  db.prepare(`UPDATE meeting_recordings SET ${campos.join(", ")} WHERE id = ?`).run(...valores);

  if (to === "AVAILABLE" || to === "FAILED" || to === "DELETED") {
    audit(reunion.community_id, actorId, `MEETING_RECORDING_${to}`, reunion.id, { recording_id: recordingId });
  }
  return recordingById(recordingId);
}

/**
 * Al cerrar la reunión, una grabación viva no se queda viva.
 *
 * Se marca como fallida y no como disponible: nadie ha confirmado que el
 * fichero se cerrara bien, y decir "disponible" sobre algo que quizá está
 * truncado es exactamente el tipo de mentira que este proyecto no cuenta.
 */
export function closeRecordings(meetingId: Snowflake, now = Date.now()): void {
  db.prepare(
    "UPDATE meeting_recordings SET state = 'FAILED', ended_at = COALESCE(ended_at, ?) WHERE meeting_id = ? AND state IN ('REQUESTED','CONSENTING','RECORDING','FINALIZING')",
  ).run(now, meetingId);
}

/* ── calendario (V4 §8.11) ─────────────────────────────────────────────
 *
 * Sin OAuth y sin integración con nadie: un `.ics` lo entiende cualquier
 * agenda que respete el RFC 5545, y así este proyecto no tiene que pedir
 * permisos sobre el calendario de otra persona ni guardar credenciales ajenas.
 */

const hashCalendario = (token: string): string => createHash("sha256").update(token).digest("base64url");

export interface CalendarToken {
  id: string;
  label: string | null;
  created_at: number;
  last_used: number | null;
  revoked_at: number | null;
}

/**
 * Crea una dirección de suscripción. El token se enseña una vez.
 *
 * Va en la URL, y eso es una concesión consciente: un cliente de calendario
 * solo sabe pedir una dirección — no puede mandar una cabecera ni un cuerpo—.
 * Por eso es de un solo propósito (solo lee reuniones), no da sesión, y se
 * revoca en un clic.
 */
export function createCalendarToken(userId: Snowflake, label?: string | null, now = Date.now()): {
  token: CalendarToken;
  secret: string;
} {
  const secret = randomBytes(24).toString("base64url");
  const id = uuidv7();
  db.prepare("INSERT INTO calendar_tokens (id, user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    userId,
    hashCalendario(secret),
    label ?? null,
    now,
  );
  return { token: calendarTokensOf(userId).find((t) => t.id === id)!, secret };
}

export function calendarTokensOf(userId: Snowflake): CalendarToken[] {
  return db
    .prepare("SELECT id, label, created_at, last_used, revoked_at FROM calendar_tokens WHERE user_id = ? ORDER BY created_at DESC")
    .all(userId) as CalendarToken[];
}

export function revokeCalendarToken(userId: Snowflake, id: string, now = Date.now()): boolean {
  return (
    db
      .prepare("UPDATE calendar_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(now, id, userId).changes > 0
  );
}

/** De quién es esta dirección, o null. Marca el último uso, para poder podarlas. */
export function calendarOwner(secret: string, now = Date.now()): Snowflake | null {
  const fila = db
    .prepare("SELECT id, user_id FROM calendar_tokens WHERE token_hash = ? AND revoked_at IS NULL")
    .get(hashCalendario(secret)) as { id: string; user_id: string } | undefined;
  if (!fila) return null;
  db.prepare("UPDATE calendar_tokens SET last_used = ? WHERE id = ?").run(now, fila.id);
  return fila.user_id;
}

/**
 * Las reuniones de alguien, para su agenda.
 *
 * Solo las de comunidades donde es miembro y solo los canales que ve: una
 * dirección de calendario no es una puerta trasera al listado de reuniones de
 * la instancia.
 */
export function agendaFor(userId: Snowflake): Meeting[] {
  const filas = db
    .prepare(
      `SELECT m.* FROM meetings m
       JOIN members mb ON mb.community_id = m.community_id AND mb.user_id = ?
       WHERE mb.banned = 0 AND m.starts_at IS NOT NULL AND m.state <> 'DRAFT'
       ORDER BY m.starts_at`,
    )
    .all(userId) as FilaReunion[];
  return filas
    .map(comoReunion)
    .filter((reunion) => has(channelPermissions(reunion.channel_id, userId), PERMISSIONS.VIEW_CHANNEL));
}

/**
 * Reprograma una reunión. Sube `sequence` con el **mismo** id.
 *
 * Ese es todo el motivo de que exista esta función en vez de un UPDATE suelto:
 * cambiar la hora sin subir la secuencia deja el evento viejo en la agenda de
 * todo el mundo y añade uno nuevo al lado.
 */
export function rescheduleMeeting(
  meetingId: Snowflake,
  actorId: Snowflake,
  cambios: { startsAt?: number | null; endsAt?: number | null; timezone?: string | null },
): Meeting {
  const reunion = meetingById(meetingId);
  if (!reunion) throw new MeetingError("MEETING_NOT_FOUND", "Reunión no encontrada.");
  const inicio = cambios.startsAt ?? reunion.starts_at;
  const fin = cambios.endsAt ?? reunion.ends_at;
  if (inicio !== null && fin !== null && fin <= inicio) {
    throw new MeetingError("MEETING_BAD_WINDOW", "La reunión no puede acabar antes de empezar.");
  }

  db.prepare("UPDATE meetings SET starts_at = ?, ends_at = ?, timezone = ?, sequence = sequence + 1 WHERE id = ?").run(
    inicio,
    fin,
    cambios.timezone ?? reunion.timezone,
    meetingId,
  );
  audit(reunion.community_id, actorId, "MEETING_RESCHEDULE", meetingId, { starts_at: inicio, ends_at: fin });
  return meetingById(meetingId)!;
}

/* ── turno de palabra (V4 §8.10) ───────────────────────────────────────
 *
 * Con `push_to_talk` puesto, solo suena quien tiene el turno, y **el turno lo
 * da el servidor**. Si lo decidiera cada cliente, "tengo el turno" sería una
 * afirmación que cualquiera escribe, y en una reunión de treinta personas eso
 * es exactamente el problema que el modo venía a resolver.
 *
 * Vive en memoria, como las salas: un turno de palabra no sobrevive a que se
 * apague el equipo, y guardarlo solo dejaría turnos fantasma.
 */
const turnos = new Map<Snowflake, { userId: Snowflake; since: number }>();

/** Nadie retiene el micrófono para siempre por soltar la tecla mal. */
export const TURNO_MAXIMO_MS = 120_000;

export function floorOf(channelId: Snowflake, now = Date.now()): Snowflake | null {
  const turno = turnos.get(channelId);
  if (!turno) return null;
  if (now - turno.since >= TURNO_MAXIMO_MS) {
    turnos.delete(channelId);
    return null;
  }
  return turno.userId;
}

/**
 * Pide el turno. Devuelve `true` si lo consigue.
 *
 * No hay cola: pedir la palabra ordenadamente es levantar la mano (V1), que sí
 * la tiene. Esto es para hablar por encima del ruido en una reunión grande, y
 * ahí el primero que llega habla — encolar turnos de dos segundos convertiría
 * una conversación en un walkie-talkie con retardo.
 */
export function takeFloor(channelId: Snowflake, userId: Snowflake, now = Date.now()): boolean {
  const actual = floorOf(channelId, now);
  if (actual !== null && actual !== userId) return false;
  turnos.set(channelId, { userId, since: actual === userId ? turnos.get(channelId)!.since : now });
  return true;
}

export function releaseFloor(channelId: Snowflake, userId: Snowflake): boolean {
  if (turnos.get(channelId)?.userId !== userId) return false;
  turnos.delete(channelId);
  return true;
}

/** Al salir de la sala se suelta el turno: si no, se lo lleva puesto. */
export function dropFloorOf(userId: Snowflake): Snowflake[] {
  const soltados: Snowflake[] = [];
  for (const [channelId, turno] of turnos) {
    if (turno.userId === userId) {
      turnos.delete(channelId);
      soltados.push(channelId);
    }
  }
  return soltados;
}

/**
 * ¿Puede sonar esta persona ahora mismo?
 *
 * Fuera del modo turno, siempre. Dentro, solo quien lo tiene — y si no lo tiene
 * nadie, nadie suena: un modo turno en el que el silencio deja hablar a todos
 * no es un modo turno.
 */
export function maySpeakNow(channelId: Snowflake, userId: Snowflake, now = Date.now()): boolean {
  const reunion = meetingOf(channelId);
  if (!reunion?.push_to_talk) return true;
  return floorOf(channelId, now) === userId;
}

/** Solo para las pruebas: olvida los turnos en curso. */
export function resetFloors(): void {
  turnos.clear();
}

/** Solo para las pruebas: vacía las salas de espera en memoria. */
export function resetLobbies(): void {
  salasDeEspera.clear();
}
