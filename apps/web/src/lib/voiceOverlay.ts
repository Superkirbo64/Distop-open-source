import { onVoice, type VoiceLocalState } from "./voice.ts";
import { useStore } from "../store.ts";

let local: VoiceLocalState | null = null;
/** Último payload enviado, serializado. En reposo vale "off" y publish() sale
    en dos comparaciones: sin walk del estado ni IPC por cada setState. */
let lastSent = "off";

function publish(): void {
  const bridge = window.distop?.overlay;
  if (!bridge) return;

  const channelId = local?.channelId ?? null;
  if (!channelId) {
    if (lastSent === "off") return;
    lastSent = "off";
    bridge.update({ channelId: null, channelName: "", participants: [] });
    return;
  }

  const snapshot = useStore.getState();
  const community = Object.values(snapshot.data).find((item) =>
    item.channels.some((channel) => channel.id === channelId),
  );
  const channel = community?.channels.find((item) => item.id === channelId);
  const states = snapshot.voice[channelId] ?? [];

  const payload = {
    channelId,
    channelName: channel?.name ?? "Sala de voz",
    participants: states.map((state) => {
      const member = community?.members.find((item) => item.user.id === state.user_id);
      return {
        id: state.user_id,
        name: member?.nickname ?? member?.user.display_name ?? "…",
        avatarUrl: member?.user.avatar_url ?? null,
        speaking: local?.speaking.has(state.user_id) ?? false,
        muted: state.muted || state.force_muted,
      };
    }),
  };

  // Solo cruza el IPC lo que cambió: el resto de setState del store no viaja.
  const encoded = JSON.stringify(payload);
  if (encoded === lastSent) return;
  lastSent = encoded;
  bridge.update(payload);
}

/** Mantiene el proceso de escritorio al día sin acoplar el overlay a React. */
export function watchVoiceOverlay(): void {
  if (!window.distop?.overlay) return;
  onVoice((state) => {
    local = state;
    publish();
  });
  useStore.subscribe(publish);
}
