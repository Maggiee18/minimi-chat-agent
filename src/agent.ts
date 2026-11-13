import type { Source, Store } from "./db.js";
import { buildRecall } from "./memory.js";
import type { Block, ModelClient, Msg } from "./model.js";
import { writeNotes } from "./notes.js";
import { suggestFollowups } from "./followups.js";
import { dynamicContext, STATIC_PROMPT } from "./prompt.js";
import { searchToolSchema, type SearchArgs, type SearchProvider } from "./search.js";
import { formatDateTime, formatDay } from "./time.js";

/**
 * One user turn, end to end:
 *
 *   recall (code, ~1ms) → model streams; may call web_search (parallel) → model reads
 *   results, may search again (≤ N rounds) → final answer streams → save → notes (async)
 *
 * Everything the UI shows comes from `emit`, so the browser sees progress the moment
 * it happens: what was recalled, each search as it fires, sources as they land, text.
 */

export type AgentEvent =
  | { type: "recall"; recall: RecallSummary }
  | { type: "search"; id: string; query: string; since?: string }
  | { type: "search_done"; id: string; count: number; error?: string }
  | { type: "sources"; sources: Source[] }
  | { type: "text"; delta: string }
  | { type: "retract" } // text streamed before a tool call was a preamble, not the answer
  | { type: "done"; exchangeId: number; latencyMs: number; firstTokenMs: number | null; searches: number; cited: number[] }
  | { type: "followups"; questions: string[] }
  | { type: "error"; message: string };

/** What the UI shows about memory for one turn; also stored with the exchange so it survives reloads. */
export interface RecallSummary {
  items: Array<{ at: number; date: string; question: string; why: string }>;
  ranges: Array<{ phrase: string; label: string; empty: boolean }>;
}

export interface AgentDeps {
  store: Store;
  model: ModelClient;
  search: SearchProvider;
  maxRounds: number;
  /** Background work (memory notes). Tests can await it; the server lets it float. */
  background?: (p: Promise<unknown>) => void;
}

export interface TurnInput {
  conversationId: string;
  message: string;
  tz: string;
  now?: Date;
  signal?: AbortSignal;
}

const MAX_RESULT_CHARS = 1200;

