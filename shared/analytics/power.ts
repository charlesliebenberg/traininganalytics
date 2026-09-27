import {
  CURVE_DURATIONS,
  FATIGUE_THRESHOLDS_KJ,
  meanMax,
  prefixSums,
  rollingMean,
  round,
  toFloat,
  type Series,
} from './series';

/** Normalized Power (Coggan): 4th-power mean of the 30 s rolling average. */
export function normalizedPower(watts: Series): number | null {
  const p = toFloat(watts);
  if (p.length < 30) return null;
  const r = rollingMean(p, 30);
  let s = 0;
  for (let i = 29; i < r.length; i++) s += r[i] ** 4;
  return (s / (r.length - 29)) ** 0.25;
}

/** Normalized power of the window [from, to). Uses the activity-wide 30 s rolling average. */
export function normalizedPowerRange(rolling30: ArrayLike<number>, from: number, to: number): number | null {
  const a = Math.max(from, 29);
  if (to - a < 1) return null;
  let s = 0;
  for (let i = a; i < to; i++) s += rolling30[i] ** 4;
  return (s / (to - a)) ** 0.25;
}

export function intensityFactor(np: number, ftp: number): number {
  return ftp > 0 ? np / ftp : 0;
}

/** TSS = hours * IF^2 * 100 — the same formula for power, pace (rTSS) and NP-derived efforts. */
export function tssFromIf(seconds: number, intensity: number): number {
  return (seconds / 3600) * intensity * intensity * 100;
}

/**
 * Mean-maximal power curve.
 */
export function powerCurve(watts: Series, durations = CURVE_DURATIONS) {
  return meanMax(toFloat(watts), durations).map((v) => round(v, 0));
}

/**
 * Normalized-power curve: for each duration, the highest NP achievable over any window
 * of that length. Captures variable, "surgy" efforts (crits, climbs with attacks) that a
 * plain mean-max curve under-represents. Durations below 30 s are undefined.
 */
export function npCurve(watts: Series, durations = CURVE_DURATIONS): (number | null)[] {
  const p = toFloat(watts);
  const n = p.length;
  if (n < 60) return durations.map(() => null);
  const r = rollingMean(p, 30);
  const r4 = new Float64Array(n - 29);
  for (let i = 29; i < n; i++) r4[i - 29] = r[i] ** 4;
  const ps = prefixSums(r4);
  const m = r4.length;
  return durations.map((d) => {
    if (d < 30 || d > m) return null;
    let best = 0;
    for (let i = 0; i + d <= m; i++) {
      const s = ps[i + d] - ps[i];
      if (s > best) best = s;
    }
    return round((best / d) ** 0.25, 0);
  });
}

/**
 * Durability / fatigue-resistance curves: the mean-max power curve computed only over the
 * part of the ride after the rider had already done N kJ of work.
 */
export function fatigueCurves(
  watts: Series,
  thresholds = FATIGUE_THRESHOLDS_KJ,
  durations = CURVE_DURATIONS,
): Record<string, (number | null)[]> {
  const p = toFloat(watts);
  const out: Record<string, (number | null)[]> = {};
  let cum = 0;
  let t = 0;
  for (let i = 0; i < p.length && t < thresholds.length; i++) {
    cum += p[i] / 1000;
    while (t < thresholds.length && cum >= thresholds[t]) {
      const rest = p.subarray(i + 1);
      if (rest.length >= 60) out[String(thresholds[t])] = meanMax(rest, durations).map((v) => round(v, 0));
      t++;
    }
  }
  return out;
}

/**
 * W' balance (Skiba, differential form by Froncioni & Clarke).
 * Returns joules remaining at each second.
 */
export function wPrimeBalance(watts: Series, cp: number, wPrime: number): number[] {
  const out = new Array<number>(watts.length);
  let bal = wPrime;
  for (let i = 0; i < watts.length; i++) {
    const p = watts[i] ?? 0;
    if (p > cp) bal -= p - cp;
    else bal += ((wPrime - bal) * (cp - p)) / wPrime;
    out[i] = bal;
  }
  return out;
}

