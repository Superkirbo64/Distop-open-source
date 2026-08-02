/**
 * Interfaz de voz (§9.4).
 * Dos piezas: la gente que ya está dentro se ve colgando del canal en la lista,
 * y quien está conectada tiene un panel fijo encima de su barra de usuario con
 * lo que se usa cada dos minutos: callar, ensordecer y colgar.
 */
import { useEffect, useState } from "react";
import { MicOff, PhoneOff, Signal, Volume2, VolumeX } from "lucide-react";
import { Headset, Microphone } from "./icons.tsx";
import type { Member, VoiceState } from "@distop/protocol";
import { useStore } from "../store.ts";
import { leaveVoice, onVoice, setDeafened, setMuted, type VoiceLocalState } from "../lib/voice.ts";
import { Avatar, ErrorNote, IconButton, useT } from "./ui.tsx";

/**
 * Referencia estable para "no hay nada".
 * Un selector de zustand que devuelve `?? []` fabrica un array nuevo en cada
 * lectura; useSyncExternalStore lo ve como estado nuevo y el render entra en
 * bucle (React #185). Devolviendo siempre el mismo array, no.
 */
const EMPTY: never[] = [];

export function useVoiceLocal(): VoiceLocalState {
  const [state, setState] = useState<VoiceLocalState>({
    channelId: null,
    muted: false,
    deafened: false,
    speaking: new Set(),
    error: null,
  });
  useEffect(() => onVoice(setState), []);
  return state;
}

/** Lista de quién está en una sala, para colgar debajo del canal en la barra. */
export function VoiceParticipants({ states, members }: { states: VoiceState[]; members: Member[] }) {
  const local = useVoiceLocal();
  if (states.length === 0) return null;

  return (
    <ul className="mt-0.5 mb-1 flex flex-col gap-0.5 pl-6">
      {states.map((state) => {
        const member = members.find((m) => m.user.id === state.user_id);
        const name = member?.nickname ?? member?.user.display_name ?? "…";
        const speaking = local.speaking.has(state.user_id);

        return (
          <li key={state.user_id} className="flex items-center gap-2 rounded-lg px-2 py-1">
            <span
              className="rounded-full transition-shadow duration-150"
              style={{ boxShadow: speaking ? "0 0 0 2px var(--ok)" : "0 0 0 2px transparent" }}
            >
              <Avatar name={name} url={member?.user.avatar_url} id={state.user_id} size={22} />
            </span>
            <span className={`truncate text-xs ${speaking ? "text-ink" : "text-muted"}`}>{name}</span>
            {state.deafened ? (
              <VolumeX size={12} className="ml-auto shrink-0 text-danger" />
            ) : state.muted ? (
              <MicOff size={12} className="ml-auto shrink-0 text-danger" />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Panel fijo mientras estás en una llamada. */
export function VoiceBar() {
  const t = useT();
  const local = useVoiceLocal();
  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const states = useStore((s) => (local.channelId ? (s.voice[local.channelId] ?? EMPTY) : EMPTY));

  if (local.error) {
    return (
      <div className="border-t border-line px-3 py-2">
        <ErrorNote>{local.error === "denied" ? t("voice.denied") : t("voice.noDevice")}</ErrorNote>
      </div>
    );
  }

  if (!local.channelId) return null;
  const channel = data?.channels.find((c) => c.id === local.channelId);

  return (
    <div className="flex flex-col gap-2 border-t border-line bg-raise px-3 py-2.5">
      <div className="flex items-center gap-2">
        <Signal size={16} className="shrink-0 text-ok" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-ok">{t("voice.connected")}</span>
          <span className="block truncate text-xs text-muted">
            {channel?.name} · {data?.community.name}
          </span>
        </span>
        <IconButton label={t("voice.disconnect")} onClick={leaveVoice} className="text-danger hover:bg-danger/10">
          <PhoneOff size={16} />
        </IconButton>
      </div>

      <div className="flex gap-1">
        <button
          onClick={() => setMuted(!local.muted)}
          aria-pressed={local.muted}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.muted ? "btn-danger" : "btn-ghost"}`}
        >
          <Microphone size={14} muted={local.muted} />
          {local.muted ? t("voice.unmute") : t("voice.mute")}
        </button>
        <button
          onClick={() => setDeafened(!local.deafened)}
          aria-pressed={local.deafened}
          className={`btn h-9 min-h-9 flex-1 px-2 text-xs ${local.deafened ? "btn-danger" : "btn-ghost"}`}
        >
          <Headset size={14} muted={local.deafened} />
          {local.deafened ? t("voice.undeafen") : t("voice.deafen")}
        </button>
      </div>

      <p className="text-[0.65rem] text-muted">{t("voice.peerToPeer", { count: Math.max(states.length - 1, 0) })}</p>
    </div>
  );
}

/** Vista principal cuando el canal abierto es de voz: cuadrícula de participantes. */
export function VoiceStage({ channelId }: { channelId: string }) {
  const t = useT();
  const local = useVoiceLocal();
  const communityId = useStore((s) => s.activeCommunityId);
  const data = useStore((s) => (communityId ? s.data[communityId] : undefined));
  const states = useStore((s) => s.voice[channelId] ?? EMPTY);

  if (states.length === 0) {
    return (
      <div className="m-auto flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <Volume2 size={32} className="text-muted" />
        <h3 className="display text-lg font-bold">{t("voice.emptyRoom")}</h3>
        <p className="text-sm text-muted">{t("voice.emptyRoomHint")}</p>
      </div>
    );
  }

  return (
    <div className="grid flex-1 content-center gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
      {states.map((state) => {
        const member = data?.members.find((m) => m.user.id === state.user_id);
        const name = member?.nickname ?? member?.user.display_name ?? "…";
        const speaking = local.speaking.has(state.user_id);

        return (
          <figure
            key={state.user_id}
            className="relative grid aspect-video place-items-center rounded-card border bg-surface transition-colors duration-150"
            style={{ borderColor: speaking ? "var(--ok)" : "var(--line)" }}
          >
            <span
              className="rounded-full transition-shadow duration-150"
              style={{ boxShadow: speaking ? "0 0 0 4px color-mix(in oklab, var(--ok) 45%, transparent)" : "none" }}
            >
              <Avatar name={name} url={member?.user.avatar_url} id={state.user_id} size={72} />
            </span>
            <figcaption className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded-lg bg-bg/80 px-2 py-1 text-xs">
              {state.deafened ? (
                <VolumeX size={12} className="text-danger" />
              ) : state.muted ? (
                <MicOff size={12} className="text-danger" />
              ) : null}
              <span className="max-w-40 truncate font-medium">{name}</span>
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
