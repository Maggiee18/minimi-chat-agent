import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { openDb, Store } from "./db.js";
import { AnthropicModel, type ModelClient } from "./model.js";
import { OpenAICompatModel } from "./openai-compat.js";
import { GeminiModel } from "./gemini.js";
import { CachedSearch, TavilySearch } from "./search.js";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Real dependencies, shared by the server and the seed/eval scripts. */
export function realDeps(dbPath = config.dbPath) {
  const store = new Store(openDb(path.resolve(root, dbPath)));
  const model: ModelClient =
    config.provider === "anthropic"
      ? new AnthropicModel(config.anthropicKey)
      : config.provider === "gemini"
        // Gemini 3 always thinks; "low" keeps the first search fast.
        ? new GeminiModel({ apiKey: config.geminiKey, answerModel: config.answerModel, noteModel: config.noteModel, thinkingLevel: "low" })
        : new OpenAICompatModel({ baseUrl: config.openaiBaseUrl, apiKey: config.openaiKey, answerModel: config.answerModel, noteModel: config.noteModel });
  const search = new CachedSearch(
    new TavilySearch(config.tavilyKey, { maxResults: config.searchResultsPerQuery, timeoutMs: config.searchTimeoutMs }),
    store,
    config.searchCacheTtlMs,
  );
  return { store, model, search, maxRounds: config.maxSearchRounds };
}
