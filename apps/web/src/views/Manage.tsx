/**
 * Administración de la comunidad (§11, §21, §23).
 * Los permisos se muestran con su identificador del protocolo a propósito: son
 * parte del contrato público, no texto de interfaz, y traducirlos los volvería
 * ambiguos entre la documentación y la pantalla.
 */
import { useEffect, useRef, useState } from "react";
import { Copy, Download, ImagePlus, Music, Trash2 } from "lucide-react";
import {
  PERMISSIONS,
  PERMISSION_NAMES,
  has,
  toBits,
  type AuditLogEntry,
  type Community,
  type CustomEmoji,
  type EmojiKind,
  type Invite,
  type Role,
} from "@distop/protocol";
import { useStore } from "../store.ts";
import { api, download, upload } from "../lib/api.ts";
import { clientOrigin } from "../lib/instance.ts";
import { formatDate } from "../i18n.ts";
import { Button, ErrorNote, Field, ImageField, Modal, Spinner, Toggle, useConfirm, useLocale, useT, useErrorText } from "../components/ui.tsx";

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];

type Tab = "overview" | "roles" | "emojis" | "invites" | "audit" | "data";

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
    ["emojis", t("emoji.title"), has(permissions, PERMISSIONS.MANAGE_COMMUNITY)],
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
          {tab === "emojis" ? <Expressions communityId={communityId} emojis={data.emojis} /> : null}
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
        <ImageField
          label={t("manage.icon")}
          hint={t("manage.iconHint")}
          value={form.icon_url}
          onChange={(url) => setForm({ ...form, icon_url: url })}
        />
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

      <ImageField
        label={t("manage.banner")}
        hint={t("common.optional")}
        value={form.banner_url}
        onChange={(url) => setForm({ ...form, banner_url: url })}
        preview="wide"
      />

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
          const url = `${(publicUrl || clientOrigin()).replace(/\/$/, "")}/invite/${invite.code}`;
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

/** Lo que devuelve /api/v1/sounds: tres campos, no el JSON de un tercero. */
interface GallerySound {
  id: string;
  name: string;
  url: string;
}

type SoundIconValue = {
  emoji: string;
  file: { id: string; url: string } | null;
};

const EMPTY_SOUND_ICON: SoundIconValue = { emoji: "", file: null };

