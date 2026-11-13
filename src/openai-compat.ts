import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, Msg, SystemBlock, Tool, TurnResult } from "./model.js";

/**
 * Adapter for any OpenAI-compatible chat API. Its main use is Google Gemini's free
 * tier (https://generativelanguage.googleapis.com/v1beta/openai/), but Groq,
 * OpenRouter, a local Ollama etc. speak the same protocol.
 *
 * The agent loop is written against Anthropic-shaped blocks (text / tool_use /
 * tool_result). This class translates those to OpenAI messages on the way out and
 * back on the way in, so the loop, memory and tests don't change per provider.
 */

interface OAToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [extra: string]: unknown; // Gemini 3 returns thought signatures here and requires them back
}
type OAMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class OpenAICompatModel implements ModelClient {
  private jsonFormatSupported = true;

  constructor(private opts: { baseUrl: string; apiKey: string; answerModel: string; noteModel: string; reasoningEffort?: string }) {}

  private async post(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let res!: Response;
    for (let attempt = 0; attempt < 2; attempt++) {
      // Stop waiting for a reply that hasn't started after 25s (Node would wait 5 minutes).
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 25_000);
      try {
      res = await fetch(this.opts.baseUrl.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          // OpenRouter asks apps to identify themselves; other providers ignore these.
          "http-referer": "http://localhost",
          "x-title": "minimi chat agent",
        },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
      });
      } catch (e) {
        if (signal?.aborted) throw e;
        throw new HttpError(504, `${String(body.model)} did not respond in time`);
      } finally {
        clearTimeout(timer);
      }
      // Free tiers rate limit hard; one or two short retries smooth over per-minute limits.
      // One quick retry for a blip; anything longer is the fallback chain's job.
      if (res.status >= 500 && attempt === 0) { await new Promise((r) => setTimeout(r, 800)); continue; }
      break;
    }
    if (!res.ok) throw new HttpError(res.status, `${String(body.model)} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res;
  }

  async turn(req: { system: SystemBlock[]; messages: Msg[]; tools: Tool[]; allowTools: boolean }, onText: (d: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const body: Record<string, unknown> = {
      model: this.opts.answerModel,
      stream: true,
      messages: toOpenAI(req.system, req.messages),
      tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
      tool_choice: req.allowTools ? "auto" : "none",
    };
    if (this.opts.reasoningEffort) body.reasoning_effort = this.opts.reasoningEffort;
    const res = await this.post(body, signal);

    let text = "";
    let finish: string | null = null;
    const calls: OAToolCall[] = [];
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
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        let chunk: any;
        try { chunk = JSON.parse(data); } catch { continue; }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) { text += delta.content; onText(delta.content); }
        for (const tc of delta.tool_calls ?? []) mergeToolCall(calls, tc);
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }

    const content: Anthropic.Messages.ContentBlock[] = [];
    if (text) content.push({ type: "text", text, citations: null } as Anthropic.Messages.TextBlock);
    for (const c of calls) {
      let input: unknown = {};
      try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = { query: c.function.arguments }; }
      // `_raw` rides along untouched through the agent loop so we can echo it back exactly.
      content.push({ type: "tool_use", id: c.id, name: c.function.name, input, _raw: c } as unknown as Anthropic.Messages.ToolUseBlock);
    }
    // Some providers report "stop" even when they called a tool, so trust the calls.
    return { content, stopReason: calls.length ? "tool_use" : finish === "length" ? "max_tokens" : "end_turn" };
  }

  async json<T>(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<T> {
    const messages = [
      { role: "system", content: `${req.system}\nReply with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(req.schema)}` },
      { role: "user", content: req.prompt },
    ];
    const body: Record<string, unknown> = { model: this.opts.noteModel, messages };
    if (this.jsonFormatSupported) body.response_format = { type: "json_schema", json_schema: { name: "output", schema: req.schema } };
    let res: Response;
    try {
      res = await this.post(body);
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 400 || !this.jsonFormatSupported) throw e;
      this.jsonFormatSupported = false; // fall back to prompt-only JSON
      delete body.response_format;
      res = await this.post(body);
    }
    const json = (await res.json()) as any;
    const out: string = json.choices?.[0]?.message?.content ?? "";
    return JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as T;
  }
}

function mergeToolCall(calls: OAToolCall[], tc: any) {
  const idx = typeof tc.index === "number" ? tc.index : calls.length;
  const cur = (calls[idx] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
  const { index: _i, id, type: _t, function: fn, ...extra } = tc;
  if (id) cur.id = id;
  if (fn?.name) cur.function.name += fn.name;
  if (fn?.arguments) cur.function.arguments += fn.arguments;
  Object.assign(cur, extra);
  if (!cur.id) cur.id = `call_${idx}_${Date.now().toString(36)}`;
}

/** Anthropic-shaped system + messages → OpenAI chat messages. */
export function toOpenAI(system: SystemBlock[], messages: Msg[]): OAMessage[] {
  const out: OAMessage[] = [{ role: "system", content: system.map((s) => s.text).join("\n\n") }];
  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content } as OAMessage); continue; }
    if (m.role === "assistant") {
      const text = m.content.map((b: any) => (b.type === "text" ? b.text : "")).join("");
      const tool_calls = m.content.filter((b: any) => b.type === "tool_use").map((b: any): OAToolCall =>
        b._raw ? { ...b._raw, id: b.id } : { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } });
      out.push({ role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) });
    } else {
      const texts: string[] = [];
      for (const b of m.content as any[]) {
        if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
        else if (b.type === "text") texts.push(b.text);
      }
      if (texts.length) out.push({ role: "user", content: texts.join("\n") });
    }
  }
  return out;
}
