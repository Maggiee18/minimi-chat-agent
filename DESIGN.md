# Design

## The insight that shaped it

Look at the three sample prompts: none of them is really a search question. Each one points at **a past conversation by date** ("on Monday", "on 3 November", "last Tuesday") and asks **whether what was said then still holds**. So the hard part is not calling a search API, it is: knowing exactly which conversation the user means, knowing what was claimed in it, and re-checking those claims honestly. Search is the means; dated memory plus re-verification is the product.

## How it works

```
message ─► recall (plain code, ~1 ms) ─► Sonnet streams ⇄ web_search ×N in parallel (≤4 rounds) ─► answer with [n] cites
             │ date phrases → exact ranges in the user's time zone                                    │
             │ exchanges on those dates + full text topic matches                                       ▼
             └ explicit negatives: "NO exchanges on Tue 10 Nov"                   saved as a dated exchange ─► Haiku files notes
                                                                                                           (topic, summary, checkable claims + sources)
```

1. **Recall is context, not a tool.** `time.ts` turns "last Tuesday" into a concrete range using chrono plus the browser's time zone. `memory.ts` pulls exchanges in that range (on topic ones first), adds topic matches from SQLite FTS5, and writes a `<memory>` block into the system prompt. It always states the negatives ("memory is empty", "nothing on 3 Nov") and labels near misses ("not on that day, but on Wed 11 Nov you asked about Postgres"), because "last Tuesday" is ambiguous and people misremember days.
2. **Claims, not transcripts.** After each answer is sent, Haiku extracts the checkable claims it made (prices, versions, dates) with their source URLs. "Is that still correct?" then becomes: restate what was said and when, re-verify each claim, report each as unchanged, changed (old → new) or couldn't verify. The prompt insists on the difference between "found no announcement of a change" and "confirmed unchanged".
3. **One search tool, shaped for change questions.** `web_search` takes a query, an optional `since` date, news vs general, and domain pinning. Its description tells the model that pricing pages rarely carry dates, so a "did the price change since Monday" check needs the current official page *and* news since Monday. Sources get one global number per turn (deduped by URL), and only the sources the answer actually cited are stored in memory.
4. **Fast by construction.** No router call before the main model (the model decides to search in its first tokens). `thinking: between_tools` skips upfront deliberation but still lets it think after reading results. Independent searches run in parallel, results are cached for 15 minutes, the tool schema plus static prompt are prompt cached, notes run off the hot path, and the final round forbids tools so latency is bounded. The UI streams everything over one NDJSON response: recalled memories show as dated cards (amber, so they never look like web sources), each search shows as a live step, source cards fill in as results land, then the answer streams.
5. **Good to talk to.** Answer first, short by default, a table only when comparing, at most one clarifying question (otherwise state the assumption and proceed). Any "let me check" preamble before a tool call is retracted from the screen. After the answer, the small model suggests three "ask next" questions; they arrive after the answer is complete and the input unlocks as soon as the answer is saved, so they never cost the user time. Every turn knows today's date and the user's time zone.

## Why this shape

The loop is about 150 lines that I own (`agent.ts`) behind a small `ModelClient` interface, so it is testable with a scripted fake model (`test/agent.test.ts`) and every behaviour can be explained line by line. The same interface has three implementations (Claude, Gemini's native API, any OpenAI compatible API such as Groq or OpenRouter), and `FallbackModel` chains whichever have keys: if one is out of quota, overloaded or hangs, the next one answers, and the failed one is benched until it should recover. It never switches after text has started streaming, so the user can't get two answers. Date math lives in deterministic, unit tested code because that is exactly where models slip (wrong weekday, wrong year, UTC vs local), and it costs a millisecond instead of a model round trip. Storage is Node's built in SQLite (`node:sqlite`, with FTS5): no native addon to compile and no external service, so `npm install && npm run dev` works on any machine with Node 22.13+.

## Considered and rejected

* **Memory as a second tool** (`recall(date)`): costs a full model round trip before any real work, the model can skip it and then confidently invent the past, and the brief says one tool.
* **A router / classifier model** ("search or not?") before the main call: adds latency to every message for a decision the main model makes anyway.
* **Vector DB / embeddings for recall:** for one person's chat history, dates plus BM25 find the right exchange; embeddings would add a dependency and a key. Worth it once history reaches thousands of exchanges.
* **Letting the LLM resolve dates:** less reliable, untestable, slower.
* **The model provider's built in web search:** less control over date filters, caching and source numbering, and it ties memory to one vendor's citation format.
* **An agent framework (LangChain etc.):** the loop is small; a framework would hide the decisions I am being judged on.
* **Replaying old tool results in history:** heavy on tokens; the answer plus its source list carries what mattered.

## With another week

* **A real eval set:** ~50 dated multi turn scenarios run with a simulated clock (the agent already takes `now`), graded by a judge model for correctness, citation faithfulness and memory honesty; track time to first token p50/p95 per change. `npm run eval` is the seed of this.
* **Citation verification:** before finalising, check each cited sentence against the source text it cites and drop or fix unsupported ones.
* **Read the page when snippets are thin:** fetch the official pricing page directly for exact numbers.
* **Proactive change watch:** re-check stored claims for things the user shortlisted and tell them when a price moves.
* **Entity memory:** link "the CRMs" or "them" to the shortlist's entities across conversations; multi user auth.
