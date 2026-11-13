import { test } from "node:test";
import assert from "node:assert/strict";
import { runTurn, type AgentEvent } from "../src/agent.js";
import { FakeModel, FakeSearch, memStore, text, toolCalls, TZ } from "./helpers.js";

const now = new Date("2026-11-13T15:00:00+05:30");
const hits = (a: any) => [
  { url: `https://${a.query.split(" ")[0].toLowerCase()}.com/pricing`, title: `${a.query} page`, content: "Plan A $10/user/month", published: "2026-11-10" },
  { url: "https://shared.example/news", title: "Shared news", content: "Something shipped", published: null },
];

async function run(model: FakeModel, search: FakeSearch, message: string, store = memStore(), conversationId = "conv-test-1") {
  const events: AgentEvent[] = [];
  const pending: Promise<unknown>[] = [];
  await runTurn({ store, model, search, maxRounds: 3, background: (p) => pending.push(p) }, { conversationId, message, tz: TZ, now }, (e) => events.push(e));
  await Promise.all(pending);
  return { events, store };
}

test("parallel searches, deduped global source numbering, citations persisted", async () => {
  const model = new FakeModel([
    { ...toolCalls({ query: "HubSpot pricing" }, { query: "Pipedrive pricing" }), content: [{ type: "text", text: "Checking…" } as any, ...toolCalls({ query: "HubSpot pricing" }, { query: "Pipedrive pricing" }).content] },
    text("HubSpot is $10 [1]; Pipedrive too [3]."),
  ], { topic: "CRM pricing", summary: "s", entities: ["HubSpot"], claims: [{ text: "HubSpot $10", source: "https://hubspot.com/pricing" }] });
  const search = new FakeSearch(hits);
  const { events, store } = await run(model, search, "HubSpot vs Pipedrive price?");

  assert.equal(search.calls.length, 2);
  const srcs = events.filter((e) => e.type === "sources").at(-1) as any;
  assert.deepEqual(srcs.sources.map((s: any) => s.n), [1, 2, 3]); // shared.example deduped
  assert.ok(events.some((e) => e.type === "retract"), "preamble before tool call is retracted");

  const second = model.requests[1];
  const toolResults = second.messages.at(-1).content;
  assert.equal(toolResults.length, 2);
  assert.match(toolResults[0].content, /\[1\] HubSpot pricing page/);

  const [ex] = store.conversationExchanges("conv-test-1");
  assert.equal(ex.answer, "HubSpot is $10 [1]; Pipedrive too [3].");
  assert.deepEqual(ex.sources.map((s) => s.n), [1, 3]); // only cited sources are remembered
  assert.equal(ex.topic, "CRM pricing"); // notes written in background
  const fu = events.find((e) => e.type === "followups") as any;
  assert.deepEqual(fu.questions.length, 3);
  assert.ok(events.findIndex((e) => e.type === "done") < events.indexOf(fu), "suggestions never delay the answer");
});

test("last round forbids tools so the loop always ends with an answer", async () => {
  const model = new FakeModel([toolCalls({ query: "a" }), toolCalls({ query: "b" }), text("final")]);
  const { events } = await run(model, new FakeSearch(hits), "q");
  assert.equal(model.requests[2].allowTools, false);
  assert.ok(events.some((e) => e.type === "done"));
});

test("search failure becomes an error tool result, not a crash", async () => {
  const model = new FakeModel([toolCalls({ query: "x" }), text("Search is down, sorry.")]);
  const search = { search: async () => { throw new Error("Tavily 503"); } };
  const { events } = await run(model, search as any, "news today?");
  const tr = model.requests[1].messages.at(-1).content[0];
  assert.equal(tr.is_error, true);
  assert.ok(events.some((e) => e.type === "search_done" && e.error));
});

test("date context and recall block reach the model; history is replayed per conversation", async () => {
  const store = memStore();
  const model = new FakeModel([text("first"), text("second")]);
  await run(model, new FakeSearch(hits), "hello", store, "conv-a-0001");
  await run(model, new FakeSearch(hits), "What did I ask you last Tuesday?", store, "conv-a-0001");
  const sys = model.requests[1].system.map((b: any) => b.text).join("\n");
  assert.match(sys, /Today's ISO date: 2026-11-13/);
  assert.match(sys, /"last Tuesday" = Tue, 10 Nov 2026/);
  assert.equal(model.requests[1].messages.length, 3); // user, assistant, user
  assert.ok(model.requests[1].system[0].cache_control, "static prompt is cache-marked");
});
