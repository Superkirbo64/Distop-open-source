/**
 * Dirección fija mediante Tailscale Funnel.
 *
 * No instala servicios ni ejecuta texto recibido del navegador. Solo detecta
 * el CLI oficial y usa una lista cerrada de argumentos. La instalación y la
 * autorización del tailnet quedan visibles para la persona anfitriona.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { fixedPublicUrl, setFixedPublicUrl, startTunnel, stopTunnel, tunnelAutostart } from "./tunnel.js";
const DOWNLOAD_URL = "https://tailscale.com/download/windows";
const WINDOWS_BIN = "C:\\Program Files\\Tailscale\\tailscale.exe";
function binary() {
    const candidates = process.platform === "win32" ? ["tailscale", WINDOWS_BIN] : ["tailscale"];
    for (const candidate of candidates) {
        if (candidate !== "tailscale" && !existsSync(candidate))
            continue;
        try {
            if (spawnSync(candidate, ["version"], { stdio: "ignore", timeout: 5000, windowsHide: true }).status === 0)
                return candidate;
        }
        catch {
            // Probar la siguiente ubicación conocida.
        }
    }
    return null;
}
function run(bin, args, timeout = 20_000) {
    try {
        const result = spawnSync(bin, args, { encoding: "utf8", timeout, windowsHide: true });
        const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
        return { ok: result.status === 0, output };
    }
    catch (error) {
        return { ok: false, output: error instanceof Error ? error.message : String(error) };
    }
}
function status(bin) {
    const result = run(bin, ["status", "--json"]);
    if (!result.ok)
        return { running: false, url: "", error: result.output };
    try {
        const parsed = JSON.parse(result.output);
        const host = parsed.Self?.DNSName?.replace(/\.$/, "") ?? "";
        return { running: parsed.BackendState === "Running", url: host ? `https://${host}` : "", error: "" };
    }
    catch {
        return { running: false, url: "", error: "Tailscale devolvió un estado que no se pudo leer." };
    }
}
function firstUrl(text) {
    return text.match(/https:\/\/[^\s)\]]+/)?.[0]?.replace(/[.,;]+$/, "") ?? "";
}
export function tailscaleState() {
    const bin = binary();
    if (!bin)
        return { step: 2, state: "missing", url: "", error: "", hint_url: DOWNLOAD_URL };
    const current = status(bin);
    if (!current.running) {
        return { step: 3, state: "login", url: "", error: current.error, hint_url: firstUrl(current.error) };
    }
    if (current.url && fixedPublicUrl() === current.url) {
        return { step: 7, state: "active", url: current.url, error: "", hint_url: "" };
    }
    return { step: 4, state: "ready", url: current.url, error: "", hint_url: "" };
}
/** Avanza el asistente un paso o reintenta el paso actual. */
export function advanceTailscale() {
    const bin = binary();
    if (!bin)
        return tailscaleState();
    const current = status(bin);
    if (!current.running) {
        const login = run(bin, ["up"], 15_000);
        const hint = firstUrl(login.output);
        const after = status(bin);
        if (!after.running) {
            return { step: 3, state: login.ok ? "login" : "error", url: "", error: login.output, hint_url: hint };
        }
    }
    const live = status(bin);
    if (!live.running || !live.url) {
        return { step: 3, state: "error", url: "", error: live.error || "Tailscale todavía no está conectado.", hint_url: "" };
    }
    /* --yes confirma la publicación local sin pedir una terminal interactiva.
       La autorización sensible del tailnet sigue ocurriendo en la página HTTPS
       que devuelve Tailscale la primera vez. */
    const funnel = run(bin, ["funnel", "--bg", "--yes", String(config.port)], 30_000);
    if (!funnel.ok) {
        return { step: 4, state: "error", url: live.url, error: funnel.output || "No se pudo activar Funnel.", hint_url: firstUrl(funnel.output) };
    }
    setFixedPublicUrl(live.url);
    stopTunnel();
    return { step: 7, state: "active", url: live.url, error: "", hint_url: "" };
}
export function stopTailscale() {
    const bin = binary();
    if (bin)
        run(bin, ["funnel", "reset"]);
    if (fixedPublicUrl().endsWith(".ts.net"))
        setFixedPublicUrl("");
    if (tunnelAutostart() && !config.publicUrl)
        void startTunnel();
    return tailscaleState();
}
/** Funnel --bg suele sobrevivir; al arrancar se repara si quedó apagado. */
export function restoreTailscale() {
    const fixed = fixedPublicUrl();
    if (!fixed.endsWith(".ts.net"))
        return;
    const bin = binary();
    if (!bin)
        return;
    const current = status(bin);
    if (current.running)
        run(bin, ["funnel", "--bg", "--yes", String(config.port)], 30_000);
}