export async function runTurn(deps: AgentDeps, input: TurnInput, emit: (e: AgentEvent) => void): Promise<number> {
  const { store, model, search } = deps;
  const now = input.now ?? new Date();
  const t0 = Date.now();
  let firstTokenMs: number | null = null;
  store.ensureConversation(input.conversationId, now.getTime());

  // 1. Conversation so far, as plain text turns. Old tool results are not replayed:
  //    the answer text (with its source list) carries what mattered, at a fraction of the tokens.
  const messages: Msg[] = [];
  const history = store.conversationExchanges(input.conversationId, 10);
  for (const ex of history) {
    // Stamp turns from earlier days so "is that still true?" inside a long-lived thread knows when "that" was.
    const stale = now.getTime() - ex.createdAt > 6 * 3_600_000;
    messages.push({ role: "user", content: stale ? `(sent ${formatDateTime(new Date(ex.createdAt), input.tz)})\n${ex.userText}` : ex.userText });
    const srcs = ex.sources.slice(0, 8).map((s) => `[${s.n}] ${s.title} — ${s.url}`).join("\n");
    messages.push({ role: "assistant", content: srcs ? `${ex.answer}\n\nSources:\n${srcs}` : ex.answer });
  }
  messages.push({ role: "user", content: input.message });

  // 2. Recall: decided by code before the model runs.
  const recall = buildRecall(store, input.message, now, input.tz, new Set(history.map((h) => h.id)));
  const recallSummary: RecallSummary = {
    ranges: recall.ranges.map((r) => ({ phrase: r.phrase, label: r.label, empty: recall.emptyRanges.includes(r) })),
    items: recall.items.map((i) => ({ at: i.exchange.createdAt, date: formatDay(new Date(i.exchange.createdAt), input.tz), question: i.exchange.userText, why: i.why })),
  };
  if (recallSummary.items.length || recallSummary.ranges.length) emit({ type: "recall", recall: recallSummary });

  const system = [
    { type: "text" as const, text: STATIC_PROMPT, cache_control: { type: "ephemeral" as const } },
    { type: "text" as const, text: dynamicContext(now, input.tz, recall.block) },
  ];

  // 3. The loop.
  const sources: Source[] = [];
  const byUrl = new Map<string, Source>();
  const searches: string[] = [];
  let answer = "";

  for (let round = 0; round < deps.maxRounds; round++) {
    const lastRound = round === deps.maxRounds - 1;
    let roundText = "";
    const res = await model.turn(
      { system, messages, tools: [searchToolSchema], allowTools: !lastRound },
      (d) => {
        if (firstTokenMs === null) firstTokenMs = Date.now() - t0;
        roundText += d;
        emit({ type: "text", delta: d });
      },
      input.signal,
    );

    const calls = res.content.filter((b): b is Extract<typeof b, { type: "tool_use" }> => b.type === "tool_use");
    if (res.stopReason !== "tool_use" || calls.length === 0) {
      answer = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      break;
    }
    if (roundText) emit({ type: "retract" });

    // All searches from this step run in parallel.
    const results = await Promise.all(
      calls.map(async (call): Promise<Block> => {
        const args = call.input as SearchArgs;
        searches.push(args.query);
        emit({ type: "search", id: call.id, query: args.query, since: args.since });
        try {
          const hits = await search.search(args);
          const lines: string[] = [];
          for (const h of hits) {
            let src = byUrl.get(h.url);
            if (!src) {
              src = { n: sources.length + 1, url: h.url, title: h.title, published: h.published ?? null, retrievedAt: now.getTime() };
              sources.push(src);
              byUrl.set(h.url, src);
            }
            const body = h.content.length > MAX_RESULT_CHARS ? h.content.slice(0, MAX_RESULT_CHARS) + " …" : h.content;
            lines.push(`[${src.n}] ${h.title}\nURL: ${h.url}\nPublished: ${h.published ? h.published.slice(0, 10) : "unknown"}\n${body}`);
          }
          emit({ type: "search_done", id: call.id, count: hits.length });
          const head = `Results for "${args.query}"${args.since ? ` since ${args.since}` : ""}:`;
          return {
            type: "tool_result",
            tool_use_id: call.id,
            content: hits.length ? `${head}\n\n${lines.join("\n\n")}` : `${head} none. Try a broader query${args.since ? " or drop `since`" : ""}.`,
          };
        } catch (e: any) {
          emit({ type: "search_done", id: call.id, count: 0, error: String(e?.message ?? e) });
          return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Search failed: ${e?.message ?? e}. Tell the user if this blocks the answer.` };
        }
      }),
    );
    emit({ type: "sources", sources });
    messages.push({ role: "assistant", content: res.content as Block[] });
    messages.push({ role: "user", content: results });
  }

  // 4. Persist. Only keep sources the answer actually cited, so memory reflects what was claimed.
  const cited = [...new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))].filter((n) => byUrl.size && sources[n - 1]);
  const kept = cited.length ? sources.filter((s) => cited.includes(s.n)) : sources;
  const latencyMs = Date.now() - t0;
  const exchangeId = store.addExchange({
    conversationId: input.conversationId,
    userText: input.message,
    answer,
    sources: kept,
    searches,
    recall: recallSummary,
    createdAt: now.getTime(),
    tz: input.tz,
    latencyMs,
  });
  emit({ type: "done", exchangeId, latencyMs, firstTokenMs, searches: searches.length, cited });

  const notes = writeNotes(store, model, exchangeId, input.conversationId, input.message, answer, kept, now, input.tz);
  (deps.background ?? (() => {}))(notes);

  // Suggestions arrive after "done": the answer is already complete on screen.
  if (answer && !input.signal?.aborted) {
    const questions = await suggestFollowups(model, input.message, answer);
    if (questions.length) emit({ type: "followups", questions });
  }
  return exchangeId;
}
