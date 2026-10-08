import { centeredMean, clamp, fillGaps, rollingMean, toFloat, type Series } from './series';

export const BEST_EFFORT_DISTANCES: { key: string; label: string; meters: number }[] = [
  { key: '400m', label: '400 m', meters: 400 },
  { key: '800m', label: '800 m', meters: 800 },
  { key: '1k', label: '1 km', meters: 1000 },
  { key: '1mi', label: '1 mile', meters: 1609.34 },
  { key: '3k', label: '3 km', meters: 3000 },
  { key: '5k', label: '5 km', meters: 5000 },
  { key: '10k', label: '10 km', meters: 10000 },
  { key: '15k', label: '15 km', meters: 15000 },
  { key: '10mi', label: '10 mile', meters: 16093.4 },
  { key: '20k', label: '20 km', meters: 20000 },
  { key: 'hm', label: 'Half marathon', meters: 21097.5 },
  { key: '30k', label: '30 km', meters: 30000 },
  { key: 'm', label: 'Marathon', meters: 42195 },
];

/**
 * Metabolic cost of running on a gradient relative to flat ground (Minetti et al. 2002).
 * `grade` is a fraction (0.05 = 5%).
 */
export function gradeCostFactor(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  const c = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
  return c / 3.6;
}

/** Grade (%) derived from altitude & distance when a grade stream is not supplied. */
export function deriveGrade(altitude: Series, distance: Series): number[] {
  const alt = fillGaps(altitude);
  const dist = fillGaps(distance);
  if (!alt || !dist) return [];
  const a = centeredMean(alt, 15);
  const n = a.length;
  const out = new Array<number>(n).fill(0);
  const w = 10;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w);
    const hi = Math.min(n - 1, i + w);
    const dd = dist[hi] - dist[lo];
    out[i] = dd > 8 ? clamp(((a[hi] - a[lo]) / dd) * 100, -40, 40) : 0;
  }
  return out;
}

/** Grade-adjusted speed series (m/s). */
export function gradeAdjustedSpeed(speed: Series, gradePct: Series): number[] {
  const out = new Array<number>(speed.length);
  for (let i = 0; i < speed.length; i++) {
    const s = speed[i] ?? 0;
    const g = (gradePct[i] ?? 0) / 100;
    out[i] = s * gradeCostFactor(g);
  }
  return out;
}

/** Normalized Graded Pace, expressed as speed (m/s): NP-style 4th-power mean of 30 s GAP. */
export function normalizedGradedSpeed(gap: Series, mask?: ArrayLike<number> | null): number | null {
  const v = toFloat(gap);
  const r = rollingMean(v, 30);
  let s = 0;
  let c = 0;
  for (let i = 29; i < r.length; i++) {
    if (mask && !mask[i]) continue;
    s += r[i] ** 4;
    c++;
  }
  return c ? (s / c) ** 0.25 : null;
}

/** Fastest time (s) to cover each distance, using a two-pointer sweep of the distance stream. */
/** No one runs faster than this for more than a stride: higher GPS speeds are glitches. */
const RUN_SPEED_LIMIT = 9;

/**
 * Running speed with GPS glitches removed. A watch that starts before GPS lock, or a phone
 * between tall buildings, makes the position jump about: the 1-s speed swings 5 → 15 → 5
 * m/s in a way legs can't, and the distance stream adds up the jumps. Two conservative
 * rules, chosen so genuine efforts (races, intervals) are left alone:
 *  - speeds above 9 m/s are impossible on foot: replace with the local median
 *  - in very jerky stretches (15-s coefficient of variation > 0.35), cap speed at the 95th
 *    percentile of the run's clean stretches — a real surge in a noisy stretch keeps that,
 *    a glitch loses it
 * Checked against every run in a 10-year history: a 400 m "in 42 s" disappears, race
 * bests move by under 1 %.
 */
