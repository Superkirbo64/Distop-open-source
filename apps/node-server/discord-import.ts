/** Importación puntual de un servidor de Discord a una comunidad Distop.
 *
 * Usa un bot creado por quien administra el servidor. El token solo existe en
 * la memoria de esta petición: no se escribe en la base, los logs ni el
 * informe. No se aceptan tokens de usuario (self-bots).
 */
import { Readable } from "node:stream";
import { ALL_PERMISSIONS, DEFAULT_MEMBER_PERMISSIONS, PERMISSIONS, uuidv7 } from "@distop/protocol";
import { db, audit, uniqueSlug } from "./db.ts";
import { config } from "./config.ts";
import { saveUploadStream, linkAttachments } from "./storage.ts";

const OFFICIAL_API = "https://discord.com/api/v10";
const MAX_MEMBERS = 10_000;
const SUPPORTED_CHANNELS = new Set([0, 2, 5, 10, 11, 12, 13, 15, 16]);

type Fetcher = typeof fetch;

interface DiscordGuild {
  id: string;
  name: string;
  description?: string | null;
  icon?: string | null;
  approximate_member_count?: number;
}

interface DiscordChannel {
  id: string;
  type: number;
  name: string;
  topic?: string | null;
  position?: number;
  parent_id?: string | null;
  permission_overwrites?: Array<{ id: string; type: 0 | 1; allow: string; deny: string }>;
}

interface DiscordRole {
  id: string;
  name: string;
  color: number;
  position: number;
  permissions: string;
  hoist: boolean;
  mentionable: boolean;
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  bot?: boolean;
}

interface DiscordMember {
  user: DiscordUser;
  nick?: string | null;
  roles: string[];
  joined_at?: string | null;
}

interface DiscordAttachment {
  id: string;
  filename: string;
  content_type?: string;
  size: number;
  url: string;
}

interface DiscordMessage {
  id: string;
  channel_id: string;
  author: DiscordUser;
  member?: { nick?: string | null; roles?: string[] };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  pinned?: boolean;
  mention_everyone?: boolean;
  message_reference?: { message_id?: string };
  attachments?: DiscordAttachment[];
}

interface DiscordEmoji {
  id: string;
  name: string;
  animated?: boolean;
}

export interface DiscordPreview {
  guild: { id: string; name: string; description: string | null; icon_url: string | null };
  counts: { channels: number; categories: number; roles: number; emojis: number; members: number | null };
  unsupported_channels: number;
}

export interface DiscordImportReport {
  community_id: string;
  source_guild_id: string;
  categories: number;
  channels: number;
  roles: number;
  imported_profiles: number;
  messages: number;
  attachments: number;
  attachments_skipped: number;
  emojis: number;
  emojis_skipped: number;
  unsupported_channels: number;
  history_limit_per_channel: number;
  members_truncated: boolean;
  warnings: string[];
}

/* Sin parameter properties: el `node server.ts` de producción corre en modo
   strip-only y `constructor(public code...)` le revienta al cargar el módulo. */
export class DiscordImportError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function apiBase(): string {
  return (process.env.DISCORD_API_BASE || OFFICIAL_API).replace(/\/+$/, "");
}

function cleanToken(input: string): string {
  const token = input.trim().replace(/^Bot\s+/i, "");
  if (token.length < 20 || /\s/.test(token)) throw new DiscordImportError("DISCORD_BAD_TOKEN", "El token de bot no tiene un formato válido.");
  return token;
}

async function discordJson<T>(tokenInput: string, path: string, fetcher: Fetcher): Promise<T> {
  const token = cleanToken(tokenInput);
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetcher(`${apiBase()}${path}`, {
      headers: { authorization: `Bot ${token}`, "user-agent": "Distop/0.1.1 community importer" },
      redirect: "error",
    }).catch(() => null);
    if (!response) throw new DiscordImportError("DISCORD_UNREACHABLE", "No se pudo contactar con Discord.", 502);
    if (response.status === 429 && attempt < 3) {
      const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
      await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max((body.retry_after ?? 1) * 1000, 250), 5000)));
      continue;
    }
    if (response.status === 401) throw new DiscordImportError("DISCORD_BAD_TOKEN", "Discord rechazó el token del bot.", 401);
    if (response.status === 403) throw new DiscordImportError("DISCORD_FORBIDDEN", "El bot no tiene permiso para leer ese servidor o canal.", 403);
    if (response.status === 404) throw new DiscordImportError("DISCORD_NOT_FOUND", "Discord no encontró ese servidor o recurso.", 404);
    if (!response.ok) throw new DiscordImportError("DISCORD_API_ERROR", `Discord respondió ${response.status}.`, 502);
    return (await response.json()) as T;
  }
  throw new DiscordImportError("DISCORD_RATE_LIMIT", "Discord pidió esperar demasiado; vuelve a intentarlo.", 429);
}

