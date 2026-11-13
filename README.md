# Chat agent with web search and dated memory

A chat agent you can talk to in the browser. It has one tool, web search, and it remembers your past conversations *by date*, so you can come back and ask "On Monday we shortlisted 5 CRMs, has any of them changed pricing since?" or "What did I ask you on 3 November? Is that still correct?"

See **[DESIGN.md](DESIGN.md)** for how it works and why.

## Run it

Requires Node 22.13+ (it uses Node's built in SQLite, so there is nothing native to compile).

```bash
npm install
cp .env.example .env      # add a model key and TAVILY_API_KEY
npm run dev               # → http://localhost:3000
```

| Key | Where | Cost |
|---|---|---|
| `GEMINI_API_KEY` | aistudio.google.com/apikey | free tier |
| `GROQ_API_KEY` | console.groq.com/keys | free tier |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | free models |
| `ANTHROPIC_API_KEY` | platform.claude.com | paid, best answers |
| `TAVILY_API_KEY` (required) | app.tavily.com | free tier: 1,000 searches/month |

Set at least one model key. Every model key you add becomes a backup: when one free tier runs out or is overloaded, the next one answers (Claude → Gemini → Groq → OpenRouter). The server prints the order on startup.

Optional settings (models, thinking, effort, port) are listed in `.env.example`.

### Try the memory features straight away

A fresh install has no history, so "what did I ask you on Monday?" will (correctly) tell you it has no record. To give it some:

```bash
npm run seed   # asks 3 real questions with a simulated clock (this Monday, last Tuesday, 10 days ago)
```

Seeded conversations show up in the sidebar as `[demo] …`.

## Scripts

| | |
|---|---|
| `npm run dev` | server with reload |
| `npm test` | unit + loop tests, no API keys needed (scripted model, fake search) |
| `npm run eval` | live smoke eval: the sample prompts and a few others, with latency and simple checks |
| `npm run typecheck` | `tsc` |

## Layout

```
src/
  agent.ts     the turn loop: recall → stream → parallel searches → answer → save → notes
  memory.ts    picks which past exchanges the model sees (dates + full text), writes the <memory> block
  time.ts      "last Tuesday" → exact range in the user's time zone
  search.ts    the web_search tool (Tavily), its schema, and a SQLite cache
  notes.ts     background: topic, summary and checkable claims for each exchange (Haiku)
  followups.ts three "ask next" suggestions after each answer (Haiku, never blocks the reply)
  prompt.ts    system prompt (static, cached) + per turn context
  model.ts     ModelClient interface + Anthropic implementation
  gemini.ts    same interface over Gemini's native API (free tier; falls back to older Flash models when one is overloaded)
  openai-compat.ts  same interface over any OpenAI-compatible API (Groq, OpenRouter, Ollama…)
  fallback.ts  chains the backends: on quota / overload / timeout, the next one answers
  db.ts        SQLite schema (exchanges, FTS5 index, search cache)
  app.ts       HTTP: NDJSON streaming chat endpoint, conversation list
public/        plain HTML/CSS/JS chat UI, no build step (light/dark, mobile, keyboard shortcuts: Ctrl K new thread, / focus, Esc stop)
test/          node:test suites
scripts/       seed + eval
```

Data lives in `data/agent.db` (delete it to reset memory).
