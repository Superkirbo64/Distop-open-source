/**
 * Panel de miembros y moderación en línea (§23).
 * Las acciones que aparecen dependen de los permisos reales; la instancia las
 * vuelve a comprobar igualmente, esto solo evita ofrecer lo imposible.
 */
import { useState } from "react";
import { Crown, MoreVertical } from "lucide-react";
import { PERMISSIONS, has, toBits, type Member } from "@distop/protocol";
import { useStore } from "../store.ts";
import { api } from "../lib/api.ts";
import { Avatar, IconButton, Menu, MenuItem, Modal, useConfirm, useLocale, useT } from "./ui.tsx";
import { formatDate } from "../i18n.ts";

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
              <li key={member.user.id} className="group flex items-center gap-2 rounded-[10px] px-2 py-1.5 hover:bg-raise">
                <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setProfile(member)}>
                  <Avatar
                    name={member.nickname ?? member.user.display_name}
                    url={member.user.avatar_url}
                    id={member.user.id}
                    size={30}
                    ring={data!.online.includes(member.user.id) ? "online" : "offline"}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1">
                      <span className="block truncate text-sm font-medium" style={colorOf(member) ? { color: colorOf(member) } : undefined}>
                        {member.nickname ?? member.user.display_name}
                      </span>
                      {isOwner ? <Crown size={12} className="shrink-0 text-warn" aria-label={t("members.owner")} /> : null}
                    </span>
                    {member.timeout_until && member.timeout_until > Date.now() ? (
                      <span className="block text-[0.68rem] text-warn">{t("message.timedOut")}</span>
                    ) : member.user.kind === "guest" ? (
                      <span className="block text-[0.68rem] text-muted">{t("members.guest")}</span>
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
    <aside data-pane="members" className="w-full overflow-y-auto border-l border-line bg-surface px-2 py-3">
      <div className="mb-2 flex items-center justify-between px-2 md:hidden">
        <h2 className="display font-bold">{t("members.title")}</h2>
        <IconButton label={t("common.close")} onClick={onClose}>
          ×
        </IconButton>
      </div>

      {grouped.map((group) => (
        <div key={group.key} className={group.key === "offline" ? "opacity-60" : ""}>
          {renderGroup(group.title, group.list, group.color)}
        </div>
      ))}

      <ProfileCard member={profile} onClose={() => setProfile(null)} color={profile ? colorOf(profile) : undefined} />
      {confirmElement}
    </aside>
  );
}

function ProfileCard({ member, onClose, color }: { member: Member | null; onClose: () => void; color: string | undefined }) {
  const t = useT();
  const locale = useLocale();
  const roles = useStore((s) => (s.activeCommunityId ? (s.data[s.activeCommunityId]?.roles ?? EMPTY) : EMPTY));

  return (
    <Modal open={member !== null} onClose={onClose} title={member?.user.display_name ?? ""}>
      {member ? (
        <div className="flex flex-col gap-4">
          {member.user.banner_url ? (
            <img src={member.user.banner_url} alt="" className="h-28 w-full rounded-[10px] object-cover" />
          ) : (
            <div className="h-20 rounded-[10px]" style={{ background: member.user.accent_color ?? "var(--accent)" }} />
          )}

          <div className="flex items-center gap-3">
            <Avatar name={member.user.display_name} url={member.user.avatar_url} id={member.user.id} size={56} />
            <div>
              <p className="display text-lg font-bold" style={color ? { color } : undefined}>
                {member.nickname ?? member.user.display_name}
              </p>
              <p className="text-sm text-muted">
                {member.user.kind === "guest" ? t("members.guest") : `@${member.user.username}`}
                {member.user.pronouns ? ` · ${member.user.pronouns}` : ""}
              </p>
            </div>
          </div>

          {member.user.bio ? <p className="text-sm whitespace-pre-wrap">{member.user.bio}</p> : null}

          {member.role_ids.length > 0 ? (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold tracking-wider text-muted uppercase">{t("members.roles")}</h4>
              <ul className="flex flex-wrap gap-1.5">
                {roles
                  .filter((role) => member.role_ids.includes(role.id))
                  .map((role) => (
                    <li
                      key={role.id}
                      className="rounded-full border px-2.5 py-0.5 text-xs"
                      style={{ borderColor: role.color ?? "var(--line)", color: role.color ?? "var(--muted)" }}
                    >
                      {role.name}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          <p className="text-xs text-muted">{t("members.joined", { date: formatDate(locale, member.joined_at) })}</p>
        </div>
      ) : null}
    </Modal>
  );
}
