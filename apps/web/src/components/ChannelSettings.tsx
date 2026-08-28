/**
 * Ajustes de un canal y de una categoría (§9.1, §11).
 *
 * Discord esconde esto detrás del engranaje que aparece al pasar el ratón por
 * la fila. Aquí también, pero además se llega con el segundo clic sobre el
 * canal ya abierto y con el clic derecho: el engranaje no existe en una
 * pantalla táctil, y un ajuste al que solo se llega con ratón no está
 * disponible para todo el mundo (§31).
 *
 * Lo que se puede cambiar es exactamente lo que la instancia acepta en
 * `PATCH /api/v1/channels/:id`: nombre, tema, categoría y modo lento. Ningún
 * campo decorativo que se guarde solo en el navegador.
 */
import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  PERMISSIONS,
  has,
  toBits,
  type Category,
  type Channel,
  type PermissionName,
  type PermissionOverwrite,
} from "@distop/protocol";
import { api } from "../lib/api.ts";
import { useStore } from "../store.ts";
import { Button, ErrorNote, Field, Modal, Select, useConfirm, useErrorText, useT } from "./ui.tsx";

/* Solo los permisos que significan algo EN ese canal. Ofrecer "hablar" en uno
   de texto, o "adjuntar archivos" en uno de voz, es prometer un ajuste que no
   existe: el interruptor se guardaría y no cambiaría nada. */
const SCOPED: Record<Channel["kind"], PermissionName[]> = {
  text: [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "READ_HISTORY",
    "MANAGE_MESSAGES",
    "ATTACH_FILES",
    "EMBED_LINKS",
    "ADD_REACTIONS",
    "USE_CUSTOM_EMOJIS",
    "MENTION_EVERYONE",
    "CREATE_THREADS",
    "MANAGE_THREADS",
    "MANAGE_WEBHOOKS",
  ],
  announcement: [
    "VIEW_CHANNEL",
    "SEND_MESSAGES",
    "READ_HISTORY",
    "MANAGE_MESSAGES",
    "ATTACH_FILES",
    "EMBED_LINKS",
    "ADD_REACTIONS",
    "MENTION_EVERYONE",
    "MANAGE_WEBHOOKS",
  ],
  voice: [
    "VIEW_CHANNEL",
    "CONNECT_VOICE",
    "SPEAK",
    "STREAM",
    "USE_CAMERA",
    "MUTE_MEMBERS",
    "DEAFEN_MEMBERS",
    "MOVE_MEMBERS",
  ],
  meeting: ["VIEW_CHANNEL", "CONNECT_VOICE", "SPEAK", "STREAM", "USE_CAMERA", "SEND_MESSAGES", "READ_HISTORY"],
};

/** Los escalones que acepta la instancia, de 0 a 6 h. */
const SLOWMODE = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600] as const;

