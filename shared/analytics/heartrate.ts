import { fillGaps, rollingMean, toFloat, type Series } from './series';

/** Banister TRIMP weighting for one second at heart-rate reserve fraction `hrr`. */
function trimpWeight(hrr: number, female = false): number {
  const k = female ? 1.67 : 1.92;
  const a = female ? 0.86 : 0.64;
  return hrr * a * Math.exp(k * hrr);
}

/** Banister exponential TRIMP (minutes-based). */
export function trimp(hr: Series, restHr: number, maxHr: number, mask?: ArrayLike<number> | null): number | null {
  if (maxHr <= restHr) return null;
  let total = 0;
  let seen = 0;
  for (let i = 0; i < hr.length; i++) {
    const v = hr[i];
    if (v == null || v <= 0) continue;
    if (mask && !mask[i]) continue;
    seen++;
    const hrr = Math.max(0, Math.min(1.1, (v - restHr) / (maxHr - restHr)));
    total += trimpWeight(hrr) / 60;
  }
  return seen ? total : null;
}

/**
 * hrTSS: TRIMP normalised so that one hour at lactate-threshold heart rate = 100,
 * matching the intent of TrainingPeaks' hrTSS.
 */
export function hrTss(hr: Series, lthr: number, restHr: number, maxHr: number, mask?: ArrayLike<number> | null): number | null {
  const t = trimp(hr, restHr, maxHr, mask);
  if (t == null || lthr <= restHr) return null;
  const hrrL = (lthr - restHr) / (maxHr - restHr);
  const hourAtLt = 60 * trimpWeight(hrrL);
  return (t / hourAtLt) * 100;
}

/**
 * Aerobic decoupling (Pw:Hr or Pa:Hr): % loss of output-per-heartbeat from first to
 * second half of the effort. < 5% suggests good aerobic endurance for that duration.
 * `output` is power or (grade-adjusted) speed. Skips the first 10 minutes of warm-up
 * when the effort is long enough.
 */
export function decoupling(output: Series, hr: Series, mask?: ArrayLike<number> | null): number | null {
  const h = fillGaps(hr);
  if (!h) return null;
  const o = toFloat(output);
  const idx: number[] = [];
  for (let i = 0; i < o.length; i++) if ((!mask || mask[i]) && h[i] > 0) idx.push(i);
  if (idx.length < 20 * 60) return null;
  const skip = idx.length > 50 * 60 ? 600 : 0;
  const use = idx.slice(skip);
  const half = Math.floor(use.length / 2);
  const ratio = (from: number, to: number) => {
    let so = 0,
      sh = 0;
    for (let k = from; k < to; k++) {
      so += o[use[k]];
      sh += h[use[k]];
    }
    return sh > 0 ? so / sh : 0;
  };
  const r1 = ratio(0, half);
  const r2 = ratio(half, use.length);
  if (r1 <= 0) return null;
  return ((r1 - r2) / r1) * 100;
}

/** Split-halves ratio series for plotting drift: rolling 5-min output/HR. */
export function efficiencySeries(output: Series, hr: Series, window = 300): (number | null)[] {
  const h = fillGaps(hr);
  if (!h) return [];
  const o = rollingMean(toFloat(output), window);
  const hh = rollingMean(h, window);
  const out: (number | null)[] = [];
  for (let i = 0; i < o.length; i++) out.push(i < window || hh[i] <= 0 ? null : o[i] / hh[i]);
  return out;
}

/** Heart-rate recovery: drop in bpm 60 s after the highest 30 s HR of the activity. */
export function hrRecovery(hr: Series): number | null {
  const h = fillGaps(hr);
  if (!h || h.length < 120) return null;
  const r = rollingMean(h, 30);
  let peak = 0;
  let at = 0;
  for (let i = 30; i < r.length - 60; i++)
    if (r[i] > peak) {
      peak = r[i];
      at = i;
    }
  if (!peak) return null;
  return peak - h[at + 60];
}
