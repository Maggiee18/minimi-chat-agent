/**
 * Small live eval: runs scenarios through the real agent (real model, real search)
 * against a throwaway copy of the database, and prints speed + a few cheap checks.
 * It is a smoke test for regressions, not a benchmark.
 *
 *   npm run eval
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runTurn } from "../src/agent.js";
import { assertKeys, config } from "../src/config.js";
import { realDeps, root } from "../src/wiring.js";

assertKeys();
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const src = path.resolve(root, config.dbPath);
const tmp = path.resolve(root, "data/eval.db");
for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) fs.rmSync(f, { force: true });
if (fs.existsSync(src)) fs.copyFileSync(src, tmp);
const deps = realDeps("data/eval.db");
const hasMemory = deps.store.stats().count > 0;

type Check = (answer: string, meta: { searches: number; cited: number[] }) => string | null;
const cites: Check = (a, m) => (m.searches > 0 && m.cited.length === 0 ? "searched but cited nothing" : null);
const searched: Check = (_a, m) => (m.searches === 0 ? "expected a web search" : null);
const noSearch: Check = (_a, m) => (m.searches > 0 ? "searched for something stable" : null);
const honestMemory: Check = (a) =>
  hasMemory || /no record|don't have|do not have|can't find|cannot find|no (past )?conversation|not see/i.test(a) ? null : "may have invented a past conversation";

const scenarios: Array<{ turns: string[]; checks: Check[] }> = [
  { turns: ["On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"], checks: [honestMemory, cites] },
  { turns: ["What did I ask you on 3 November? Is your answer still correct today?"], checks: [honestMemory] },
  { turns: ["Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"], checks: [honestMemory, cites] },
  { turns: ["What's the current price of the cheapest Notion paid plan?"], checks: [searched, cites] },
  { turns: ["Explain the difference between a mutex and a semaphore in two sentences."], checks: [noSearch] },
  { turns: ["Who is the current CEO of OpenAI?", "And when did they start in that role?"], checks: [searched, cites] },
];

let failures = 0;
const pending: Promise<unknown>[] = [];
for (const s of scenarios) {
  const conversationId = randomUUID();
  for (const [i, q] of s.turns.entries()) {
    let answer = "";
    let meta = { searches: 0, cited: [] as number[], latencyMs: 0, firstTokenMs: null as number | null };
    await runTurn({ ...deps, background: (p) => pending.push(p) }, { conversationId, message: q, tz }, (e) => {
      if (e.type === "text") answer += e.delta;
      if (e.type === "retract") answer = "";
      if (e.type === "done") meta = e;
    });
    const problems = i === s.turns.length - 1 ? s.checks.map((c) => c(answer, meta)).filter(Boolean) : [];
    failures += problems.length;
    console.log(`\n${problems.length ? "✗" : "✓"} ${q}`);
    console.log(`  first words ${meta.firstTokenMs ?? "-"}ms · total ${meta.latencyMs}ms · ${meta.searches} searches · cites ${meta.cited.join(",") || "-"}`);
    console.log(`  ${answer.split("\n").find((l) => l.trim())?.slice(0, 160)}`);
    problems.forEach((p) => console.log(`  ! ${p}`));
  }
}
console.log(`\n${failures ? `${failures} check(s) failed` : "all checks passed"}`);
await Promise.allSettled(pending);
deps.store.db.close();
for (const f of [tmp, tmp + "-wal", tmp + "-shm"]) fs.rmSync(f, { force: true });
