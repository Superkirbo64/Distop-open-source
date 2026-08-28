/**
 * Interfaz de reunión (V1–V4 del plan de continuidad).
 *
 * Una reunión es un canal de voz con reglas encima, y por eso aquí no hay
 * ningún escenario de vídeo propio: se reutiliza `VoiceStage` tal cual. Lo que
 * vive en este fichero es lo que una sala de voz normal no tiene — la sala de
 * espera, los papeles, la cola de manos, el aviso de grabación, el reparto de
 * vídeo y el turno de palabra.
 *
 * Dos reglas que se respetan en todo el fichero:
 *
 * - **Lo que la instancia va a rechazar no se enseña.** Es la misma regla del
 *   menú de moderación de la sala de voz: un botón que devuelve 403 no es
 *   interfaz, es una trampa.
 * - **El servidor manda.** Admitir, denegar, el turno y el estado se piden y se
 *   esperan; nada se pinta como hecho antes de que vuelva el evento. Así dos
 *   pestañas de la misma persona ven lo mismo.
 */
import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CircleDot,
  Clock,
  DoorOpen,
  Hand,
  Link2,
  Mic,
  Play,
  Square,
  Trash2,
  UserCheck,
  Users,
  Video,
  X,
} from "lucide-react";
import {
  MEETING_RANK,
  MEETING_ROLES,
  PERMISSIONS,
  has,
  meetingCanModerate,
  recordingIsLive,
  toBits,
  type Meeting,
  type MeetingRole,
  type MeetingWaiting,
  type VideoBudget,
} from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { sendCommand } from "../lib/gateway.ts";
import { holdFloor, joinVoice, raiseHand, setPushToTalkMode } from "../lib/voice.ts";
import { recordingSupported, requestRecording, stopRecording } from "../lib/record.ts";
import { useVoiceLocal } from "./Voice.tsx";
import { Avatar, Button, ErrorNote, Field, IconButton, Modal, Select, Spinner, useConfirm, useErrorText, useT } from "./ui.tsx";
import type { MessageKey } from "../i18n.ts";

/** Referencia estable: un `?? []` nuevo en cada lectura repinta en bucle (React #185). */
const SIN_ESPERA: MeetingWaiting[] = [];

const ESTADO_CLAVE: Record<Meeting["state"], MessageKey> = {
  DRAFT: "meeting.state.draft",
  SCHEDULED: "meeting.state.scheduled",
  LOBBY: "meeting.state.lobby",
  LIVE: "meeting.state.live",
  ENDED: "meeting.state.ended",
  CANCELLED: "meeting.state.cancelled",
};

const PAPEL_CLAVE: Record<MeetingRole, MessageKey> = {
  host: "meeting.role.host",
  cohost: "meeting.role.cohost",
  presenter: "meeting.role.presenter",
  attendee: "meeting.role.attendee",
  viewer: "meeting.role.viewer",
};

