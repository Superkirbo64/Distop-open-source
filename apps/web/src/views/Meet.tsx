/**
 * Entrar a una reunión por enlace, sin cuenta y sin instalar nada (V2).
 *
 * Esta es la ventaja real frente a las herramientas de siempre, y depende de
 * dos cosas que no se pueden aflojar:
 *
 * - **El token va en el cuerpo, no en la ruta.** La dirección `/meet/<token>`
 *   solo vive en el navegador de quien la recibió; en cuanto se pide algo al
 *   servidor, el token viaja en el cuerpo de un POST. Una ruta acabaría en los
 *   registros de cualquier proxy intermedio y en la cabecera `Referer` de la
 *   siguiente petición, y el §22 dice que los tokens no se registran.
 * - **La sesión que se recibe sirve para una reunión y para nada más.** No es
 *   una cuenta recortada: es una sesión acotada que la instancia rechaza fuera
 *   de esa reunión. Aquí se dice tal cual, sin adornarlo.
 */
import { useEffect, useState } from "react";
import { CalendarClock, Phone, PhoneOff } from "lucide-react";
import type { Meeting, SelfUser } from "@distop/protocol";
import { BRAND } from "../brand.ts";
import { api, setTokens } from "../lib/api.ts";
import { connect } from "../lib/gateway.ts";
import { joinVoice, leaveVoice } from "../lib/voice.ts";
import { useStore } from "../store.ts";
import { MeetingPanel } from "../components/Meeting.tsx";
import { StageLayoutPicker, VoiceStage, useVoiceLocal } from "../components/Voice.tsx";
import { Button, ErrorNote, Field, useErrorText, useT } from "../components/ui.tsx";

interface GuestSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: SelfUser;
  meeting: Meeting;
}

export function Meet({ token, onEnter }: { token: string; onEnter: (meeting: Meeting) => void }) {
  const t = useT();
  const errorText = useErrorText();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  /* La dirección se limpia en cuanto se monta la pantalla: dejar el token en la
     barra invita a compartir la captura, y el historial del navegador lo guarda
     tal cual. El valor ya está en memoria; la URL no hace falta para nada. */
  useEffect(() => {
    history.replaceState(null, "", "/");
  }, []);

  const entrar = async () => {
    setOcupado(true);
    setError(null);
    try {
      const sesion = await api<GuestSession>("POST", "/api/v1/meetings/guest", {
        token,
        display_name: name.trim(),
      });
      setTokens({ access_token: sesion.access_token, refresh_token: sesion.refresh_token });
      useStore.setState({
        user: sesion.user,
        guestMeeting: sesion.meeting,
        meetings: { ...useStore.getState().meetings, [sesion.meeting.channel_id]: sesion.meeting },
      });
      connect();
      onEnter(sesion.meeting);
    } catch (fallo) {
      setError(errorText(fallo));
    } finally {
      setOcupado(false);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-bg p-6">
      <div className="w-full max-w-sm">
        <p className="display mb-1 text-center text-lg font-bold">{BRAND.name}</p>
        <div className="rounded-[14px] border border-line bg-surface p-5">
          <h1 className="display mb-1 flex items-center gap-2 text-base font-bold">
            <CalendarClock size={18} className="shrink-0 text-muted" />
            {t("meeting.guestTitle")}
          </h1>
          <p className="mb-4 text-sm text-muted">{t("meeting.guestScoped")}</p>

          {error ? <ErrorNote>{error}</ErrorNote> : null}

          <Field label={t("meeting.guestName")}>
            {(id) => (
              <input
                id={id}
                className="field w-full"
                value={name}
                maxLength={32}
                autoFocus
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && name.trim()) void entrar();
                }}
              />
            )}
          </Field>

          <Button
            variant="primary"
            className="mt-3 w-full"
            disabled={ocupado || !name.trim()}
            onClick={() => void entrar()}
          >
            {t("meeting.guestEnter")}
          </Button>
        </div>
      </div>
    </main>
  );
}

/**
 * La reunión, para quien entró por enlace.
 *
 * Sin barra de comunidades, sin canales y sin ajustes: no es que se escondan,
 * es que la instancia rechaza esas rutas para esta sesión, y enseñar una
 * aplicación entera cuyos botones devuelven 403 sería la trampa de siempre.
 */
export function GuestMeeting({ meeting }: { meeting: Meeting }) {
  const t = useT();
  const local = useVoiceLocal();
  const reunion = useStore((s) => s.meetings[meeting.channel_id]) ?? meeting;
  const dentro = local.channelId === meeting.channel_id;

  /* Salir del todo es cerrar la sesión acotada: no hay ningún otro sitio al que
     ir con ella, así que dejarla viva solo serviría para que caducara sola. */
  const salir = () => {
    leaveVoice();
    void useStore.getState().logout();
  };

  return (
    <div className="flex h-dvh flex-col bg-bg">
      <header className="flex h-[var(--header-h)] shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
        <CalendarClock size={18} className="shrink-0 text-muted" />
        <h1 className="display truncate text-[0.95rem] font-bold">{reunion.title}</h1>
        <span className="flex-1" />
        <StageLayoutPicker />
        <Button variant="ghost" onClick={salir}>
          {t("meeting.guestLeave")}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col wide:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <VoiceStage channelId={reunion.channel_id} mode="meeting" />
        </div>
        <div className="flex min-h-0 shrink-0 flex-col border-line wide:w-[22rem] wide:border-l">
          <MeetingPanel channelId={reunion.channel_id} communityId={null} />
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line bg-surface p-2">
        {dentro ? (
          <Button variant="danger" onClick={() => leaveVoice()}>
            <PhoneOff size={15} /> {t("voice.disconnect")}
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void joinVoice(reunion.channel_id)}>
            <Phone size={15} /> {t("voice.join")}
          </Button>
        )}
      </div>
    </div>
  );
}