function iconUrl(guild: DiscordGuild): string | null {
  if (!guild.icon) return null;
  const ext = guild.icon.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.${ext}?size=256`;
}

function avatarUrl(user: DiscordUser): string | null {
  if (!user.avatar) return null;
  const ext = user.avatar.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=128`;
}

async function metadata(token: string, guildId: string, fetcher: Fetcher) {
  if (!/^\d{6,24}$/.test(guildId)) throw new DiscordImportError("DISCORD_BAD_GUILD", "El ID del servidor no es válido.");
  const [guild, channels, roles, emojis] = await Promise.all([
    discordJson<DiscordGuild>(token, `/guilds/${guildId}?with_counts=true`, fetcher),
    discordJson<DiscordChannel[]>(token, `/guilds/${guildId}/channels`, fetcher),
    discordJson<DiscordRole[]>(token, `/guilds/${guildId}/roles`, fetcher),
    discordJson<DiscordEmoji[]>(token, `/guilds/${guildId}/emojis`, fetcher),
  ]);
  if (guild.id !== guildId) throw new DiscordImportError("DISCORD_GUILD_MISMATCH", "Discord respondió con otro servidor.");
  return { guild, channels, roles, emojis };
}

export async function previewDiscord(token: string, guildId: string, fetcher: Fetcher = fetch): Promise<DiscordPreview> {
  const { guild, channels, roles, emojis } = await metadata(token, guildId, fetcher);
  return {
    guild: { id: guild.id, name: guild.name, description: guild.description ?? null, icon_url: iconUrl(guild) },
    counts: {
      channels: channels.filter((channel) => SUPPORTED_CHANNELS.has(channel.type)).length,
      categories: channels.filter((channel) => channel.type === 4).length,
      roles: roles.length,
      emojis: emojis.length,
      members: guild.approximate_member_count ?? null,
    },
    unsupported_channels: channels.filter((channel) => channel.type !== 4 && !SUPPORTED_CHANNELS.has(channel.type)).length,
  };
}

async function allMembers(token: string, guildId: string, fetcher: Fetcher): Promise<{ members: DiscordMember[]; truncated: boolean }> {
  const members: DiscordMember[] = [];
  let after = "0";
  while (members.length < MAX_MEMBERS) {
    const page = await discordJson<DiscordMember[]>(token, `/guilds/${guildId}/members?limit=1000&after=${after}`, fetcher);
    members.push(...page);
    if (page.length < 1000) return { members, truncated: false };
    after = page.at(-1)!.user.id;
  }
  return { members, truncated: true };
}

async function channelMessages(token: string, channelId: string, limit: number, fetcher: Fetcher): Promise<DiscordMessage[]> {
  const out: DiscordMessage[] = [];
  let before = "";
  while (out.length < limit) {
    const take = Math.min(100, limit - out.length);
    const page = await discordJson<DiscordMessage[]>(
      token,
      `/channels/${channelId}/messages?limit=${take}${before ? `&before=${before}` : ""}`,
      fetcher,
    );
    out.push(...page);
    if (page.length < take) break;
    before = page.at(-1)!.id;
  }
  return out.reverse();
}

