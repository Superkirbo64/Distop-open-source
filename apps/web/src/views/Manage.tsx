/**
 * Administración de la comunidad (§11, §21, §23).
 * Los permisos se muestran con su identificador del protocolo a propósito: son
 * parte del contrato público, no texto de interfaz, y traducirlos los volvería
 * ambiguos entre la documentación y la pantalla.
 */
import { useEffect, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import {
  PERMISSIONS,
  PERMISSION_NAMES,
  has,
  toBits,
  type AuditLogEntry,
  type Community,
  type Invite,
  type Role,
} from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, download } from "../lib/api.ts";
import { formatDate } from "../i18n.ts";
import { Button, ErrorNote, Field, Modal, Toggle, useConfirm, useLocale, useT, useErrorText } from "../components/ui.tsx";

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];

type Tab = "overview" | "roles" | "invites" | "audit" | "data";

export function Manage({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const [tab, setTab] = useState<Tab>("overview");

  if (!communityId || !data) return null;
  const permissions = toBits(data.permissions);

  const tabs: Array<[Tab, string, boolean]> = [
    ["overview", t("manage.overview"), has(permissions, PERMISSIONS.MANAGE_COMMUNITY)],
    ["roles", t("manage.roles"), has(permissions, PERMISSIONS.MANAGE_ROLES)],
    ["invites", t("manage.invites"), has(permissions, PERMISSIONS.MANAGE_INVITES)],
    ["audit", t("manage.audit"), has(permissions, PERMISSIONS.VIEW_AUDIT_LOG)],
    ["data", t("manage.data"), has(permissions, PERMISSIONS.MANAGE_COMMUNITY)],
  ];
  const visible = tabs.filter(([, , allowed]) => allowed);

  return (
    <Modal open={open} onClose={onClose} title={t("manage.title", { name: data.community.name })} size="lg">
      <div className="grid gap-5 md:grid-cols-[11rem_1fr]">
        <nav aria-label={t("community.manage")}>
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {visible.map(([id, label]) => (
              <li key={id}>
                <button
                  onClick={() => setTab(id)}
                  aria-current={tab === id ? "page" : undefined}
                  className={`w-full rounded-[10px] px-3 py-2 text-left text-sm transition-colors ${
                    tab === id ? "bg-accent-soft font-semibold text-accent" : "text-muted hover:bg-raise hover:text-ink"
                  }`}
                >
                  {label}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          {tab === "overview" ? <Overview community={data.community} /> : null}
          {tab === "roles" ? <Roles communityId={communityId} roles={data.roles} mine={permissions} /> : null}
          {tab === "invites" ? <Invites communityId={communityId} /> : null}
          {tab === "audit" ? <Audit communityId={communityId} /> : null}
          {tab === "data" ? <DataTab community={data.community} onClose={onClose} /> : null}
        </div>
      </div>
    </Modal>
  );
}

function Overview({ community }: { community: Community }) {
  const t = useT();
  const errorText = useErrorText();
  const [form, setForm] = useState({
    name: community.name,
    description: community.description ?? "",
    icon_url: community.icon_url ?? "",
    banner_url: community.banner_url ?? "",
    accent_color: community.accent_color,
    rules: community.rules ?? "",
    is_public: community.is_public,
  });
  const [state, setState] = useState<"idle" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      await api("PATCH", `/api/v1/communities/${community.id}`, form);
      setState("saved");
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label={t("community.name")}>
        {(id) => (
          <input id={id} className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={64} />
        )}
      </Field>

      <Field label={t("manage.description")} hint={t("common.optional")}>
        {(id) => (
          <textarea
            id={id}
            className="field min-h-20"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            maxLength={500}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("manage.icon")} hint={t("common.optional")}>
          {(id) => (
            <input id={id} className="field" value={form.icon_url} onChange={(e) => setForm({ ...form, icon_url: e.target.value })} inputMode="url" />
          )}
        </Field>
        <Field label={t("manage.accent")}>
          {(id) => (
            <input
              id={id}
              type="color"
              className="field h-11 p-1"
              value={form.accent_color}
              onChange={(e) => setForm({ ...form, accent_color: e.target.value })}
            />
          )}
        </Field>
      </div>

      <Field label={t("manage.banner")} hint={t("common.optional")}>
        {(id) => (
          <input id={id} className="field" value={form.banner_url} onChange={(e) => setForm({ ...form, banner_url: e.target.value })} inputMode="url" />
        )}
      </Field>

      <Field label={t("manage.rules")} hint={t("common.optional")}>
        {(id) => (
          <textarea
            id={id}
            className="field min-h-28"
            value={form.rules}
            onChange={(e) => setForm({ ...form, rules: e.target.value })}
            maxLength={4000}
          />
        )}
      </Field>

      <Toggle
        checked={form.is_public}
        onChange={(value) => setForm({ ...form, is_public: value })}
        label={t("community.public")}
        hint={t("community.publicHint")}
      />

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Button variant="primary" onClick={save} className="self-start">
        {state === "saved" ? t("common.saved") : t("common.save")}
      </Button>
    </div>
  );
}

function Roles({ communityId, roles, mine }: { communityId: string; roles: Role[]; mine: bigint }) {
  const t = useT();
  const errorText = useErrorText();
  const { confirm, element } = useConfirm();

  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.id ?? null);
  const [error, setError] = useState<string | null>(null);
  const selected = roles.find((role) => role.id === selectedId) ?? roles[0];

  const [draft, setDraft] = useState<{ name: string; color: string; permissions: bigint } | null>(null);
  useEffect(() => {
    if (selected) setDraft({ name: selected.name, color: selected.color ?? "#8892a6", permissions: toBits(selected.permissions) });
  }, [selected?.id]);

  async function save() {
    if (!selected || !draft) return;
    setError(null);
    try {
      await api("PATCH", `/api/v1/roles/${selected.id}`, {
        name: draft.name,
        color: draft.color,
        permissions: draft.permissions.toString(),
      });
    } catch (err) {
      setError(errorText(err));
    }
  }

  async function create() {
    setError(null);
    try {
      const role = await api<Role>("POST", `/api/v1/communities/${communityId}/roles`, { name: t("manage.newRole") });
      setSelectedId(role.id);
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
      <div className="flex flex-col gap-2">
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                onClick={() => setSelectedId(role.id)}
                aria-current={selected?.id === role.id ? "true" : undefined}
                className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm ${
                  selected?.id === role.id ? "bg-raise font-semibold" : "hover:bg-raise"
                }`}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: role.color ?? "var(--muted)" }} />
                <span className="truncate">{role.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <Button onClick={create}>{t("manage.newRole")}</Button>
      </div>

      {selected && draft ? (
        <div className="flex min-w-0 flex-col gap-4">
          {selected.is_default ? <p className="text-xs text-muted">{t("manage.defaultRole")}</p> : null}

          <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
            <Field label={t("manage.roleName")}>
              {(id) => (
                <input
                  id={id}
                  className="field"
                  value={draft.name}
                  disabled={selected.is_default}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  maxLength={48}
                />
              )}
            </Field>
            <Field label={t("settings.accent")}>
              {(id) => (
                <input
                  id={id}
                  type="color"
                  className="field h-11 p-1"
                  value={draft.color}
                  onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                />
              )}
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm font-medium">{t("manage.permissions")}</legend>
            <ul className="grid max-h-64 gap-1 overflow-y-auto rounded-[10px] border border-line p-2 sm:grid-cols-2">
              {PERMISSION_NAMES.map((name) => {
                const bit = PERMISSIONS[name];
                const enabled = (draft.permissions & bit) !== 0n;
                const grantable = has(mine, bit);
                return (
                  <li key={name}>
                    <label className={`flex items-center gap-2 rounded-lg px-2 py-1 text-xs ${grantable ? "hover:bg-raise" : "opacity-45"}`}>
                      <input
                        type="checkbox"
                        checked={enabled}
                        disabled={!grantable}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            permissions: e.target.checked ? draft.permissions | bit : draft.permissions & ~bit,
                          })
                        }
                        style={{ accentColor: "var(--accent)" }}
                      />
                      <code className="truncate">{name}</code>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={save}>
              {t("common.save")}
            </Button>
            {selected.is_default ? null : (
              <Button
                variant="danger"
                onClick={async () => {
                  if (await confirm(`${t("manage.roleDelete")} — ${selected.name}`)) {
                    await api("DELETE", `/api/v1/roles/${selected.id}`);
                    setSelectedId(null);
                  }
                }}
              >
                {t("manage.roleDelete")}
              </Button>
            )}
          </div>
        </div>
      ) : null}
      {element}
    </div>
  );
}

function Invites({ communityId }: { communityId: string }) {
  const t = useT();
  const locale = useLocale();
  const publicUrl = useStore((s) => s.publicUrl);
  const [list, setList] = useState<Invite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);

  const load = () => {
    api<Invite[]>("GET", `/api/v1/communities/${communityId}/invites`).then(setList).catch(() => setList([]));
  };
  useEffect(load, [communityId]);

  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="primary"
        className="self-start"
        onClick={async () => {
          await api("POST", `/api/v1/communities/${communityId}/invites`, {});
          load();
        }}
      >
        {t("manage.newInvite")}
      </Button>

      <ul className="flex flex-col gap-2">
        {list.map((invite) => {
          const url = `${(publicUrl || location.origin).replace(/\/$/, "")}/invite/${invite.code}`;
          return (
            <li key={invite.code} className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line p-2 text-sm">
              <code className="min-w-0 flex-1 truncate">{url}</code>
              <span className="text-xs text-muted">
                {t("manage.inviteUses")} {invite.uses}
                {invite.max_uses ? `/${invite.max_uses}` : ""} ·{" "}
                {invite.expires_at ? formatDate(locale, invite.expires_at) : t("manage.inviteNever")}
              </span>
              <button
                className="btn btn-ghost h-9 min-h-9 px-2"
                onClick={async () => {
                  await navigator.clipboard.writeText(url);
                  setCopied(invite.code);
                }}
              >
                <Copy size={14} /> {copied === invite.code ? t("common.copied") : t("common.copy")}
              </button>
              <button
                className="btn btn-danger h-9 min-h-9 px-2"
                aria-label={t("common.delete")}
                onClick={async () => {
                  await api("DELETE", `/api/v1/invites/${invite.code}`);
                  load();
                }}
              >
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Audit({ communityId }: { communityId: string }) {
  const t = useT();
  const locale = useLocale();
  const members = useStore((s) => s.data[communityId]?.members ?? EMPTY);
  const [list, setList] = useState<AuditLogEntry[]>([]);

  useEffect(() => {
    api<AuditLogEntry[]>("GET", `/api/v1/communities/${communityId}/audit`).then(setList).catch(() => setList([]));
  }, [communityId]);

  if (list.length === 0) return <p className="text-sm text-muted">{t("manage.auditEmpty")}</p>;

  return (
    <ul className="flex flex-col divide-y divide-line rounded-[10px] border border-line">
      {list.map((entry) => (
        <li key={entry.id} className="flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm">
          <code className="text-accent">{entry.action}</code>
          <span className="text-muted">
            {members.find((m) => m.user.id === entry.actor_id)?.user.display_name ?? entry.actor_id.slice(0, 8)}
          </span>
          <span className="ml-auto text-xs text-muted">{formatDate(locale, entry.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function DataTab({ community, onClose }: { community: Community; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <h3 className="display font-bold">{t("manage.export")}</h3>
        <p className="text-sm text-muted">{t("manage.exportHint")}</p>
        <Button
          className="self-start"
          onClick={() => void download(`/api/v1/communities/${community.id}/export`, `${community.slug}-export.json`)}
        >
          {t("manage.export")}
        </Button>
      </section>

      <section className="flex flex-col gap-2 rounded-[10px] border border-danger/40 p-4">
        <h3 className="display font-bold text-danger">{t("manage.dangerZone")}</h3>
        <p className="text-sm text-muted">{t("manage.deleteConfirm", { name: community.name })}</p>
        <input className="field" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label={t("community.name")} />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        <Button
          variant="danger"
          disabled={typed !== community.name}
          className="self-start"
          onClick={async () => {
            try {
              await api("DELETE", `/api/v1/communities/${community.id}`);
              onClose();
              location.reload();
            } catch (err) {
              setError(errorText(err));
            }
          }}
        >
          {t("manage.deleteCommunity")}
        </Button>
      </section>
    </div>
  );
}
