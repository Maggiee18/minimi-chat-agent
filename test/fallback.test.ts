import { test } from "node:test";
import assert from "node:assert/strict";
import { FallbackModel } from "../src/fallback.js";
import type { ModelClient } from "../src/model.js";
import { text } from "./helpers.js";

const err = (status: number, message = "") => Object.assign(new Error(message || `HTTP ${status}`), { status });
function client(behaviour: Array<"ok" | Error>, reply = "answer", partial = false): ModelClient & { calls: number } {
  const c = {
    calls: 0,
    async turn(_req: any, onText: (d: string) => void) {
      const b = behaviour[Math.min(c.calls++, behaviour.length - 1)];
      if (b === "ok") { onText(reply); return text(reply); }
      if (partial) onText("half an ans");
      throw b;
    },
    async json<T>() { return {} as T; },
  };
  return c;
}
const req = { system: [], messages: [{ role: "user" as const, content: "q" }], tools: [], allowTools: true };

test("quota on the first backend moves the turn to the next, and the first is skipped afterwards", async () => {
  const gemini = client([err(429, "Quota exceeded per day. Please retry in 12h3m1s.")]);
  const groq = client(["ok"], "from groq");
  const logs: string[] = [];
  const m = new FallbackModel([{ name: "gemini", client: gemini }, { name: "groq", client: groq }], (l) => logs.push(l));
  let out = "";
  await m.turn(req, (d) => (out += d));
  assert.equal(out, "from groq");
  await m.turn(req, () => {});
  assert.equal(gemini.calls, 1, "cooling backend not retried on the next question");
  assert.equal(groq.calls, 2);
  assert.match(logs[0], /gemini failed \(429.*trying groq/);
});

test("never switches after the user has seen text (no double answers)", async () => {
  const a = client([err(500)], "x", true);
  const b = client(["ok"]);
  const m = new FallbackModel([{ name: "a", client: a }, { name: "b", client: b }], () => {});
  await assert.rejects(m.turn(req, () => {}));
  assert.equal(b.calls, 0);
});

test("when every backend fails, the most telling error (quota) is reported", async () => {
  const m = new FallbackModel([
    { name: "a", client: client([err(429, "per day")]) },
    { name: "b", client: client([err(404)]) },
  ], () => {});
  await assert.rejects(m.turn(req, () => {}), (e: any) => e.status === 429);
});
