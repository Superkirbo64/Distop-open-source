/**
 * Cómo se ven los avisos (§9.2, §31).
 *
 * Dos piezas de la misma cosa:
 *   · `NoticeToaster` — lo que asoma cuando algo acaba de pasar. Se apoya en
 *     sonner, que ya resuelve el apilado, el gesto para descartar y los avisos
 *     a lectores de pantalla; escribir eso a mano habría sido peor y más largo.
 *   · `Notices` — el historial, para quien vuelve al ordenador media hora
 *     después y quiere saber qué se perdió.
 *
 * El aviso que asoma no es el registro: es un vistazo. Todo lo que asoma queda
 * escrito, y por eso se puede descartar sin miedo.
 */
import { useEffect, useRef } from "react";
import { toast, Toaster } from "sonner";
import { AtSign, Bell, MessageSquare, Server, UserPlus } from "lucide-react";
import { useStore } from "../store.ts";
import { formatTime } from "../i18n.ts";
import { Button, EmptyState, Modal, useLocale, useT } from "./ui.tsx";
import type { Notice, NoticeKind } from "../lib/notices.ts";

const ICONO: Record<NoticeKind, typeof Bell> = {
  message: MessageSquare,
  mention: AtSign,
  member: UserPlus,
  meeting: UserPlus,
  request: UserPlus,
  instance: Server,
  error: Bell,
};

function NoticeIcon({ kind, size = 16 }: { kind: NoticeKind; size?: number }) {
  const Icon = ICONO[kind] ?? Bell;
  return <Icon size={size} aria-hidden />;
}

/**
 * Asoma cada aviso nuevo una sola vez.
 *
 * Se compara contra el último id visto en vez de contra la longitud de la lista:
 * vaciar el historial no puede provocar una lluvia de avisos repetidos.
 */
export function NoticeToaster() {
  const t = useT();
  const notices = useStore((s) => s.notices);
  const openChannel = useStore((s) => s.openChannel);
  const openCommunity = useStore((s) => s.openCommunity);
  const motion = useStore((s) => s.prefs.motion);
  const visto = useRef<string | null>(null);
  const arrancado = useRef(false);

  useEffect(() => {
    const ultimo = notices[0];
    // Al abrir la aplicación el historial ya viene lleno: no es novedad.
    if (!arrancado.current) {
      arrancado.current = true;
      visto.current = ultimo?.id ?? null;
      return;
    }
    if (!ultimo || ultimo.id === visto.current) return;
    visto.current = ultimo.id;

    const ir = ultimo.target?.channelId
      ? () => void openChannel(ultimo.target!.channelId!)
      : ultimo.target?.communityId
        ? () => void openCommunity(ultimo.target!.communityId!)
        : undefined;

    toast.custom((id) => (
      <div className="flex w-full max-w-sm items-start gap-3 rounded-[12px] border border-line bg-raised p-3 shadow-lg">
        <span className="mt-0.5 shrink-0 text-muted">
          <NoticeIcon kind={ultimo.kind} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{ultimo.title}</p>
          <p className="line-clamp-2 text-xs text-muted">{ultimo.body}</p>
        </div>
        {ir ? (
          <button
            className="btn btn-ghost h-8 min-h-8 shrink-0 px-2 text-xs"
            onClick={() => {
              ir();
              toast.dismiss(id);
            }}
          >
            {t("notice.go")}
          </button>
        ) : null}
      </div>
    ), { duration: ultimo.kind === "error" || ultimo.kind === "instance" ? 8000 : 5000 });
  }, [notices, openChannel, openCommunity, t]);

  return (
    <Toaster
      position="bottom-right"
      expand={false}
      visibleToasts={3}
      /* Sin animaciones, un aviso que se va solo en 5 s es un parpadeo: sin el
         movimiento que avisa de que se está yendo, conviene que dure más. */
      duration={motion ? 5000 : 8000}
      toastOptions={{ unstyled: true, classNames: { toast: "w-full" } }}
    />
  );
}

/** El historial: qué ha pasado, cuándo, y cómo llegar hasta ello. */
export function Notices({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const notices = useStore((s) => s.notices);
  const readNotices = useStore((s) => s.readNotices);
  const clearNotices = useStore((s) => s.clearNotices);
  const openChannel = useStore((s) => s.openChannel);
  const openCommunity = useStore((s) => s.openCommunity);

  // Abrirlo es haberlos leído: dejar el punto encendido después sería mentir.
  useEffect(() => {
    if (open) readNotices();
  }, [open, readNotices]);

  function ir(notice: Notice): void {
    if (notice.target?.channelId) void openChannel(notice.target.channelId);
    else if (notice.target?.communityId) void openCommunity(notice.target.communityId);
    else return;
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={t("notice.title")}>
      {notices.length === 0 ? (
        <EmptyState title={t("notice.empty")} hint={t("notice.emptyHint")} />
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1">
            {notices.map((notice) => {
              const navegable = Boolean(notice.target?.channelId || notice.target?.communityId);
              return (
                <li key={notice.id}>
                  <button
                    className="flex w-full items-start gap-3 rounded-[10px] p-2 text-left hover:bg-sunken disabled:cursor-default"
                    onClick={() => ir(notice)}
                    disabled={!navegable}
                  >
                    <span className="mt-0.5 shrink-0 text-muted">
                      <NoticeIcon kind={notice.kind} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{notice.title}</span>
                      <span className="block truncate text-xs text-muted">{notice.body}</span>
                    </span>
                    <span className="shrink-0 text-[11px] text-muted">{formatTime(locale, notice.at)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Button variant="ghost" onClick={clearNotices}>{t("notice.clear")}</Button>
        </div>
      )}
    </Modal>
  );
}
