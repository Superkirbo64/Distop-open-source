/**
 * Qué carril de publicación describe el estado real de la instancia (§6).
 *
 * "Compartir tu comunidad" ofrece tres caminos: el túnel de Cloudflare, la
 * dirección fija de Tailscale Funnel y la máquina siempre encendida en la nube
 * (docs/nube-vps.md). La detección vive aquí, pura y sin React, porque es
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
 * Guía del carril "siempre encendida": qué hay, qué cuesta y cómo publicarlo.
 *
 * Aquí vivía `ORACLE_STACK_URL`, un botón de despliegue en un clic que nunca
 * llegó a encenderse. Se retiró con su carril entero: la capa gratuita ARM de
 * Oracle no daba capacidad, y ofrecer un atajo que termina en `Out of host
 * capacity` tras veinte minutos es peor que no ofrecer ninguno. La guía compara
 * las opciones reales con sus precios, sin recomendar un proveedor concreto que
 * mañana cambie de condiciones.
 */
export const CLOUD_GUIDE_URL =
  "https://github.com/Superkirbo64/Distop-open-source/blob/main/docs/nube-vps.md";
export const VPS_INSTALL_GUIDE_URL =
  "https://github.com/Superkirbo64/Distop-open-source/blob/main/docs/instalar-vps.md";
export const RASPBERRY_GUIDE_URL =
  "https://github.com/Superkirbo64/Distop-open-source/blob/main/docs/raspberry-pi.md";

/**
 * El carril detectable a partir del túnel. `cloud-offer` no sale de aquí:
 * ofrecer la nube es una elección de quien mira, no un estado de la instancia.
 *
 * - `fixed_url` acabada en `.ts.net` → Tailscale Funnel está puesto.
 * - Túnel apagado pero con dirección pública y sin dirección fija → la
 *   dirección viene de `PUBLIC_URL` del entorno: una instalación ya desplegada
 *   detrás de su propio proxy: una VPS, una Raspberry o un PaaS. Ahí los túneles
 *   sobran y romperían la dirección que la gente ya usa.
 * - Todo lo demás → Cloudflare, que es el punto de partida sin configurar nada.
 */
export function detectLane(tunnel: TunnelSnapshot | null): "cloudflare" | "tailscale" | "cloud-fixed" {
  if (!tunnel) return "cloudflare";
  if (tunnel.fixed_url?.endsWith(".ts.net")) return "tailscale";
  if (tunnel.status === "off" && tunnel.public_url !== "" && !tunnel.fixed_url) return "cloud-fixed";
  return "cloudflare";
}

/**
 * Explorar promete que una ficha seguirá llevando al mismo sitio mañana. El
 * túnel rápido de Cloudflare no puede hacer esa promesa: su hostname cambia
 * cada vez que se vuelve a abrir. Funnel y PUBLIC_URL sí representan una
 * dirección elegida para sobrevivir reinicios.
 *
 * Esta regla vive junto a detectLane para que Compartir, Gestionar y el futuro
 * registro del directorio no terminen inventando tres definiciones distintas
 * de "estable".
 */
export function hasStablePublicAddress(tunnel: TunnelSnapshot | null): boolean {
  if (!tunnel) return false;
  if (typeof tunnel.fixed_url === "string" && tunnel.fixed_url !== "") return true;
  return tunnel.status === "off" && tunnel.public_url !== "";
}
