import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { openDb, Store } from "./db.js";
import { FallbackModel, type Backend } from "./fallback.js";
import { GeminiModel } from "./gemini.js";
import { AnthropicModel } from "./model.js";
import { OpenAICompatModel } from "./openai-compat.js";
import { CachedSearch, TavilySearch } from "./search.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** One entry per backend in config.backends; OpenAI-style providers get one entry per model. */
export function buildBackends(): Backend[] {
  const out: Backend[] = [];
  for (const b of config.backends) {
    if (b.kind === "anthropic") {
      out.push({ name: "claude", client: new AnthropicModel(b.key, { answer: list(b.answer)[0], note: list(b.note)[0] }) });
    } else if (b.kind === "gemini") {
      // Gemini 3 always thinks; "low" keeps the first search fast. It manages its own model list.
      out.push({ name: "gemini", client: new GeminiModel({ apiKey: b.key, answerModel: b.answer, noteModel: b.note, thinkingLevel: "low" }) });
    } else {
      for (const m of list(b.answer)) {
        out.push({ name: `${b.kind}:${m}`, client: new OpenAICompatModel({ baseUrl: b.baseUrl, apiKey: b.key, answerModel: m, noteModel: list(b.note)[0] ?? m }) });
      }
    }
  }
  return out;
}

/** Real dependencies, shared by the server and the seed/eval scripts. */
export function realDeps(dbPath = config.dbPath) {
  const store = new Store(openDb(path.resolve(root, dbPath)));
  const backends = buildBackends();
  const model = backends.length === 1 ? backends[0].client : new FallbackModel(backends);
  const search = new CachedSearch(
    new TavilySearch(config.tavilyKey, { maxResults: config.searchResultsPerQuery, timeoutMs: config.searchTimeoutMs }),
    store,
    config.searchCacheTtlMs,
  );
  return { store, model, search, maxRounds: config.maxSearchRounds, backendNames: backends.map((b) => b.name) };
}