const DISCORD_PERMISSIONS: Array<[bigint, bigint]> = [
  [1n << 0n, PERMISSIONS.CREATE_INVITE], [1n << 1n, PERMISSIONS.KICK_MEMBERS], [1n << 2n, PERMISSIONS.BAN_MEMBERS],
  [1n << 3n, PERMISSIONS.ADMINISTRATOR], [1n << 4n, PERMISSIONS.MANAGE_CHANNELS], [1n << 5n, PERMISSIONS.MANAGE_COMMUNITY],
  [1n << 6n, PERMISSIONS.ADD_REACTIONS], [1n << 7n, PERMISSIONS.VIEW_AUDIT_LOG], [1n << 9n, PERMISSIONS.STREAM],
  [1n << 10n, PERMISSIONS.VIEW_CHANNEL], [1n << 11n, PERMISSIONS.SEND_MESSAGES], [1n << 13n, PERMISSIONS.MANAGE_MESSAGES],
  [1n << 14n, PERMISSIONS.EMBED_LINKS], [1n << 15n, PERMISSIONS.ATTACH_FILES], [1n << 16n, PERMISSIONS.READ_HISTORY],
  [1n << 17n, PERMISSIONS.MENTION_EVERYONE], [1n << 18n, PERMISSIONS.USE_CUSTOM_EMOJIS], [1n << 20n, PERMISSIONS.CONNECT_VOICE],
  [1n << 21n, PERMISSIONS.SPEAK], [1n << 22n, PERMISSIONS.MUTE_MEMBERS], [1n << 23n, PERMISSIONS.DEAFEN_MEMBERS],
  [1n << 24n, PERMISSIONS.MOVE_MEMBERS], [1n << 28n, PERMISSIONS.MANAGE_ROLES], [1n << 29n, PERMISSIONS.MANAGE_WEBHOOKS],
  [1n << 34n, PERMISSIONS.MANAGE_THREADS], [1n << 35n, PERMISSIONS.CREATE_THREADS], [1n << 36n, PERMISSIONS.CREATE_THREADS],
  [1n << 40n, PERMISSIONS.TIMEOUT_MEMBERS],
];

function mapPermissions(raw: string): bigint {
  let source = 0n;
  try { source = BigInt(raw); } catch { return 0n; }
  let target = 0n;
  for (const [from, to] of DISCORD_PERMISSIONS) if ((source & from) !== 0n) target |= to;
  return target;
}

function channelKind(type: number): "text" | "voice" | "announcement" {
  if (type === 2 || type === 13) return "voice";
  if (type === 5) return "announcement";
  return "text";
}

function colorOf(value: number): string | null {
  return value > 0 ? `#${value.toString(16).padStart(6, "0")}` : null;
}

function uniqueImportedUsername(user: DiscordUser): string {
  return `discord_${user.id}`.slice(0, 32);
}

