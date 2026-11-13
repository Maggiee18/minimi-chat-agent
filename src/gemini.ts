import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, Msg, SystemBlock, Tool, TurnResult } from "./model.js";

/**
 * Google Gemini over its native REST API (streamGenerateContent).
 *
 * Why native and not Gemini's OpenAI-compatible endpoint: AI Studio now issues "AQ."
 * auth keys, which the native endpoint accepts in the `x-goog-api-key` header but the
 * OpenAI-compatible endpoint rejects as a Bearer token.
 *
 * Like the other adapters, it maps Anthropic-shaped blocks in and out so the agent loop
 * doesn't know which provider it is talking to. The model's own `parts` (which carry
 * Gemini's thought signatures) are kept verbatim and sent back unchanged in the next
 * request, which Gemini 3 requires for tool calling.
 */

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Part = Record<string, any>;
interface Content { role: "user" | "model"; parts: Part[] }

export class GeminiModel implements ModelClient {
  private useThinkingConfig = true;
  private useJsonSchema = true;

  private answerModels: string[];
  private noteModels: string[];

  /** answerModel / noteModel may be comma separated lists: first is preferred, the rest are fallbacks. */
  constructor(private opts: { apiKey: string; answerModel: string; noteModel: string; thinkingLevel?: string; baseUrl?: string; headerTimeoutMs?: number }) {
    this.answerModels = opts.answerModel.split(",").map((m) => m.trim()).filter(Boolean);
    this.noteModels = opts.noteModel.split(",").map((m) => m.trim()).filter(Boolean);
  }

  /**
   * POST to the first healthy model in `models`. Gemini's free tier often answers 503
   * "high demand" for its newest model, or hangs without answering. Either way we move
   * on to the next model in the list, and remember the bad one for a few minutes so
   * the next question doesn't waste time on it again (a small circuit breaker).
   */
  private busyUntil = new Map<string, number>();
  private available?: Promise<Set<string> | null>;

