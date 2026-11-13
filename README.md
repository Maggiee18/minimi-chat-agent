# Chat agent with web search and dated memory

A chat agent you talk to in the browser. It has one tool, **web search**, and it remembers your past conversations **by date**. So you can come back days later and ask:

> "On Monday we shortlisted 5 CRM tools for a 20 person sales team. Has any of them changed pricing or shipped something big since?"
>
> "What did I ask you on 3 November? Is your answer still correct today?"

and it finds that exact conversation, rechecks each claim it made against fresh sources, and tells you what changed.

**How it works and why it's built this way: [DESIGN.md](DESIGN.md)**

## What it does

- **Answers with sources.** Searches the web when a question needs current facts, runs searches in parallel, cites every fact with numbered sources, and says "as of" for prices and versions.
- **Remembers by date.** "Last Tuesday", "on 3 November" and "this week" are resolved in your own time zone. Memory is only used when your question refers back to a past conversation, so a question about the news "this week" doesn't drag old chats in.
- **Rechecks itself.** Each answer is saved with the checkable claims it made. "Is that still correct?" reports each claim as unchanged, changed (old → new) or couldn't verify.
- **Honest about gaps.** If there's no conversation on the date you mention, it says so instead of inventing one, then helps anyway.
- **Fast and resilient.** Answers stream as they're written; searches show live as steps. If one model provider is out of quota, overloaded or slow, the next one answers automatically.
- **Nice to use.** Light and dark themes, works on mobile, "Ask next" suggestions, copy and retry buttons, keyboard shortcuts (`Ctrl K` new thread, `/` focus, `Esc` stop).

## Quick start

Needs **Node 22.13 or newer** (it uses Node's built in SQLite, so there's nothing native to compile). Check with `node -v`.

```bash
git clone https://github.com/Maggiee18/minimi-chat-agent.git
cd minimi-chat-agent
npm install
cp .env.example .env        # Windows: copy .env.example .env
# open .env and paste your keys (see below)
npm run dev
```

Then open **http://localhost:3000**.

### API keys

You need **Tavily** for search plus **at least one** model key. Everything except Claude has a free tier, no card needed.

| Key | Get it at | Cost |
|---|---|---|
| `TAVILY_API_KEY` **(required)** | app.tavily.com | free, 1,000 searches a month |
| `GEMINI_API_KEY` | aistudio.google.com/apikey | free tier (small daily limit) |
| `GROQ_API_KEY` | console.groq.com/keys | free tier, very fast |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | free models (leave the key's credit limit empty) |
| `ANTHROPIC_API_KEY` | platform.claude.com | paid, best answers |

Every model key you set becomes a backup for the others, in this order: **Claude → Gemini → Groq → OpenRouter**. When one runs out of quota or is overloaded, the next answers and the failed one is skipped until it should recover. The server prints the order when it starts:

```
Chat agent running → http://localhost:3000
models, in fallback order: gemini → groq:openai/gpt-oss-120b → groq:qwen/qwen3.8-27b → groq:openai/gpt-oss-20b → openrouter:openrouter/free
```

To put a different provider first, set `PROVIDER=groq` (or `gemini`, `openrouter`, `anthropic`) in `.env`. All optional settings are listed in [`.env.example`](.env.example).

## Things to try

| Try | What you should see |
|---|---|
| Shortlist 5 CRMs for a 20 person sales team, with current pricing | Several parallel searches, source cards, a cited comparison |
| What did OpenAI, Google and Anthropic announce this week? | News searches limited to this week, no memory cards |
| What did I ask you yesterday? Is that still correct? | An amber "You asked on…" card, then each claim rechecked |
| What did I ask you on 3 November? | "No conversation found" if there wasn't one, never an invented answer |
| Explain a mutex vs a semaphore in two sentences | Instant answer, no search |

A fresh install has no history. To try the memory questions straight away, run `npm run seed`. It asks 3 real questions with a simulated clock (this Monday, last Tuesday, 10 days ago); they show up in the sidebar as `[demo] …`.

## How a turn works

```
your message
   │
   ├─ recall (plain code, ~1 ms): resolve dates in your time zone, find past
   │  exchanges on those dates + full text topic matches, say so if there are none
   │
   ├─ model streams ⇄ web_search (parallel, cached 15 min, up to 4 rounds)
   │      └─ provider out of quota / overloaded / slow → next provider answers
   │
   ├─ answer streams with [n] citations → saved as a dated exchange
   │
   └─ in the background: a small model files the answer's checkable claims
      (for future "is that still true?") and suggests 3 follow up questions
```

## Project layout

```
src/
  agent.ts          the turn loop: recall → stream → parallel searches → answer → save
  memory.ts         decides which past exchanges the model sees (dates + full text search)
  time.ts           "last Tuesday" → exact date range in the user's time zone
  search.ts         the web_search tool (Tavily), its schema and a SQLite cache
  prompt.ts         system prompt (static, cached) + per turn context
  notes.ts          background: topic, summary and checkable claims per exchange
  followups.ts      three "Ask next" suggestions, never delays the answer
  model.ts          ModelClient interface + Claude implementation
  gemini.ts         Gemini native API: model discovery, busy model skipping, quota aware
  openai-compat.ts  any OpenAI compatible API (Groq, OpenRouter, Ollama…)
  fallback.ts       chains providers; never switches after text has started streaming
  db.ts             SQLite schema: exchanges, FTS5 index, search cache
  app.ts            HTTP: streaming chat endpoint (NDJSON), thread list
  server.ts         startup
public/             the chat UI: plain HTML, CSS and JS, no build step
test/               node:test suites (no API keys needed)
scripts/            seed (demo history) and eval (live smoke test)
```

All data stays on your machine in `data/agent.db`. Delete that file to reset memory.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | start the server, restarting on code changes |
| `npm start` | start the server once |
| `npm test` | 29 tests: date parsing, memory recall, the agent loop, every provider adapter, the fallback chain. Uses a scripted model and fake search, so no keys or network needed |
| `npm run eval` | live smoke test of the sample questions with your real keys: latency, citations, memory honesty |
| `npm run seed` | adds demo history for trying the memory questions |
| `npm run typecheck` | TypeScript check |

## Troubleshooting

| You see | Do this |
|---|---|
| `'tsx' is not recognized` | Run `npm install` first |
| `Missing … in .env` | Add `TAVILY_API_KEY` and at least one model key, then restart |
| "Today's free model quota is used up" | Gemini's free tier allows only ~20 requests a day per model. Add a `GROQ_API_KEY` or `OPENROUTER_API_KEY` as a backup |
| "The model is overloaded right now" | Free tiers get busy; wait a few seconds or add another provider key |
| "The model API key was rejected" | Check the key in `.env` has no spaces or quotes, then restart |
| PowerShell: "running scripts is disabled" | Use Command Prompt, or type `npm.cmd` instead of `npm` |
| New keys not picked up | Stop the server with `Ctrl C` and run `npm run dev` again |

## Built with

Node + TypeScript, Express, Node's built in SQLite (FTS5), chrono for dates, Tavily for search, and Claude / Gemini / Groq / OpenRouter for models. The UI is plain JavaScript with marked and DOMPurify. No agent framework: the loop is about 150 lines in `src/agent.ts`.
