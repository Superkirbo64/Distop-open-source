/**
 * Extrae únicamente la dirección de un Quick Tunnel creado para esta sesión.
 * cloudflared también imprime endpoints propios como api.trycloudflare.com;
 * aceptar el primero hacía anunciar la API de Cloudflare como si fuera Distop.
 */
const QUICK_TUNNEL = /https:\/\/(?!api\.trycloudflare\.com)[a-z0-9-]+\.trycloudflare\.com/;
export function findTunnelAddress(output) {
    return QUICK_TUNNEL.exec(output)?.[0] ?? "";
}
