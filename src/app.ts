import express from "express";
import path from "node:path";
import { runTurn, type AgentEvent } from "./agent.js";
import type { Store } from "./db.js";
import type { ModelClient } from "./model.js";
import type { SearchProvider } from "./search.js";
import { safeTz } from "./time.js";

/** HTTP layer. Takes its dependencies so tests and the offline demo can inject fakes. */
export function createApp({ store, model, search, maxRounds, root }: { store: Store; model: ModelClient; search: SearchProvider; maxRounds: number; root: string }) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use(express.static(path.join(root, "public")));
  app.get("/vendor/marked.js", (_req, res) => res.sendFile(path.join(root, "node_modules/marked/lib/marked.umd.js")));
  app.get("/vendor/purify.js", (_req, res) => res.sendFile(path.join(root, "node_modules/dompurify/dist/purify.min.js")));

  const ID = /^[a-zA-Z0-9-]{8,64}$/;
  const busy = new Map<string, symbol>(); // conversation → the turn currently answering it

  app.get("/api/conversations", (_req, res) => {
    res.json(store.listConversations());
  });

  app.get("/api/conversations/:id", (req, res) => {
    if (!ID.test(req.params.id)) return res.status(400).json({ error: "bad id" });
    res.json(store.conversationExchanges(req.params.id, 200));
  });

  /**
   * Streams newline-delimited JSON events (one AgentEvent per line). NDJSON over a
   * POST keeps it to one request per turn, works with fetch() streaming, and needs no
   * SSE/WebSocket plumbing.
   */
  app.post("/api/chat", async (req, res) => {
    const { conversationId, message, tz } = req.body ?? {};
    if (typeof conversationId !== "string" || !ID.test(conversationId)) return res.status(400).json({ error: "bad conversationId" });
    if (typeof message !== "string" || !message.trim() || message.length > 8000) return res.status(400).json({ error: "message must be 1 to 8000 chars" });
    if (busy.has(conversationId)) return res.status(409).json({ error: "still answering the previous message" });

    const token = Symbol(conversationId);
    busy.set(conversationId, token);
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
    const emit = (e: AgentEvent) => {
      // Once the answer is saved the user may ask the next question while suggestions are still loading.
      if (e.type === "done" && busy.get(conversationId) === token) busy.delete(conversationId);
      if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
    };

    try {
      await runTurn(
        { store, model, search, maxRounds, background: (p) => p.catch(() => {}) },
        { conversationId, message: message.trim(), tz: safeTz(tz), signal: abort.signal },
        emit,
      );
    } catch (e: any) {
      if (!abort.signal.aborted) {
        console.error("[chat]", e);
        const msg =
          e?.status === 401 || e?.status === 403 || (e?.status === 400 && /api.key/i.test(String(e?.message))) ? "The model API key was rejected. Check the key in .env and restart."
          : e?.status === 429 ? "The model's rate limit was hit (free tiers allow only a few requests per minute and per day). Wait a minute and try again."
          : e?.status === 503 || e?.status === 504 ? "The model is overloaded right now (the free tier gets busy). Wait a few seconds and try again."
          : e?.status === 404 ? "The model name wasn't found. Check ANSWER_MODEL / NOTE_MODEL in .env."
          : /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(String(e?.message) + String(e?.cause?.code)) ? "Couldn't reach the model API. Check your internet connection and try again."
          : "Something went wrong while answering. Please try again.";
        emit({ type: "error", message: msg });
      }
    } finally {
      if (busy.get(conversationId) === token) busy.delete(conversationId);
      res.end();
    }
  });

  return app;
}
