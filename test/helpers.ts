import { openDb, Store } from "../src/db.js";
import type { ModelClient, TurnResult } from "../src/model.js";
import type { SearchArgs, SearchHit, SearchProvider } from "../src/search.js";

export const TZ = "Asia/Kolkata";
export const at = (iso: string) => new Date(iso);

export function memStore() {
  return new Store(openDb(":memory:"));
}

/** Scripted model: returns the queued turns in order and records every request. */
export class FakeModel implements ModelClient {
  requests: any[] = [];
  constructor(private script: TurnResult[], private notes: any = { topic: "t", summary: "s", entities: [], claims: [] }) {}
  async turn(req: any, onText: (d: string) => void) {
    this.requests.push(structuredClone(req));
    const next = this.script.shift();
    if (!next) throw new Error("FakeModel ran out of script");
    for (const b of next.content) if (b.type === "text") onText(b.text);
    return next;
  }
  async json<T>(req?: any) {
    if (req?.schema?.required?.includes("questions")) return { questions: ["Next one?", "And another?", "Third?"] } as T;
    return this.notes as T;
  }
}

export class FakeSearch implements SearchProvider {
  calls: SearchArgs[] = [];
  constructor(private hits: (a: SearchArgs) => SearchHit[]) {}
  async search(a: SearchArgs) {
    this.calls.push(a);
    return this.hits(a);
  }
}

export const text = (t: string): TurnResult => ({ content: [{ type: "text", text: t, citations: null } as any], stopReason: "end_turn" });
export const toolCalls = (...qs: Array<Partial<SearchArgs> & { query: string }>): TurnResult => ({
  content: qs.map((q, i) => ({ type: "tool_use", id: `tu_${i}_${q.query.length}`, name: "web_search", input: q }) as any),
  stopReason: "tool_use",
});
