import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimeRefs, isoDate } from "../src/time.js";
import { TZ } from "./helpers.js";

// Friday 13 Nov 2026, 3pm in India.
const now = new Date("2026-11-13T15:00:00+05:30");
const days = (q: string, tz = TZ) => resolveTimeRefs(q, now, tz).map((r) => isoDate(r.start, tz));

test("weekday without modifier means the most recent past one", () => {
  assert.deepEqual(days("On Monday we shortlisted 5 CRM tools"), ["2026-11-09"]);
});
test("'last Tuesday' resolves to this week's Tuesday when said on Friday", () => {
  assert.deepEqual(days("Last Tuesday I asked you about Postgres hosting"), ["2026-11-10"]);
});
test("explicit date; trailing 'today' is not a recall target", () => {
  assert.deepEqual(days("What did I ask you on 3 November? Is your answer still correct today?"), ["2026-11-03"]);
});
test("a future-looking date without a year means last year", () => {
  assert.deepEqual(days("what did we discuss on 20 December"), ["2025-12-20"]);
});
test("'last week' is the whole previous Mon–Sun", () => {
  const [r] = resolveTimeRefs("last week we discussed laptops", now, TZ);
  assert.equal(isoDate(r.start, TZ), "2026-11-02");
  assert.equal((r.end.getTime() - r.start.getTime()) / 86_400_000, 7);
});
test("ranges are in the user's time zone, not UTC", () => {
  const [r] = resolveTimeRefs("yesterday", now, "America/Los_Angeles");
  // 13 Nov 15:00 IST is 13 Nov 01:30 PST, so yesterday there is 12 Nov
  assert.equal(isoDate(r.start, "America/Los_Angeles"), "2026-11-12");
  assert.equal(r.start.toISOString(), "2026-11-12T08:00:00.000Z");
});
test("no time words, no ranges (and 'now' / numbers are ignored)", () => {
  assert.deepEqual(days("what's the weather now"), []);
  assert.deepEqual(days("best CRM for a 20-person team in 2026"), []);
});
