import dotenv from "dotenv";
dotenv.config({ quiet: true });

/**
 * All tunables live here so the rest of the code never reads process.env directly.
 * Defaults are chosen for latency first: Sonnet answers, Haiku does background bookkeeping.
 */
const env = (k: string) => (process.env[k] ?? "").trim();

/**
 * Model backends. Every backend whose key is set is used, in this order, as a fallback
 * chain: when one is out of quota or overloaded, the next one answers.
 *   PROVIDER picks which goes first (default: the first one with a key).
 *   ANSWER_MODEL / NOTE_MODEL override the models of that first backend only.
 */
type Kind = "anthropic" | "gemini" | "groq" | "openrouter" | "openai";
const ORDER: Kind[] = ["anthropic", "gemini", "groq", "openrouter", "openai"];
const keyFor: Record<Kind, string> = {
  anthropic: env("ANTHROPIC_API_KEY"),
  gemini: env("GEMINI_API_KEY"),
  groq: env("GROQ_API_KEY"),
  openrouter: env("OPENROUTER_API_KEY"),
  openai: env("OPENAI_API_KEY"),
};
const DEFAULTS: Record<Kind, { answer: string; note: string; baseUrl?: string }> = {
  anthropic: { answer: "claude-sonnet-5-5", note: "claude-haiku-5-5" },
  // Flash writes answers; Flash-Lite (bigger free quota) does background bookkeeping and
  // is the last resort for answers. Any other Flash model the key can use is added after these.
  gemini: { answer: "gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite", note: "gemini-3.1-flash-lite,gemini-3.5-flash-lite" },
  // Free tiers with ~1,000 requests/day per model and tool calling.
  groq: { answer: "openai/gpt-oss-120b,qwen/qwen3.8-27b,openai/gpt-oss-20b", note: "openai/gpt-oss-20b", baseUrl: "https://api.groq.com/openai/v1" },
  // "openrouter/free" routes to whichever free model supports the features the request needs.
  openrouter: { answer: "openrouter/free", note: "openrouter/free", baseUrl: "https://openrouter.ai/api/v1" },
  openai: { answer: env("ANSWER_MODEL"), note: env("NOTE_MODEL") || env("ANSWER_MODEL"), baseUrl: env("OPENAI_BASE_URL") },
};
const primary = (env("PROVIDER") as Kind) || ORDER.find((k) => keyFor[k]) || "anthropic";
const backends = [primary, ...ORDER.filter((k) => k !== primary)]
  .filter((k) => keyFor[k] && (k !== "openai" || (DEFAULTS.openai.baseUrl && DEFAULTS.openai.answer)))
  .map((kind) => ({
    kind,
    key: keyFor[kind],
    baseUrl: DEFAULTS[kind].baseUrl ?? "",
    answer: (kind === primary && env("ANSWER_MODEL")) || DEFAULTS[kind].answer,
    note: (kind === primary && env("NOTE_MODEL")) || DEFAULTS[kind].note,
  }));
const first = backends[0];

export const config = {
  port: Number(process.env.PORT ?? 3000),
  backends,
  provider: first?.kind ?? primary,
  tavilyKey: env("TAVILY_API_KEY"),

  // Main model of the first backend: writes answers and decides when/what to search.
  answerModel: first?.answer ?? DEFAULTS.anthropic.answer,
  // Small model: off the hot path (memory notes, titles, suggestions). Never blocks a reply.
  noteModel: first?.note ?? DEFAULTS.anthropic.note,
  // "between_tools" = no up-front thinking (fast first token / first search),
  // but the model may still think after reading search results.
  thinking: (process.env.THINKING ?? "between_tools") as "between_tools" | "adaptive" | "off",
  effort: (process.env.EFFORT ?? "medium") as "low" | "medium" | "high",

  maxSearchRounds: Number(process.env.MAX_SEARCH_ROUNDS ?? 4),
  searchResultsPerQuery: 6,
  searchCacheTtlMs: 15 * 60 * 1000,
  searchTimeoutMs: 12_000,

  dbPath: process.env.DB_PATH ?? "data/agent.db",
};

export function assertKeys() {
  const missing = [
    !backends.length && "a model key: GEMINI_API_KEY or GROQ_API_KEY (free), or ANTHROPIC_API_KEY",
    !config.tavilyKey && "TAVILY_API_KEY",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`\nMissing ${missing.join(" and ")} in .env (see .env.example).\n`);
    process.exit(1);
  }
}
