/**
 * Adjunto que viaja entre miembros (fase 3). La instancia no tiene el archivo:
 * se pide a quien lo envió y solo se enseña después de verificar su SHA-256.
 */
import { useCallback, useEffect, useState } from "react";
import { Paperclip } from "lucide-react";
import type { Attachment } from "@distop/protocol";
import { fetchP2PFile, heldBlob, type P2PFailure } from "../lib/p2pFiles.ts";
import { formatBytes } from "../i18n.ts";
import { useLocale, useT } from "./ui.tsx";
import { VoiceMessagePlayer } from "./VoiceMessagePlayer.tsx";

// ponytail: las URL viven lo que la pestaña; liberarlas si la memoria molesta.
const received = new Map<string, string>();

export function P2PAttachment({ file, channelId, onViewImage }: {
  file: Attachment;
  channelId: string;
  onViewImage: (file: Attachment) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const [url, setUrl] = useState(() => received.get(file.id) ?? null);
  const [state, setState] = useState<"idle" | "loading" | P2PFailure>("idle");
  const [pct, setPct] = useState(0);
  const image = file.content_type.startsWith("image/") && file.content_type !== "image/svg+xml";

  const load = useCallback(() => {
    setState("loading");
    setPct(0);
    const own = heldBlob(file.id);
    (own ? Promise.resolve(own) : fetchP2PFile(file, channelId, (f) => setPct(Math.round(f * 100))))
      .then((blob) => {
        const next = URL.createObjectURL(blob);
        received.set(file.id, next);
        setUrl(next);
        setState("idle");
      })
      .catch((reason: P2PFailure) => setState(reason));
  }, [file, channelId]);

  // Las fotos se piden solas, como una foto normal; lo demás espera al toque.
  useEffect(() => {
    if (!url && image) load();
  }, [url, image, load]);

  if (url && image)
    return (
      <button onClick={() => onViewImage({ ...file, url })} aria-label={t("message.imageOpen")}>
        <img src={url} alt={file.filename} className="max-h-72 max-w-full rounded-[10px] object-cover transition-opacity hover:opacity-90" />
      </button>
    );
  if (url && file.content_type.startsWith("audio/")) return <VoiceMessagePlayer src={url} label={file.filename} />;
  if (url && file.content_type.startsWith("video/"))
    return <video src={url} controls className="max-h-72 max-w-full rounded-[10px]" />;

  const status =
    state === "loading" ? (pct > 0 ? t("message.p2pProgress", { pct }) : t("message.p2pSearching"))
    : state === "offline" ? t("message.p2pOffline")
    : state === "corrupt" ? t("message.p2pCorrupt")
    : null;

  return (
    <div className="flex max-w-full flex-wrap items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2 text-sm">
      <Paperclip size={14} className="shrink-0" />
      {url ? (
        <a href={url} download={file.filename} className="max-w-56 truncate hover:underline">{file.filename}</a>
      ) : (
        <span className="max-w-56 truncate">{file.filename}</span>
      )}
      <span className="text-xs text-muted">{formatBytes(locale, file.size)}</span>
      {status ? <span className="text-xs text-muted" role="status">{status}</span> : null}
      {!url && state !== "loading" ? (
        <button onClick={load} className="text-xs font-medium text-accent hover:underline">
          {state === "idle" ? t("message.p2pLoad") : t("message.p2pRetry")}
        </button>
      ) : null}
    </div>
  );
}
