import type { Exchange, Store } from "./db.js";
import { formatDateTime, formatDay, isoDate, resolveTimeRefs, type TimeRange } from "./time.js";

/**
 * Recall = deciding which past exchanges the model should see for *this* message.
 *
 * It runs before the model is called, in plain code (~1ms), instead of being a tool
 * the model has to decide to call. Reasons:
 *  - The brief says the agent has one tool: web search. Memory is context, not a tool.
 *  - A recall tool costs a full model round trip before the real work starts.
 *  - Recall failures should be explicit ("nothing on 3 Nov") so the model can't
 *    paper over them. Code can guarantee that; a model choosing not to look cannot.
 */

export interface RecallItem {
  exchange: Exchange;
  why: "on-date" | "near-date" | "topic";
}

export interface Recall {
  ranges: TimeRange[];
  emptyRanges: TimeRange[];
  items: RecallItem[];
  block: string; // text injected into the system prompt
}

const MEMORY_CUE =
  /\b(i|we)\s+(asked|told|said|mentioned|discussed|talked|shortlisted|picked|chose|compared|looked|searched)\b|\byou\s+(said|told|recommended|suggested|mentioned|answered|found|gave)\b|\b(earlier|previously|last time|before|remember|recall|still (true|correct|right|valid)|since then|changed since|our)\b/i;

const STOP = new Set(
  `a an the and or but if of to in on at by for with from about as is are was were be been being do does did done
   have has had having i me my we our us you your yours it its they them their this that these those what which who
   whom when where why how any some all each both few more most other such no not only own same so than too very can
   will just should now then there here ask asked asking tell told said say says answer answered answers question
   still correct right true valid today yesterday tomorrow since changed change changes anything something
   last next week month year ago earlier before previously time again remember recall please could would
   monday tuesday wednesday thursday friday saturday sunday january february march april may june july
   august september october november december jan feb mar apr jun jul aug sep sept oct nov dec`.split(/\s+/),
);

export function keyTerms(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.add(w);
  }
  return [...out].slice(0, 12);
}

function overlap(e: Exchange, terms: string[]): number {
  const hay = `${e.userText} ${e.topic ?? ""} ${e.entities ?? ""} ${e.summary ?? ""}`.toLowerCase();
  return terms.filter((t) => hay.includes(t)).length;
}

/**
 * `inContext` = ids of exchanges already replayed as chat history this turn; they are
 * skipped so the model doesn't see the same exchange twice.
 */
export function buildRecall(store: Store, message: string, now: Date, tz: string, inContext: Set<number> = new Set()): Recall {
  const ranges = resolveTimeRefs(message, now, tz);
  const terms = keyTerms(message);
  const wantsMemory = ranges.length > 0 || MEMORY_CUE.test(message);
  const items: RecallItem[] = [];
  const seen = new Set<number>();
  const add = (exchange: Exchange, why: RecallItem["why"]) => {
    if (seen.has(exchange.id) || inContext.has(exchange.id)) return;
    seen.add(exchange.id);
    items.push({ exchange, why });
  };
  const emptyRanges: TimeRange[] = [];

  for (const r of ranges) {
    const hits = store.inRange(r.start.getTime(), r.end.getTime(), 30).filter((e) => !inContext.has(e.id));
    if (hits.length) {
      // Several things may have been discussed that day; put the on-topic ones first.
      hits.sort((a, b) => overlap(b, terms) - overlap(a, terms));
      hits.slice(0, 5).forEach((e) => add(e, "on-date"));
    } else {
      emptyRanges.push(r);
      // "Last Tuesday" is ambiguous (this week's or last week's?) and people misremember
      // days. Look a week back and a few days forward, but label it as not-that-day.
      const near = store.inRange(r.start.getTime() - 7 * 86_400_000, r.end.getTime() + 3 * 86_400_000, 30)
        .filter((e) => !inContext.has(e.id))
        .filter((e) => terms.length === 0 || overlap(e, terms) > 0)
        .sort((a, b) => overlap(b, terms) - overlap(a, terms));
      near.slice(0, 3).forEach((e) => add(e, "near-date"));
    }
  }

  if (wantsMemory && terms.length) {
    store.searchText(terms, 8).filter((e) => !inContext.has(e.id)).slice(0, 4).forEach((e) => add(e, "topic"));
  }

  const kept = items.slice(0, 6);
  return { ranges, emptyRanges, items: kept, block: renderBlock(store, kept, ranges, emptyRanges, now, tz, wantsMemory) };
}

function ago(then: number, now: Date): string {
  const days = Math.round((now.getTime() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function renderBlock(store: Store, items: RecallItem[], ranges: TimeRange[], emptyRanges: TimeRange[], now: Date, tz: string, wantsMemory: boolean): string {
  const lines: string[] = [];
  const stats = store.stats();
  lines.push(
    stats.count === 0
      ? "Memory: empty. There are no past conversations with this user yet."
      : `Memory: ${stats.count} past exchanges, the earliest on ${formatDay(new Date(stats.first!), tz)}.`,
  );
  for (const r of ranges) {
    lines.push(`Time reference "${r.phrase}" = ${r.label}${r.granularity === "day" ? ` (${isoDate(r.start, tz)})` : ""}. For searches "since" then, use ${isoDate(r.start, tz)}.`);
  }
  for (const r of emptyRanges) {
    lines.push(`NO exchanges with this user on ${r.label}. Do not invent what was said then.`);
  }
  if (!items.length) {
    if (wantsMemory) lines.push("No past exchanges match this message.");
    return lines.join("\n");
  }
  items.forEach((it, i) => {
    const e = it.exchange;
    const tag = it.why === "on-date" ? "on the requested date" : it.why === "near-date" ? "NOT on the requested date, but close and on topic" : "matched by topic";
    lines.push("");
    lines.push(`[M${i + 1}] ${formatDateTime(new Date(e.createdAt), tz)} (${ago(e.createdAt, now)}; ${tag})`);
    lines.push(`User asked: ${e.userText}`);
    if (e.summary) {
      lines.push(`What you answered (summary): ${e.summary}`);
      if (e.claims.length) {
        lines.push("Checkable claims you made then:");
        e.claims.slice(0, 10).forEach((c) => lines.push(`  - ${c.text}${c.source ? ` (source: ${c.source})` : ""}`));
      }
    } else {
      lines.push(`What you answered: ${e.answer.length > 1500 ? e.answer.slice(0, 1500) + " …" : e.answer}`);
    }
    if (e.sources.length) {
      lines.push(`Sources you used then (retrieved ${formatDay(new Date(e.sources[0].retrievedAt), tz)}):`);
      e.sources.slice(0, 8).forEach((s) => lines.push(`  - ${s.title} — ${s.url}${s.published ? ` (published ${s.published.slice(0, 10)})` : ""}`));
    }
  });
  return lines.join("\n");
}
