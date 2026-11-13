import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";

/**
 * The agent depends on this small interface, not on the SDK, so the loop can be
 * tested with a scripted fake (see test/agent.test.ts) and the provider swapped later.
 */

export type Block = Anthropic.Messages.ContentBlockParam;
export type Msg = Anthropic.Messages.MessageParam;
export type SystemBlock = Anthropic.Messages.TextBlockParam;
export type Tool = Anthropic.Messages.Tool;

export interface TurnResult {
  content: Anthropic.Messages.ContentBlock[];
  stopReason: string | null;
}

export interface ModelClient {
  /** One streamed model call. `onText` receives visible text deltas as they arrive. */
  turn(req: { system: SystemBlock[]; messages: Msg[]; tools: Tool[]; allowTools: boolean }, onText: (d: string) => void, signal?: AbortSignal): Promise<TurnResult>;
  /** Small, non-streamed JSON call for bookkeeping (memory notes). */
  json<T>(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<T>;
}

export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  // If the API rejects our thinking/effort settings (older model, different account),
  // drop them once and remember, rather than failing every turn.
  private useReasoningParams = config.thinking !== "off";

  constructor(apiKey: string, private models = { answer: config.answerModel, note: config.noteModel }) {
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  async turn(req: Parameters<ModelClient["turn"]>[0], onText: (d: string) => void, signal?: AbortSignal): Promise<TurnResult> {
    const run = async () => {
      const params: Anthropic.Messages.MessageCreateParamsStreaming = {
        model: this.models.answer,
        max_tokens: 4096,
        system: req.system,
        messages: req.messages,
        tools: req.tools,
        tool_choice: req.allowTools ? { type: "auto" } : { type: "none" },
        stream: true,
      };
      if (this.useReasoningParams) {
        params.thinking = { type: config.thinking as "between_tools" | "adaptive" } as Anthropic.Messages.ThinkingConfigParam;
        params.output_config = { effort: config.effort };
      }
      const stream = this.client.messages.stream(params, { signal });
      stream.on("text", onText);
      const msg = await stream.finalMessage();
      return { content: msg.content, stopReason: msg.stop_reason };
    };
    try {
      return await run();
    } catch (e: any) {
      if (this.useReasoningParams && e?.status === 400 && /thinking|effort|output_config/i.test(String(e?.message))) {
        console.warn("[model] reasoning params rejected, retrying without them:", e.message);
        this.useReasoningParams = false;
        return await run();
      }
      throw e;
    }
  }

  async json<T>(req: { system: string; prompt: string; schema: Record<string, unknown> }): Promise<T> {
    const msg = await this.client.messages.create({
      model: this.models.note,
      max_tokens: 1200,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      output_config: { format: { type: "json_schema", schema: req.schema } },
    });
    const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as T;
  }
}
