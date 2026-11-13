import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * One SQLite file holds everything. The unit of memory is an *exchange*
 * (one user message + the agent's final answer), because that is exactly what users
 * refer back to: "what did I ask you on 3 November?".
 *
 * Every exchange keeps: a precise timestamp, the sources the answer cited, and
 * (filled in asynchronously by a small model) a topic, summary, entities and the
 * checkable claims it made. Those claims are what make "is that still true?" answerable.
 */

export interface Source {
  n: number;
  url: string;
  title: string;
  published?: string | null;
  retrievedAt: number;
}

export interface Claim {
  text: string;
  source?: string;
}

export interface Exchange {
  recall: { items: Array<{ at: number; date: string; question: string; why: string }>; ranges: Array<{ phrase: string; label: string; empty: boolean }> };
  id: number;
  conversationId: string;
  userText: string;
  answer: string;
  sources: Source[];
  searches: string[];
  createdAt: number;
  tz: string;
  topic: string | null;
  summary: string | null;
  entities: string | null;
  claims: Claim[];
  latencyMs: number | null;
}

export type DB = DatabaseSync;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  // Node's built in SQLite: no native addon to compile, so `npm install` works everywhere.
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 2000;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exchanges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      user_text TEXT NOT NULL,
      answer TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '[]',
      searches TEXT NOT NULL DEFAULT '[]',
      recall TEXT NOT NULL DEFAULT '{"items":[],"ranges":[]}',
      created_at INTEGER NOT NULL,
      tz TEXT NOT NULL DEFAULT 'UTC',
      topic TEXT,
      summary TEXT,
      entities TEXT,
      claims TEXT NOT NULL DEFAULT '[]',
      latency_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS exchanges_created ON exchanges(created_at);
    CREATE INDEX IF NOT EXISTS exchanges_conv ON exchanges(conversation_id, created_at);

    -- Full-text index for "the Postgres hosting thing" style recall.
    CREATE VIRTUAL TABLE IF NOT EXISTS exchanges_fts USING fts5(
      user_text, topic, entities, summary,
      content='exchanges', content_rowid='id', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS exchanges_ai AFTER INSERT ON exchanges BEGIN
      INSERT INTO exchanges_fts(rowid, user_text, topic, entities, summary)
      VALUES (new.id, new.user_text, coalesce(new.topic,''), coalesce(new.entities,''), coalesce(new.summary,''));
    END;
    CREATE TRIGGER IF NOT EXISTS exchanges_au AFTER UPDATE ON exchanges BEGIN
      INSERT INTO exchanges_fts(exchanges_fts, rowid, user_text, topic, entities, summary)
      VALUES ('delete', old.id, old.user_text, coalesce(old.topic,''), coalesce(old.entities,''), coalesce(old.summary,''));
      INSERT INTO exchanges_fts(rowid, user_text, topic, entities, summary)
      VALUES (new.id, new.user_text, coalesce(new.topic,''), coalesce(new.entities,''), coalesce(new.summary,''));
    END;

    CREATE TABLE IF NOT EXISTS search_cache (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  return db;
}

function rowToExchange(r: any): Exchange {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    userText: r.user_text,
    answer: r.answer,
    sources: JSON.parse(r.sources),
    searches: JSON.parse(r.searches),
    recall: JSON.parse(r.recall),
    createdAt: r.created_at,
    tz: r.tz,
    topic: r.topic,
    summary: r.summary,
    entities: r.entities,
    claims: JSON.parse(r.claims),
    latencyMs: r.latency_ms,
  };
}

export class Store {
  constructor(readonly db: DB) {}

  ensureConversation(id: string, now: number) {
    this.db
      .prepare(`INSERT INTO conversations(id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)
                ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`)
      .run(id, now, now);
  }

  setTitleIfEmpty(id: string, title: string) {
    this.db.prepare(`UPDATE conversations SET title = ? WHERE id = ? AND title IS NULL`).run(title, id);
  }

  listConversations() {
    return this.db
      .prepare(`SELECT c.id, coalesce(c.title, (SELECT user_text FROM exchanges e WHERE e.conversation_id = c.id ORDER BY id LIMIT 1)) AS title,
                       c.created_at AS createdAt, c.updated_at AS updatedAt
                FROM conversations c ORDER BY c.updated_at DESC LIMIT 100`)
      .all() as Array<{ id: string; title: string; createdAt: number; updatedAt: number }>;
  }

  addExchange(e: Omit<Exchange, "id" | "topic" | "summary" | "entities" | "claims" | "recall"> & { recall?: Exchange["recall"] }): number {
    const info = this.db
      .prepare(`INSERT INTO exchanges(conversation_id, user_text, answer, sources, searches, recall, created_at, tz, latency_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.conversationId, e.userText, e.answer, JSON.stringify(e.sources), JSON.stringify(e.searches), JSON.stringify(e.recall ?? { items: [], ranges: [] }), e.createdAt, e.tz, e.latencyMs);
    return Number(info.lastInsertRowid);
  }

  setNotes(id: number, n: { topic: string; summary: string; entities: string[]; claims: Claim[] }) {
    this.db
      .prepare(`UPDATE exchanges SET topic = ?, summary = ?, entities = ?, claims = ? WHERE id = ?`)
      .run(n.topic, n.summary, n.entities.join(", "), JSON.stringify(n.claims), id);
  }

  conversationExchanges(conversationId: string, limit = 50): Exchange[] {
    const rows = this.db
      .prepare(`SELECT * FROM (SELECT * FROM exchanges WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?) ORDER BY created_at ASC`)
      .all(conversationId, limit);
    return rows.map(rowToExchange);
  }

  inRange(start: number, end: number, limit = 20): Exchange[] {
    return this.db
      .prepare(`SELECT * FROM exchanges WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT ?`)
      .all(start, end, limit)
      .map(rowToExchange);
  }

  /** BM25 search over what was asked and what it was about. `terms` are pre-cleaned words. */
  searchText(terms: string[], limit = 5): Array<Exchange & { rank: number }> {
    if (!terms.length) return [];
    const q = terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
    return this.db
      .prepare(`SELECT e.*, bm25(exchanges_fts, 1.0, 2.0, 2.0, 0.5) AS rank FROM exchanges_fts
                JOIN exchanges e ON e.id = exchanges_fts.rowid
                WHERE exchanges_fts MATCH ?
                ORDER BY rank LIMIT ?`)
      .all(q, limit)
      .map((r: any) => ({ ...rowToExchange(r), rank: r.rank }));
  }

  stats(): { count: number; first: number | null } {
    const r = this.db.prepare(`SELECT count(*) AS count, min(created_at) AS first FROM exchanges`).get() as any;
    return { count: r.count, first: r.first };
  }

  cacheGet(key: string, ttlMs: number, now = Date.now()): string | null {
    const r = this.db.prepare(`SELECT value, created_at FROM search_cache WHERE key = ?`).get(key) as any;
    return r && now - r.created_at < ttlMs ? r.value : null;
  }

  cacheSet(key: string, value: string, now = Date.now()) {
    this.db.prepare(`INSERT OR REPLACE INTO search_cache(key, value, created_at) VALUES (?, ?, ?)`).run(key, value, now);
  }
}
