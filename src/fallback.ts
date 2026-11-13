import type { ModelClient, TurnResult } from "./model.js";
import { retryAfterMs } from "./gemini.js";

/**
 * Chains several model backends (Claude, Gemini, Groq, OpenRouter…) behind one
 * ModelClient. Free tiers run out or get overloaded all the time; when one backend
 * fails, the turn quietly moves to the next instead of showing the user an error.
 *
 * Rules:
 *  - A failed backend "cools down" (for as long as the provider asks, else 3 minutes,
 *    or an hour for a bad key / unknown model) and is tried last until then.
 *  - Never switch once the user has started seeing text from a backend: that would
 *    print a second, different answer on top of the first.
 *  - A stop from the user is never treated as a failure.
 */

export interface Backend {
  name: string; // shown in logs, e.g. "gemini" or "groq:openai/gpt-oss-120b"
  client: ModelClient;
}

export class FallbackModel implements ModelClient {
  private coolUntil = new Map<string, number>();

  constructor(private backends: Backend[], private log: (msg: string) => void = (m) => console.warn(m)) {
    if (!backends.length) throw new Error("FallbackModel needs at least one backend");
  }

  private order(): Backend[] {
    const now = Date.now();
    const cool = (b: Backend) => (this.coolUntil.get(b.name) ?? 0) > now;
    return [...this.backends.filter((b) => !cool(b)), ...this.backends.filter(cool)];
  }

  private failed(b: Backend, e: any) {
    const status = e?.status as number | undefined;
    const msg = String(e?.message ?? e);
    // A malformed reply is a one-off, not an outage: don't bench the backend for it.
    if (e instanceof SyntaxError) return `${b.name} returned malformed output`;
    const wait = status === 401 || status === 403 || status === 404 ? 60 * 60_000 : retryAfterMs(msg) ?? 3 * 60_000;
    this.coolUntil.set(b.name, Date.now() + wait);
    return `${b.name} failed (${status ?? "network"}: ${msg.replace(/\s+/g, " ").slice(0, 140)})`;
  }

  /** Prefer the error that best explains the outage: quota > overload > anything else. */
  private pick(errors: any[]) {
    const rank = (e: any) => (e?.status === 429 ? 3 : e?.status >= 500 ? 2 : 1);
    return errors.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  }

  async turn(req: Parameters<ModelClient["turn"]>[0], onText: (d: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const errors: any[] = [];
    const order = this.order();
    for (const [i, b] of order.entries()) {
      let streamed = false;
      try {
        return await b.client.turn(req, (d) => { streamed = true; onText(d); }, signal);
      } catch (e) {
        if (signal?.aborted || streamed) throw e;
        errors.push(e);
        const why = this.failed(b, e);
        if (i < order.length - 1) this.log(`[models] ${why}; trying ${order[i + 1].name}`);
        else this.log(`[models] ${why}; no backends left`);
      }
    }
    throw this.pick(errors);
  }

  async json<T>(req: Parameters<ModelClient["json"]>[0]): Promise<T> {
    const errors: any[] = [];
    for (const b of this.order()) {
      try {
        return await b.client.json<T>(req);
      } catch (e) {
        errors.push(e);
        this.failed(b, e);
      }
    }
    throw this.pick(errors);
  }
}