function SoundIconPreview({ emoji, url, size = "md" }: { emoji?: string | null; url?: string | null; size?: "sm" | "md" }) {
  const dimensions = size === "sm" ? "h-9 w-9 text-lg" : "h-14 w-14 text-2xl";
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden rounded-[10px] border border-line bg-sunken ${dimensions}`}>
      {url ? (
        <img src={url} alt="" className="h-full w-full object-cover" />
      ) : emoji ? (
        <span aria-hidden="true">{emoji}</span>
      ) : (
        <Music size={size === "sm" ? 16 : 20} className="text-muted" />
      )}
    </span>
  );
}

function SoundIconPicker({
  value,
  onChange,
  onBusyChange,
}: {
  value: SoundIconValue;
  onChange: (value: SoundIconValue) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useT();
  const errorText = useErrorText();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    onBusyChange(true);
    setError(null);
    try {
      const uploaded = await upload(file);
      onChange({ emoji: "", file: { id: uploaded.id, url: uploaded.url } });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      onBusyChange(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-sunken/40 p-3">
      <div>
        <p className="text-sm font-medium">{t("emoji.soundIcon")}</p>
        <p className="text-xs text-muted">{t("emoji.soundIconHint")}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <SoundIconPreview emoji={value.emoji} url={value.file?.url ?? null} />
        <Field label={t("emoji.soundIconEmoji")}>
          {(id) => (
            <input
              id={id}
              className="field w-28 text-center text-xl"
              value={value.emoji}
              onChange={(event) => onChange({ emoji: event.target.value, file: null })}
              maxLength={16}
              placeholder="🔊"
            />
          )}
        </Field>
        <Button onClick={() => input.current?.click()} disabled={busy}>
          {busy ? t("common.uploading") : t("emoji.soundIconImage")}
        </Button>
        {value.file || value.emoji ? (
          <Button onClick={() => onChange(EMPTY_SOUND_ICON)}>{t("common.remove")}</Button>
        ) : null}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        onChange={(event) => void pick(event.target.files?.[0])}
      />
      {error ? <ErrorNote>{error}</ErrorNote> : null}
    </div>
  );
}

interface TelegramSticker {
  file_id: string;
  emoji: string;
  static: boolean;
}

/**
 * Importar un paquete de Telegram como sticker propio (§10.3, §12).
 *
 * Se guarda con el mismo createEmoji que un sticker subido a mano: pasa a ser
 * de la comunidad, no un enlace a Telegram que puede romperse (§21).
 *
 * Colapsado por defecto: solo funciona si quien hospeda configuró un bot de
 * Telegram, así que no tiene sentido ocuparle sitio a quien no lo activó.
 * Solo estáticos por ahora — los animados se filtran aquí, no se dejan elegir
 * para luego fallar en el servidor.
 */
function TelegramImport({ communityId }: { communityId: string }) {
  const t = useT();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [pack, setPack] = useState("");
  const [result, setResult] = useState<{ title: string; stickers: TelegramSticker[] } | null>(null);
  const [picked, setPicked] = useState<TelegramSticker | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function search() {
    const query = pack.trim();
    if (!query) return;
    setError(null);
    setResult(null);
    setPicked(null);
    setBusy(true);
    try {
      setResult(await api("GET", `/api/v1/stickers?pack=${encodeURIComponent(query)}`));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function importSticker() {
    if (!picked) return;
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/api/v1/communities/${communityId}/emojis/import-telegram`, {
        file_id: picked.file_id,
        name: name.trim(),
      });
      setPicked(null);
      setName("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-2 text-sm font-medium">
        <Download size={15} />
        {t("emoji.telegramImport")}
      </button>

      {open ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">{t("emoji.telegramHint")}</p>

          <div className="flex gap-2">
            <input
              value={pack}
              onChange={(e) => setPack(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void search()}
              placeholder={t("emoji.telegramPlaceholder")}
              className="field flex-1"
            />
            <Button onClick={() => void search()} disabled={busy || !pack.trim()}>
              {t("emoji.telegramSearch")}
            </Button>
          </div>

          {busy && !result ? <Spinner label={t("common.loading")} /> : null}

          {result ? (
            result.stickers.length === 0 ? (
              <p className="text-sm text-muted">{t("emoji.telegramEmpty")}</p>
            ) : (
              <ul className="grid max-h-64 grid-cols-6 gap-2 overflow-y-auto sm:grid-cols-8">
                {result.stickers.map((sticker) => (
                  <li key={sticker.file_id}>
                    <button
                      onClick={() => {
                        setPicked(sticker);
                        setName("");
                      }}
                      disabled={!sticker.static}
                      title={sticker.static ? sticker.emoji : t("emoji.telegramAnimatedYet")}
                      aria-pressed={picked?.file_id === sticker.file_id}
                      className={`grid aspect-square place-items-center rounded-[10px] border p-1 ${
                        picked?.file_id === sticker.file_id ? "border-accent" : "border-line hover:border-accent"
                      } ${sticker.static ? "" : "opacity-30"}`}
                    >
                      {sticker.static ? (
                        <img
                          src={`/api/v1/stickers/image?id=${encodeURIComponent(sticker.file_id)}`}
                          alt={sticker.emoji}
                          loading="lazy"
                          className="max-h-full max-w-full"
                        />
                      ) : (
                        <span aria-hidden="true">{sticker.emoji}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {picked ? (
            <div className="flex flex-wrap items-end gap-2 rounded-[10px] border border-line p-2">
              <img
                src={`/api/v1/stickers/image?id=${encodeURIComponent(picked.file_id)}`}
                alt=""
                className="h-12 w-12 object-contain"
              />
              <div className="min-w-40 flex-1">
                <Field label={t("emoji.name")} hint={t("emoji.nameHint")}>
                  {(id) => (
                    <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="mi_sticker" />
                  )}
                </Field>
              </div>
              <Button variant="primary" onClick={() => void importSticker()} disabled={busy || name.trim().length < 2}>
                {t("emoji.telegramAdd")}
              </Button>
            </div>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Galeria de sonidos (§10.3), contra la API publica de MyInstants.
 *
 * Se escucha antes de decidir y solo se baja el que se elige: la rejilla no
 * cuesta disco, el sonido elegido si — y pasa a ser de la comunidad, no un
 * enlace a un tercero que puede romperse.
 *
 * De 10 en 10 porque el catalogo no admite pedir mas por pagina; el boton de
 * "ver mas" pide la siguiente y la añade a lo que ya hay.
 */
function SoundGallery({ communityId }: { communityId: string }) {
  const t = useT();
  const errorText = useErrorText();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [results, setResults] = useState<GallerySound[] | null>(null);
  const [picked, setPicked] = useState<GallerySound | null>(null);
  const [name, setName] = useState("");
  const [icon, setIcon] = useState<SoundIconValue>(EMPTY_SOUND_ICON);
  const [iconBusy, setIconBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Nada de buscar en cada tecla: cada una es una peticion que sale de la instancia.
  useEffect(() => {
    if (!open) return;
    setPage(1);
    setResults(null);
    setError(null);
    const timer = setTimeout(() => {
      api<GallerySound[]>("GET", `/api/v1/sounds?q=${encodeURIComponent(query.trim())}`)
        .then(setResults)
        .catch((err) => {
          setResults([]);
          setError(errorText(err));
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [query, open, errorText]);

  async function more() {
    const siguiente = page + 1;
    setBusy(true);
    try {
      const extra = await api<GallerySound[]>(
        "GET",
        `/api/v1/sounds?q=${encodeURIComponent(query.trim())}&page=${siguiente}`,
      );
      setResults((prev) => [...(prev ?? []), ...extra]);
      setPage(siguiente);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function importSound() {
    if (!picked) return;
    setError(null);
    setBusy(true);
    try {
      await api("POST", `/api/v1/communities/${communityId}/emojis/import-sound`, {
        url: picked.url,
        name: name.trim(),
        icon_emoji: icon.emoji || undefined,
        icon_attachment_id: icon.file?.id,
      });
      setPicked(null);
      setName("");
      setIcon(EMPTY_SOUND_ICON);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex items-center gap-2 text-sm font-medium">
        <Music size={15} />
        {t("emoji.soundGallery")}
      </button>

      {open ? (
        <div className="flex flex-col gap-3">
          <p className="text-xs text-muted">{t("emoji.soundGalleryHint")}</p>

          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("emoji.soundPlaceholder")}
            aria-label={t("emoji.soundPlaceholder")}
            className="field"
          />

          {results === null ? (
            <Spinner label={t("common.loading")} />
          ) : results.length === 0 ? (
            <p className="text-sm text-muted">{t("emoji.soundEmpty")}</p>
          ) : (
            <>
              <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
                {results.map((sound) => (
                  <li key={sound.id} className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setPicked(sound);
                        setIcon(EMPTY_SOUND_ICON);
                        // El nombre del sonido es el mejor primer intento; se puede corregir.
                        setName(sound.name.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").slice(0, 32));
                      }}
                      aria-pressed={picked?.id === sound.id}
                      className={`min-w-0 flex-1 truncate rounded-[10px] border px-2 py-1 text-left text-sm ${
                        picked?.id === sound.id ? "border-accent" : "border-line hover:border-accent"
                      }`}
                    >
                      {sound.name}
                    </button>
                    {/* Escuchar antes de decidir. Suena desde MyInstants: hasta
                        que no se elige, el disco del anfitrion no se toca. */}
                    <audio src={sound.url} controls preload="none" className="h-8 w-44 shrink-0" />
                  </li>
                ))}
              </ul>
              <Button onClick={() => void more()} disabled={busy}>
                {t("emoji.soundMore")}
              </Button>
            </>
          )}

          {picked ? (
            <div className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-40 flex-1">
                  <Field label={t("emoji.name")} hint={t("emoji.nameHintSound")}>
                    {(id) => (
                      <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="mi_sonido" />
                    )}
                  </Field>
                </div>
                <Button variant="primary" onClick={() => void importSound()} disabled={busy || iconBusy || name.trim().length < 2}>
                  {t("emoji.soundAdd")}
                </Button>
              </div>
              <SoundIconPicker value={icon} onChange={setIcon} onBusyChange={setIconBusy} />
            </div>
          ) : null}

          {error ? <ErrorNote>{error}</ErrorNote> : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Emojis y stickers de la comunidad (§10.3).
 *
 * Aquí no hay contador de "te quedan 3 espacios": el límite es el disco del
 * anfitrión, se dice tal cual, y quien hospeda decide si le sobra. Es la
 * diferencia entre un límite físico —que se puede ampliar comprando un disco—
 * y uno inventado para vender una suscripción (§10, §29.6).
 */
function Expressions({ communityId, emojis }: { communityId: string; emojis: CustomEmoji[] }) {
  const t = useT();
  const errorText = useErrorText();
  const { confirm, element: confirmElement } = useConfirm();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<EmojiKind>("emoji");
  const [file, setFile] = useState<{ id: string; url: string } | null>(null);
  const [soundIcon, setSoundIcon] = useState<SoundIconValue>(EMPTY_SOUND_ICON);
  const [iconBusy, setIconBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function pick(chosen: File | undefined) {
    if (!chosen) return;
    setError(null);
    setBusy(true);
    try {
      const subido = await upload(chosen);
      setFile({ id: subido.id, url: subido.url });
      // El nombre del archivo es el mejor primer intento; se puede corregir.
      if (!name) setName(chosen.name.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function create() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/v1/communities/${communityId}/emojis`, {
        name: name.trim(),
        kind,
        attachment_id: file.id,
        icon_emoji: kind === "sound" ? soundIcon.emoji || undefined : undefined,
        icon_attachment_id: kind === "sound" ? soundIcon.file?.id : undefined,
      });
      setName("");
      setFile(null);
      setSoundIcon(EMPTY_SOUND_ICON);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const listas: Array<[EmojiKind, string]> = [
    ["emoji", t("emoji.kindEmoji")],
    ["sticker", t("emoji.kindSticker")],
    ["sound", t("emoji.kindSound")],
  ];

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted">{t("emoji.hint")}</p>

      <section className="flex flex-col gap-3 rounded-[10px] border border-line p-3">
        <div className="flex flex-wrap items-end gap-3">
          <button
            onClick={() => input.current?.click()}
            className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-[10px] border border-dashed border-line bg-sunken hover:border-accent"
          >
            {file && kind !== "sound" ? (
              <img src={file.url} alt="" className="max-h-full max-w-full" />
            ) : kind === "sound" ? (
              <Music size={20} className={file ? "text-accent" : "text-muted"} />
            ) : (
              <ImagePlus size={20} className="text-muted" />
            )}
            <span className="sr-only">{t(kind === "sound" ? "emoji.soundFile" : "emoji.image")}</span>
          </button>

          <div className="min-w-40 flex-1">
            <Field label={t("emoji.name")} hint={t(kind === "sound" ? "emoji.nameHintSound" : "emoji.nameHint")}>
              {(id) => (
                <input
                  id={id}
                  className="field"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={32}
                  placeholder={kind === "sound" ? "mi_sonido" : "mi_emoji"}
                />
              )}
            </Field>
          </div>

          <fieldset className="flex gap-2">
            <legend className="sr-only">{t("emoji.kind")}</legend>
            {listas.map(([value, label]) => (
              <button
                key={value}
                onClick={() => {
                  setKind(value);
                  if (value !== "sound") setSoundIcon(EMPTY_SOUND_ICON);
                }}
                aria-pressed={kind === value}
                className={`btn ${kind === value ? "btn-primary" : "btn-ghost"}`}
              >
                {label}
              </button>
            ))}
          </fieldset>

          <Button variant="primary" onClick={create} disabled={busy || iconBusy || !file || name.trim().length < 2}>
            {t("emoji.add")}
          </Button>
        </div>

        {kind === "sound" ? (
          <SoundIconPicker value={soundIcon} onChange={setSoundIcon} onBusyChange={setIconBusy} />
        ) : null}

        <input
          ref={input}
          type="file"
          accept={kind === "sound" ? "audio/mpeg,audio/ogg,audio/wav" : "image/png,image/jpeg,image/gif,image/webp"}
          className="sr-only"
          onChange={(e) => void pick(e.target.files?.[0])}
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}
      </section>

      <TelegramImport communityId={communityId} />
      <SoundGallery communityId={communityId} />

      {listas.map(([value, label]) => {
        const grupo = emojis.filter((e) => e.kind === value);
        return (
          <section key={value}>
            <h4 className="mb-2 text-sm font-semibold">{label}</h4>
            {grupo.length === 0 ? (
              <p className="text-sm text-muted">{t("emoji.none")}</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {grupo.map((emoji) => (
                  <li
                    key={emoji.id}
                    className="group relative flex flex-col items-center gap-1 rounded-[10px] border border-line p-2"
                  >
                    {value === "sound" ? (
                      <div className="flex items-center gap-2">
                        <SoundIconPreview emoji={emoji.icon_emoji} url={emoji.icon_url} size="sm" />
                        <audio src={emoji.url} controls preload="none" className="h-8 w-48" />
                      </div>
                    ) : (
                      <img
                        src={emoji.url}
                        alt={`:${emoji.name}:`}
                        className={value === "sticker" ? "h-16 w-16 object-contain" : "h-8 w-8 object-contain"}
                      />
                    )}
                    <span className={`truncate text-[0.7rem] text-muted ${value === "sound" ? "max-w-52" : "max-w-24"}`}>
                      {value === "sound" ? emoji.name : `:${emoji.name}:`}
                    </span>
                    <button
                      onClick={async () => {
                        if (await confirm(t("emoji.deleteConfirm")))
                          await api("DELETE", `/api/v1/emojis/${emoji.id}`).catch(() => {});
                      }}
                      aria-label={t("common.delete")}
                      className="absolute -top-2 -right-2 hidden rounded-full border border-line bg-surface p-1 text-danger group-hover:block group-focus-within:block"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}

      {confirmElement}
    </div>
  );
}
