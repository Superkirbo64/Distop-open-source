import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronRight } from "lucide-react";
import { Gear } from "./icons.tsx";
import { Range, useT, type SelectOption } from "./ui.tsx";
import {
  inputDevice,
  inputProfile,
  setInputDevice,
  setInputProfile,
  type InputProfile,
} from "../lib/voice.ts";
import * as audio from "../lib/relay.ts";

type Kind = "input" | "output";

/**
 * Menú rápido de los botones de micrófono y auriculares.
 * Los ajustes son locales a este equipo y se aplican en caliente a la llamada.
 */
export function AudioQuickMenu({
  kind,
  close,
  onOpenSettings,
}: {
  kind: Kind;
  close: () => void;
  onOpenSettings: () => void;
}) {
  const t = useT();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [device, setDevice] = useState(kind === "input" ? inputDevice() : audio.outputDevice());
  const [profile, setProfile] = useState<InputProfile>(inputProfile());
  const [volume, setVolume] = useState(kind === "input" ? audio.micVolume() : audio.outputVolume());
  const [page, setPage] = useState<"device" | "profile" | null>(null);
  const media = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  const refreshDevices = useCallback(async () => {
    if (!media) return;
    const all = await media.enumerateDevices();
    setDevices(all.filter((item) => item.kind === (kind === "input" ? "audioinput" : "audiooutput")));
  }, [kind, media]);

  useEffect(() => {
    void refreshDevices();
    media?.addEventListener("devicechange", refreshDevices);
    return () => media?.removeEventListener("devicechange", refreshDevices);
  }, [media, refreshDevices]);

  const currentDevice = useMemo(() => {
    const selected = devices.find((item) => item.deviceId === device);
    const system = devices.find((item) => item.deviceId === "default");
    return selected?.label || (!device ? system?.label : "") || t("voice.deviceDefault");
  }, [device, devices, t]);

  const deviceLabel = kind === "input" ? t("voice.inputDevice") : t("voice.outputDevice");
  const volumeLabel = kind === "input" ? t("voice.inputVolume") : t("voice.outputVolume");
  const deviceOptions: SelectOption[] = [
    { value: "", label: t("voice.deviceDefault") },
    ...devices
      .filter((item) => item.deviceId && item.deviceId !== "default")
      .map((item, index) => ({
        value: item.deviceId,
        label: item.label || t(kind === "input" ? "voice.deviceUnnamed" : "voice.deviceUnnamedOut", { n: index + 1 }),
      })),
  ];
  const profileOptions: SelectOption[] = [
    { value: "custom", label: t("voice.inputProfile.custom") },
    { value: "clear", label: t("voice.inputProfile.clear") },
    { value: "natural", label: t("voice.inputProfile.natural") },
  ];

  if (page) {
    const options = page === "device" ? deviceOptions : profileOptions;
    const selected = page === "device" ? device : profile;
    return (
      <div className="w-[13.75rem] max-w-[calc(100vw-1rem)] p-2">
        <button
          className="mb-1 flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left hover:bg-raise"
          onClick={() => setPage(null)}
        >
          <ArrowLeft size={16} className="text-muted" />
          <span className="text-xs font-bold">{page === "device" ? deviceLabel : t("voice.inputProfile")}</span>
        </button>
        <div className="max-h-64 overflow-y-auto">
          {options.map((option) => (
            <button
              key={option.value}
              role="menuitemradio"
              aria-checked={selected === option.value}
              className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-xs transition-colors ${
                selected === option.value ? "bg-accent-soft text-accent" : "hover:bg-raise"
              }`}
              onClick={() => {
                if (page === "device") {
                  setDevice(option.value);
                  if (kind === "input") void setInputDevice(option.value);
                  else void audio.setOutputDevice(option.value);
                } else {
                  const next = option.value as InputProfile;
                  setProfile(next);
                  void setInputProfile(next);
                }
                setPage(null);
              }}
            >
              <span className="min-w-0 flex-1 truncate font-medium">{option.label}</span>
              {selected === option.value ? <Check size={15} className="shrink-0" /> : null}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="w-[13.75rem] max-w-[calc(100vw-1rem)] p-2">
      <QuickSelect
        label={deviceLabel}
        display={currentDevice}
        disabled={!media || (kind === "output" && !audio.canPickOutput())}
        onOpen={() => setPage("device")}
      />

      {kind === "input" ? (
        <QuickSelect
          label={t("voice.inputProfile")}
          display={t(`voice.inputProfile.${profile}`)}
          onOpen={() => setPage("profile")}
        />
      ) : null}

      <label className="block px-2 pb-3 pt-2">
        <span className="mb-2 block text-xs font-semibold text-ink">{volumeLabel}</span>
        <Range
          min={0}
          max={200}
          step={5}
          value={Math.round(volume * 100)}
          aria-label={volumeLabel}
          title={`${Math.round(volume * 100)}%`}
          className="w-full"
          onChange={(event) => {
            const next = Number(event.target.value) / 100;
            setVolume(next);
            if (kind === "input") audio.setMicVolume(next);
            else audio.setOutputVolume(next);
          }}
        />
      </label>

      <div className="border-t border-line pt-1">
        <button
          role="menuitem"
          className="flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left text-sm font-semibold hover:bg-raise"
          onClick={() => {
            close();
            onOpenSettings();
          }}
        >
          <Gear size={17} className="text-muted" />
          {t("voice.openSettings")}
        </button>
      </div>
    </div>
  );
}

function QuickSelect({
  label,
  display,
  disabled = false,
  onOpen,
}: {
  label: string;
  display: string;
  disabled?: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex w-full items-center gap-2 rounded-[10px] px-2 py-2 text-left transition-colors ${
        disabled ? "cursor-not-allowed opacity-55" : "hover:bg-raise"
      }`}
      onClick={onOpen}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[0.7rem] text-muted">{display}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
    </button>
  );
}