  /**
   * Which models this key can actually use (GET /models), fetched once. Model names
   * change often and differ per account, so configured names that don't exist are
   * dropped instead of failing every turn with a 404. If listing fails, we trust the config.
   */
  private listModels(): Promise<Set<string> | null> {
    this.available ??= fetch(`${this.opts.baseUrl ?? BASE}?pageSize=1000`, { headers: { "x-goog-api-key": this.opts.apiKey }, signal: AbortSignal.timeout(8000) })
      .then(async (r) => {
        if (!r.ok) return null;
        const j = (await r.json()) as { models?: Array<{ name: string; supportedGenerationMethods?: string[] }> };
        const names = (j.models ?? [])
          .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
          .map((m) => m.name.replace(/^models\//, ""));
        return names.length ? new Set(names) : null;
      })
      .catch(() => null);
    return this.available;
  }

  /**
   * Configured models this key can use, in order, followed by every other text Flash
   * model the key can use (newest first, Flash before Flash-Lite) as extra backups.
   */
  private async resolve(models: string[], kind: "answer" | "note"): Promise<string[]> {
    const avail = await this.listModels();
    if (!avail) return models;
    const ok = models.filter((m) => avail.has(m));
    const version = (m: string) => parseFloat(m.replace(/^gemini-/, "")) || 0;
    const extras = [...avail]
      .filter((m) => /^gemini-[\d.]+-flash/.test(m) && !/image|tts|audio|live|transcribe|translate|embedding|native/.test(m) && !ok.includes(m))
      .sort((a, b) => (kind === "answer" ? Number(/lite/.test(a)) - Number(/lite/.test(b)) : 0) || version(b) - version(a));
    const all = [...ok, ...extras];
    if (!ok.length && all.length) console.warn(`[gemini] none of ${models.join(", ")} is available to this key; using ${all.slice(0, 3).join(", ")}`);
    return all.length ? all : models;
  }

  private async post(configured: string[], kind: "answer" | "note", method: string, build: (model: string) => Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const models = await this.resolve(configured, kind);
    const now = Date.now();
    const cooling = (m: string) => (this.busyUntil.get(m) ?? 0) >= now;
    // Healthy models first; ones that were busy recently still get a turn at the end.
    const order = [...models.filter((m) => !cooling(m)), ...models.filter(cooling)];
    let last: HttpError | undefined;
    let busy: HttpError | undefined; // a 503/timeout explains a failure better than a later 404
    for (const [i, model] of order.entries()) {
      const isLast = i === order.length - 1;
      const url = `${this.opts.baseUrl ?? BASE}/${encodeURIComponent(model)}:${method}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        // Give up waiting for the first byte after a while; otherwise Node waits 5 minutes.
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), this.opts.headerTimeoutMs ?? 20_000);
        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
            body: JSON.stringify(build(model)),
            signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
          });
        } catch (e) {
          if (signal?.aborted) throw e; // the user pressed stop
          last = new HttpError(504, `${model} did not respond in time`);
          break;
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) return res;
        const detail = await res.text();
        last = new HttpError(res.status, `${model} ${res.status}: ${detail.match(/"message":\s*"([^"]+)/)?.[1] ?? detail.slice(0, 200)}`);
        // Retry the same model only when there's nowhere else to go, and never for a used-up daily quota.
        const daily = res.status === 429 && /per day|PerDay/i.test(detail);
        if (isLast && attempt === 0 && !daily && (res.status === 429 || res.status >= 500)) { await new Promise((r) => setTimeout(r, res.status === 429 ? 2500 : 1000)); continue; }
        break;
      }
      if (last && (last.status >= 500 || last.status === 404 || last.status === 429)) {
        if (last.status !== 404) busy = last;
        // A missing model won't come back soon, a used-up daily quota comes back when Google
        // says so ("retry in 12h33m"), and a busy model might be fine in a few minutes.
        const wait = last.status === 404 ? 60 * 60_000 : retryAfterMs(last.message) ?? 3 * 60_000;
        this.busyUntil.set(model, Date.now() + wait);
        if (!isLast) console.warn(`[gemini] ${last.message}; switching to the next model`);
        continue;
      }
      throw last;
    }
    throw busy ?? last;
  }

  /** Retry once without an optional setting if this model/account rejects it. */
  private async postWithFallback(models: string[], kind: "answer" | "note", method: string, build: (model: string) => Record<string, unknown>, flag: "useThinkingConfig" | "useJsonSchema", signal?: AbortSignal) {
    try {
      return await this.post(models, kind, method, build, signal);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || !this[flag] || /api.key/i.test(e.message)) throw e;
      console.warn(`[gemini] ${flag} rejected, retrying without it: ${e.message.slice(0, 160)}`);
      this[flag] = false;
      return await this.post(models, kind, method, build, signal);
    }
  }

  async turn(req: { system: SystemBlock[]; messages: Msg[]; tools: Tool[]; allowTools: boolean }, onText: (d: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const build = (model: string) => {
      const body: Record<string, unknown> = {
        systemInstruction: { parts: [{ text: req.system.map((s) => s.text).join("\n\n") }] },
        contents: toGemini(req.messages),
        tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) }],
        toolConfig: { functionCallingConfig: { mode: req.allowTools ? "AUTO" : "NONE" } },
      };
      // thinkingLevel exists on Gemini 3+ only; older fallbacks use their defaults.
      if (this.useThinkingConfig && this.opts.thinkingLevel && !/gemini-[12]\./.test(model)) body.generationConfig = { thinkingConfig: { thinkingLevel: this.opts.thinkingLevel } };
      return body;
    };
    const res = await this.postWithFallback(this.answerModels, "answer", "streamGenerateContent?alt=sse", build, "useThinkingConfig", signal);

    const parts: Part[] = [];
    let text = "";
    let finish: string | undefined;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      // If the stream goes silent for 45s, stop waiting rather than hang the turn.
      let stall: NodeJS.Timeout | undefined;
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, rej) => { stall = setTimeout(() => { reader.cancel().catch(() => {}); rej(new HttpError(504, "Gemini stopped responding mid answer")); }, 45_000); }),
      ]).finally(() => clearTimeout(stall));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        let chunk: any;
        try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        for (const p of cand.content?.parts ?? []) {
          parts.push(p);
          if (typeof p.text === "string" && !p.thought) { text += p.text; onText(p.text); }
        }
        if (cand.finishReason) finish = cand.finishReason;
      }
    }

    const content: Anthropic.Messages.ContentBlock[] = [];
    if (text) content.push({ type: "text", text, citations: null } as Anthropic.Messages.TextBlock);
    const calls = parts.filter((p) => p.functionCall);
    calls.forEach((p, n) => {
      content.push({
        type: "tool_use",
        id: p.functionCall.id || `call_${n}_${Date.now().toString(36)}`,
        name: p.functionCall.name,
        input: p.functionCall.args ?? {},
        _hasId: !!p.functionCall.id,
        // The full model turn, signatures included, replayed verbatim next request.
        _geminiParts: n === 0 ? parts : undefined,
      } as unknown as Anthropic.Messages.ToolUseBlock);
    });
    if (!text && !calls.length && finish && finish !== "STOP") {
      throw new HttpError(502, `Gemini returned no answer (finishReason ${finish})`);
    }
    return { content, stopReason: calls.length ? "tool_use" : finish === "MAX_TOKENS" ? "max_tokens" : "end_turn" };
  }

  async json<T>(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<T> {
    const build = () => ({
      systemInstruction: { parts: [{ text: `${req.system}\nReply with one JSON object matching this schema and nothing else:\n${JSON.stringify(req.schema)}` }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: this.useJsonSchema
        ? { responseMimeType: "application/json", responseJsonSchema: req.schema }
        : { responseMimeType: "application/json" },
    });
    const res = await this.postWithFallback(this.noteModels, "note", "generateContent", build, "useJsonSchema");
    const json = (await res.json()) as any;
    const out: string = (json.candidates?.[0]?.content?.parts ?? []).filter((p: Part) => !p.thought).map((p: Part) => p.text ?? "").join("");
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as T;
  }
}

/** Parse Google's "Please retry in 12h33m45.7s" / "retry in 41s" hint. */
export function retryAfterMs(message: string): number | null {
  const m = message.match(/retry in\s+(?:(\d+)h)?(?:(\d+)m(?!s))?(?:([\d.]+)s)?/i);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
}

/** Anthropic-shaped messages → Gemini `contents`. */
export function toGemini(messages: Msg[]): Content[] {
  const out: Content[] = [];
  const toolNames = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      const blocks = m.content as any[];
      for (const b of blocks) if (b.type === "tool_use") toolNames.set(b.id, b._hasId ? `${b.name}\u0000id` : b.name);
      const raw = blocks.find((b) => b._geminiParts)?._geminiParts;
      if (raw) { out.push({ role: "model", parts: raw }); continue; }
      const parts: Part[] = [];
      for (const b of blocks) {
        if (b.type === "text" && b.text) parts.push({ text: b.text });
        if (b.type === "tool_use") parts.push({ functionCall: { name: b.name, args: b.input } });
      }
      out.push({ role: "model", parts });
    } else {
      const parts: Part[] = [];
      for (const b of m.content as any[]) {
        if (b.type === "tool_result") {
          const result = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
          const [name, hasId] = (toolNames.get(b.tool_use_id) ?? "web_search").split("\u0000");
          parts.push({ functionResponse: { ...(hasId ? { id: b.tool_use_id } : {}), name, response: b.is_error ? { error: result } : { result } } });
        } else if (b.type === "text") parts.push({ text: b.text });
      }
      out.push({ role: "user", parts });
    }
  }
  return out;
}