/** El mismo nombre que valida la instancia: ni espacio inicial ni `#`/`@`. */
const CHANNEL_NAME = /^[^\s#@][^#@]{0,63}$/;

type Overwrite = { allow: bigint; deny: bigint };
type Estado = "inherit" | "allow" | "deny";

const VACIO: Overwrite = { allow: 0n, deny: 0n };

export function ChannelSettings({ channel, onClose }: { channel: Channel | null; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const { confirm, element: confirmElement } = useConfirm();

  const data = useStore((s) => (channel ? s.data[channel.community_id] : undefined));
  const mine = toBits(data?.permissions ?? "0");
  const canManageRoles = has(mine, PERMISSIONS.MANAGE_ROLES);

  const [tab, setTab] = useState<"general" | "permissions">("general");
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [slowmode, setSlowmode] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /* Los overwrites, tal como están en la instancia y tal como se están
     tocando. Se guardan aparte para mandar solo lo que de verdad cambió: cada
     PUT avisa a toda la comunidad, y reenviar lo idéntico es ruido para todos. */
  const [saved, setSaved] = useState<Record<string, Overwrite>>({});
  const [draft, setDraft] = useState<Record<string, Overwrite>>({});
  const [roleId, setRoleId] = useState<string | null>(null);

  const channelId = channel?.id ?? null;

  useEffect(() => {
    if (!channel) return;
    setTab("general");
    setName(channel.name);
    setTopic(channel.topic ?? "");
    setCategoryId(channel.category_id ?? "");
    setSlowmode(channel.slowmode_s);
    setRoleId(null);
    setError(null);
  }, [channelId]);

  /* Los overwrites no vienen en el bootstrap —solo llega lo que hace falta
     para pintar—, así que se piden al abrir la pestaña y no antes. */
  useEffect(() => {
    if (!channelId || tab !== "permissions") return;
    let vivo = true;
    void api<PermissionOverwrite[]>("GET", `/api/v1/channels/${channelId}/permissions`)
      .then((list) => {
        if (!vivo) return;
        const mapa: Record<string, Overwrite> = {};
        for (const o of list) {
          if (o.target_type !== "role") continue;
          mapa[o.target_id] = { allow: toBits(o.allow), deny: toBits(o.deny) };
        }
        setSaved(mapa);
        setDraft(mapa);
      })
      .catch(() => {
        if (!vivo) return;
        setSaved({});
        setDraft({});
      });
    return () => {
      vivo = false;
    };
  }, [channelId, tab]);

  if (!channel || !data) return null;

  const roles = data.roles.slice().sort((a, b) => b.position - a.position);
  const role = roles.find((r) => r.id === roleId) ?? roles.find((r) => r.is_default) ?? roles[0];
  const actual = (role ? draft[role.id] : undefined) ?? VACIO;

  const estadoDe = (bit: bigint): Estado =>
    (actual.allow & bit) !== 0n ? "allow" : (actual.deny & bit) !== 0n ? "deny" : "inherit";

  function poner(bit: bigint, estado: Estado) {
    if (!role) return;
    setDraft((prev) => {
      const base = prev[role.id] ?? VACIO;
      return {
        ...prev,
        [role.id]: {
          allow: estado === "allow" ? base.allow | bit : base.allow & ~bit,
          deny: estado === "deny" ? base.deny | bit : base.deny & ~bit,
        },
      };
    });
  }

  const nombreValido = CHANNEL_NAME.test(name.trim());

  async function guardar() {
    if (!channel) return;
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/v1/channels/${channel.id}`, {
        name: name.trim(),
        topic: topic.trim(),
        category_id: categoryId || null,
        slowmode_s: slowmode,
      });

      for (const [id, valor] of Object.entries(draft)) {
        const antes = saved[id] ?? VACIO;
        if (antes.allow === valor.allow && antes.deny === valor.deny) continue;
        if (valor.allow === 0n && valor.deny === 0n) {
          await api("DELETE", `/api/v1/channels/${channel.id}/permissions/${id}`);
        } else {
          await api("PUT", `/api/v1/channels/${channel.id}/permissions/${id}`, {
            target_type: "role",
            allow: valor.allow.toString(),
            deny: valor.deny.toString(),
          });
        }
      }
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function eliminar() {
    if (!channel) return;
    if (!(await confirm(t("channel.deleteConfirm")))) return;
    try {
      await api("DELETE", `/api/v1/channels/${channel.id}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  const tabs = (
    [
      ["general", t("channel.tabGeneral")],
      ["permissions", t("channel.tabPermissions")],
    ] as const
  ).filter(([id]) => id !== "permissions" || canManageRoles);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={t("channel.settings", { name: channel.name })}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void guardar()} disabled={busy || !nombreValido}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {tabs.length > 1 ? (
          <div role="tablist" className="flex gap-1 border-b border-line">
            {tabs.map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
                  tab === id ? "border-accent font-semibold text-accent" : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {tab === "general" ? (
          <div className="flex flex-col gap-4">
            <Field label={t("channel.name")} {...(name.trim() && !nombreValido ? { error: t("channel.nameInvalid") } : {})}>
              {(id) => (
                <input id={id} className="field" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
              )}
            </Field>

            <Field label={t("channel.topic")} hint={t("channel.topicHint")}>
              {(id) => (
                <textarea
                  id={id}
                  className="field min-h-20"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  maxLength={500}
                />
              )}
            </Field>

            <Field label={t("channel.category")}>
              {(id) => (
                <Select
                  id={id}
                  value={categoryId}
                  onChange={setCategoryId}
                  options={[
                    { value: "", label: t("common.none") },
                    ...data.categories.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              )}
            </Field>

            {/* El modo lento solo existe donde se escribe: en un canal de voz no
                hay nada que espaciar, y un desplegable inerte confunde más que
                su ausencia. */}
            {channel.kind === "text" || channel.kind === "announcement" ? (
              <Field label={t("channel.slowmode")} hint={t("channel.slowmodeHint")}>
                {(id) => (
                  <Select
                    id={id}
                    value={String(slowmode)}
                    onChange={(value) => setSlowmode(Number(value))}
                    options={SLOWMODE.map((segundos) => ({ value: String(segundos), label: duracion(t, segundos) }))}
                  />
                )}
              </Field>
            ) : null}

            {error ? <ErrorNote>{error}</ErrorNote> : null}

            <section className="flex flex-col gap-2 rounded-[10px] border border-danger/40 p-4">
              <h3 className="display font-bold text-danger">{t("manage.dangerZone")}</h3>
              <p className="text-sm text-muted">{t("channel.deleteConfirm")}</p>
              <Button variant="danger" className="self-start" onClick={() => void eliminar()}>
                <Trash2 size={15} /> {t("channel.delete")}
              </Button>
            </section>
          </div>
        ) : null}

        {tab === "permissions" && role ? (
          <div className="grid gap-4 sm:grid-cols-[11rem_1fr]">
            <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
              {roles.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setRoleId(r.id)}
                    aria-current={role.id === r.id ? "true" : undefined}
                    className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-sm ${
                      role.id === r.id ? "bg-raise font-semibold" : "hover:bg-raise"
                    }`}
                  >
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: r.color ?? "var(--muted)" }} />
                    <span className="truncate">{r.name}</span>
                  </button>
                </li>
              ))}
            </ul>

            <div className="flex min-w-0 flex-col gap-3">
              <p className="text-xs text-muted">{t("channel.permissionsHint")}</p>
              <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-[10px] border border-line p-2">
                {SCOPED[channel.kind].map((nombre) => {
                  const bit = PERMISSIONS[nombre];
                  const estado = estadoDe(bit);
                  /* No se puede conceder en un canal lo que no se tiene en la
                     comunidad: si no, cualquiera con MANAGE_ROLES se fabricaría
                     permisos de administrador canal a canal. */
                  const puede = has(mine, bit);
                  return (
                    <li key={nombre} className={`flex items-center gap-2 rounded-lg px-2 py-1 ${puede ? "" : "opacity-45"}`}>
                      <code className="min-w-0 flex-1 truncate text-xs">{nombre}</code>
                      <div className="flex shrink-0 gap-0.5" role="group" aria-label={nombre}>
                        {(["deny", "inherit", "allow"] as const).map((opcion) => (
                          <button
                            key={opcion}
                            onClick={() => poner(bit, opcion)}
                            disabled={!puede}
                            aria-pressed={estado === opcion}
                            className={`btn h-7 min-h-7 px-2 text-[0.7rem] ${
                              estado !== opcion
                                ? "btn-ghost"
                                : opcion === "deny"
                                  ? "btn-danger"
                                  : opcion === "allow"
                                    ? "btn-primary"
                                    : "btn-ghost ring-1 ring-line"
                            }`}
                          >
                            {t(opcion === "deny" ? "channel.deny" : opcion === "allow" ? "channel.allow" : "channel.inherit")}
                          </button>
                        ))}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {error ? <ErrorNote>{error}</ErrorNote> : null}
            </div>
          </div>
        ) : null}
      </div>
      {confirmElement}
    </Modal>
  );
}

/** "Desactivado", "30 s", "5 min", "6 h": no hace falta una librería de fechas para catorce valores. */
function duracion(t: ReturnType<typeof useT>, segundos: number): string {
  if (segundos === 0) return t("channel.slowmodeOff");
  if (segundos < 60) return t("common.seconds", { n: segundos });
  if (segundos < 3600) return t("common.minutes", { n: segundos / 60 });
  return t("common.hours", { n: segundos / 3600 });
}

/**
 * Ajustes de categoría: nombre y borrado.
 * Borrar una categoría NO borra sus canales —la instancia los deja sueltos—, y
 * eso hay que decirlo antes, no descubrirlo después (§29.6).
 */
export function CategorySettings({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const t = useT();
  const errorText = useErrorText();
  const { confirm, element: confirmElement } = useConfirm();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const categoryId = category?.id ?? null;
  useEffect(() => {
    if (!category) return;
    setName(category.name);
    setError(null);
  }, [categoryId]);

  if (!category) return null;

  async function guardar() {
    if (!category) return;
    setBusy(true);
    setError(null);
    try {
      await api("PATCH", `/api/v1/categories/${category.id}`, { name: name.trim() });
      onClose();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function eliminar() {
    if (!category) return;
    if (!(await confirm(t("category.deleteConfirm")))) return;
    try {
      await api("DELETE", `/api/v1/categories/${category.id}`);
      onClose();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t("category.settings", { name: category.name })}
      footer={
        <>
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" onClick={() => void guardar()} disabled={busy || !name.trim()}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label={t("channel.categoryName")}>
          {(id) => (
            <input
              id={id}
              className="field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={64}
              autoFocus
            />
          )}
        </Field>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        <section className="flex flex-col gap-2 rounded-[10px] border border-danger/40 p-4">
          <h3 className="display font-bold text-danger">{t("manage.dangerZone")}</h3>
          <p className="text-sm text-muted">{t("category.deleteConfirm")}</p>
          <Button variant="danger" className="self-start" onClick={() => void eliminar()}>
            <Trash2 size={15} /> {t("category.delete")}
          </Button>
        </section>
      </div>
      {confirmElement}
    </Modal>
  );
}
