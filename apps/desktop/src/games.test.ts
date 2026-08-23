import test from "node:test";
import assert from "node:assert/strict";
import { detectGame, parseEpicManifest, parseRegDword, parseRegString, parseTasklist, pickGame } from "./game-detection.ts";

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

test("el appid en marcha sale del REG_DWORD, y 0 significa ninguno", () => {
  const salida = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    RunningAppID    REG_DWORD    0x1f2b3\r\n\r\n";
  assert.equal(parseRegDword(salida), 0x1f2b3);
  assert.equal(parseRegDword("    RunningAppID    REG_DWORD    0x0\r\n"), 0);
  assert.equal(parseRegDword("ERROR: no existe la clave"), null);
});

test("el nombre del juego conserva sus espacios y signos", () => {
  const salida = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\Apps\\1030300\r\n    Name    REG_SZ    Hollow Knight: Silksong\r\n\r\n";
  assert.equal(parseRegString(salida), "Hollow Knight: Silksong");
  assert.equal(parseRegString("    Name    REG_SZ    \r\n"), null);
  assert.equal(parseRegString("ERROR: no existe la clave"), null);
});

test("Steam gana al catálogo, que es lo que hacía que un juego suyo no saliera nunca", () => {
  // El caso real: `launcher.exe` entra en el catálogo desde el manifiesto de
  // Rocket League, y cualquier programa del equipo llamado igual lo activaba.
  // Con el catálogo delante, Geometry Dash no aparecía jamás.
  assert.equal(pickGame("Geometry Dash", "Rocket League®"), "Geometry Dash");
  // Sin partida de Steam abierta, el catálogo sigue mandando.
  assert.equal(pickGame(null, "Rocket League®"), "Rocket League®");
  assert.equal(pickGame(null, null), null);
});

test("del manifiesto de Epic salen el nombre, la carpeta y el ejecutable suelto", () => {
  const manifiesto = JSON.stringify({
    DisplayName: "Rocket League®",
    InstallLocation: "C:\\Program Files\\Epic Games\\rocketleague",
    LaunchExecutable: "Binaries/Win64/Launcher.exe",
  });
  assert.deepEqual(parseEpicManifest(manifiesto), {
    name: "Rocket League®",
    install: "C:\\Program Files\\Epic Games\\rocketleague",
    exe: "launcher.exe",
  });
});

test("un manifiesto a medio escribir o sin nombre no rompe la pasada", () => {
  assert.equal(parseEpicManifest('{"DisplayName": "a medio'), null);
  assert.equal(parseEpicManifest(JSON.stringify({ InstallLocation: "C:\\Juegos" })), null);
  assert.equal(parseEpicManifest(JSON.stringify({ DisplayName: "  ", InstallLocation: "C:\\Juegos" })), null);
  // Sin LaunchExecutable sigue valiendo: los ejecutables salen de la carpeta.
  assert.equal(parseEpicManifest(JSON.stringify({ DisplayName: "X", InstallLocation: "C:\\J" }))?.exe, "");
});
