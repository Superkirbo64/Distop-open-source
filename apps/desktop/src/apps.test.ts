import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { GUESTS, allowed, isTabId } from "./apps-policy.ts";

test("cada huésped navega por lo suyo", () => {
  strictEqual(allowed(GUESTS.whatsapp, "https://web.whatsapp.com/"), true);
  strictEqual(allowed(GUESTS.whatsapp, "https://static.whatsapp.net/x.js"), true);
  strictEqual(allowed(GUESTS.telegram, "https://web.telegram.org/k/"), true);
});

test("un dominio ajeno o parecido sale fuera", () => {
  strictEqual(allowed(GUESTS.whatsapp, "https://notwhatsapp.com/"), false);
  strictEqual(allowed(GUESTS.whatsapp, "https://web.telegram.org/"), false);
  strictEqual(allowed(GUESTS.telegram, "https://evil.example/telegram.org"), false);
  strictEqual(allowed(GUESTS.whatsapp, "no es una url"), false);
});

test("sin HTTPS no se entra", () => {
  strictEqual(allowed(GUESTS.whatsapp, "http://web.whatsapp.com/"), false);
  strictEqual(allowed(GUESTS.telegram, "file:///C:/Windows/System32/"), false);
  strictEqual(allowed(GUESTS.telegram, "javascript:alert(1)"), false);
});

test("solo se aceptan las tres pestañas conocidas", () => {
  deepStrictEqual([isTabId("distop"), isTabId("whatsapp"), isTabId("telegram")], [true, true, true]);
  deepStrictEqual([isTabId("otra"), isTabId(7), isTabId(null)], [false, false, false]);
});
