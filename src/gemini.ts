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
  constructor(private opts: { apiKey: string; answerModel: string; noteModel: string; thinkingLevel?: string; baseUrl?: string }) {
    this.answerModels = opts.answerModel.split(",").map((m) => m.trim()).filter(Boolean);
    this.noteModels = opts.noteModel.split(",").map((m) => m.trim()).filter(Boolean);
  }

  /**
   * POST to the first model in `models` that answers. Gemini's free tier often returns
   * 503 "high demand" for its newest model, so on 503/404 we fall through to the next
   * model in the list (e.g. 3.8 Flash → 3.6 Flash → 2.5 Flash) instead of failing the turn.
   */
  private async post(models: string[], method: string, build: (model: string) => Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let last: HttpError | undefined;
    for (const model of models) {
      const url = `${this.opts.baseUrl ?? BASE}/${encodeURIComponent(model)}:${method}`;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": this.opts.apiKey },
          body: JSON.stringify(build(model)),
          signal,
        });
        if (res.ok) return res;
        last = new HttpError(res.status, `${model} ${res.status}: ${(await res.text()).slice(0, 400)}`);
        if (res.status === 429 && attempt === 0) { await new Promise((r) => setTimeout(r, 2500)); continue; }
        if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
        break;
      }
      if (last && (last.status >= 500 || last.status === 404 || last.status === 429)) {
        console.warn(`[gemini] ${last.message.split("\n")[0].slice(0, 120)}; trying next model`);
        continue;
      }
      throw last;
    }
    throw last;
  }

  /** Retry once without an optional setting if this model/account rejects it. */
  private async postWithFallback(models: string[], method: string, build: (model: string) => Record<string, unknown>, flag: "useThinkingConfig" | "useJsonSchema", signal?: AbortSignal) {
    try {
      return await this.post(models, method, build, signal);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || !this[flag] || /api.key/i.test(e.message)) throw e;
      console.warn(`[gemini] ${flag} rejected, retrying without it: ${e.message.slice(0, 160)}`);
      this[flag] = false;
      return await this.post(models, method, build, signal);
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
    const res = await this.postWithFallback(this.answerModels, "streamGenerateContent?alt=sse", build, "useThinkingConfig", signal);

    const parts: Part[] = [];
    let text = "";
    let finish: string | undefined;
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
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
    const res = await this.postWithFallback(this.noteModels, "generateContent", build, "useJsonSchema");
    const json = (await res.json()) as any;
    const out: string = (json.candidates?.[0]?.content?.parts ?? []).filter((p: Part) => !p.thought).map((p: Part) => p.text ?? "").join("");
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as T;
  }
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
