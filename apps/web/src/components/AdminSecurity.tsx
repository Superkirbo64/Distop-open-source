/**
 * "Seguridad del admin" dentro de Tu servidor: activar el autenticador de
 * quien hospeda (claudexcodex/plan-acceso-admin-2026-09-14.md, fase C).
 *
 * Solo aparece en VPS y solo a quien hospeda. El asistente tiene tres pasos:
 * instalar Google Authenticator (dos QR, Android e iPhone, lado a lado),
 * escanear el QR de Distop y confirmar con un código real. Sin códigos de
 * respaldo (Kirbo, 14-09): si se pierde el teléfono, la salida es SSH.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { api } from "../lib/api.ts";
import { Button, ErrorNote, Field, Spinner, useErrorText, useT } from "./ui.tsx";

const PLAY_STORE = "https://play.google.com/store/apps/details?id=com.google.android.apps.authenticator2";
const APP_STORE = "https://apps.apple.com/app/google-authenticator/id388497605";

/* Logos de theSVG (https://thesvg.org, código MIT). Son marcas de sus dueños:
   se usan solo para señalar dónde descargar la app, que es para lo que las
   tiendas los ofrecen. Van en línea y no se piden a thesvg.org al abrir. */
function GoogleAuthenticatorLogo() {
  return (
    <svg viewBox="0 0 24 24" fill="#4285F4" aria-hidden="true" className="h-5 w-5 shrink-0">
      <path d="M6.957 1.3379A2.0133 2.0133 0 0 0 6 1.6074c-.967.5583-1.2985 1.7947-.7402 2.7617L8.498 9.9785H2.0215C.9049 9.9785 0 10.8835 0 12c0 1.1166.905 2.0215 2.0215 2.0215H8.498l-3.2382 5.6094c-.5583.967-.2268 2.2034.7402 2.7617.967.5582 2.2034.2267 2.7617-.7403L12 16.045l3.2383 5.6074c.5583.967 1.7947 1.2985 2.7617.7403.967-.5583 1.2985-1.7947.7402-2.7617l-3.2382-5.6094h6.4765C23.0951 14.0215 24 13.1165 24 12c0-1.1166-.905-2.0215-2.0215-2.0215H15.502l3.2382-5.6094c.5583-.967.2268-2.2034-.7402-2.7617-.967-.5582-2.2034-.2267-2.7617.7403L12 7.955 8.7617 2.3477C8.378 1.6829 7.674 1.3193 6.957 1.3379Zm9.959 1.0058c.1932-.0127.3928.0317.5781.1387.4944.2854.6565.8866.3711 1.3809l-4.1132 7.125h8.2265c.5709 0 1.0117.4408 1.0117 1.0117s-.4408 1.0117-1.0117 1.0117H14.92l-1.168-2.0234-1.168-2.0235 3.5294-6.1113c.1783-.3089.4808-.4885.8027-.5098zm-9.9336.004c.3587-.0093.7081.166.9043.5058l3.5293 6.1113-1.168 2.0235-1.168 2.0234H2.0216c-.5709 0-1.0117-.4408-1.0117-1.0117s.4408-1.0117 1.0117-1.0117h8.2265l-4.1132-7.125c-.2854-.4943-.1233-1.0955.371-1.3809a.9891.9891 0 0 1 .4766-.1347ZM9.666 14.0215h4.668l3.5312 6.1152c.2854.4943.1233 1.0955-.371 1.3809-.4942.2852-1.0956.1231-1.381-.3711L12 14.0254l-4.1133 7.121c-.2853.4943-.8867.6564-1.3808.3712-.4944-.2854-.6565-.8866-.3711-1.3809Z" />
    </svg>
  );
}

function GooglePlayLogo() {
  return (
    <svg viewBox="0 0 466 511.98" aria-hidden="true" className="h-6 w-6 shrink-0">
      <path fill="#EA4335" d="M199.9 237.8 1.4 470.17c7.22 24.57 30.16 41.81 55.8 41.81 11.16 0 20.93-2.79 29.3-8.37l244.16-139.46L199.9 237.8z" />
      <path fill="#FBBC04" d="m433.91 205.1-104.65-60-111.61 110.22 113.01 108.83 104.64-58.6c18.14-9.77 30.7-29.3 30.7-50.23-1.4-20.93-13.95-40.46-32.09-50.22z" />
      <path fill="#34A853" d="M199.42 273.45 329.27 145.1 87.9 8.37C79.53 2.79 68.36 0 57.2 0 30.7 0 6.98 18.14 1.4 41.86l198.02 231.59z" />
      <path fill="#4285F4" d="M1.39 41.86C0 46.04 0 51.63 0 57.2v397.64c0 5.57 0 9.76 1.4 15.34l216.27-214.86L1.39 41.86z" />
    </svg>
  );
}

