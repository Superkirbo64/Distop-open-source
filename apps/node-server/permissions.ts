/**
 * Cálculo de permisos efectivos (§11).
 * Orden: roles del miembro → overwrite de @everyone → overwrites de sus roles →
 * overwrite individual. ADMINISTRATOR y la propiedad de la comunidad cortocircuitan.
 */
import { ALL_PERMISSIONS, PERMISSIONS, toBits } from "@distop/protocol";
import { db } from "./db.ts";

/** Lo que un timeout suspende: hablar, no leer (§23). */
const TIMEOUT_REVOKES =
  PERMISSIONS.SEND_MESSAGES |
  PERMISSIONS.ADD_REACTIONS |
  PERMISSIONS.SPEAK |
  PERMISSIONS.STREAM |
  PERMISSIONS.USE_CAMERA |
  PERMISSIONS.CREATE_THREADS |
  PERMISSIONS.ATTACH_FILES;

export interface MemberState {
  isMember: boolean;
  isOwner: boolean;
  banned: boolean;
  timedOut: boolean;
  roleIds: string[];
}

export function memberState(communityId: string, userId: string): MemberState {
  const row = db
    .prepare(
      `SELECT m.timeout_until, m.banned, c.owner_id
       FROM members m JOIN communities c ON c.id = m.community_id
       WHERE m.community_id = ? AND m.user_id = ?`,
    )
    .get(communityId, userId) as { timeout_until: number | null; banned: number; owner_id: string } | undefined;

  if (!row) return { isMember: false, isOwner: false, banned: false, timedOut: false, roleIds: [] };

  const roleIds = (
    db.prepare("SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ?").all(communityId, userId) as {
      role_id: string;
    }[]
  ).map((r) => r.role_id);

  return {
    isMember: true,
    isOwner: row.owner_id === userId,
    banned: row.banned === 1,
    timedOut: (row.timeout_until ?? 0) > Date.now(),
    roleIds,
  };
}

export function communityPermissions(communityId: string, userId: string): bigint {
  const state = memberState(communityId, userId);
  if (!state.isMember || state.banned) return 0n;
  if (state.isOwner) return ALL_PERMISSIONS;

  const rows = db
    .prepare(
      `SELECT permissions FROM roles
       WHERE community_id = ? AND (is_default = 1 OR id IN (SELECT role_id FROM member_roles WHERE community_id = ? AND user_id = ?))`,
    )
    .all(communityId, communityId, userId) as { permissions: string }[];

  let bits = rows.reduce((acc, row) => acc | toBits(row.permissions), 0n);
  if ((bits & PERMISSIONS.ADMINISTRATOR) !== 0n) bits = ALL_PERMISSIONS;
  if (state.timedOut) bits &= ~TIMEOUT_REVOKES;
  return bits;
}

export function channelPermissions(channelId: string, userId: string): bigint {
  const channel = db.prepare("SELECT community_id FROM channels WHERE id = ?").get(channelId) as
    | { community_id: string }
    | undefined;
  if (!channel) return 0n;

  const state = memberState(channel.community_id, userId);
  if (!state.isMember || state.banned) return 0n;
  if (state.isOwner) return ALL_PERMISSIONS;

  let bits = communityPermissions(channel.community_id, userId);
  if ((bits & PERMISSIONS.ADMINISTRATOR) !== 0n) return ALL_PERMISSIONS;

  const overwrites = db.prepare("SELECT target_id, target_type, allow, deny FROM overwrites WHERE channel_id = ?").all(
    channelId,
  ) as { target_id: string; target_type: string; allow: string; deny: string }[];

  const defaultRole = db.prepare("SELECT id FROM roles WHERE community_id = ? AND is_default = 1").get(
    channel.community_id,
  ) as { id: string } | undefined;

  const everyone = overwrites.find((o) => o.target_type === "role" && o.target_id === defaultRole?.id);
  if (everyone) bits = (bits & ~toBits(everyone.deny)) | toBits(everyone.allow);

  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.target_type !== "role" || !state.roleIds.includes(o.target_id)) continue;
    allow |= toBits(o.allow);
    deny |= toBits(o.deny);
  }
  bits = (bits & ~deny) | allow;

  const personal = overwrites.find((o) => o.target_type === "member" && o.target_id === userId);
  if (personal) bits = (bits & ~toBits(personal.deny)) | toBits(personal.allow);

  if (state.timedOut) bits &= ~TIMEOUT_REVOKES;
  return bits;
}

/**
 * Un rol solo puede tocar roles por debajo del más alto de quien actúa.
 * Sin esto, un moderador puede otorgarse permisos de administrador.
 */
export function highestRolePosition(communityId: string, userId: string): number {
  const state = memberState(communityId, userId);
  if (state.isOwner) return Number.MAX_SAFE_INTEGER;

  const row = db
    .prepare(
      `SELECT MAX(r.position) AS pos FROM roles r
       JOIN member_roles mr ON mr.role_id = r.id
       WHERE mr.community_id = ? AND mr.user_id = ?`,
    )
    .get(communityId, userId) as { pos: number | null } | undefined;

  return row?.pos ?? 0;
}

export function canActOn(communityId: string, actorId: string, targetId: string): boolean {
  if (actorId === targetId) return false;
  const target = memberState(communityId, targetId);
  if (target.isOwner) return false;
  return highestRolePosition(communityId, actorId) > highestRolePosition(communityId, targetId);
}