/** Fecha larga en el idioma de quien mira, sin inventar zona. */
function cuando(ms: number | null, locale: string): string {
  if (ms === null) return "";
  return new Date(ms).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

/* ── el panel entero ──────────────────────────────────────────────────── */

export function MeetingPanel({ channelId, communityId }: { channelId: string; communityId: string | null }) {
  const t = useT();
  const reunion = useStore((s) => s.meetings[channelId]);
  const loadMeeting = useStore((s) => s.loadMeeting);
  const [fallo, setFallo] = useState(false);

  useEffect(() => {
    setFallo(false);
    void loadMeeting(channelId).catch(() => setFallo(true));
  }, [channelId, loadMeeting]);

  /* El modo turno puede encenderse a mitad de reunión: el micrófono tiene que
     cerrarse en ese mismo instante, no en el siguiente repintado. */
  useEffect(() => {
    setPushToTalkMode(Boolean(reunion?.push_to_talk) && reunion?.state === "LIVE");
  }, [reunion?.push_to_talk, reunion?.state]);

  useEffect(() => () => setPushToTalkMode(false), []);

  if (fallo) return <ErrorNote>{t("meeting.loadFailed")}</ErrorNote>;
  if (!reunion) return <Spinner label={t("common.loading")} />;

  return <MeetingBody meeting={reunion} communityId={communityId} />;
}

function MeetingBody({ meeting, communityId }: { meeting: Meeting; communityId: string | null }) {
  const t = useT();
  const locale = useStore((s) => s.prefs.locale);
  const selfId = useStore((s) => s.user?.id ?? "");
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const papel = useStore((s) => s.meetingRole[meeting.id]) ?? "attendee";
  const esperando = useStore((s) => s.meetingWaiting[meeting.channel_id]) ?? false;

  /* Modera quien tiene papel de coanfitrión para arriba, o quien administra la
     comunidad. Los dos ejes existen a propósito (§8.2): organizar no da poder
     sobre el servidor, y administrar el servidor no te hace organizador. */
  const permisos = toBits(data?.permissions ?? "0");
  const autoridad = has(permisos, PERMISSIONS.ADMINISTRATOR) || has(permisos, PERMISSIONS.MANAGE_MEETINGS);
  const modero = meetingCanModerate(papel) || autoridad;

  if (esperando) return <SalaDeEspera meeting={meeting} />;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <CalendarClock size={18} className="shrink-0 text-muted" />
            <h2 className="display truncate text-base font-bold">{meeting.title}</h2>
            <EstadoPastilla state={meeting.state} />
          </div>
          {meeting.starts_at !== null ? (
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
              <Clock size={12} />
              {cuando(meeting.starts_at, locale)}
              {meeting.timezone ? <span className="opacity-70">· {meeting.timezone}</span> : null}
            </p>
          ) : null}
          {meeting.agenda ? <p className="mt-2 whitespace-pre-wrap text-sm text-muted">{meeting.agenda}</p> : null}
        </div>
        <MiPapel role={papel} />
      </header>

      <AvisoDeGrabacion channelId={meeting.channel_id} selfId={selfId} />
      <NotaDePresupuesto channelId={meeting.channel_id} />

      {modero ? <ControlesDeModeracion meeting={meeting} papel={papel} autoridad={autoridad} /> : null}
      {modero ? <SalaDeEsperaPanel meeting={meeting} /> : null}

      <ColaDeManos channelId={meeting.channel_id} members={data?.members ?? []} />

      {meeting.state === "LIVE" ? (
        <TurnoDePalabra meeting={meeting} papel={papel} members={data?.members ?? []} />
      ) : null}

      {meeting.state === "ENDED" || meeting.state === "CANCELLED" ? (
        <p className="text-sm text-muted">{t("meeting.overHint")}</p>
      ) : null}
    </div>
  );
}

