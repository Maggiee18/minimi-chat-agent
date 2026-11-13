import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { runTurn, type AgentEvent } from "../src/agent.js";
import { GeminiModel } from "../src/gemini.js";
import { FakeSearch, memStore, TZ } from "./helpers.js";

/** Stand-in for generativelanguage.googleapis.com, streaming SSE like the real API. */
async function fakeGemini(replies: Array<object[] | object>) {
  const reqs: Array<{ url: string; key: string | undefined; auth: string | undefined; body: any }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(404).end(); return; } // model listing unavailable → trust config
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      reqs.push({ url: req.url!, key: req.headers["x-goog-api-key"] as string, auth: req.headers.authorization, body: JSON.parse(raw) });
      const reply = replies.shift()!;
      if (Array.isArray(reply)) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const c of reply) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(reply));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/models`, reqs, close: () => server.close() };
}
const cand = (parts: object[], finishReason?: string) => ({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] });

test("native Gemini: AQ key in x-goog-api-key, thought signature replayed, functionResponse named", async () => {
  const srv = await fakeGemini([
    [cand([{ text: "planning", thought: true }]), cand([{ functionCall: { name: "web_search", args: { query: "Pipedrive pricing" } }, thoughtSignature: "SIG" }], "STOP")],
    [cand([{ text: "Pipedrive is " }]), cand([{ text: "$52 [1]." }], "STOP")],
    { candidates: [{ content: { parts: [{ text: '{"topic":"t","summary":"s","entities":[],"claims":[]}' }] } }] },
    { candidates: [{ content: { parts: [{ text: '{"questions":["a?","b?","c?"]}' }] } }] },
  ]);
  const model = new GeminiModel({ apiKey: "AQ.test-key", answerModel: "gemini-3.8-flash", noteModel: "gemini-lite", thinkingLevel: "low", baseUrl: srv.base });
  const search = new FakeSearch(() => [{ url: "https://pipedrive.com/pricing", title: "Pricing", content: "$52" }]);
  const events: AgentEvent[] = [];
  const pending: Promise<unknown>[] = [];
  await runTurn({ store: memStore(), model, search, maxRounds: 3, background: (p) => pending.push(p) },
    { conversationId: "conv-gemini-native", message: "Pipedrive price?", tz: TZ }, (e) => events.push(e));
  await Promise.all(pending);
  srv.close();

  const [first, second] = srv.reqs;
  assert.equal(first.key, "AQ.test-key");
  assert.equal(first.auth, undefined, "never send the key twice");
  assert.match(first.url, /gemini-3\.8-flash:streamGenerateContent\?alt=sse/);
  assert.equal(first.body.generationConfig.thinkingConfig.thinkingLevel, "low");
  assert.equal(first.body.tools[0].functionDeclarations[0].name, "web_search");
  assert.equal(search.calls[0].query, "Pipedrive pricing");

  const modelTurn = second.body.contents.find((c: any) => c.role === "model");
  assert.equal(modelTurn.parts.find((p: any) => p.functionCall).thoughtSignature, "SIG");
  const resp = second.body.contents.at(-1).parts[0].functionResponse;
  assert.equal(resp.name, "web_search");
  assert.match(resp.response.result, /\[1\] Pricing/);

  // thought text is never shown to the user
  assert.equal(events.filter((e) => e.type === "text").map((e: any) => e.delta).join(""), "Pipedrive is $52 [1].");
  assert.deepEqual((events.find((e) => e.type === "followups") as any).questions, ["a?", "b?", "c?"]);
  assert.match(srv.reqs[2].url, /gemini-lite:generateContent/);
});

test("503 high demand on the preferred model falls through to the next one", async () => {
  const busy = { error: { code: 503, message: "high demand", status: "UNAVAILABLE" } };
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(404).end(); return; }
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push(`${req.url} ${JSON.stringify(JSON.parse(raw).generationConfig ?? null)}`);
      if (req.url!.includes("gemini-3.8-flash")) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify(busy)); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(cand([{ text: "ok" }], "STOP"))}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/models`;
  const model = new GeminiModel({ apiKey: "k", answerModel: "gemini-3.8-flash, gemini-2.5-flash", noteModel: "x", thinkingLevel: "low", baseUrl: base });
  let out = "";
  const r = await model.turn({ system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools: [], allowTools: true }, (d) => (out += d));
  server.close();
  assert.equal(out, "ok");
  assert.equal(r.stopReason, "end_turn");
  assert.equal(seen.filter((s) => s.includes("3.8")).length, 1, "no time wasted retrying a busy model when a fallback exists");
  assert.match(seen.at(-1)!, /gemini-2\.5-flash.*null/, "fallback model gets no thinkingLevel");
});

test("a model that hangs is abandoned quickly and skipped on the next question", async () => {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") { res.writeHead(404).end(); return; }
    req.resume();
    req.on("end", () => {
      seen.push(req.url!);
      if (req.url!.includes("slow-model")) return; // never answers
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(cand([{ text: "ok" }], "STOP"))}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/models`;
  const model = new GeminiModel({ apiKey: "k", answerModel: "slow-model,gemini-2.5-flash", noteModel: "x", baseUrl: base, headerTimeoutMs: 300 });
  const ask = async () => { let out = ""; await model.turn({ system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools: [], allowTools: true }, (d) => (out += d)); return out; };
  const t0 = Date.now();
  assert.equal(await ask(), "ok");
  assert.ok(Date.now() - t0 < 2000, "did not wait long on the hanging model");
  assert.equal(await ask(), "ok");
  server.closeAllConnections(); server.close();
  assert.equal(seen.filter((u) => u.includes("slow-model")).length, 1, "second question skipped the bad model");
});

test("configured model names this key can't use are swapped for available Flash models", async () => {
  const posted: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
      ] }));
      return;
    }
    req.resume();
    req.on("end", () => {
      posted.push(req.url!);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify(cand([{ text: "ok" }], "STOP"))}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/models`;
  const model = new GeminiModel({ apiKey: "k", answerModel: "gemini-9-flash", noteModel: "x", baseUrl: base });
  await model.turn({ system: [{ type: "text", text: "s" }], messages: [{ role: "user", content: "hi" }], tools: [], allowTools: true }, () => {});
  server.close();
  assert.match(posted[0], /gemini-3\.6-flash:/, "newest available non-lite Flash");
});
