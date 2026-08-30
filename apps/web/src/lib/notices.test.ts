import test from "node:test";
import assert from "node:assert/strict";
import { addNotice, unreadNotices, type Notice } from "./notices.ts";

const aviso = (id: string, read = false): Notice => ({
  id, kind: "message", title: "t", body: "b", at: 1, read,
});

test("el historial no crece sin límite y el más nuevo va primero", () => {
  let lista: Notice[] = [];
  for (let i = 0; i < 80; i++) lista = addNotice(lista, aviso(`n${i}`));
  assert.equal(lista.length, 60, "se queda en los últimos 60");
  assert.equal(lista[0]?.id, "n79", "el más reciente arriba");
});

test("el contador solo cuenta lo no leído", () => {
  const lista = [aviso("a"), aviso("b", true), aviso("c")];
  assert.equal(unreadNotices(lista), 2);
  assert.equal(unreadNotices([]), 0);
});
