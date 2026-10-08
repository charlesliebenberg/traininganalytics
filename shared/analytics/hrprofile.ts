/**
 * Power at a given heart rate, from steady stretches of riding.
 *
 * Every ride with power and heart rate contributes steady 10-minute windows (no 30-s chunk
 * more than ±20 % off the window's mean, at least 100 W). Each window pairs its mean power
 * with the mean heart rate of its last 5 minutes — heart rate lags power by a minute or two,
 * so the first half settles it. Windows start after the first 10 minutes of a ride (warm-up)
 * and step a minute at a time.
 *
 * Comparing two periods bin by bin (5 bpm) separates the aerobic engine (power at moderate
 * heart rates) from the top end (what can be sustained near threshold).
 */
import type { Streams } from '../types';
import { resample1Hz } from './series';

export const HR_BIN = 5;
const WINDOW = 600;
const SETTLE = 300;
const STEP = 60;
const SKIP = 600;
const CHUNK = 30;
const STEADY = 0.2;
const MIN_POWER = 100;

/** Steady-window powers keyed by heart-rate bin (bpm, multiples of 5). */
export type HrBins = Record<string, number[]>;

export function hrPowerWindows(s: Streams): HrBins {
  if (!s.watts || !s.heartrate || s.time.length < 2) return {};
  const n = s.time[s.time.length - 1] + 1;
  if (n < SKIP + WINDOW) return {};
  const P = resample1Hz(s.time, s.watts, n, { gapValue: 0 }).map((v) => v ?? 0);
  const H = resample1Hz(s.time, s.heartrate, n, { hold: true });
  return hrOutputWindows(P, H, MIN_POWER, 0);
}

/**
 * The same steady-window pairing for any 1 Hz output (power in W, or grade-adjusted running
 * speed in m/s), on a uniform time grid. `decimals` rounds the stored values.
 */
export function hrOutputWindows(P: ArrayLike<number>, H: ArrayLike<number | null>, minOutput: number, decimals: number): HrBins {
  const out: HrBins = {};
  const n = Math.min(P.length, H.length);
  if (n < SKIP + WINDOW) return out;
  const f = 10 ** decimals;
  // prefix sums for fast window means
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + P[i];
  const mean = (a: number, b: number) => (ps[b] - ps[a]) / (b - a);
  for (let st = SKIP; st + WINDOW <= n; st += STEP) {
    const pm = mean(st, st + WINDOW);
    if (pm < minOutput) continue;
    let steady = true;
    for (let c = st; c < st + WINDOW; c += CHUNK) {
      if (Math.abs(mean(c, c + CHUNK) - pm) > STEADY * pm) {
        steady = false;
        break;
      }
    }
    if (!steady) continue;
    let hs = 0;
    let hn = 0;
    for (let i = st + SETTLE; i < st + WINDOW; i++) {
      const h = H[i];
      if (h != null && h > 40) {
        hs += h;
        hn++;
      }
    }
    if (hn < (WINDOW - SETTLE) * 0.9) continue;
    const bin = String(Math.round(hs / hn / HR_BIN) * HR_BIN);
    (out[bin] ??= []).push(Math.round(pm * f) / f);
  }
  return out;
}

export interface HrProfilePoint {
  hr: number;
  /** median steady power in this heart-rate bin (W) */
  power: number;
  windows: number;
  rides: number;
}

const median = (x: number[]) => {
  const y = [...x].sort((a, b) => a - b);
  const m = y.length >> 1;
  return y.length % 2 ? y[m] : (y[m - 1] + y[m]) / 2;
};

/** Pool rides into one profile; bins need at least 2 rides and 5 windows. */
export function hrProfile(rides: HrBins[]): HrProfilePoint[] {
  const pooled = new Map<number, { p: number[]; rides: number }>();
  for (const r of rides) {
    for (const [bin, ps] of Object.entries(r)) {
      if (!ps.length) continue;
      const e = pooled.get(Number(bin)) ?? { p: [], rides: 0 };
      e.p.push(...ps);
      e.rides++;
      pooled.set(Number(bin), e);
    }
  }
  return [...pooled]
    .filter(([, e]) => e.rides >= 2 && e.p.length >= 5)
    .map(([hr, e]) => ({ hr, power: Math.round(median(e.p)), windows: e.p.length, rides: e.rides }))
    .sort((a, b) => a.hr - b.hr);
}

export interface HrComparison {
  /** median of now / then across shared bins (weighted by data), e.g. 0.98 */
  ratio: number | null;
  /** shared bins used for the ratio */
  shared: { hr: number; then: number; now: number; ratio: number }[];
  /** highest heart-rate bin with steady data, and its power */
  thenTop: HrProfilePoint | null;
  nowTop: HrProfilePoint | null;
}

export function compareHrProfiles(then: HrProfilePoint[], now: HrProfilePoint[]): HrComparison {
  const shared = then
    .map((t) => {
      const n = now.find((x) => x.hr === t.hr);
      return n ? { hr: t.hr, then: t.power, now: n.power, ratio: n.power / t.power, w: Math.min(t.windows, n.windows) } : null;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  // weighted median of the ratios
  let ratio: number | null = null;
  if (shared.length) {
    const sorted = [...shared].sort((a, b) => a.ratio - b.ratio);
    const total = sorted.reduce((s, x) => s + x.w, 0);
    let acc = 0;
    for (const x of sorted) {
      acc += x.w;
      if (acc >= total / 2) {
        ratio = x.ratio;
        break;
      }
    }
  }
  return {
    ratio,
    shared: shared.map(({ w: _w, ...x }) => x),
    thenTop: then.length ? then[then.length - 1] : null,
    nowTop: now.length ? now[now.length - 1] : null,
  };
}