export function cleanRunSpeed(speed: Series): number[] {
  const v = Array.from(speed, (x) => (x != null && Number.isFinite(x) && x > 0 ? x : 0));
  const n = v.length;
  if (n < 20) return v;
  const s1 = new Float64Array(n + 1);
  const s2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    s1[i + 1] = s1[i] + v[i];
    s2[i + 1] = s2[i] + v[i] * v[i];
  }
  const W = 15;
  const jerky = new Uint8Array(n);
  for (let i = 0; i + W <= n; i++) {
    const m = (s1[i + W] - s1[i]) / W;
    const sd = Math.sqrt(Math.max(0, (s2[i + W] - s2[i]) / W - m * m));
    if (m > 2 && sd / m > 0.35) jerky.fill(1, i, i + W);
  }
  // the run's own fast pace, judged from its clean stretches only: a long glitch at the start
  // of a short run would otherwise set its own cap
  const clean = v.filter((x, i) => !jerky[i] && x > 0.5 && x <= RUN_SPEED_LIMIT);
  const pool = clean.length >= 60 ? clean : v.filter((x) => x > 0.5 && x <= RUN_SPEED_LIMIT);
  if (!pool.length) return v.map((x) => (x > RUN_SPEED_LIMIT ? 0 : x));
  pool.sort((a, b) => a - b);
  const cap = pool[Math.floor(0.95 * (pool.length - 1))];
  const localMedian = (i: number) => {
    const w = v.slice(Math.max(0, i - 30), Math.min(n, i + 31)).filter((x) => x <= RUN_SPEED_LIMIT).sort((a, b) => a - b);
    return w.length ? w[w.length >> 1] : 0;
  };
  return v.map((x, i) => (x > RUN_SPEED_LIMIT ? Math.min(localMedian(i), cap) : jerky[i] && x > cap ? cap : x));
}

/** Cumulative distance from a 1 Hz speed series. */
export function distanceFromSpeed(speed: ArrayLike<number>): number[] {
  const out = new Array<number>(speed.length);
  let d = 0;
  for (let i = 0; i < speed.length; i++) {
    d += speed[i];
    out[i] = d;
  }
  return out;
}

export function bestEfforts(distance: Series, targets = BEST_EFFORT_DISTANCES): Record<string, number> {
  const d = fillGaps(distance);
  const out: Record<string, number> = {};
  if (!d) return out;
  const n = d.length;
  const total = d[n - 1] - d[0];
  for (const t of targets) {
    if (t.meters > total) continue;
    let best = Infinity;
    let j = 0;
    for (let i = 0; i < n; i++) {
      if (j < i) j = i;
      while (j < n - 1 && d[j] - d[i] < t.meters) j++;
      if (d[j] - d[i] < t.meters) break;
      // interpolate within the last second for precision
      const over = d[j] - d[i] - t.meters;
      const step = j > 0 ? d[j] - d[j - 1] : 0;
      const frac = step > 0 ? over / step : 0;
      const time = j - i - frac;
      if (time < best) best = time;
    }
    if (Number.isFinite(best)) out[t.key] = Math.round(best * 10) / 10;
  }
  return out;
}

export interface Split {
  index: number;
  distance: number;
  time: number;
  start: number;
  speed: number;
  gapSpeed: number | null;
  avgHr: number | null;
  elevation: number | null;
  avgPower: number | null;
  avgCadence: number | null;
}

/** Per-km (or per-mile) splits. */
export function splits(
  streams: {
    distance: Series;
    heartrate?: Series | null;
    altitude?: Series | null;
    gap?: Series | null;
    watts?: Series | null;
    cadence?: Series | null;
  },
  unit = 1000,
): Split[] {
  const d = fillGaps(streams.distance);
  if (!d) return [];
  const out: Split[] = [];
  let start = 0;
  let next = unit;
  const flush = (end: number, dist: number) => {
    const time = end - start;
    if (time <= 0) return;
    const avg = (s: Series | null | undefined) => {
      if (!s) return null;
      let sum = 0,
        c = 0;
      for (let k = start; k < end; k++) {
        const v = s[k];
        if (v != null && v > 0) {
          sum += v;
          c++;
        }
      }
      return c ? sum / c : null;
    };
    const alt = streams.altitude;
    out.push({
      index: out.length + 1,
      distance: dist,
      time,
      start,
      speed: dist / time,
      gapSpeed: avg(streams.gap),
      avgHr: avg(streams.heartrate),
      elevation: alt && alt[end - 1] != null && alt[start] != null ? (alt[end - 1] as number) - (alt[start] as number) : null,
      avgPower: avg(streams.watts),
      avgCadence: avg(streams.cadence),
    });
  };
  for (let i = 0; i < d.length; i++) {
    if (d[i] >= next) {
      flush(i, unit);
      start = i;
      next += unit;
    }
  }
  const rem = d[d.length - 1] - (next - unit);
  if (rem > unit * 0.05) flush(d.length, rem);
  return out;
}

/** Swim TSS: hours * IF^3 * 100 where IF = speed / CSS. */
export function swimTss(seconds: number, avgSpeed: number, css: number): number | null {
  if (!css || !avgSpeed) return null;
  const i = avgSpeed / css;
  return (seconds / 3600) * i ** 3 * 100;
}
