import type { Claim, Store } from "./db.js";
import type { ModelClient } from "./model.js";
import { formatDay } from "./time.js";

/**
 * After a reply has been sent, a small model files a compact note about the exchange:
 * topic, summary, entities and the *checkable claims* it made. This is what lets a
 * later "is that still correct?" re-verify specific statements instead of re-reading
 * a wall of prose. It runs off the hot path; if it fails, recall falls back to the
 * raw answer text, so nothing breaks.
 */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic", "summary", "entities", "claims"],
  properties: {
    topic: { type: "string", description: "3 to 8 words, e.g. 'CRM shortlist for 20-person sales team'" },
    summary: { type: "string", description: "At most 60 words: what the user wanted and what the answer concluded." },
    entities: { type: "array", items: { type: "string" }, description: "Products, companies, people, places named." },
    claims: {
      type: "array",
      description: "Up to 10 concrete, checkable facts the answer stated that could change over time (prices, plans, versions, dates, rankings).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "source"],
        properties: {
          text: { type: "string", description: "Self-contained claim, at most 25 words, e.g. 'Pipedrive Growth plan: $49/user/month billed annually'" },
          source: { type: "string", description: "URL the claim was cited to, or empty string." },
        },
      },
    },
  },
};

export async function writeNotes(store: Store, model: ModelClient, exchangeId: number, conversationId: string, userText: string, answer: string, sources: { n: number; url: string }[], at: Date, tz: string) {
  try {
    const srcList = sources.map((s) => `[${s.n}] ${s.url}`).join("\n");
    const notes = await model.json<{ topic: string; summary: string; entities: string[]; claims: Claim[] }>({
      system: "You file concise notes about a chat exchange so a future assistant can recall and re-verify it. Only record what the answer actually said.",
      prompt: `Date of exchange: ${formatDay(at, tz)}\n\nUser:\n${userText}\n\nAssistant answer:\n${answer}\n\nSources referenced by [n]:\n${srcList || "(none)"}`,
      schema: SCHEMA,
    });
    store.setNotes(exchangeId, {
      topic: notes.topic.slice(0, 120),
      summary: notes.summary.slice(0, 600),
      entities: notes.entities.slice(0, 20),
      claims: notes.claims.slice(0, 10).map((c) => ({ text: c.text, source: c.source || undefined })),
    });
    store.setTitleIfEmpty(conversationId, notes.topic.slice(0, 80));
  } catch (e: any) {
    console.warn(`[notes] exchange ${exchangeId}: ${e?.message ?? e}`);
    store.setTitleIfEmpty(conversationId, userText.slice(0, 60));
  }
}
