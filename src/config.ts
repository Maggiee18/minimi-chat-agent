import dotenv from "dotenv";
dotenv.config({ quiet: true });

/**
 * All tunables live here so the rest of the code never reads process.env directly.
 * Defaults are chosen for latency first: Sonnet answers, Haiku does background bookkeeping.
 */
const env = (k: string) => (process.env[k] ?? "").trim();

/**
 * Provider: Anthropic (default when its key is set) or Google Gemini's free tier
 * (native API). Any OpenAI-compatible API (Groq, OpenRouter, Ollama…) works via
 * PROVIDER=openai + OPENAI_BASE_URL.
 */
const provider = (env("PROVIDER") || (env("ANTHROPIC_API_KEY") ? "anthropic" : env("GEMINI_API_KEY") ? "gemini" : "anthropic")) as "anthropic" | "gemini" | "openai";
const defaults = {
  anthropic: { answer: "claude-sonnet-5-5", note: "claude-haiku-5-5" },
  // Flash writes answers; Flash-Lite (bigger free quota) does the background bookkeeping.
  // Later entries are fallbacks for when the free tier says "high demand" (503).
  gemini: { answer: "gemini-3.8-flash,gemini-3.6-flash,gemini-2.5-flash", note: "gemini-3.1-flash-lite,gemini-2.5-flash-lite" },
  openai: { answer: env("ANSWER_MODEL"), note: env("NOTE_MODEL") || env("ANSWER_MODEL") },
}[provider];

export const config = {
  port: Number(process.env.PORT ?? 3000),
  provider,
  anthropicKey: env("ANTHROPIC_API_KEY"),
  geminiKey: env("GEMINI_API_KEY"),
  openaiKey: env("OPENAI_API_KEY"),
  openaiBaseUrl: env("OPENAI_BASE_URL"),
  tavilyKey: env("TAVILY_API_KEY"),

  // Main model: writes every answer and decides when/what to search.
  answerModel: env("ANSWER_MODEL") || defaults.answer,
  // Small model: off the hot path (memory notes, titles, suggestions). Never blocks a reply.
  noteModel: env("NOTE_MODEL") || defaults.note,
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
  const modelKey = { anthropic: config.anthropicKey, gemini: config.geminiKey, openai: config.openaiKey }[config.provider];
  const missing = [
    !modelKey && (config.provider === "anthropic" ? "ANTHROPIC_API_KEY (or a free GEMINI_API_KEY)" : config.provider === "gemini" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"),
    !config.tavilyKey && "TAVILY_API_KEY",
    config.provider === "openai" && !config.openaiBaseUrl && "OPENAI_BASE_URL",
    config.provider === "openai" && !config.answerModel && "ANSWER_MODEL",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`\nMissing ${missing.join(", ")} in .env (see .env.example).\n`);
    process.exit(1);
  }
}
