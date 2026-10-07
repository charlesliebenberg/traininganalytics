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
  return { toX, fromX, breaks, hidden, breakBetween };
}
export type Timeline = ReturnType<typeof makeTimeline>;

export const monthsText = (days: number) => (days >= 365 ? `${(days / 365).toFixed(1)} yr` : `${Math.round(days / 30.4)} mo`);
