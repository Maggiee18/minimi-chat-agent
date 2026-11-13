import type { ModelClient } from "./model.js";

/**
 * Three short "ask next" suggestions, made by the small model after the answer is on
 * screen. It never delays the answer: the UI already has it, and if this takes longer
 * than `timeoutMs` or fails, the user simply gets no suggestions.
 */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: { type: "array", items: { type: "string" }, description: "Exactly 3 follow-up questions, each under 12 words." },
  },
};

export async function suggestFollowups(model: ModelClient, question: string, answer: string, timeoutMs = 5000): Promise<string[]> {
  const work = model
    .json<{ questions: string[] }>({
      system: "Suggest what this user would most likely ask next. Write as the user, short and specific, no numbering. Prefer questions that build on the answer (compare, go deeper, check a detail, apply it to their case).",
      prompt: `User asked:\n${question}\n\nAssistant answered:\n${answer.slice(0, 4000)}`,
      schema: SCHEMA,
    })
    .then((r) => (r.questions ?? []).map((q) => q.trim()).filter((q) => q && q.length < 140).slice(0, 3))
    .catch(() => [] as string[]);
  const timeout = new Promise<string[]>((r) => setTimeout(() => r([]), timeoutMs));
  return Promise.race([work, timeout]);
}
