/**
 * Panel de miembros y moderación en línea (§23).
 * Las acciones que aparecen dependen de los permisos reales; la instancia las
 * vuelve a comprobar igualmente, esto solo evita ofrecer lo imposible.
 */
import { useEffect, useState } from "react";
import { Ban, CalendarDays, Clock, Crown, Gamepad2, MicOff, MoreVertical, UserRound, Video, Volume2, VolumeX, X } from "lucide-react";
import { PERMISSIONS, has, toBits, type GameSession, type Member } from "@distop/protocol";
import { gameOf, useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Avatar, avatarOverflow, DisplayName, IconButton, Menu, MenuItem, Modal, PanelResizeHandle, useConfirm, useLocale, useT } from "./ui.tsx";
import { CardEffectLayer, cardBackground, profileSurfaceBackground } from "./ProfileStyle.tsx";
import { formatDate, formatDuration } from "../i18n.ts";

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];

const TIMEOUT_MS = 10 * 60 * 1000;

export function Members({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { confirm, element: confirmElement } = useConfirm();

  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const me = useStore((s) => s.user);
  const [profile, setProfile] = useState<Member | null>(null);

  if (!communityId || !data) return null;

  const permissions = toBits(data.permissions);
  const canKick = has(permissions, PERMISSIONS.KICK_MEMBERS);
  const canBan = has(permissions, PERMISSIONS.BAN_MEMBERS);
  const canTimeout = has(permissions, PERMISSIONS.TIMEOUT_MEMBERS);

  /*
   * Agrupado por rol destacado, no solo por conexión: en una comunidad con
   * moderación, saber quién manda importa más que quién está conectado. Solo
   * agrupan los roles marcados como "hoist"; el resto cae en el grupo general,
   * y quien está desconectado siempre va al final.
   */
  const online = data.members.filter((member) => data.online.includes(member.user.id));
  const offline = data.members.filter((member) => !data.online.includes(member.user.id));

  const hoisted = data.roles
    .filter((role) => role.hoist && !role.is_default)
    .sort((a, b) => b.position - a.position);

  const grouped: Array<{ key: string; title: string; color?: string | undefined; list: Member[] }> = [];
  const placed = new Set<string>();

  for (const role of hoisted) {
    const list = online.filter((member) => !placed.has(member.user.id) && member.role_ids.includes(role.id));
    for (const member of list) placed.add(member.user.id);
    if (list.length > 0) grouped.push({ key: role.id, title: role.name, color: role.color ?? undefined, list });
  }

  const rest = online.filter((member) => !placed.has(member.user.id));
  if (rest.length > 0) grouped.push({ key: "online", title: t("members.online"), list: rest });
  if (offline.length > 0) grouped.push({ key: "offline", title: t("members.offline"), list: offline });

  function colorOf(member: Member): string | undefined {
    return data!.roles
      .filter((role) => role.color && member.role_ids.includes(role.id))
      .sort((a, b) => b.position - a.position)[0]?.color ?? undefined;
  }

  function rowGame(member: Member) {
    return data!.game_presences?.find((presence) => presence.user_id === member.user.id);
  }

  function renderGroup(title: string, list: Member[], color?: string | undefined) {
    if (list.length === 0) return null;
    return (
      <section className="mb-4">
        <h3
          className="px-2 pb-1 text-[0.7rem] font-semibold tracking-wider uppercase"
          style={{ color: color ?? "var(--muted)" }}
        >
          {title} — {list.length}
        </h3>
        <ul className="flex flex-col">
          {list.map((member) => {
            const isOwner = data!.community.owner_id === member.user.id;
            const canModerate = member.user.id !== me?.id && !isOwner;
            return (
              /* La placa va en background-image y el hover en background-color:
                 por eso conviven en la misma fila sin pisarse (ver styles.css). */
              <li
                key={member.user.id}
                className={`group flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-raise plate plate-${member.user.profile_style.nameplate}`}
              >
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setProfile(member)}>
                  <Avatar
                    name={member.nickname ?? member.user.display_name}
                    url={member.user.avatar_url}
                    id={member.user.id}
                    size={30}
                    ring={data!.online.includes(member.user.id) ? "online" : "offline"}
                    profile={member.user.profile_style}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1">
                      <span className="block truncate text-sm font-medium">
                        <DisplayName
                          name={member.nickname ?? member.user.display_name}
                          style={member.user.profile_style}
                          accent={member.user.accent_color}
                          roleColor={colorOf(member)}
                        />
                      </span>
                      {isOwner ? <Crown size={12} className="shrink-0 text-warn" aria-label={t("members.owner")} /> : null}
                    </span>
                    {member.timeout_until && member.timeout_until > Date.now() ? (
                      <span className="block text-[0.68rem] text-warn">{t("message.timedOut")}</span>
                    ) : member.user.kind === "guest" ? (
                      <span className="block text-[0.68rem] text-muted">{t("members.guest")}</span>
                    ) : rowGame(member) ? (
                      <span className="block truncate text-[0.68rem]" style={{ color: "var(--ok)" }}>
                        {t("game.playing", { name: rowGame(member)!.game_name })}
                      </span>
                    ) : null}
                  </span>
                </button>

                {canModerate && (canKick || canBan || canTimeout) ? (
                  <Menu
                    trigger={({ onClick }) => (
                      <IconButton label={t("members.title")} onClick={onClick} className="h-7 w-7 opacity-0 group-hover:opacity-100 focus:opacity-100">
                        <MoreVertical size={14} />
                      </IconButton>
                    )}
                  >
                    {(close) => (
                      <>
                        {canTimeout ? (
                          <MenuItem
                            onClick={() => {
                              close();
                              const active = (member.timeout_until ?? 0) > Date.now();
                              void api("PATCH", `/api/v1/communities/${communityId}/members/${member.user.id}`, {
                                timeout_until: active ? null : Date.now() + TIMEOUT_MS,
                              });
                            }}
                          >
                            {(member.timeout_until ?? 0) > Date.now() ? t("members.untimeout") : t("members.timeout")}
                          </MenuItem>
                        ) : null}

                        {canKick ? (
                          <MenuItem
                            danger
                            onClick={async () => {
                              close();
                              if (await confirm(`${t("members.kick")} — ${member.user.display_name}`))
                                await api("DELETE", `/api/v1/communities/${communityId}/members/${member.user.id}`);
                            }}
                          >
                            {t("members.kick")}
                          </MenuItem>
                        ) : null}

                        {canBan ? (
                          <MenuItem
                            danger
                            onClick={async () => {
                              close();
                              if (await confirm(`${t("members.ban")} — ${member.user.display_name}`))
                                await api("PATCH", `/api/v1/communities/${communityId}/members/${member.user.id}`, {
                                  banned: !member.banned,
                                });
                            }}
                          >
                            {member.banned ? t("members.unban") : t("members.ban")}
                          </MenuItem>
                        ) : null}
                      </>
                    )}
                  </Menu>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  return (
    <aside data-pane="members" className="relative flex w-full flex-col border-l border-line bg-surface">
      <PanelResizeHandle />
      {/* Cabecera de la misma altura que las otras dos: las tres líneas de la
          parte de arriba tienen que quedar a la misma altura, no escalonadas. */}
      <header className="flex h-[var(--header-h)] shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="display truncate text-[0.95rem] font-bold">{t("members.title")}</h2>
        <IconButton label={t("common.close")} onClick={onClose}>
          <X size={17} />
        </IconButton>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {grouped.map((group) => (
          <div key={group.key} className={group.key === "offline" ? "opacity-60" : ""}>
            {renderGroup(group.title, group.list, group.color)}
          </div>
        ))}
      </div>

      <ProfileCard member={profile} onClose={() => setProfile(null)} color={profile ? colorOf(profile) : undefined} />
      {confirmElement}
    </aside>
  );
}

/**
 * Tarjeta de perfil (§10.1).
 * Portada a sangre, avatar centrado encima y el resto en bloques: quién es, sus
 * roles, dónde coincidís y qué está haciendo ahora mismo. Todo lo que pinta
 * sale de datos reales de la instancia; no hay huecos rellenos con servicios de
 * terceros ni nada que dependa de pagar (§10).
 */
function ProfileCard({ member, onClose, color }: { member: Member | null; onClose: () => void; color: string | undefined }) {
  const t = useT();
  const locale = useLocale();
  const communities = useStore((s) => s.data);
  const voice = useStore((s) => s.voice);
  const activeId = useStore((s) => s.activeCommunityId);

  const active = activeId ? communities[activeId] : undefined;
  const roles = active?.roles ?? EMPTY;

  if (!member) return <Modal open={false} onClose={onClose} title="" chrome={false}>{null}</Modal>;

  const user = member.user;
  const isOnline = active?.online.includes(user.id) ?? false;
  const isOwner = active?.community.owner_id === user.id;
  const timedOut = (member.timeout_until ?? 0) > Date.now();

  /* Lo único "en vivo" que este cliente sabe de otra persona es si está metida
     en una sala de voz. Ocupa el sitio que otros clientes llenan con lo que
     estás escuchando en un servicio de música ajeno. */
  const rooms = Object.values(communities).flatMap((data) =>
    data.channels
      .filter((channel) => channel.kind === "voice")
      .map((channel) => ({ channel, community: data.community })),
  );
  const room = rooms.find(({ channel }) => (voice[channel.id] ?? EMPTY).some((state) => state.user_id === user.id));
  const voiceState = room ? voice[room.channel.id]?.find((state) => state.user_id === user.id) : undefined;

  /* El otro "en vivo": a qué está jugando, si su app lo comparte (§9.1). La
     sala de voz gana el sitio del pie —estar hablando aquí importa más que el
     juego—, pero el juego gana a la fecha de ingreso, que no cambia nunca. */
  const game = gameOf(communities, user.id);

  /* Comunidades en común: solo las que este cliente ya tiene cargadas. Es una
     cota inferior honesta, no una consulta al servidor por cada perfil abierto. */
  const mutual = Object.values(communities).filter((data) => data.members.some((m) => m.user.id === user.id));

  const badges: Array<{ key: string; icon: typeof Crown; label: string; tone: string }> = [];
  if (isOwner) badges.push({ key: "owner", icon: Crown, label: t("members.owner"), tone: "var(--warn)" });
  if (user.kind === "guest") badges.push({ key: "guest", icon: UserRound, label: t("members.guest"), tone: "var(--muted)" });
  if (timedOut) badges.push({ key: "timeout", icon: Clock, label: t("message.timedOut"), tone: "var(--warn)" });
  if (member.banned) badges.push({ key: "banned", icon: Ban, label: t("members.banned"), tone: "var(--danger)" });

  return (
    <Modal open onClose={onClose} title={user.display_name} chrome={false}>
      <div
        className="relative flex min-h-full flex-col"
        style={{ background: profileSurfaceBackground(user.profile_style, user.accent_color) }}
      >
        {/* Portada a sangre: el diálogo ya recorta las esquinas, así que la
            imagen llega al borde sin redondearla otra vez aquí. */}
        <div
          className="relative h-36 shrink-0"
          style={{ background: cardBackground(user.profile_style, user.accent_color, user.banner_url) }}
        >
          {/* Botón propio y no IconButton: encima de una foto cualquiera hace
              falta contraste fijo, y los colores del tema no lo garantizan. */}
          <button
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
            className="absolute top-3 right-3 grid h-9 w-9 place-items-center rounded-[10px] text-white backdrop-blur"
            style={{ background: "rgb(0 0 0 / 0.4)" }}
          >
            <X size={17} />
          </button>
        </div>

        <div className="-mt-14 flex flex-col items-center px-5 text-center">
          {/* `relative` no es decorativo: el <img> de la portada es contenido
              en línea y se pinta después que el fondo de un bloque hermano, así
              que sin posicionarlo la foto se comía el avatar. El recorte contra
              la portada lo pone `cutout`, que sabe callarse cuando hay aro. */}
          <span className="relative inline-block" style={{ marginBottom: avatarOverflow(user.profile_style, 112) }}>
            <Avatar
              name={member.nickname ?? user.display_name}
              url={user.avatar_url}
              id={user.id}
              size={112}
              ring={isOnline ? "online" : "offline"}
              profile={user.profile_style}
              cutout={6}
            />
          </span>

          <h3 className="display mt-4 flex flex-wrap items-center justify-center gap-1.5 text-xl font-bold">
            <DisplayName
              name={member.nickname ?? user.display_name}
              style={user.profile_style}
              accent={null}
              roleColor={color}
            />
            <code className="rounded-md bg-sunken px-1.5 py-0.5 font-body text-[0.72rem] font-medium text-accent">
              @{user.username}
            </code>
          </h3>

          {badges.length > 0 ? (
            <ul className="mt-2 flex items-center gap-1.5">
              {badges.map((badge) => (
                <li
                  key={badge.key}
                  title={badge.label}
                  className="grid h-7 w-7 place-items-center rounded-full bg-raise"
                  style={{ color: badge.tone }}
                >
                  <badge.icon size={14} aria-label={badge.label} />
                </li>
              ))}
            </ul>
          ) : null}

          <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: isOnline ? "var(--ok)" : "var(--muted)" }}
            />
            {isOnline ? t("members.online") : t("members.disconnected")}
            {user.pronouns ? ` · ${user.pronouns}` : ""}
          </p>

          {user.bio ? <p className="mt-3 text-sm whitespace-pre-wrap text-muted">{user.bio}</p> : null}
        </div>

        <PrivateNote targetId={user.id} />

        {member.role_ids.length > 0 ? (
          <section className="px-5 pt-5">
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{t("members.roles")}</h4>
            <ul className="flex flex-wrap gap-1.5">
              {roles
                .filter((role) => member.role_ids.includes(role.id))
                .map((role) => (
                  <li
                    key={role.id}
                    className="flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs"
                    style={{ borderColor: role.color ?? "var(--line)", color: role.color ?? "var(--muted)" }}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: role.color ?? "var(--muted)" }}
                    />
                    {role.name}
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        <RecentGames userId={user.id} />

        {mutual.length > 0 ? (
          <section className="px-5 pt-5">
            <h4 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">
              {t("members.mutual")} — {mutual.length}
            </h4>
            <ul className="grid grid-cols-3 gap-3">
              {mutual.map((data) => (
                <li key={data.community.id} className="flex flex-col items-center gap-1.5 text-center">
                  <Avatar name={data.community.name} url={data.community.icon_url} id={data.community.id} size={56} />
                  <span className="w-full truncate text-[0.7rem] font-medium">{data.community.name}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="h-5 shrink-0" />

        {/* Barra de abajo fija, como el reproductor del diseño, pero contando lo
            único que de verdad está pasando: dónde está ahora, o desde cuándo. */}
        <div className="sticky bottom-0 mt-auto flex items-center gap-3 border-t border-line bg-raise px-5 py-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-accent-soft text-accent">
            {room ? (
              <Volume2 size={16} aria-label={t("members.inVoice")} />
            ) : game ? (
              <Gamepad2 size={16} aria-label={t("game.playing", { name: game.game_name })} />
            ) : (
              <CalendarDays size={16} aria-hidden="true" />
            )}
          </span>
          <span className="min-w-0 flex-1 text-left">
            <span className="block truncate text-sm font-medium">
              {room
                ? `# ${room.channel.name}`
                : game
                  ? game.game_name
                  : t("members.joined", { date: formatDate(locale, member.joined_at) })}
            </span>
            <span className="block truncate text-[0.7rem] text-muted">
              {room
                ? room.community.name
                : game
                  ? t("game.for", { time: formatDuration(locale, Math.max(1, Math.floor((Date.now() - game.started_at) / 1000))) })
                  : t("members.created", { date: formatDate(locale, user.created_at) })}
            </span>
          </span>
          {voiceState && (voiceState.muted || voiceState.deafened || voiceState.video) ? (
            <span className="flex shrink-0 items-center gap-1.5 text-muted">
              {voiceState.muted ? <MicOff size={14} aria-hidden="true" /> : null}
              {voiceState.deafened ? <VolumeX size={14} aria-hidden="true" /> : null}
              {voiceState.video ? <Video size={14} aria-hidden="true" /> : null}
            </span>
          ) : null}
        </div>

        {/* El efecto cubre la tarjeta ENTERA del perfil, no solo la portada. Va
            al final para pintarse encima del contenido; sus clases llevan
            pointer-events: none, así que el botón de cerrar sigue funcionando. */}
        <CardEffectLayer effect={user.profile_style.profile_effect} className="absolute inset-0" />
      </div>
    </Modal>
  );
}

/**
 * Juegos recientes del perfil (§9.1): las últimas partidas que su dueño quiso
 * compartir. Se pide al abrir la tarjeta y solo entonces, como la nota privada:
 * la lista de miembros no dispara una petición por cada fila. Vacío o error
 * —historial oculto, instancia vieja sin la ruta— simplemente no se pinta.
 */
function RecentGames({ userId }: { userId: string }) {
  const t = useT();
  const locale = useLocale();
  const [sessions, setSessions] = useState<GameSession[]>(EMPTY);

  useEffect(() => {
    let alive = true;
    api<GameSession[]>("GET", `/api/v1/users/${userId}/game-history`)
      .then((list) => {
        if (alive && Array.isArray(list)) setSessions(list);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [userId]);

  if (sessions.length === 0) return null;

  return (
    <section className="px-5 pt-5">
      <h4 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{t("game.recent")}</h4>
      <ul className="flex flex-col gap-1">
        {sessions.map((session) => (
          <li key={session.id} className="flex items-center gap-2.5 rounded-[10px] border border-line px-2.5 py-1.5">
            <Gamepad2 size={14} className="shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm">{session.game_name}</span>
            <span className="shrink-0 text-[0.7rem] text-muted">
              {t("game.duration", {
                time: formatDuration(locale, Math.max(60, Math.floor((session.ended_at - session.started_at) / 1000))),
                date: formatDate(locale, session.started_at),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Nota privada sobre alguien (§10.1).
 *
 * Vive en los ajustes de QUIEN la escribe, no en el perfil de quien la recibe:
 * es una anotacion tuya sobre otra persona, y esa otra persona no tiene por que
 * poder leerla ni saber que existe. Por eso no hay evento ni se publica a la
 * comunidad — sale y entra por el mismo PATCH del propio perfil.
 *
 * ponytail: dentro del JSON de ajustes, sin tabla propia. Son un par de lineas
 * por persona; el dia que alguien las quiera buscar o paginar, se muda.
 */
function PrivateNote({ targetId }: { targetId: string }) {
  const t = useT();
  const me = useStore((s) => s.user);
  const refreshUser = useStore((s) => s.refreshUser);

  const notas = (me?.settings.notes ?? {}) as Record<string, string>;
  const guardada = typeof notas[targetId] === "string" ? notas[targetId] : "";
  const [texto, setTexto] = useState(guardada);

  if (!me || me.id === targetId) return null;

  async function guardar() {
    const limpio = texto.trim();
    if (limpio === guardada) return;

    // Una nota vacia se BORRA en vez de guardarse como cadena vacia: si no, los
    // ajustes irian engordando con una entrada por cada perfil que se abre.
    const siguientes = { ...notas };
    if (limpio) siguientes[targetId] = limpio;
    else delete siguientes[targetId];

    try {
      refreshUser(await api("PATCH", "/api/v1/users/me", { settings: { ...me!.settings, notes: siguientes } }));
    } catch {
      setTexto(guardada); // Si no se guardo, que el campo no diga lo contrario.
    }
  }

  return (
    <section className="px-5 pt-5">
      <h4 className="mb-2 text-xs font-semibold tracking-wider text-muted uppercase">{t("members.note")}</h4>
      <textarea
        value={texto}
        onChange={(e) => setTexto(e.target.value)}
        onBlur={() => void guardar()}
        maxLength={500}
        rows={2}
        placeholder={t("members.notePlaceholder")}
        className="field min-h-16 text-sm"
      />
    </section>
  );
}
