/**
 * La regla que elige el carril de "Compartir tu comunidad". Lo importante no
 * es que devuelva algo, sino que una VM con PUBLIC_URL no ofrezca túneles que
 * romperían su dirección, y que Tailscale gane aunque el túnel esté encendido.
 *
 *   node --test "src/lib/*.test.ts"
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { detectLane, ORACLE_STACK_URL, type TunnelSnapshot } from "./publish.ts";

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

test("el botón de deploy queda apagado hasta que exista el zip versionado", () => {
  /* Cuando esto falle será porque alguien puso una URL: entonces tiene que ser
     una release concreta con checksum, jamás main (docs/nube-oracle.md). */
  assert.ok(
    ORACLE_STACK_URL === null || /^https:\/\/github\.com\/.+\/releases\/download\/.+/.test(ORACLE_STACK_URL),
    "ORACLE_STACK_URL solo puede ser null o el zip de una release publicada",
  );
});
