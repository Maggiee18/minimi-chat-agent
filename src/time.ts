import * as chrono from "chrono-node";

/**
 * Turns phrases like "on Monday", "last Tuesday", "3 November", "last week" into
 * concrete half-open ranges [start, end) in the *user's* time zone.
 *
 * Why deterministic code and not the LLM: date math is where models quietly slip
 * (off-by-one weekdays, wrong year, UTC vs local). It is also on the hot path, so a
 * library call (~1ms) beats an extra model round trip (~500ms+).
 */

export interface TimeRange {
  phrase: string; // what the user wrote
  start: Date;
  end: Date; // exclusive
  label: string; // human label in user's tz, e.g. "Tue 10 Nov 2026"
  granularity: "day" | "week" | "month";
}

const DAY = 86_400_000;

/** Offset of `tz` from UTC in minutes at instant `at` (e.g. Asia/Kolkata → 330). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value;
    const m = part?.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!m) return 0;
    const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
    return m[1] === "-" ? -mins : mins;
  } catch {
    return 0;
  }
}

export function safeTz(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

/** Calendar date (y, m, d) of `at` as seen in `tz`. */
function localYmd(at: Date, tz: string) {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
  const [y, m, d] = s.split("-").map(Number);
  return { y, m, d };
}

/** Midnight at the start of local calendar day (y, m, d) in `tz`, as a UTC instant. */
export function startOfLocalDay(y: number, m: number, d: number, tz: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - tzOffsetMinutes(tz, guess) * 60_000);
}

export function formatDay(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(at);
}

export function formatDateTime(at: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  }).format(at);
}

export function isoDate(at: Date, tz: string): string {
  const { y, m, d } = localYmd(at, tz);
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function dayRange(phrase: string, y: number, m: number, d: number, tz: string): TimeRange {
  const start = startOfLocalDay(y, m, d, tz);
  return { phrase, start, end: new Date(start.getTime() + DAY), label: formatDay(start, tz), granularity: "day" };
}

// Relative periods chrono resolves to a single day; we want the whole period.
const PERIODS: Array<[RegExp, (now: Date, tz: string) => { from: number; days: number; gran: TimeRange["granularity"] }]> = [
  [/\b(last|past|previous)\s+week\b/i, (now, tz) => {
    const { y, m, d } = localYmd(now, tz);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Mon=0
    return { from: -dow - 7, days: 7, gran: "week" };
  }],
  [/\b(this|earlier this)\s+week\b/i, (now, tz) => {
    const { y, m, d } = localYmd(now, tz);
    const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
    return { from: -dow, days: dow + 1, gran: "week" };
  }],
  [/\b(last|past|previous)\s+month\b/i, () => ({ from: -31, days: 31, gran: "month" })],
  [/\b(a\s+few|couple(\s+of)?)\s+days\s+ago\b/i, () => ({ from: -4, days: 4, gran: "week" })],
];

export function resolveTimeRefs(text: string, now: Date, tzIn: string): TimeRange[] {
  const tz = safeTz(tzIn);
  const ranges: TimeRange[] = [];
  const today = localYmd(now, tz);
  const todayStart = startOfLocalDay(today.y, today.m, today.d, tz);
  let rest = text;

  for (const [re, fn] of PERIODS) {
    const m = rest.match(re);
    if (!m) continue;
    const { from, days, gran } = fn(now, tz);
    const start = new Date(todayStart.getTime() + from * DAY);
    const end = new Date(start.getTime() + days * DAY);
    ranges.push({ phrase: m[0], start, end, label: `${formatDay(start, tz)} – ${formatDay(new Date(end.getTime() - 1), tz)}`, granularity: gran });
    rest = rest.replace(m[0], " ");
  }

  const results = chrono.parse(rest, { instant: now, timezone: tzOffsetMinutes(tz, now) }, { forwardDate: false });
  for (const r of results) {
    // Ignore bare times ("at 5") and "now": they don't point at a past conversation.
    const s = r.start;
    if (/^(right\s+)?now$/i.test(r.text.trim())) continue;
    if (!s.isCertain("day") && !s.isCertain("weekday") && !s.isCertain("month")) {
      if (!/\b(yesterday|today|tonight|ago)\b/i.test(r.text)) continue;
    }
    let y = s.get("year")!, m = s.get("month")!, d = s.get("day")!;

    // Month only ("in October") → whole month.
    if (s.isCertain("month") && !s.isCertain("day") && !s.isCertain("weekday")) {
      if (!s.isCertain("year") && (y > today.y || (y === today.y && m > today.m))) y -= 1;
      const start = startOfLocalDay(y, m, 1, tz);
      const end = m === 12 ? startOfLocalDay(y + 1, 1, 1, tz) : startOfLocalDay(y, m + 1, 1, tz);
      ranges.push({ phrase: r.text, start, end, label: new Intl.DateTimeFormat("en-GB", { timeZone: tz, month: "long", year: "numeric" }).format(start), granularity: "month" });
      continue;
    }

    let range = dayRange(r.text, y, m, d, tz);
    // People asking about past conversations mean the past: "on Monday" said on a
    // Friday is this week's Monday, "3 November" said in January is last year's.
    if (range.start.getTime() > now.getTime()) {
      if (s.isCertain("weekday") && !s.isCertain("day")) {
        range = dayRange(r.text, ...ymdShift(y, m, d, -7), tz);
      } else if (!s.isCertain("year")) {
        range = dayRange(r.text, y - 1, m, d, tz);
      }
    }
    if (r.end) {
      const e = r.end;
      const endDay = dayRange(r.text, e.get("year")!, e.get("month")!, e.get("day")!, tz);
      range = { ...range, end: endDay.end, label: `${range.label} – ${endDay.label}`, granularity: "week" };
    }
    ranges.push(range);
  }
  // "Is it still correct today?" next to a real date is about freshness, not recall.
  if (ranges.length > 1) return ranges.filter((r) => !/^(today|tonight)$/i.test(r.phrase.trim()));
  return ranges;
}

function ymdShift(y: number, m: number, d: number, days: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}
