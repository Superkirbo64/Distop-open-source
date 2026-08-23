import test from "node:test";
import assert from "node:assert/strict";
import { detectGame, parseTasklist } from "./game-detection.ts";

test("tasklist se interpreta sin depender de mayúsculas ni finales de línea", () => {
  const csv = [
    '"RobloxPlayerBeta.exe","123","Console","1","250,000 K"',
    '"explorer.EXE","456","Console","1","80,000 K"',
  ].join("\r\n");
  assert.deepEqual([...parseTasklist(csv)], ["robloxplayerbeta.exe", "explorer.exe"]);
});

test("un ejecutable del catálogo se convierte en el nombre público", () => {
  const running = new Set(["robloxplayerbeta.exe", "explorer.exe"]);
  const catalog = new Map([
    ["rocketleague.exe", "Rocket League"],
    ["robloxplayerbeta.exe", "Roblox"],
  ]);
  assert.equal(detectGame(running, catalog, null), "Roblox");
});

test("mantiene el juego actual mientras siga abierto", () => {
  const running = new Set(["cs2.exe", "robloxplayerbeta.exe"]);
  const catalog = new Map([
    ["cs2.exe", "Counter-Strike 2"],
    ["robloxplayerbeta.exe", "Roblox"],
  ]);
  assert.equal(detectGame(running, catalog, "Roblox"), "Roblox");
  assert.equal(detectGame(new Set(["cs2.exe"]), catalog, "Roblox"), "Counter-Strike 2");
  assert.equal(detectGame(new Set(), catalog, "Roblox"), null);
});
