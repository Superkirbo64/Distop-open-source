/**
 * La regla que elige el carril de "Compartir tu comunidad". Lo importante no
 * es que devuelva algo, sino que una VM con PUBLIC_URL no ofrezca túneles que
 * romperían su dirección, y que Tailscale gane aunque el túnel esté encendido.
 *
 *   node --test "src/lib/*.test.ts"
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectLane, hasStablePublicAddress, type TunnelSnapshot } from "./publish.ts";

const tunel = (partes: Partial<TunnelSnapshot>): TunnelSnapshot => ({
  status: "off",
  public_url: "",
  ...partes,
});

test("sin estado de túnel, el punto de partida es Cloudflare", () => {
  assert.equal(detectLane(null), "cloudflare");
});

test("una instancia doméstica sin nada configurado arranca en Cloudflare", () => {
  assert.equal(detectLane(tunel({})), "cloudflare");
});

test("una dirección fija .ts.net significa Tailscale Funnel", () => {
  assert.equal(detectLane(tunel({ fixed_url: "https://equipo.tailnet.ts.net" })), "tailscale");
});

test("Tailscale manda incluso con el túnel de Cloudflare encendido", () => {
  assert.equal(
    detectLane(tunel({ status: "on", public_url: "https://x.trycloudflare.com", fixed_url: "https://equipo.tailnet.ts.net" })),
    "tailscale",
  );
});

test("túnel apagado + dirección pública + sin fija = despliegue en la nube (PUBLIC_URL)", () => {
  assert.equal(detectLane(tunel({ status: "off", public_url: "https://comunidad.duckdns.org" })), "cloud-fixed");
});

test("con el túnel vivo la dirección pública es del túnel, no de PUBLIC_URL", () => {
  assert.equal(detectLane(tunel({ status: "on", public_url: "https://x.trycloudflare.com" })), "cloudflare");
});

test("una dirección fija que no es .ts.net no activa ningún carril especial", () => {
  assert.equal(
    detectLane(tunel({ fixed_url: "https://midominio.org", public_url: "https://midominio.org" })),
    "cloudflare",
  );
});

test("el túnel rápido de Cloudflare no sirve para publicar en Explorar", () => {
  assert.equal(
    hasStablePublicAddress(tunel({ status: "on", public_url: "https://x.trycloudflare.com" })),
    false,
  );
});

test("Funnel y PUBLIC_URL sí son direcciones estables para Explorar", () => {
  assert.equal(hasStablePublicAddress(tunel({ fixed_url: "https://equipo.tailnet.ts.net" })), true);
  assert.equal(hasStablePublicAddress(tunel({ public_url: "https://comunidad.example" })), true);
});

test("una instancia local todavía no puede publicarse en Explorar", () => {
  assert.equal(hasStablePublicAddress(null), false);
  assert.equal(hasStablePublicAddress(tunel({})), false);
});