/** Count of W' "matches burned": drops of >= minFraction of W' from a local peak. */
export function matchesBurned(wbal: number[], wPrime: number, minFraction = 0.1): number {
  const thr = wPrime * minFraction;
  let count = 0;
  let ref = wbal[0] ?? wPrime;
  let low = ref;
  let burning = false;
  for (const v of wbal) {
    if (!burning) {
      if (v > ref) ref = v;
      if (ref - v >= thr) {
        count++;
        burning = true;
        low = v;
      }
    } else {
      if (v < low) low = v;
      // a match ends once the rider has recovered a meaningful part of it
      if (v - low >= thr * 0.5) {
        burning = false;
        ref = v;
      }
    }
  }
  return count;
}

export interface Interval {
  start: number;
  end: number; // exclusive
  kind: 'detected' | 'lap' | 'selection';
  label: string;
}

/**
 * Detect sustained efforts in a 1 Hz series relative to a threshold.
 * Two passes: long efforts (>= 88% for >= 3 min) and short hard efforts (>= 120% for >= 15 s).
 */
export function detectIntervals(values: Series, threshold: number): Interval[] {
  if (!threshold) return [];
  const p = toFloat(values);
  const smooth = rollingMean(p, 5);
  const found: Interval[] = [];
  const passes = [
    { level: 0.88, minDur: 180, maxGap: 20 },
    { level: 1.2, minDur: 15, maxGap: 4 },
  ];
  for (const { level, minDur, maxGap } of passes) {
    const lim = level * threshold;
    let start = -1;
    let lastAbove = -1;
    const flush = () => {
      if (start >= 0) {
        // shift for trailing window lag of the 5 s smoothing
        const s = Math.max(0, start - 2);
        const e = Math.min(p.length, lastAbove - 1);
        if (e - s >= minDur) {
          // must actually average above the level
          let sum = 0;
          for (let i = s; i < e; i++) sum += p[i];
          if (sum / (e - s) >= lim * 0.97) found.push({ start: s, end: e, kind: 'detected', label: '' });
        }
      }
      start = -1;
    };
    for (let i = 0; i < smooth.length; i++) {
      if (smooth[i] >= lim) {
        if (start < 0) start = i;
        lastAbove = i + 1;
      } else if (start >= 0 && i - lastAbove > maxGap) {
        flush();
      }
    }
    flush();
  }
  // drop short efforts fully contained in a long one if they're a big part of it
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const result: Interval[] = [];
  for (const iv of found) {
    const container = result.find((r) => r.start <= iv.start && r.end >= iv.end);
    if (container && (iv.end - iv.start) / (container.end - container.start) > 0.6) continue;
    result.push(iv);
  }
  return result.slice(0, 60);
}

/** Pedal force / velocity for quadrant analysis. */
export function quadrantPoint(watts: number, cadence: number, crankLengthMm: number) {
  const cpv = (cadence * (crankLengthMm / 1000) * 2 * Math.PI) / 60; // m/s
  const aepf = cpv > 0 ? watts / cpv : 0; // N
  return { cpv, aepf };
}

export function powerHistogram(watts: Series, binSize = 20, mask?: ArrayLike<number> | null): { bin: number; seconds: number }[] {
  const counts = new Map<number, number>();
  let maxBin = 0;
  for (let i = 0; i < watts.length; i++) {
    const v = watts[i];
    if (v == null) continue;
    if (mask && !mask[i]) continue;
    const b = Math.floor(v / binSize) * binSize;
    counts.set(b, (counts.get(b) ?? 0) + 1);
    if (b > maxBin) maxBin = b;
  }
  const out: { bin: number; seconds: number }[] = [];
  for (let b = 0; b <= maxBin; b += binSize) out.push({ bin: b, seconds: counts.get(b) ?? 0 });
  return out;
}
