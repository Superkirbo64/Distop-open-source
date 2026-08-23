import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Gear } from "./icons.tsx";
import { useT } from "./ui.tsx";
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

  return (
    <div className="w-[13.75rem] max-w-[calc(100vw-1rem)] p-2">
      <QuickSelect
        label={deviceLabel}
        value={device}
        display={currentDevice}
        disabled={!media || (kind === "output" && !audio.canPickOutput())}
        onChange={(value) => {
          setDevice(value);
          if (kind === "input") void setInputDevice(value);
          else void audio.setOutputDevice(value);
        }}
      >
        <option value="">{t("voice.deviceDefault")}</option>
        {devices
          .filter((item) => item.deviceId !== "default")
          .map((item, index) => (
            <option key={item.deviceId} value={item.deviceId}>
              {item.label || t(kind === "input" ? "voice.deviceUnnamed" : "voice.deviceUnnamedOut", { n: index + 1 })}
            </option>
          ))}
      </QuickSelect>

      {kind === "input" ? (
        <QuickSelect
          label={t("voice.inputProfile")}
          value={profile}
          display={t(`voice.inputProfile.${profile}`)}
          onChange={(value) => {
            const next = value as InputProfile;
            setProfile(next);
            void setInputProfile(next);
          }}
        >
          <option value="custom">{t("voice.inputProfile.custom")}</option>
          <option value="clear">{t("voice.inputProfile.clear")}</option>
          <option value="natural">{t("voice.inputProfile.natural")}</option>
        </QuickSelect>
      ) : null}

      <label className="block px-2 pb-3 pt-2">
        <span className="mb-2 block text-xs font-semibold text-ink">{volumeLabel}</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(volume * 100)}
          aria-label={volumeLabel}
          title={`${Math.round(volume * 100)}%`}
          className="quick-audio-range w-full"
          style={{ "--audio-progress": `${volume * 50}%` } as React.CSSProperties}
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
  value,
  display,
  disabled = false,
  onChange,
  children,
}: {
  label: string;
  value: string;
  display: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className={`relative flex items-center gap-2 rounded-[10px] px-2 py-2 ${disabled ? "opacity-55" : "hover:bg-raise"}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-semibold text-ink">{label}</span>
        <span className="block truncate text-[0.7rem] text-muted">{display}</span>
      </span>
      <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden />
      <select
        aria-label={label}
        className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
    </label>
  );
}
