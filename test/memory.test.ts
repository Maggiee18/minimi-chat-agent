import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecall, keyTerms } from "../src/memory.js";
import { memStore, TZ } from "./helpers.js";

const now = new Date("2026-11-13T15:00:00+05:30");

function seeded() {
  const store = memStore();
  const put = (conv: string, iso: string, q: string, a: string, notes?: any) => {
    store.ensureConversation(conv, Date.parse(iso));
    const id = store.addExchange({ conversationId: conv, userText: q, answer: a, sources: [{ n: 1, url: "https://x.com/p", title: "X pricing", retrievedAt: Date.parse(iso) }], searches: [], createdAt: Date.parse(iso), tz: TZ, latencyMs: 1 });
    if (notes) store.setNotes(id, notes);
    return id;
  };
  put("c1", "2026-11-03T11:00:00+05:30", "Which CRM tools should a 20-person sales team shortlist?", "HubSpot, Pipedrive, Salesforce, Zoho, Close [1]",
    { topic: "CRM shortlist for 20-person sales team", summary: "Shortlisted 5 CRMs", entities: ["HubSpot", "Pipedrive", "Salesforce", "Zoho", "Close"], claims: [{ text: "Pipedrive Growth costs $49/user/month", source: "https://x.com/p" }] });
  put("c1", "2026-11-03T18:00:00+05:30", "What's a good pasta recipe?", "Cacio e pepe.");
  put("c2", "2026-11-11T09:00:00+05:30", "Compare Postgres hosting: Neon vs Supabase vs RDS pricing", "Neon starts at ...");
  return store;
}

test("date reference pulls that day's exchanges, on-topic first, with claims", () => {
  const r = buildRecall(seeded(), "What did I ask you on 3 November about CRMs? Still correct?", now, TZ);
  assert.equal(r.items[0].why, "on-date");
  assert.match(r.items[0].exchange.userText, /CRM/);
  assert.match(r.block, /Pipedrive Growth costs \$49/);
  assert.match(r.block, /2026-11-03/);
});

test("empty date is stated explicitly, near-date topic match is offered and labelled", () => {
  const r = buildRecall(seeded(), "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?", now, TZ);
  assert.match(r.block, /NO exchanges with this user on Tue, 10 Nov 2026/);
  assert.equal(r.items[0].why, "near-date");
  assert.match(r.items[0].exchange.userText, /Postgres/);
  assert.match(r.block, /NOT on the requested date/);
});

test("empty memory says so, so the model cannot invent a past conversation", () => {
  const r = buildRecall(memStore(), "What did I ask you on 3 November?", now, TZ);
  assert.equal(r.items.length, 0);
  assert.match(r.block, /Memory: empty/);
  assert.match(r.block, /NO exchanges with this user on Tue, 3 Nov 2026/);
});

test("a plain question does not drag in unrelated memory", () => {
  const r = buildRecall(seeded(), "What's the capital of Australia?", now, TZ);
  assert.equal(r.items.length, 0);
});

test("memory cue without a date uses full-text topic search", () => {
  const r = buildRecall(seeded(), "Has HubSpot changed anything since we shortlisted it?", now, TZ);
  assert.equal(r.items[0]?.why, "topic");
  assert.match(r.items[0].exchange.userText, /CRM/);
});

test("exchanges already replayed as chat history are not duplicated in recall", () => {
  const store = seeded();
  const replayed = new Set(store.conversationExchanges("c1").map((e) => e.id));
  const r = buildRecall(store, "what did I ask on 3 November", now, TZ, replayed);
  assert.equal(r.items.length, 0);
});

test("keyTerms drops stopwords, dates and numbers", () => {
  assert.deepEqual(keyTerms("Last Tuesday I asked you about Postgres hosting. Has any pricing changed?"), ["postgres", "hosting", "pricing"]);
});
