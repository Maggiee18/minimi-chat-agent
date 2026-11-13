import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runTurn, type AgentEvent } from "../src/agent.js";
import { OpenAICompatModel } from "../src/openai-compat.js";
import { FakeSearch, memStore, TZ } from "./helpers.js";

/** A tiny stand-in for Gemini's OpenAI-compatible endpoint, streaming SSE like the real one. */
function fakeServer(replies: Array<(body: any) => string[] | object>) {
  const bodies: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      bodies.push(body);
      const reply = replies.shift()!(body);
      if (Array.isArray(reply)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of reply) res.write(`data: ${c}\n\n`);
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      }
    });
  });
  return new Promise<{ url: string; bodies: any[]; close: () => void }>((r) =>
    server.listen(0, () => r({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai/`, bodies, close: () => server.close() })));
}

const chunk = (delta: object, finish: string | null = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] });

test("Gemini-style tool call streams, thought signature is echoed back, answer streams", async () => {
  const srv = await fakeServer([
    () => [
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"Pipe' }, extra_content: { google: { thought_signature: "SIG123" } } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'drive pricing"}' } }] }, "stop"), // Gemini often says "stop" here
    ],
    () => [chunk({ content: "Pipedrive is " }), chunk({ content: "$52 [1]." }, "stop")],
    () => ({ choices: [{ message: { content: '{"topic":"t","summary":"s","entities":[],"claims":[]}' } }] }),
    () => ({ choices: [{ message: { content: '```json\n{"questions":["a?","b?","c?"]}\n```' } }] }),
  ]);
  const model = new OpenAICompatModel({ baseUrl: srv.url, apiKey: "k", answerModel: "gemini-x", noteModel: "gemini-lite", reasoningEffort: "low" });
  const search = new FakeSearch(() => [{ url: "https://pipedrive.com/pricing", title: "Pricing", content: "$52" }]);
  const events: AgentEvent[] = [];
  const pending: Promise<unknown>[] = [];
  await runTurn({ store: memStore(), model, search, maxRounds: 3, background: (p) => pending.push(p) },
    { conversationId: "conv-gemini-1", message: "Pipedrive price?", tz: TZ }, (e) => events.push(e));
  await Promise.all(pending);
  srv.close();

  assert.equal(search.calls[0].query, "Pipedrive pricing");
  const second = srv.bodies[1];
  assert.equal(second.reasoning_effort, "low");
  const asst = second.messages.find((m: any) => m.role === "assistant");
  assert.equal(asst.tool_calls[0].extra_content.google.thought_signature, "SIG123");
  const tool = second.messages.find((m: any) => m.role === "tool");
  assert.equal(tool.tool_call_id, "c1");
  assert.match(tool.content, /\[1\] Pricing/);
  assert.equal(srv.bodies[0].tools[0].function.name, "web_search");
  assert.equal(events.filter((e) => e.type === "text").map((e: any) => e.delta).join(""), "Pipedrive is $52 [1].");
  assert.deepEqual((events.find((e) => e.type === "followups") as any).questions, ["a?", "b?", "c?"]);
});
