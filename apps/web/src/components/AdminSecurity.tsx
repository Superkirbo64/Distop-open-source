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

/* Logos de theSVG (https://thesvg.org, código MIT). Son marcas de Google: se
   usan solo para señalar dónde descargar la app, que es para lo que Google los
   ofrece. Van en línea y no se piden a thesvg.org al abrir la pantalla. */
function GoogleAuthenticatorLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="#4285F4" aria-hidden="true" className="h-5 w-5 shrink-0">
      <path d="M6.957 1.3379A2.0133 2.0133 0 0 0 6 1.6074c-.967.5583-1.2985 1.7947-.7402 2.7617L8.498 9.9785H2.0215C.9049 9.9785 0 10.8835 0 12c0 1.1166.905 2.0215 2.0215 2.0215H8.498l-3.2382 5.6094c-.5583.967-.2268 2.2034.7402 2.7617.967.5582 2.2034.2267 2.7617-.7403L12 16.045l3.2383 5.6074c.5583.967 1.7947 1.2985 2.7617.7403.967-.5583 1.2985-1.7947.7402-2.7617l-3.2382-5.6094h6.4765C23.0951 14.0215 24 13.1165 24 12c0-1.1166-.905-2.0215-2.0215-2.0215H15.502l3.2382-5.6094c.5583-.967.2268-2.2034-.7402-2.7617-.967-.5582-2.2034-.2267-2.7617.7403L12 7.955 8.7617 2.3477C8.378 1.6829 7.674 1.3193 6.957 1.3379Zm9.959 1.0058c.1932-.0127.3928.0317.5781.1387.4944.2854.6565.8866.3711 1.3809l-4.1132 7.125h8.2265c.5709 0 1.0117.4408 1.0117 1.0117s-.4408 1.0117-1.0117 1.0117H14.92l-1.168-2.0234-1.168-2.0235 3.5294-6.1113c.1783-.3089.4808-.4885.8027-.5098zm-9.9336.004c.3587-.0093.7081.166.9043.5058l3.5293 6.1113-1.168 2.0235-1.168 2.0234H2.0216c-.5709 0-1.0117-.4408-1.0117-1.0117s.4408-1.0117 1.0117-1.0117h8.2265l-4.1132-7.125c-.2854-.4943-.1233-1.0955.371-1.3809a.9891.9891 0 0 1 .4766-.1347ZM9.666 14.0215h4.668l3.5312 6.1152c.2854.4943.1233 1.0955-.371 1.3809-.4942.2852-1.0956.1231-1.381-.3711L12 14.0254l-4.1133 7.121c-.2853.4943-.8867.6564-1.3808.3712-.4944-.2854-.6565-.8866-.3711-1.3809Z" />
    </svg>
  );
}

function GooglePlayLogo() {
  return (
    <svg viewBox="0 0 466 511.98" aria-hidden="true" className="h-5 w-5 shrink-0">
      <path fill="#EA4335" d="M199.9 237.8 1.4 470.17c7.22 24.57 30.16 41.81 55.8 41.81 11.16 0 20.93-2.79 29.3-8.37l244.16-139.46L199.9 237.8z" />
      <path fill="#FBBC04" d="m433.91 205.1-104.65-60-111.61 110.22 113.01 108.83 104.64-58.6c18.14-9.77 30.7-29.3 30.7-50.23-1.4-20.93-13.95-40.46-32.09-50.22z" />
      <path fill="#34A853" d="M199.42 273.45 329.27 145.1 87.9 8.37C79.53 2.79 68.36 0 57.2 0 30.7 0 6.98 18.14 1.4 41.86l198.02 231.59z" />
      <path fill="#4285F4" d="M1.39 41.86C0 46.04 0 51.63 0 57.2v397.64c0 5.57 0 9.76 1.4 15.34l216.27-214.86L1.39 41.86z" />
    </svg>
  );
}

interface MfaStatus {
  /** Solo en VPS: en el PC quien arranca el servidor ya es quien lo administra. */
  available: boolean;
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

  // Un autenticador ya activo se sigue enseñando aunque el tipo cambie, para poder gestionarlo.
  if (!status || (!status.available && !status.enabled)) return null;

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
              <p className="flex items-center gap-2 text-muted">
                <GoogleAuthenticatorLogo />
                {t("security.step1Hint")}
              </p>
              <a href={PLAY_STORE} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-accent hover:underline">
                <GooglePlayLogo />
                {t("security.android")}
              </a>
              <a href={APP_STORE} target="_blank" rel="noreferrer" className="flex items-center gap-2 text-accent hover:underline">
                <GoogleAuthenticatorLogo />
                {t("security.iphone")}
              </a>
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
            {/* Un QR nuevo solo se puede pedir en VPS: fuera de ahí el botón solo daría un error. */}
            {status.available ? (
              <Button disabled={busy} onClick={() => void startSetup()}>{t("security.reconfigure")}</Button>
            ) : null}
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
