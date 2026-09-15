/**
 * "Seguridad del admin" dentro de Tu servidor: activar el autenticador de
 * quien hospeda (claudexcodex/plan-acceso-admin-2026-09-14.md, fase C).
 *
 * Solo aparece si /instance/mfa responde, es decir, a quien hospeda. El
 * asistente tiene tres pasos: instalar la app (QR a la Play Store), escanear
 * el QR de Distop y confirmar con un código real. Al final enseña los 8
 * códigos de respaldo, que no vuelven a salir.
 */
import { useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { api } from "../lib/api.ts";
import { Button, ErrorNote, Field, Spinner, useErrorText, useT } from "./ui.tsx";

const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2";
const APP_STORE = "https://apps.apple.com/app/google-authenticator/id388497605";

interface MfaStatus {
  enabled: boolean;
  recovery_codes_left: number;
}

type Step =
  | { kind: "idle" }
  | { kind: "setup"; secret: string; uri: string }
  | { kind: "codes"; codes: string[] };

/** QR dibujado como SVG a partir de la matriz: sin innerHTML y con fondo blanco para escanear en tema oscuro. */
function Qr({ text, label }: { text: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    return { size: n, path: d };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`-3 -3 ${size + 6} ${size + 6}`} className="h-44 w-44 shrink-0 rounded-[10px]" shapeRendering="crispEdges">
      <rect x={-3} y={-3} width={size + 6} height={size + 6} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function AdminSecurity() {
  const t = useT();
  const errorText = useErrorText();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  function load(): void {
    void api<MfaStatus>("GET", "/api/v1/instance/mfa").then(setStatus).catch(() => setStatus(null));
  }
  useEffect(load, []);

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }

  const startSetup = () =>
    run(async () => {
      const result = await api<{ secret: string; otpauth_uri: string }>("POST", "/api/v1/instance/mfa/setup");
      setCode("");
      setStep({ kind: "setup", secret: result.secret, uri: result.otpauth_uri });
    });

  const confirm = () =>
    run(async () => {
      const result = await api<{ recovery_codes: string[] }>("POST", "/api/v1/instance/mfa/confirm", { code: code.trim() });
      setCode("");
      setCopied(false);
      setStep({ kind: "codes", codes: result.recovery_codes });
    });

  const newCodes = () =>
    run(async () => {
      const result = await api<{ recovery_codes: string[] }>("POST", "/api/v1/instance/mfa/recovery-codes", { code: code.trim() });
      setCode("");
      setCopied(false);
      setStep({ kind: "codes", codes: result.recovery_codes });
    });

  if (!status) return null;

  const box = "flex flex-col gap-3 rounded-[10px] border border-line p-3";
  const codeInput = (label: string) => (
    <Field label={label}>
      {(id) => (
        <input
          id={id}
          className="field font-mono text-lg tracking-[0.3em]"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
        />
      )}
    </Field>
  );

  if (step.kind === "codes") {
    return (
      <section className={box} aria-labelledby="admin-security-title">
        <h3 id="admin-security-title" className="display text-sm font-bold">{t("security.codesTitle")}</h3>
        <p className="text-xs text-muted">{t("security.codesHint")}</p>
        <ul className="grid grid-cols-2 gap-2 font-mono text-sm">
          {step.codes.map((item) => (
            <li key={item} className="rounded-[8px] bg-sunken px-2 py-1.5 text-center tabular-nums">{item}</li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(step.codes.join("\n")).then(() => setCopied(true)).catch(() => {});
            }}
          >
            {copied ? t("security.copied") : t("security.copy")}
          </Button>
          <Button variant="primary" onClick={() => { setStep({ kind: "idle" }); load(); }}>
            {t("security.saved")}
          </Button>
        </div>
      </section>
    );
  }

  if (step.kind === "setup") {
    return (
      <section className={box} aria-labelledby="admin-security-title">
        <h3 id="admin-security-title" className="display text-sm font-bold">{t("security.title")}</h3>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{t("security.step1")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Qr text={PLAY_STORE} label={t("security.android")} />
            <div className="flex min-w-0 flex-col gap-2 text-xs">
              <p className="text-muted">{t("security.step1Hint")}</p>
              <a href={PLAY_STORE} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("security.android")}</a>
              <a href={APP_STORE} target="_blank" rel="noreferrer" className="text-accent hover:underline">{t("security.iphone")}</a>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{t("security.step2")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Qr text={step.uri} label={t("security.step2")} />
            <div className="flex min-w-0 flex-col gap-2 text-xs">
              <p className="text-muted">{t("security.step2Hint")}</p>
              <code className="break-all rounded-[8px] bg-sunken px-2 py-1.5 font-mono text-sm tracking-wider">
                {step.secret.match(/.{1,4}/g)?.join(" ")}
              </code>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-semibold">{t("security.step3")}</p>
          {codeInput(t("auth.mfaCode"))}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || code.length !== 6} onClick={() => void confirm()}>
              {busy ? t("common.loading") : t("security.confirm")}
            </Button>
            <Button onClick={() => { setStep({ kind: "idle" }); setError(null); }}>{t("start.back")}</Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={box} aria-labelledby="admin-security-title">
      <div>
        <h3 id="admin-security-title" className="display text-sm font-bold">{t("security.title")}</h3>
        <p className="text-xs text-muted">
          {status.enabled ? t("security.on", { n: status.recovery_codes_left }) : t("security.hintOff")}
        </p>
      </div>
      {status.enabled ? (
        <>
          {codeInput(t("security.currentCode"))}
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy || code.length !== 6} onClick={() => void newCodes()}>{t("security.newCodes")}</Button>
            <Button disabled={busy} onClick={() => void startSetup()}>{t("security.reconfigure")}</Button>
          </div>
          <p className="text-xs text-muted">{t("security.lostAll")}</p>
        </>
      ) : (
        <>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <div>
            <Button variant="primary" disabled={busy} onClick={() => void startSetup()}>
              {busy ? <Spinner label={t("common.loading")} /> : t("security.enable")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