function EstadoPastilla({ state }: { state: Meeting["state"] }) {
  const t = useT();
  const tono =
    state === "LIVE" ? "text-ok border-ok/40" : state === "CANCELLED" ? "text-danger border-danger/40" : "text-muted border-line";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[0.7rem] font-medium ${tono}`}>
      {t(ESTADO_CLAVE[state])}
    </span>
  );
}

function MiPapel({ role }: { role: MeetingRole }) {
  const t = useT();
  return (
    <span className="shrink-0 rounded-[10px] border border-line px-2 py-1 text-xs text-muted">
      {t("meeting.yourRole")}: <strong className="text-ink">{t(PAPEL_CLAVE[role])}</strong>
    </span>
  );
}

/* ── sala de espera, vista desde fuera ────────────────────────────────── */

/**
 * Lo que ve quien todavía no ha entrado.
 *
 * La instancia no distingue "esperando" de "denegado" a propósito —no publica a
 * quién culpar—, así que aquí tampoco se finge esa diferencia: se dice lo que
 * es cierto en los dos casos, que todavía estás fuera.
 */
function SalaDeEspera({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const grabacion = useStore((s) => s.recording[meeting.channel_id]) ?? null;

  return (
    <div className="grid flex-1 place-items-center p-6">
      <div className="max-w-sm text-center">
        <DoorOpen size={32} className="mx-auto mb-3 text-muted" />
        <h2 className="display text-base font-bold">{meeting.title}</h2>
        <p className="mt-2 text-sm text-muted">{t("meeting.waitingHint")}</p>
        {/* Se avisa desde la puerta, antes de entrar: enterarse después no es
            consentir. La instancia manda el estado de grabación al que espera
            justo por esto. */}
        {grabacion && recordingIsLive(grabacion.state) ? (
          <p className="mt-3 rounded-[10px] border border-warn/40 px-3 py-2 text-sm text-warn">
            {t("meeting.recordingBeforeEntry")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ── sala de espera, vista desde dentro ───────────────────────────────── */

function SalaDeEsperaPanel({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const locale = useStore((s) => s.prefs.locale);
  const espera = useStore((s) => s.lobby[meeting.channel_id]) ?? SIN_ESPERA;

  const admitir = (userId: string) =>
    sendCommand({ t: "MEETING_ADMIT", d: { channel_id: meeting.channel_id, user_id: userId } });
  const denegar = (userId: string) =>
    sendCommand({ t: "MEETING_DENY", d: { channel_id: meeting.channel_id, user_id: userId } });

  if (!meeting.lobby) return null;

  return (
    <section className="rounded-[12px] border border-line bg-surface p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Users size={15} className="text-muted" />
        {t("meeting.lobbyTitle")}
        <span className="rounded-full bg-raise px-1.5 text-xs text-muted">{espera.length}</span>
        <span className="flex-1" />
        {espera.length > 1 ? (
          <Button
            variant="ghost"
            className="h-7 px-2 text-xs"
            onClick={() => sendCommand({ t: "MEETING_ADMIT_ALL", d: { channel_id: meeting.channel_id } })}
          >
            {t("meeting.admitAll")}
          </Button>
        ) : null}
      </h3>

      {espera.length === 0 ? (
        <p className="text-xs text-muted">{t("meeting.lobbyEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {/* En orden de llegada: la instancia los manda ordenados por `since` y
              saber quién pidió primero es la mitad del valor de una cola. */}
          {espera.map((quien) => (
            <li key={quien.user_id} className="flex items-center gap-2 rounded-[10px] px-2 py-1 hover:bg-raise">
              <Avatar name={quien.display_name} size={26} />
              <span className="min-w-0 flex-1 truncate text-sm">{quien.display_name}</span>
              <time className="shrink-0 text-[0.7rem] text-muted" dateTime={new Date(quien.since).toISOString()}>
                {new Date(quien.since).toLocaleTimeString(locale, { timeStyle: "short" })}
              </time>
              <IconButton label={t("meeting.admit")} onClick={() => admitir(quien.user_id)}>
                <UserCheck size={16} className="text-ok" />
              </IconButton>
              <IconButton label={t("meeting.deny")} onClick={() => denegar(quien.user_id)}>
                <X size={16} className="text-danger" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ── manos levantadas ─────────────────────────────────────────────────── */

function ColaDeManos({ channelId, members }: { channelId: string; members: { user: { id: string; display_name: string }; nickname: string | null }[] }) {
  const t = useT();
  const local = useVoiceLocal();
  const estados = useStore((s) => s.voice[channelId]);
  const selfId = useStore((s) => s.user?.id ?? "");

  const dentro = local.channelId === channelId;
  /* Por hora de levantarla, no por orden de la sala: quien pidió primero va
     primero, que es justo lo que Teams no enseña. */
  const manos = (estados ?? [])
    .filter((estado) => estado.hand_raised_at !== null)
    .sort((a, b) => (a.hand_raised_at ?? 0) - (b.hand_raised_at ?? 0));

  const nombre = (id: string) => {
    const miembro = members.find((m) => m.user.id === id);
    return miembro?.nickname ?? miembro?.user.display_name ?? id;
  };
  const miMano = manos.some((estado) => estado.user_id === selfId);

  if (!dentro && manos.length === 0) return null;

  return (
    <section className="rounded-[12px] border border-line bg-surface p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Hand size={15} className="text-muted" />
        {t("meeting.handsTitle")}
        <span className="flex-1" />
        {dentro ? (
          <Button variant={miMano ? "primary" : "ghost"} className="h-7 px-2 text-xs" onClick={() => raiseHand(!miMano)}>
            {miMano ? t("meeting.handLower") : t("meeting.handRaise")}
          </Button>
        ) : null}
      </h3>

      {manos.length === 0 ? (
        <p className="text-xs text-muted">{t("meeting.handsEmpty")}</p>
      ) : (
        <ol className="flex flex-col gap-1">
          {manos.map((estado, indice) => (
            <li key={estado.user_id} className="flex items-center gap-2 text-sm">
              <span className="w-4 shrink-0 text-center text-xs text-muted">{indice + 1}</span>
              <Avatar name={nombre(estado.user_id)} size={22} />
              <span className="min-w-0 flex-1 truncate">{nombre(estado.user_id)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ── turno de palabra ─────────────────────────────────────────────────── */

/**
 * Pulsar para hablar.
 *
 * El botón y la barra espaciadora hacen lo mismo. El corte real lo aplica la
 * instancia en el reenvío: aquí solo se cierra el envío para no gastar subida
 * en algo que va a descartarse. Quién tiene la palabra lo dice el servidor, no
 * esta pantalla — por eso el nombre que se enseña sale del evento y no de la
 * bandera local.
 */
function TurnoDePalabra({
  meeting,
  papel,
  members,
}: {
  meeting: Meeting;
  papel: MeetingRole;
  members: { user: { id: string; display_name: string }; nickname: string | null }[];
}) {
  const t = useT();
  const local = useVoiceLocal();
  const selfId = useStore((s) => s.user?.id ?? "");
  const turno = useStore((s) => s.floor[meeting.channel_id]) ?? null;
  const dentro = local.channelId === meeting.channel_id;

  /* Sin `push_to_talk` no hay turno que pedir y el botón sobraría. Y quien solo
     mira no puede hablar: enseñarle el botón sería la trampa de siempre. */
  const activo = meeting.push_to_talk && dentro && MEETING_RANK[papel] >= MEETING_RANK.attendee;

  const soltar = useCallback(() => holdFloor(false), []);
  const pedir = useCallback(() => holdFloor(true), []);

  /* La barra espaciadora, ignorando los campos de texto: en una reunión se
     escribe en el chat lateral, y robar la barra ahí sería insufrible. */
  useEffect(() => {
    if (!activo) return;
    const escribiendo = (target: EventTarget | null): boolean => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
    };
    const abajo = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat || escribiendo(event.target)) return;
      event.preventDefault();
      pedir();
    };
    const arriba = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      soltar();
    };
    /* Perder el foco de la ventana con la tecla pulsada dejaría el micrófono
       abierto sin que nadie lo vea: se suelta al salir, siempre. */
    window.addEventListener("keydown", abajo);
    window.addEventListener("keyup", arriba);
    window.addEventListener("blur", soltar);
    return () => {
      window.removeEventListener("keydown", abajo);
      window.removeEventListener("keyup", arriba);
      window.removeEventListener("blur", soltar);
      soltar();
    };
  }, [activo, pedir, soltar]);

  if (!meeting.push_to_talk) return null;

  const nombre = (id: string) => {
    const miembro = members.find((m) => m.user.id === id);
    return miembro?.nickname ?? miembro?.user.display_name ?? id;
  };
  const mio = turno === selfId;
  const libre = turno === null;

  return (
    <section className="rounded-[12px] border border-line bg-surface p-3">
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <Mic size={15} className="text-muted" />
        {t("meeting.floorTitle")}
      </h3>
      <p className="mb-2 text-xs text-muted">
        {libre ? t("meeting.floorFree") : mio ? t("meeting.floorMine") : t("meeting.floorTaken", { name: nombre(turno) })}
      </p>
      {activo ? (
        <button
          type="button"
          onPointerDown={pedir}
          onPointerUp={soltar}
          onPointerLeave={soltar}
          onPointerCancel={soltar}
          disabled={!libre && !mio}
          className={`btn w-full ${mio ? "btn-primary" : "btn-ghost"} h-10`}
        >
          {mio ? t("meeting.floorRelease") : t("meeting.floorHold")}
        </button>
      ) : (
        <p className="text-xs text-muted">{dentro ? t("meeting.floorViewer") : t("meeting.floorJoinFirst")}</p>
      )}
    </section>
  );
}

/* ── grabación ────────────────────────────────────────────────────────── */

/**
 * El aviso de grabación.
 *
 * Permanente mientras dura, con nombre de quien graba —un aviso anónimo no deja
 * decidir si te quedas— y sin afirmar en ningún momento que verlo equivalga
 * legalmente a consentir.
 */
function AvisoDeGrabacion({ channelId, selfId }: { channelId: string; selfId: string }) {
  const t = useT();
  const grabacion = useStore((s) => s.recording[channelId]) ?? null;
  const data = useStore((s) => (s.activeCommunityId ? s.data[s.activeCommunityId] : undefined));

  if (!grabacion || !recordingIsLive(grabacion.state)) return null;

  const miembro = data?.members.find((m) => m.user.id === grabacion.recorder_id);
  const quien = miembro?.nickname ?? miembro?.user.display_name ?? t("meeting.someone");
  const yo = grabacion.recorder_id === selfId;

  return (
    <p
      role="status"
      className="flex items-center gap-2 rounded-[10px] border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
    >
      <CircleDot size={15} className="shrink-0 animate-pulse" />
      <span className="min-w-0 flex-1">
        {grabacion.state === "CONSENTING"
          ? t("meeting.recordingAboutTo", { name: quien })
          : t("meeting.recordingNow", { name: quien })}
      </span>
      {yo ? (
        <Button
          variant="danger"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => stopRecording(channelId)}
        >
          <Square size={12} /> {t("meeting.recordStop")}
        </Button>
      ) : null}
    </p>
  );
}

/* ── presupuesto de vídeo ─────────────────────────────────────────────── */

/**
 * Lo que no cabe, dicho antes de que se note.
 *
 * Solo aparece cuando hay cola: un reparto holgado no es noticia. En modo
 * directo el servidor no mide el bitrate real, así que no se enseña un número
 * que sería inventado.
 */
function NotaDePresupuesto({ channelId }: { channelId: string }) {
  const t = useT();
  const reparto: VideoBudget | null = useStore((s) => s.budget[channelId]) ?? null;

  if (!reparto || reparto.queued.length === 0) return null;

  return (
    <p className="flex items-start gap-2 rounded-[10px] border border-warn/40 px-3 py-2 text-sm text-warn">
      <Video size={15} className="mt-0.5 shrink-0" />
      <span>
        {reparto.mode === "host"
          ? t("meeting.budgetHost", { queued: reparto.queued.length, slots: reparto.slots })
          : t("meeting.budgetDirect", { queued: reparto.queued.length })}
      </span>
    </p>
  );
}

/* ── mandos de quien organiza ─────────────────────────────────────────── */

function ControlesDeModeracion({ meeting, papel, autoridad }: { meeting: Meeting; papel: MeetingRole; autoridad: boolean }) {
  const t = useT();
  const errorText = useErrorText();
  const { confirm, element } = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [panel, setPanel] = useState<"roles" | "invites" | "attendance" | null>(null);

  const cambiarEstado = async (state: Meeting["state"], entrar = false) => {
    setOcupado(true);
    setError(null);
    try {
      const actualizada = await api<Meeting>("POST", `/api/v1/meetings/${meeting.id}/state`, { state });
      useStore.setState((actual) => ({
        meetings: { ...actual.meetings, [actualizada.channel_id]: actualizada },
      }));
      if (entrar) await joinVoice(meeting.channel_id);
    } catch (fallo) {
      setError(errorText(fallo));
    } finally {
      setOcupado(false);
    }
  };

  /* Reactivo, no getState(): el botón tiene que desaparecer solo cuando otra
     persona empieza a grabar, no cuando este componente repinte por otra cosa. */
  const voiceLocal = useVoiceLocal();
  const grabando = useStore((s) => s.recording[meeting.channel_id]);
  const puedeGrabar = !grabando || !recordingIsLive(grabando.state);
  const dentroDeLaLlamada = voiceLocal.channelId === meeting.channel_id;

  return (
    <section className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-surface p-3">
      {meeting.state === "DRAFT" || meeting.state === "SCHEDULED" ? (
        <>
          {/* Que llegue alguien no abre la reunión: la abre una persona. */}
          <Button variant="ghost" disabled={ocupado} onClick={() => void cambiarEstado("LOBBY")}>
            <DoorOpen size={15} /> {t("meeting.openLobby")}
          </Button>
          <Button variant="primary" disabled={ocupado} onClick={() => void cambiarEstado("LIVE", true)}>
            <Play size={15} /> {t("meeting.start")}
          </Button>
        </>
      ) : null}

      {meeting.state === "LOBBY" ? (
        <Button variant="primary" disabled={ocupado} onClick={() => void cambiarEstado("LIVE", true)}>
          <Play size={15} /> {t("meeting.start")}
        </Button>
      ) : null}

      {meeting.state === "LOBBY" || meeting.state === "LIVE" ? (
        <Button
          variant="danger"
          disabled={ocupado}
          onClick={async () => {
            /* Terminar es irreversible: `ENDED` no tiene salida en la tabla de
               transiciones, porque reabrir falsearía asistencia y duración. */
            if (await confirm(t("meeting.endConfirm"))) void cambiarEstado("ENDED");
          }}
        >
          <Square size={15} /> {t("meeting.end")}
        </Button>
      ) : null}

      {meeting.state === "LIVE" && puedeGrabar ? (
        <Button
          variant="ghost"
          disabled={!dentroDeLaLlamada || !recordingSupported()}
          title={dentroDeLaLlamada ? undefined : t("meeting.recordNeedsCall")}
          onClick={() => requestRecording(meeting.channel_id)}
        >
          <CircleDot size={15} /> {t("meeting.recordStart")}
        </Button>
      ) : null}

      <span className="flex-1" />

      <Button variant="ghost" onClick={() => setPanel("roles")}>
        <Users size={15} /> {t("meeting.roles")}
      </Button>
      <Button variant="ghost" onClick={() => setPanel("invites")}>
        <Link2 size={15} /> {t("meeting.invites")}
      </Button>
      <Button variant="ghost" onClick={() => setPanel("attendance")}>
        <Check size={15} /> {t("meeting.attendance")}
      </Button>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <PanelDeRoles meeting={meeting} papel={papel} open={panel === "roles"} onClose={() => setPanel(null)} />
      <PanelDeInvitaciones meeting={meeting} open={panel === "invites"} onClose={() => setPanel(null)} />
      <PanelDeAsistencia meeting={meeting} open={panel === "attendance"} onClose={() => setPanel(null)} />
      {element}
    </section>
  );
}

/* ── papeles ──────────────────────────────────────────────────────────── */

function PanelDeRoles({
  meeting,
  papel,
  open,
  onClose,
}: {
  meeting: Meeting;
  papel: MeetingRole;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const communityId = meeting.community_id;
  const data = useStore((s) => s.data[communityId]);
  const [roles, setRoles] = useState<Array<{ user_id: string; role: MeetingRole }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCargando(true);
    api<{ meeting: Meeting; roles: Array<{ user_id: string; role: MeetingRole }> }>("GET", `/api/v1/meetings/${meeting.id}`)
      .then((detalle) => setRoles(detalle.roles))
      .catch((fallo) => setError(errorText(fallo)))
      .finally(() => setCargando(false));
  }, [open, meeting.id, errorText]);

  const asignar = async (userId: string, role: MeetingRole) => {
    setError(null);
    try {
      const respuesta = await api<{ roles: Array<{ user_id: string; role: MeetingRole }> }>(
        "PUT",
        `/api/v1/meetings/${meeting.id}/roles`,
        { user_id: userId, role },
      );
      setRoles(respuesta.roles);
    } catch (fallo) {
      setError(errorText(fallo));
    }
  };

  const papelDe = (userId: string): MeetingRole => roles.find((r) => r.user_id === userId)?.role ?? "attendee";

  /* No se ofrece un papel igual o superior al propio: la instancia lo rechaza,
     así que enseñarlo sería prometer algo que no se puede cumplir. */
  const opciones = MEETING_ROLES.filter((role) => MEETING_RANK[role] < MEETING_RANK[papel]).map((role) => ({
    value: role,
    label: t(PAPEL_CLAVE[role]),
  }));

  return (
    <Modal open={open} onClose={onClose} title={t("meeting.roles")} size="lg">
      <p className="mb-3 text-xs text-muted">{t("meeting.rolesHint")}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {cargando ? (
        <Spinner label={t("common.loading")} />
      ) : (
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {(data?.members ?? []).map((miembro) => {
            const suyo = papelDe(miembro.user.id);
            const intocable = MEETING_RANK[suyo] >= MEETING_RANK[papel];
            return (
              <li key={miembro.user.id} className="flex items-center gap-2 rounded-[10px] px-2 py-1 hover:bg-raise">
                <Avatar name={miembro.nickname ?? miembro.user.display_name} url={miembro.user.avatar_url} size={26} />
                <span className="min-w-0 flex-1 truncate text-sm">{miembro.nickname ?? miembro.user.display_name}</span>
                {intocable ? (
                  <span className="shrink-0 text-xs text-muted">{t(PAPEL_CLAVE[suyo])}</span>
                ) : (
                  <Select
                    compact
                    value={suyo}
                    options={opciones}
                    label={t("meeting.roleOf", { name: miembro.nickname ?? miembro.user.display_name })}
                    onChange={(next) => void asignar(miembro.user.id, next as MeetingRole)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/* ── invitaciones de reunión ──────────────────────────────────────────── */

interface InviteRow {
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
 * Enlaces para quien no tiene cuenta.
 *
 * El token se enseña una sola vez, al crearlo: la instancia solo guarda su
 * hash, así que no hay forma de volver a mostrarlo — y eso es una propiedad,
 * no una carencia.
 */
function PanelDeInvitaciones({ meeting, open, onClose }: { meeting: Meeting; open: boolean; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const publicUrl = useStore((s) => s.publicUrl);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [reciente, setReciente] = useState<string | null>(null);
  const [etiqueta, setEtiqueta] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const recargar = useCallback(() => {
    api<{ guests_allowed: boolean; invites: InviteRow[] }>("GET", `/api/v1/meetings/${meeting.id}/invites`)
      .then((respuesta) => setInvites(respuesta.invites))
      .catch((fallo) => setError(errorText(fallo)));
  }, [meeting.id, errorText]);

  useEffect(() => {
    if (open) recargar();
  }, [open, recargar]);

  const crear = async () => {
    setOcupado(true);
    setError(null);
    try {
      const respuesta = await api<{ invite: InviteRow; token: string }>("POST", `/api/v1/meetings/${meeting.id}/invites`, {
        ...(etiqueta.trim() ? { label: etiqueta.trim() } : {}),
      });
      setInvites((previas) => [respuesta.invite, ...previas]);
      setReciente(respuesta.token);
      setEtiqueta("");
    } catch (fallo) {
      setError(errorText(fallo));
    } finally {
      setOcupado(false);
    }
  };

  const revocar = async (id: string) => {
    setError(null);
    try {
      const respuesta = await api<{ invites: InviteRow[] }>("DELETE", `/api/v1/meetings/${meeting.id}/invites/${id}`);
      setInvites(respuesta.invites);
    } catch (fallo) {
      setError(errorText(fallo));
    }
  };

  const base = publicUrl || location.origin;
  const enlace = reciente ? `${base}/meet/${reciente}` : "";

  return (
    <Modal open={open} onClose={onClose} title={t("meeting.invites")} size="lg">
      <p className="mb-3 text-xs text-muted">{t("meeting.invitesHint")}</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="mb-3 flex items-end gap-2">
        <Field label={t("meeting.inviteLabel")}>
          {(id) => (
            <input
              id={id}
              value={etiqueta}
              maxLength={60}
              onChange={(event) => setEtiqueta(event.target.value)}
              className="field w-full"
            />
          )}
        </Field>
        <Button variant="primary" disabled={ocupado} onClick={() => void crear()}>
          {t("meeting.inviteCreate")}
        </Button>
      </div>

      {reciente ? (
        <div className="mb-3 rounded-[10px] border border-ok/40 p-2">
          <p className="mb-1 text-xs text-ok">{t("meeting.inviteOnce")}</p>
          <div className="flex items-center gap-2">
            <input readOnly value={enlace} className="field min-w-0 flex-1 text-xs" onFocus={(e) => e.target.select()} />
            <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(enlace)}>
              {t("common.copy")}
            </Button>
          </div>
        </div>
      ) : null}

      <ul className="flex max-h-[40vh] flex-col gap-1 overflow-y-auto">
        {invites.length === 0 ? <li className="text-xs text-muted">{t("meeting.invitesEmpty")}</li> : null}
        {invites.map((invite) => (
          <li key={invite.id} className="flex items-center gap-2 rounded-[10px] px-2 py-1 hover:bg-raise">
            <Link2 size={14} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1 truncate text-sm">{invite.label ?? t("meeting.inviteUnnamed")}</span>
            <span className="shrink-0 text-xs text-muted">
              {invite.max_uses === null ? t("meeting.inviteUses", { used: invite.uses }) : `${invite.uses}/${invite.max_uses}`}
            </span>
            {invite.revoked_at === null ? (
              <IconButton label={t("meeting.inviteRevoke")} onClick={() => void revocar(invite.id)}>
                <Trash2 size={15} className="text-danger" />
              </IconButton>
            ) : (
              <span className="shrink-0 text-xs text-muted">{t("meeting.inviteRevoked")}</span>
            )}
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/* ── asistencia ───────────────────────────────────────────────────────── */

interface AttendanceRow {
  user_id: string;
  joined_at: number;
  left_at: number | null;
  admitted_by: string | null;
  role_at_join: MeetingRole;
}

function PanelDeAsistencia({ meeting, open, onClose }: { meeting: Meeting; open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useStore((s) => s.prefs.locale);
  const errorText = useErrorText();
  const data = useStore((s) => s.data[meeting.community_id]);
  const [totales, setTotales] = useState<Array<{ user_id: string; seconds: number }>>([]);
  const [sesiones, setSesiones] = useState<AttendanceRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    api<{ sessions: AttendanceRow[]; totals: Array<{ user_id: string; seconds: number }> }>(
      "GET",
      `/api/v1/meetings/${meeting.id}/attendance`,
    )
      .then((respuesta) => {
        setSesiones(respuesta.sessions);
        setTotales(respuesta.totals);
      })
      .catch((fallo) => setError(errorText(fallo)));
  }, [open, meeting.id, errorText]);

  const nombre = (id: string) => {
    const miembro = data?.members.find((m) => m.user.id === id);
    return miembro?.nickname ?? miembro?.user.display_name ?? id;
  };
  const duracion = (segundos: number) => {
    const minutos = Math.round(segundos / 60);
    return minutos < 60 ? t("meeting.minutes", { n: minutos }) : t("meeting.hoursMinutes", { h: Math.floor(minutos / 60), m: minutos % 60 });
  };

  return (
    <Modal open={open} onClose={onClose} title={t("meeting.attendance")} size="lg">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {totales.length === 0 ? (
        <p className="text-xs text-muted">{t("meeting.attendanceEmpty")}</p>
      ) : (
        <ul className="flex max-h-[50vh] flex-col gap-1 overflow-y-auto">
          {totales.map((fila) => {
            const tramos = sesiones.filter((s) => s.user_id === fila.user_id);
            const primero = tramos[0];
            return (
              <li key={fila.user_id} className="flex items-center gap-2 rounded-[10px] px-2 py-1">
                <Avatar name={nombre(fila.user_id)} size={26} />
                <span className="min-w-0 flex-1 truncate text-sm">{nombre(fila.user_id)}</span>
                {primero ? (
                  <time className="shrink-0 text-xs text-muted" dateTime={new Date(primero.joined_at).toISOString()}>
                    {new Date(primero.joined_at).toLocaleTimeString(locale, { timeStyle: "short" })}
                  </time>
                ) : null}
                <span className="shrink-0 text-xs font-medium">{duracion(fila.seconds)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/* ── envío de comandos ────────────────────────────────────────────────── */

/* ── convocar ─────────────────────────────────────────────────────────── */

/** El formulario de convocar, que vive en la barra lateral. */
export function CreateMeeting({
  communityId,
  open,
  onClose,
}: {
  communityId: string;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const openChannel = useStore((s) => s.openChannel);
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [cuandoTexto, setCuandoTexto] = useState("");
  const [lobby, setLobby] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const crear = async () => {
    setOcupado(true);
    setError(null);
    try {
      /* La hora se manda en epoch ms y la zona aparte, solo informativa: el
         instante vive en UTC porque una zona cambia de reglas y "18:00 en
         Madrid" se desplaza sola cuando el país mueve su horario. */
      const inicio = cuandoTexto ? new Date(cuandoTexto).getTime() : null;
      const reunion = await api<Meeting>("POST", `/api/v1/communities/${communityId}/meetings`, {
        title: title.trim(),
        ...(agenda.trim() ? { agenda: agenda.trim() } : {}),
        ...(inicio !== null && Number.isFinite(inicio) ? { starts_at: inicio } : {}),
        lobby,
      });
      if (inicio !== null && Number.isFinite(inicio)) {
        await api<Meeting>("PATCH", `/api/v1/meetings/${reunion.id}/schedule`, {
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }).catch(() => undefined);
      }
      onClose();
      setTitle("");
      setAgenda("");
      setCuandoTexto("");
      /* reloadCommunities solo refresca los iconos del rail. El canal recién
         creado y sus permisos viven en bootstrap; sin recargarlo, openChannel
         seleccionaba un id que Chat no podía encontrar y la reunión quedaba
         inutilizable hasta recargar toda la aplicación. */
      await useStore.getState().openCommunity(communityId);
      await openChannel(reunion.channel_id);
    } catch (fallo) {
      setError(errorText(fallo));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("meeting.create")}
      footer={
        <Button variant="primary" disabled={ocupado || !title.trim()} onClick={() => void crear()}>
          <CalendarPlus size={15} /> {t("meeting.create")}
        </Button>
      }
    >
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Field label={t("meeting.title")}>
        {(id) => (
          <input
            id={id}
            value={title}
            maxLength={120}
            onChange={(event) => setTitle(event.target.value)}
            className="field w-full"
            autoFocus
          />
        )}
      </Field>
      <Field label={t("meeting.agenda")} hint={t("meeting.agendaHint")}>
        {(id) => (
          <textarea
            id={id}
            value={agenda}
            maxLength={2000}
            rows={3}
            onChange={(event) => setAgenda(event.target.value)}
            className="field w-full resize-y"
          />
        )}
      </Field>
      <Field label={t("meeting.when")} hint={t("meeting.whenHint")}>
        {(id) => (
          <input
            id={id}
            type="datetime-local"
            value={cuandoTexto}
            onChange={(event) => setCuandoTexto(event.target.value)}
            className="field w-full"
          />
        )}
      </Field>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={lobby} onChange={(event) => setLobby(event.target.checked)} />
        {t("meeting.lobbyOption")}
      </label>
    </Modal>
  );
}