function rewriteContent(content: string, users: Map<string, string>, channels: Map<string, string>): string {
  return content
    .replace(/<@!?(\d+)>/g, (_, id: string) => users.has(id) ? `<@${users.get(id)}>` : "@usuario-importado")
    .replace(/<#(\d+)>/g, (_, id: string) => channels.has(id) ? `<#${channels.get(id)}>` : "#canal-importado")
    .replace(/<@&(\d+)>/g, "@rol-importado")
    .replace(/<a?:([A-Za-z0-9_]+):\d+>/g, ":$1:");
}

function safeDate(value: string | null | undefined, fallback = Date.now()): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function downloadAttachment(asset: DiscordAttachment, ownerId: string, fetcher: Fetcher) {
  const url = new URL(asset.url);
  if (url.protocol !== "https:" || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return null;
  if (asset.size <= 0 || asset.size > config.maxUploadMb * 1024 * 1024) return null;
  const response = await fetcher(url, { redirect: "error" }).catch(() => null);
  if (!response?.ok || !response.body) return null;
  const type = (asset.content_type ?? response.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  try {
    return await saveUploadStream({
      ownerId,
      filename: asset.filename,
      contentType: type,
      body: Readable.fromWeb(response.body as never),
      limit: config.maxUploadMb * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

export async function importDiscord(opts: {
  token: string;
  guildId: string;
  ownerId: string;
  historyLimitPerChannel: number;
  importMembers: boolean;
  fetcher?: Fetcher;
}): Promise<DiscordImportReport> {
  const fetcher = opts.fetcher ?? fetch;
  const duplicate = db.prepare("SELECT community_id FROM external_imports WHERE provider = 'discord' AND source_id = ?").get(opts.guildId) as { community_id: string } | undefined;
  if (duplicate) throw new DiscordImportError("DISCORD_ALREADY_IMPORTED", "Ese servidor de Discord ya fue importado en esta instancia.", 409);

  const { guild, channels: allChannels, roles, emojis } = await metadata(opts.token, opts.guildId, fetcher);
  const channels = allChannels.filter((channel) => SUPPORTED_CHANNELS.has(channel.type));
  const messageChannels = channels.filter((channel) => ![15, 16].includes(channel.type));
  const historyLimit = Math.max(0, Math.min(Math.trunc(opts.historyLimitPerChannel), 1000));
  const messagesByChannel = new Map<string, DiscordMessage[]>();
  if (historyLimit > 0) {
    for (const channel of messageChannels) {
      try { messagesByChannel.set(channel.id, await channelMessages(opts.token, channel.id, historyLimit, fetcher)); }
      catch (error) {
        if (error instanceof DiscordImportError && error.status === 403) messagesByChannel.set(channel.id, []);
        else throw error;
      }
    }
  }

  let members: DiscordMember[] = [];
  let membersTruncated = false;
  if (opts.importMembers) {
    const result = await allMembers(opts.token, opts.guildId, fetcher);
    members = result.members;
    membersTruncated = result.truncated;
  }
  const memberByUser = new Map(members.map((member) => [member.user.id, member]));
  for (const list of messagesByChannel.values()) {
    for (const message of list) if (!memberByUser.has(message.author.id)) {
      memberByUser.set(message.author.id, { user: message.author, nick: message.member?.nick ?? null, roles: message.member?.roles ?? [] });
    }
  }

  const communityId = uuidv7();
  const importId = uuidv7();
  const now = Date.now();
  const categoryIds = new Map<string, string>();
  const channelIds = new Map<string, string>();
  const roleIds = new Map<string, string>();
  const userIds = new Map<string, string>();
  const messageIds = new Map<string, string>();
  for (const category of allChannels.filter((channel) => channel.type === 4)) categoryIds.set(category.id, uuidv7());
  for (const channel of channels) channelIds.set(channel.id, uuidv7());
  for (const role of roles) roleIds.set(role.id, uuidv7());
  for (const member of memberByUser.values()) userIds.set(member.user.id, uuidv7());
  for (const list of messagesByChannel.values()) for (const message of list) messageIds.set(message.id, uuidv7());

  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO communities (id,name,slug,description,icon_url,accent_color,is_public,owner_id,created_at)
                VALUES (?,?,?,?,?,'#5865f2',0,?,?)`).run(
      communityId, guild.name.slice(0, 64), uniqueSlug(guild.name), guild.description?.slice(0, 500) ?? null, iconUrl(guild), opts.ownerId, now,
    );
    for (const category of allChannels.filter((channel) => channel.type === 4)) {
      db.prepare("INSERT INTO categories (id,community_id,name,position) VALUES (?,?,?,?)").run(
        categoryIds.get(category.id)!, communityId, category.name.slice(0, 100), category.position ?? 0,
      );
    }
    for (const role of roles) {
      const isDefault = role.id === guild.id;
      db.prepare(`INSERT INTO roles (id,community_id,name,color,permissions,position,hoist,mentionable,is_default)
                  VALUES (?,?,?,?,?,?,?,?,?)`).run(
        roleIds.get(role.id)!, communityId, role.name.slice(0, 100), colorOf(role.color),
        (isDefault ? (mapPermissions(role.permissions) || DEFAULT_MEMBER_PERMISSIONS) : mapPermissions(role.permissions)).toString(),
        role.position, role.hoist ? 1 : 0, role.mentionable ? 1 : 0, isDefault ? 1 : 0,
      );
    }
    for (const channel of channels) {
      const parent = categoryIds.get(channel.parent_id ?? "") ?? null;
      db.prepare(`INSERT INTO channels (id,community_id,category_id,name,topic,kind,position,created_at)
                  VALUES (?,?,?,?,?,?,?,?)`).run(
        channelIds.get(channel.id)!, communityId, parent, channel.name.slice(0, 100), channel.topic?.slice(0, 1024) ?? null,
        channelKind(channel.type), channel.position ?? 0, now,
      );
      for (const overwrite of channel.permission_overwrites ?? []) {
        const target = overwrite.type === 0 ? roleIds.get(overwrite.id) : userIds.get(overwrite.id);
        if (!target) continue;
        db.prepare("INSERT INTO overwrites (channel_id,target_id,target_type,allow,deny) VALUES (?,?,?,?,?)").run(
          channelIds.get(channel.id)!, target, overwrite.type === 0 ? "role" : "member",
          mapPermissions(overwrite.allow).toString(), mapPermissions(overwrite.deny).toString(),
        );
      }
    }
    db.prepare("INSERT INTO members (community_id,user_id,joined_at) VALUES (?,?,?)").run(communityId, opts.ownerId, now);
    for (const member of memberByUser.values()) {
      const localId = userIds.get(member.user.id)!;
      db.prepare(`INSERT INTO users (id,username,display_name,password_hash,kind,avatar_url,created_at)
                  VALUES (?,?,?,NULL,'imported',?,?)`).run(
        localId, uniqueImportedUsername(member.user), (member.user.global_name ?? member.user.username).slice(0, 64), avatarUrl(member.user), now,
      );
      db.prepare("INSERT INTO members (community_id,user_id,nickname,joined_at) VALUES (?,?,?,?)").run(
        communityId, localId, member.nick?.slice(0, 64) ?? null, safeDate(member.joined_at),
      );
      for (const externalRole of member.roles) {
        const localRole = roleIds.get(externalRole);
        if (localRole) db.prepare("INSERT OR IGNORE INTO member_roles (community_id,user_id,role_id) VALUES (?,?,?)").run(communityId, localId, localRole);
      }
    }
    for (const [externalChannel, list] of messagesByChannel) {
      const localChannel = channelIds.get(externalChannel);
      if (!localChannel) continue;
      for (const message of list) {
        const author = userIds.get(message.author.id);
        if (!author) continue;
        db.prepare(`INSERT INTO messages (id,channel_id,community_id,author_id,content,created_at,edited_at,reply_to_id,pinned,mentions_everyone)
                    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          messageIds.get(message.id)!, localChannel, communityId, author,
          rewriteContent(message.content ?? "", userIds, channelIds), safeDate(message.timestamp),
          message.edited_timestamp ? safeDate(message.edited_timestamp) : null,
          message.message_reference?.message_id ? messageIds.get(message.message_reference.message_id) ?? null : null,
          message.pinned ? 1 : 0, message.mention_everyone ? 1 : 0,
        );
      }
    }
    db.prepare(`INSERT INTO external_imports (id,provider,source_id,community_id,actor_id,state,created_at)
                VALUES (?,'discord',?,?,?,'RUNNING',?)`).run(importId, guild.id, communityId, opts.ownerId, now);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const report: DiscordImportReport = {
    community_id: communityId, source_guild_id: guild.id,
    categories: categoryIds.size, channels: channelIds.size, roles: roleIds.size,
    imported_profiles: userIds.size, messages: messageIds.size,
    attachments: 0, attachments_skipped: 0, emojis: 0, emojis_skipped: 0,
    unsupported_channels: allChannels.filter((channel) => channel.type !== 4 && !SUPPORTED_CHANNELS.has(channel.type)).length,
    history_limit_per_channel: historyLimit, members_truncated: membersTruncated, warnings: [],
  };

  for (const list of messagesByChannel.values()) for (const message of list) {
    const localMessage = messageIds.get(message.id);
    const owner = userIds.get(message.author.id);
    if (!localMessage || !owner) continue;
    for (const asset of message.attachments ?? []) {
      const saved = await downloadAttachment(asset, owner, fetcher);
      if (!saved) { report.attachments_skipped++; continue; }
      linkAttachments(localMessage, [saved.id], owner);
      report.attachments++;
    }
  }

  /* Los emojis se importan como adjuntos sin mensaje y una fila de expresión.
     Si Discord o el formato falla, la comunidad sigue importada y el informe
     lo dice; no se borra todo el historial por una pegatina rota. */
  for (const emoji of emojis) {
    const url = `https://cdn.discordapp.com/emojis/${emoji.id}.${emoji.animated ? "gif" : "png"}?size=128&quality=lossless`;
    const saved = await downloadAttachment({ id: emoji.id, filename: `${emoji.name}.${emoji.animated ? "gif" : "png"}`, content_type: emoji.animated ? "image/gif" : "image/png", size: 1024 * 1024, url }, opts.ownerId, fetcher);
    if (!saved) { report.emojis_skipped++; continue; }
    db.prepare(`INSERT INTO emojis (id,community_id,name,kind,attachment_id,creator_id,created_at)
                VALUES (?,?,?,'emoji',?,?,?)`).run(uuidv7(), communityId, emoji.name.slice(0, 32), saved.id, opts.ownerId, now);
    report.emojis++;
  }

  if (historyLimit > 0 && report.messages === 0) report.warnings.push("MESSAGE_CONTENT_EMPTY");
  if (!opts.importMembers) report.warnings.push("MEMBERS_ONLY_AUTHORS");
  if (report.attachments_skipped > 0) report.warnings.push("ATTACHMENTS_SKIPPED");
  if (report.unsupported_channels > 0) report.warnings.push("UNSUPPORTED_CHANNELS");
  if (membersTruncated) report.warnings.push("MEMBERS_TRUNCATED");

  db.prepare("UPDATE external_imports SET state='COMPLETED', report=?, completed_at=? WHERE id=?").run(JSON.stringify(report), Date.now(), importId);
  audit(communityId, opts.ownerId, "COMMUNITY_IMPORT_DISCORD", guild.id, report as unknown as Record<string, unknown>);
  return report;
}

export { mapPermissions as mapDiscordPermissions };
