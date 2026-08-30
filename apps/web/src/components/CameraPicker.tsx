/**
 * Elegir qué cámara se usa (§9.5).
 *
 * El aparato es de este equipo, no de la cuenta: quien entra desde el móvil
 * quiere la trasera y desde el portátil la webcam de fuera, y esa decisión no
 * tiene por qué viajar a la instancia. Por eso vive en `voice.ts` sobre
 * `localStorage` y aquí solo se pinta.
 *
 * El botón va en la llamada y no solo en Ajustes porque quien entra por enlace
 * a una reunión no tiene Ajustes —su sesión acotada no llega ahí— y porque en
 * el móvil cambiar de cámara es algo que se hace a mitad de llamada.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, SwitchCamera } from "lucide-react";
import { IconButton, Menu, useT } from "./ui.tsx";
import { setVideoDevice, videoDevice } from "../lib/voice.ts";

/**
 * Las cámaras del equipo, al día.
 *
 * Sin permiso concedido el navegador entrega los aparatos sin nombre: se puede
 * elegir a ciegas, y en cuanto la cámara se enciende una vez los nombres
 * aparecen solos por el evento `devicechange`.
 */
export function useCameras(): MediaDeviceInfo[] {
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  const list = useCallback(async () => {
    if (!media) return;
    const all = await media.enumerateDevices();
    setCameras(all.filter((device) => device.kind === "videoinput" && device.deviceId));
  }, [media]);

  useEffect(() => {
    void list();
    media?.addEventListener("devicechange", list);
    return () => media?.removeEventListener("devicechange", list);
  }, [list, media]);

  return cameras;
}

/**
 * El botón de la llamada.
 *
 * Con una sola cámara no hay nada que elegir: el botón no aparece, en vez de
 * abrir un menú de un solo elemento.
 */
export function CameraPickerButton({ label = false }: { label?: boolean }) {
  const t = useT();
  const cameras = useCameras();
  const [chosen, setChosen] = useState(videoDevice);

  if (cameras.length < 2) return null;

  const options = [
    { id: "", name: t("voice.deviceDefault") },
    ...cameras.map((device, index) => ({
      id: device.deviceId,
      name: device.label || t("voice.cameraUnnamed", { n: index + 1 }),
    })),
  ];

  return (
    <Menu
      floating
      trigger={(props) =>
        label ? (
          <button {...props} className="btn btn-ghost rounded-full border-transparent px-3 text-xs">
            <SwitchCamera size={15} />
            {t("voice.cameraPick")}
          </button>
        ) : (
          <IconButton {...props} label={t("voice.cameraPick")}>
            <SwitchCamera size={17} />
          </IconButton>
        )
      }
    >
      {(close) => (
        <div className="w-[13.75rem] max-w-[calc(100vw-1rem)] p-1" role="menu" aria-label={t("voice.cameraPick")}>
          {options.map((option) => (
            <button
              key={option.id}
              role="menuitemradio"
              aria-checked={chosen === option.id}
              className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-xs transition-colors ${
                chosen === option.id ? "bg-accent-soft text-accent" : "hover:bg-raise"
              }`}
              onClick={() => {
                setChosen(option.id);
                void setVideoDevice(option.id);
                close();
              }}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{option.name}</span>
              {chosen === option.id ? <Check size={15} className="shrink-0" /> : null}
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}
