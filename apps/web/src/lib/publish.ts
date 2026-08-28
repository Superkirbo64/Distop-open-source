/**
 * Qué carril de publicación describe el estado real de la instancia (§6).
 *
 * "Compartir tu comunidad" ofrece tres caminos: el túnel de Cloudflare, la
 * dirección fija de Tailscale Funnel y la máquina siempre encendida en la nube
 * (docs/nube-oracle.md). La detección vive aquí, pura y sin React, porque es
 * una regla sobre datos —el estado del túnel— y las reglas se prueban con
 * node:test, no pulsando botones.
 */

export type PublishLane = "cloudflare" | "tailscale" | "cloud-fixed" | "cloud-offer";

/** Lo mínimo del estado del túnel que hace falta para decidir el carril. */
export interface TunnelSnapshot {
  status: "off" | "starting" | "on" | "error";
  /** Túnel vivo o, si existe, PUBLIC_URL configurada por el anfitrión. */
  public_url: string;
  /** Dirección fija de Tailscale, si Funnel está activo. */
  fixed_url?: string | undefined;
}

/**
 * URL del stack de Oracle para el botón "Desplegar en Oracle Cloud".
 *
 * Es `null` a propósito y el botón no se pinta mientras lo sea:
 * docs/nube-oracle.md prohíbe apuntar un botón de deploy a `main`, porque lo
 * que se despliega tiene que ser un artefacto versionado con checksum. Cuando
 * el job `oci-stack` de release.yml publique el zip en una release concreta,
 * aquí irá la URL de ESA release — nunca un enlace que cambie por debajo de
 * quien ya desplegó.
 */
export const ORACLE_STACK_URL: string | null = null;

/** Guía paso a paso del despliegue en Oracle Cloud Always Free. */
export const CLOUD_GUIDE_URL =
  "https://github.com/Superkirbo64/Distop-open-source/blob/main/docs/nube-oracle.md";

/**
 * El carril detectable a partir del túnel. `cloud-offer` no sale de aquí:
 * ofrecer la nube es una elección de quien mira, no un estado de la instancia.
 *
 * - `fixed_url` acabada en `.ts.net` → Tailscale Funnel está puesto.
 * - Túnel apagado pero con dirección pública y sin dirección fija → la
 *   dirección viene de `PUBLIC_URL` del entorno: una instalación ya desplegada
 *   detrás de su propio proxy (la VM de Oracle con Caddy). Ahí los túneles
 *   sobran y romperían la dirección que la gente ya usa.
 * - Todo lo demás → Cloudflare, que es el punto de partida sin configurar nada.
 */
export function detectLane(tunnel: TunnelSnapshot | null): "cloudflare" | "tailscale" | "cloud-fixed" {
  if (!tunnel) return "cloudflare";
  if (tunnel.fixed_url?.endsWith(".ts.net")) return "tailscale";
  if (tunnel.status === "off" && tunnel.public_url !== "" && !tunnel.fixed_url) return "cloud-fixed";
  return "cloudflare";
}
