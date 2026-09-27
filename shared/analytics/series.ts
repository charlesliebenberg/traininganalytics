// Low-level numeric helpers for 1 Hz time series.

export type Series = ArrayLike<number | null | undefined>;

/**
 * Duration grid (seconds) used for every mean-maximal curve. Dense at short
 * durations, roughly log-spaced beyond so curves look smooth on a log axis.
 */
export const CURVE_DURATIONS: number[] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 17, 20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100,
  110, 120, 135, 150, 165, 180, 210, 240, 270, 300, 330, 360, 420, 480, 540, 600, 660, 720, 780, 840,
  900, 1020, 1200, 1320, 1500, 1800, 2100, 2400, 2700, 3000, 3600, 4200, 4800, 5400, 6000, 6600, 7200,
  8100, 9000, 10800, 12600, 14400, 16200, 18000, 21600, 25200, 28800,
];

export const FATIGUE_THRESHOLDS_KJ = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000];

export function toFloat(values: Series, fill = 0): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    out[i] = v == null || Number.isNaN(v) ? fill : v;
  }
  return out;
}

/** Forward/backward fill nulls; returns null if the series has no values. */
export function fillGaps(values: Series): Float64Array | null {
  const n = values.length;
  const out = new Float64Array(n);
  let last: number | null = null;
  let first = -1;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v != null && !Number.isNaN(v)) {
      last = v;
      if (first < 0) first = i;
    }
    out[i] = last ?? 0;
  }
  if (first < 0) return null;
  for (let i = 0; i < first; i++) out[i] = out[first];
  return out;
}

export function hasData(values: Series | null | undefined, minNonZero = 1): boolean {
  if (!values) return false;
  let c = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v != null && v > 0 && ++c >= minNonZero) return true;
  }
  return false;
}

export function prefixSums(values: ArrayLike<number>): Float64Array {
  const ps = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) ps[i + 1] = ps[i] + values[i];
  return ps;
}

/** Trailing rolling mean (window seconds). Early samples average what is available. */
export function rollingMean(values: ArrayLike<number>, window: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out[i] = sum / Math.min(i + 1, window);
  }
  return out;
}

/** Centered rolling mean, used for display smoothing and grade calculation. */
export function centeredMean(values: ArrayLike<number>, window: number): Float64Array {
  const n = values.length;
  const half = Math.floor(window / 2);
  const ps = prefixSums(values);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (ps[b] - ps[a]) / (b - a);
  }
  return out;
}

export function mean(values: ArrayLike<number>, from = 0, to = values.length): number {
  if (to <= from) return 0;
  let s = 0;
  for (let i = from; i < to; i++) s += values[i];
  return s / (to - from);
}

/** Mean of non-null values, optionally only where mask[i] is truthy. */
export function meanDefined(values: Series, mask?: ArrayLike<number> | null, from = 0, to = values.length): number | null {
  let s = 0;
  let c = 0;
  for (let i = from; i < to; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    if (mask && !mask[i]) continue;
    s += v;
    c++;
  }
  return c ? s / c : null;
}

export function maxDefined(values: Series, from = 0, to = values.length): number | null {
  let m: number | null = null;
  for (let i = from; i < to; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    if (m == null || v > m) m = v;
  }
  return m;
}

/** Best average of `values` over each duration. Returns null where duration > length. */
export function meanMax(values: ArrayLike<number>, durations: number[] = CURVE_DURATIONS): (number | null)[] {
  const n = values.length;
  const ps = prefixSums(values);
  return durations.map((d) => {
    if (d > n) return null;
    let best = -Infinity;
    for (let i = 0; i + d <= n; i++) {
      const s = ps[i + d] - ps[i];
      if (s > best) best = s;
    }
    return best / d;
  });
}

/** Mean-max for a single duration, also returning the start index of the best window. */
export function bestWindow(values: ArrayLike<number>, d: number): { value: number; start: number } | null {
  const n = values.length;
  if (d > n || d <= 0) return null;
  const ps = prefixSums(values);
  let best = -Infinity;
  let start = 0;
  for (let i = 0; i + d <= n; i++) {
    const s = ps[i + d] - ps[i];
    if (s > best) {
      best = s;
      start = i;
    }
  }
  return { value: best / d, start };
}

export function round(v: number | null | undefined, digits = 0): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear regression y = a + b x. */
export function linreg(xs: number[], ys: number[]): { a: number; b: number; r2: number } {
  const n = xs.length;
  let sx = 0,
    sy = 0,
    sxx = 0,
    sxy = 0,
    syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i];
    sy += ys[i];
    sxx += xs[i] * xs[i];
    sxy += xs[i] * ys[i];
    syy += ys[i] * ys[i];
  }
  const b = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1);
  const a = (sy - b * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i] - (a + b * xs[i])) ** 2;
  return { a, b, r2: ssTot > 0 ? 1 - ssRes / ssTot : 1 };
}

/**
 * Resample irregular samples onto a 1 Hz grid starting at t=0.
 * Short gaps (<= maxInterpGap s) are linearly interpolated; longer gaps get `gapValue`
 * (null by default, or e.g. 0 for power).
 */
export function resample1Hz(
  time: number[],
  values: (number | null | undefined)[],
  length: number,
  opts: { maxInterpGap?: number; gapValue?: number | null; hold?: boolean } = {},
): (number | null)[] {
  const { maxInterpGap = 5, gapValue = null, hold = false } = opts;
  const out: (number | null)[] = new Array(length).fill(gapValue);
  let j = 0;
  for (let t = 0; t < length; t++) {
    while (j + 1 < time.length && time[j + 1] <= t) j++;
    const t0 = time[j];
    const v0 = values[j];
    if (t0 === t) {
      out[t] = v0 ?? gapValue;
      continue;
    }
    if (t0 > t) continue; // before first sample
    const t1 = time[j + 1];
    if (t1 == null) continue; // after last sample
    const v1 = values[j + 1];
    if (t1 - t0 > maxInterpGap || v0 == null || v1 == null) continue;
    out[t] = hold ? v0 : v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
  }
  return out;
}