function AppStoreLogo() {
  return (
    <svg viewBox="0 0 800 800" aria-hidden="true" className="h-6 w-6 shrink-0">
      <linearGradient id="app-store-logo" x1="400.05" x2="400.05" y1="798.772" y2="-1.228" gradientTransform="matrix(1 0 0 -1 0 798.772)" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#18bffb" />
        <stop offset="1" stopColor="#2072f3" />
      </linearGradient>
      <path fill="url(#app-store-logo)" d="M638.4 0H161.6C72.3 0 0 72.3 0 161.6v476.9C0 727.7 72.3 800 161.6 800h476.9c89.2 0 161.6-72.3 161.6-161.6V161.6C800 72.3 727.7 0 638.4 0z" />
      <path fill="#FFF" d="m396.6 183.8 16.2-28c10-17.5 32.3-23.4 49.8-13.4s23.4 32.3 13.4 49.8L319.9 462.4h112.9c36.6 0 57.1 43 41.2 72.8H143c-20.2 0-36.4-16.2-36.4-36.4s16.2-36.4 36.4-36.4h92.8l118.8-205.9-37.1-64.4c-10-17.5-4.1-39.6 13.4-49.8 17.5-10 39.6-4.1 49.8 13.4l15.9 28.1zM256.2 572.7l-35 60.7c-10 17.5-32.3 23.4-49.8 13.4S148 614.5 158 597l26-45c29.4-9.1 53.3-2.1 72.2 20.7zm301.4-110.1h94.7c20.2 0 36.4 16.2 36.4 36.4s-16.2 36.4-36.4 36.4h-52.6l35.5 61.6c10 17.5 4.1 39.6-13.4 49.8-17.5 10-39.6 4.1-49.8-13.4-59.8-103.7-104.7-181.3-134.5-233-30.5-52.6-8.7-105.4 12.8-123.3 23.9 41 59.6 102.9 107.3 185.5z" />
    </svg>
  );
}

interface MfaStatus {
  /** Solo en VPS: en el PC quien arranca el servidor ya es quien lo administra. */
  available: boolean;
  enabled: boolean;
}

type Step = { kind: "idle" } | { kind: "setup"; secret: string; uri: string };

/** QR dibujado como SVG a partir de la matriz: sin innerHTML y con fondo blanco para escanear en tema oscuro. */
function Qr({ text, label, size = "h-44 w-44" }: { text: string; label: string; size?: string }) {
  const { modules, path } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = "";
    for (let row = 0; row < n; row++) for (let col = 0; col < n; col++) if (qr.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
    return { modules: n, path: d };
  }, [text]);
  return (
    <svg role="img" aria-label={label} viewBox={`-3 -3 ${modules + 6} ${modules + 6}`} className={`${size} shrink-0 rounded-[10px]`} shapeRendering="crispEdges">
      <rect x={-3} y={-3} width={modules + 6} height={modules + 6} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** Una tienda: su icono, su nombre y el QR que lleva a Google Authenticator en ella. */
function StoreQr({ href, logo, name }: { href: string; logo: ReactNode; name: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="flex flex-col items-center gap-2 rounded-[10px] border border-line p-3 hover:border-accent">
      <span className="flex items-center gap-2 text-sm font-semibold">
        {logo}
        {name}
      </span>
      <Qr text={href} label={name} size="h-36 w-36" />
    </a>
  );
}

export function AdminSecurity() {
  const t = useT();
  const errorText = useErrorText();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [showStores, setShowStores] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
      setShowStores(false);
      setStep({ kind: "setup", secret: result.secret, uri: result.otpauth_uri });
    });

  const confirm = () =>
    run(async () => {
      await api("POST", "/api/v1/instance/mfa/confirm", { code: code.trim() });
      setCode("");
      setStep({ kind: "idle" });
      load();
    });

  // Un autenticador ya activo se sigue enseñando aunque el tipo cambie, para saber que está.
  if (!status || (!status.available && !status.enabled)) return null;

  const box = "flex flex-col gap-3 rounded-[10px] border border-line p-3";

  if (step.kind === "setup") {
    return (
      <section className={box} aria-labelledby="admin-security-title">
        <h3 id="admin-security-title" className="display text-sm font-bold">{t("security.title")}</h3>

        <div className="flex flex-col gap-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <GoogleAuthenticatorLogo />
            {t("security.step1")}
          </p>
          <div>
            <Button onClick={() => setShowStores((open) => !open)} aria-expanded={showStores}>
              {t("security.download")}
            </Button>
          </div>
          {showStores ? (
            <>
              <p className="text-xs text-muted">{t("security.downloadHint")}</p>
              <div className="grid grid-cols-2 gap-3">
                <StoreQr href={PLAY_STORE} logo={<GooglePlayLogo />} name={t("security.android")} />
                <StoreQr href={APP_STORE} logo={<AppStoreLogo />} name={t("security.iphone")} />
              </div>
            </>
          ) : null}
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
          <Field label={t("auth.mfaCode")}>
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
        <p className="text-xs text-muted">{status.enabled ? t("security.on") : t("security.hintOff")}</p>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {status.enabled ? (
        <>
          {/* Un QR nuevo solo se puede pedir en VPS: fuera de ahí el botón solo daría un error. */}
          {status.available ? (
            <div>
              <Button disabled={busy} onClick={() => void startSetup()}>{t("security.reconfigure")}</Button>
            </div>
          ) : null}
          <p className="text-xs text-muted">{t("security.lostAll")}</p>
        </>
      ) : (
        <div>
          <Button variant="primary" disabled={busy} onClick={() => void startSetup()}>
            {busy ? <Spinner label={t("common.loading")} /> : t("security.enable")}
          </Button>
        </div>
      )}
    </section>
  );
}
