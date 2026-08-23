import test from "node:test";
import assert from "node:assert/strict";
import { findTunnelAddress } from "./tunnel-address.ts";

test("ignora la API de Cloudflare y toma el Quick Tunnel de la sesión", () => {
  const output = [
    "Requesting new quick Tunnel on https://api.trycloudflare.com",
    "Your quick Tunnel has been created! Visit it at",
    "https://quiet-lantern-river-example.trycloudflare.com",
  ].join("\n");

  assert.equal(findTunnelAddress(output), "https://quiet-lantern-river-example.trycloudflare.com");
});

test("tolera que la dirección llegue partida entre dos lecturas", () => {
  let output = "https://quiet-lantern-";
  assert.equal(findTunnelAddress(output), "");
  output += "river-example.trycloudflare.com";
  assert.equal(findTunnelAddress(output), "https://quiet-lantern-river-example.trycloudflare.com");
});
