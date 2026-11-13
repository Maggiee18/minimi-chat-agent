import { createHash } from "node:crypto";
import type { Store } from "./db.js";

/**
 * The agent's single tool. Thin wrapper over Tavily with three jobs:
 *  1. expose the knobs that matter for "has X changed since Monday?" (a since-date,
 *     news vs general, domain pinning) and nothing else, so the model can't misuse them;
 *  2. cache identical queries for 15 minutes (follow-ups often repeat a search);
 *  3. fail soft: a search error becomes a tool result the model can talk about,
 *     never a crashed turn.
 */

export interface SearchArgs {
  query: string;
  since?: string; // YYYY-MM-DD
  topic?: "general" | "news";
  domains?: string[];
  depth?: "basic" | "advanced";
}

export interface SearchHit {
  url: string;
  title: string;
  content: string;
  published?: string | null;
  score?: number;
}

export interface SearchProvider {
  search(args: SearchArgs): Promise<SearchHit[]>;
}

export const searchToolSchema = {
  name: "web_search",
  description: [
    "Search the live web. Returns numbered results with title, URL, publish date (when known) and the relevant page text.",
    "Use it for anything that could have changed since your training data: prices, plans, releases, news, people in roles, availability, versions, laws.",
    "Call it several times in one turn (in parallel) when a question covers several entities, e.g. one query per product.",
    "Tips: put the product/company name and the specific fact in the query ('Pipedrive pricing per user 2026').",
    "`since` restricts to pages published on/after a date: great for news ('what did X ship since 2026-11-09'),",
    "but pricing pages often carry no date, so for 'did the price change' also run one query WITHOUT `since` to read the current price.",
  ].join(" "),
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Search query, specific and keyword-rich." },
      since: { type: "string", description: "Optional YYYY-MM-DD. Only results published on/after this date." },
      topic: { type: "string", enum: ["general", "news"], description: "'news' for announcements, launches, funding, outages. Default general." },
      domains: { type: "array", items: { type: "string" }, description: "Optional list of domains to restrict to, e.g. ['hubspot.com'] for an official pricing page." },
      depth: { type: "string", enum: ["basic", "advanced"], description: "'advanced' is slower but reads pages more deeply. Use for detailed pricing/spec tables." },
    },
    required: ["query"],
  },
};

export class TavilySearch implements SearchProvider {
  constructor(private apiKey: string, private opts: { maxResults: number; timeoutMs: number }) {}

  async search(args: SearchArgs): Promise<SearchHit[]> {
    const body: Record<string, unknown> = {
      query: args.query,
      topic: args.topic ?? "general",
      search_depth: args.depth ?? "basic",
      max_results: this.opts.maxResults,
      include_published_date: true,
      include_answer: false, // we want sources, not someone else's summary
    };
    if (args.depth === "advanced") body.chunks_per_source = 3;
    if (args.since && /^\d{4}-\d{2}-\d{2}$/.test(args.since)) body.start_date = args.since;
    if (args.domains?.length) body.include_domains = args.domains.slice(0, 10);

    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`Tavily ${res.status}`);
        if (!res.ok) throw Object.assign(new Error(`Tavily ${res.status}: ${(await res.text()).slice(0, 200)}`), { fatal: true });
        const json = (await res.json()) as { results?: any[] };
        return (json.results ?? []).map((r) => ({
          url: r.url,
          title: r.title ?? r.url,
          content: String(r.content ?? ""),
          published: r.published_date ?? null,
          score: r.score,
        }));
      } catch (e: any) {
        lastErr = e;
        if (e?.fatal) break;
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    throw lastErr;
  }
}

/** Wraps any provider with a SQLite cache keyed on normalised args. */
export class CachedSearch implements SearchProvider {
  constructor(private inner: SearchProvider, private store: Store, private ttlMs: number) {}

  async search(args: SearchArgs): Promise<SearchHit[]> {
    const norm = { ...args, query: args.query.trim().toLowerCase().replace(/\s+/g, " ") };
    const key = createHash("sha1").update(JSON.stringify(norm)).digest("hex");
    const hit = this.store.cacheGet(key, this.ttlMs);
    if (hit) return JSON.parse(hit);
    const out = await this.inner.search(args);
    this.store.cacheSet(key, JSON.stringify(out));
    return out;
  }
}
