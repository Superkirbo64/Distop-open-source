import test from "node:test";
import assert from "node:assert/strict";
import type { DirectMessage } from "@distop/protocol";
import { directMessagesFor } from "./direct.ts";

test("un DM nuevo conserva el mismo snapshot vacío entre lecturas", () => {
  const cache: Record<string, DirectMessage[]> = {};
  const first = directMessagesFor("conversation-new", cache);
  const second = directMessagesFor("conversation-new", cache);

  assert.strictEqual(first, second);
  assert.deepEqual(first, []);
});

test("un DM cargado devuelve el array guardado en la caché", () => {
  const saved: DirectMessage[] = [];
  assert.strictEqual(directMessagesFor("conversation", { conversation: saved }), saved);
});
