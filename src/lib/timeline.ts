import { parseISO } from 'date-fns';

export interface Gap {
  from: string;
  to: string;
  days: number;
}

const DAY = 86400_000;
/** Width a collapsed break takes on a chart. */
export const COLLAPSED_DAYS = 21;

/**
 * Time axis with long breaks squeezed to a fixed width, so years of history read
 * continuously. Works in milliseconds: `toX` maps a timestamp onto the squeezed axis and
 * `fromX` maps it back (for axis labels).
 */
export function makeTimeline(gaps: Gap[]) {
  const segs = gaps.map((g) => ({ ...g, a: parseISO(g.from).getTime(), b: parseISO(g.to).getTime() + DAY }));
  const toX = (ts: number) => {
    let x = ts;
    for (const g of segs) {
      const len = g.b - g.a;
      if (ts >= g.b) x -= len - COLLAPSED_DAYS * DAY;
      else if (ts > g.a) x -= (ts - g.a) * (1 - (COLLAPSED_DAYS * DAY) / len);
    }
    return x;
  };
  const fromX = (x: number) => {
    let ts = x;
    for (const g of segs) {
      const ga = toX(g.a);
      if (x >= ga + COLLAPSED_DAYS * DAY) ts += g.b - g.a - COLLAPSED_DAYS * DAY;
      else if (x > ga) ts += (x - ga) * ((g.b - g.a) / (COLLAPSED_DAYS * DAY) - 1);
    }
    return ts;
  };
  const breaks = segs.map((g) => ({ ...g, x0: toX(g.a), x1: toX(g.a) + COLLAPSED_DAYS * DAY }));
  /** dates inside a break */
  const hidden = (date: string) =>
    segs.some((g) => {
      const t = parseISO(date).getTime();
      return t > g.a && t <= g.b;
    });
  /** a break between two dates (a line shouldn't be drawn across it) */
  const breakBetween = (a: string, b: string) => breaks.some((g) => g.a > parseISO(a).getTime() && g.a < parseISO(b).getTime());
  /** an axis position inside a squeezed break: a tick there would show a date nobody trained on */
  const inBreak = (x: number) => breaks.some((g) => x > g.x0 && x < g.x1);
  return { toX, fromX, breaks, hidden, breakBetween, inBreak };
}
export type Timeline = ReturnType<typeof makeTimeline>;

export const monthsText = (days: number) => (days >= 365 ? `${(days / 365).toFixed(1)} yr` : `${Math.round(days / 30.4)} mo`);

/**
 * Labels for the collapsed-break bands ("10 mo / off"). Two breaks close together would
 * print on top of each other on a narrow chart, so only the longer of them is labelled.
 */
export function breakNames(breaks: { x0: number; days: number }[], minApartDays = 120): string[] {
  return breaks.map((g, i) => {
    const crowded = breaks.some((h, j) => j !== i && Math.abs(h.x0 - g.x0) < minApartDays * DAY && (h.days > g.days || (h.days === g.days && j < i)));
    return crowded ? '' : `${monthsText(g.days)}\noff`;
  });
}

/** Days in a long break: at least this many consecutive days without any training. */
export const BREAK_DAYS = 90;

/**
 * Long breaks in a daily series: runs of at least `minDays` consecutive days where `empty`
 * holds (no load, no activity). Leading and trailing days count too.
 */
export function gapsInDaily<T extends { date: string }>(days: T[], empty: (d: T) => boolean, minDays = BREAK_DAYS): Gap[] {
  const out: Gap[] = [];
  // two breaks separated by a few days of activity (a couple of runs) read as one break
  let start = -1;
  const flush = (end: number) => {
    if (start >= 0 && end - start >= minDays) out.push({ from: days[start].date, to: days[end - 1].date, days: end - start });
    start = -1;
  };
  days.forEach((d, i) => {
    if (empty(d)) {
      if (start < 0) start = i;
    } else flush(i);
  });
  flush(days.length);
  const merged: Gap[] = [];
  for (const g of out) {
    const prev = merged[merged.length - 1];
    if (prev && Date.parse(g.from) - Date.parse(prev.to) <= 30 * 86400_000) {
      prev.to = g.to;
      prev.days = Math.round((Date.parse(g.to) - Date.parse(prev.from)) / 86400_000) + 1;
    } else merged.push({ ...g });
  }
  return merged;
}

/**
 * Bucketed series (weeks, months) with long empty stretches folded into one marker, so
 * years of history read continuously. A run of at least `minBuckets` empty buckets becomes
 * `{ gap }` with the span it replaces.
 */
export function foldEmptyBuckets<T extends { start: string }>(buckets: T[], empty: (b: T) => boolean, minBuckets: number): (T | { gap: Gap })[] {
  const out: (T | { gap: Gap })[] = [];
  let run: T[] = [];
  const flush = () => {
    if (run.length >= minBuckets) {
      const from = run[0].start;
      const to = run[run.length - 1].start;
      out.push({ gap: { from, to, days: Math.round((Date.parse(to) - Date.parse(from)) / 86400_000) } });
    } else out.push(...run);
    run = [];
  };
  for (const b of buckets) {
    if (empty(b)) run.push(b);
    else {
      flush();
      out.push(b);
    }
  }
  flush();
  return out;
}
export const isGap = <T,>(x: T | { gap: Gap }): x is { gap: Gap } => typeof x === 'object' && x != null && 'gap' in x;
