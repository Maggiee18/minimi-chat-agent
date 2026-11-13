/**
 * Optional demo data. A fresh install has no history, so "what did I ask you on
 * Monday?" can only (correctly) answer "I have no record of that". This script gives
 * the memory something to find: it asks the agent real questions with a *simulated
 * clock* set to earlier days this month, so they are stored as if asked then.
 *
 *   npm run seed            (uses your API keys; ~3 questions)
 *
 * Seeded conversations are titled "[demo] …" so they are easy to spot.
 */
import { randomUUID } from "node:crypto";
import { runTurn } from "../src/agent.js";
import { assertKeys } from "../src/config.js";
import { startOfLocalDay, formatDay } from "../src/time.js";
import { realDeps } from "../src/wiring.js";

assertKeys();
const tz = process.env.SEED_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const deps = realDeps();
const DAY = 86_400_000;

/** Most recent past `weekday` (0=Sun) strictly before today, at `hour` local time. */
function lastWeekday(weekday: number, hour: number): Date {
  const now = new Date();
  for (let i = 1; i <= 7; i++) {
    const d = new Date(now.getTime() - i * DAY);
    const local = new Date(d.toLocaleString("en-US", { timeZone: tz }));
    if (local.getDay() === weekday) {
      return new Date(startOfLocalDay(local.getFullYear(), local.getMonth() + 1, local.getDate(), tz).getTime() + hour * 3_600_000);
    }
  }
  throw new Error("unreachable");
}
function daysAgo(n: number, hour: number): Date {
  const local = new Date(new Date(Date.now() - n * DAY).toLocaleString("en-US", { timeZone: tz }));
  return new Date(startOfLocalDay(local.getFullYear(), local.getMonth() + 1, local.getDate(), tz).getTime() + hour * 3_600_000);
}

const plan = [
  { at: lastWeekday(1, 11), q: "We're a 20-person sales team picking a CRM. Shortlist 5 tools with current per-seat pricing for the plan we'd likely need." },
  { at: lastWeekday(2, 16), q: "What are the cheapest decent managed Postgres hosting options for a small SaaS right now? Compare Neon, Supabase, AWS RDS and DigitalOcean on entry pricing." },
  { at: daysAgo(10, 10), q: "What's the latest stable version of Node.js and when does it reach end of life?" },
];

for (const p of plan) {
  const conversationId = randomUUID();
  process.stdout.write(`${formatDay(p.at, tz)} — ${p.q.slice(0, 60)}… `);
  const pending: Promise<unknown>[] = [];
  await runTurn({ ...deps, background: (x) => pending.push(x) }, { conversationId, message: p.q, tz, now: p.at }, (e) => {
    if (e.type === "search") process.stdout.write(".");
  });
  await Promise.all(pending);
  deps.store.db.prepare(`UPDATE conversations SET title = '[demo] ' || coalesce(title, '') WHERE id = ?`).run(conversationId);
  console.log(" saved");
}
console.log("\nDone. Try: \"On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?\"");
