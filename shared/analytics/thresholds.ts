/**
 * Automatic threshold estimation from rolling best efforts.
 *
 * Cycling uses the critical-power model (work = CP·t + W′), running and swimming the
 * equivalent critical-speed model (distance = CS·t + D′). Both are a straight line in the
 * work–time (distance–time) plane, fitted to three of the athlete's most impressive efforts:
 *
 *   1. Take the window's mean-maximal curve (best power or speed for every duration) within
 *      the model's valid range (≈ 2–30 min — long enough to be aerobic-dominant, short enough
 *      to be maximal).
 *   2. Fit a reference hyperbola to that curve's *upper envelope* (asymmetric loss), so that
 *      sub-maximal points — an easy 30 min that only happens to be the best 30 min — don't
 *      pull it down.
 *   3. Score every point by how far above or below that envelope it sits (value / model).
 *      Search every combination of three efforts that are well spread in duration (each at
 *      least 1.6× longer than the previous, 4× overall) and keep the one whose *weakest*
 *      effort scores highest — three genuinely maximal efforts, spread out enough to pin
 *      down both the slope (CP / CS) and the intercept (W′ / D′).
 *   4. Least-squares line through those three points → CP and W′ (or CS and D′).
 *   5. FTP is 96 % of CP, but never below an effort actually sustained: 95 % of the best
 *      20 minutes, or any 30–60 minute effort scaled to an hour (98 % of 40 minutes, the
 *      best hour in full).
 */
import { CURVE_DURATIONS, linreg } from './series';
import { nelderMead } from './models';

export type ThresholdSport = 'ride' | 'run' | 'swim';

export interface EffortPoint {
  /** duration, s */
  t: number;
  /** power (W) or speed (m/s) */
  value: number;
  activityId: number | null;
  date: string | null;
  /** value relative to the envelope model (1 = on the envelope) */
  score: number;
  band: number;
}

export interface ThresholdEstimate {
  sport: ThresholdSport;
  /** date the estimate applies from (window ends the day before) */
  date: string;
  windowFrom: string;
  windowTo: string;
  /** CP (W) or CS (m/s) */
  cp: number;
  /** W′ (J) or D′ (m) */
  wPrime: number;
  /** FTP (W) / threshold speed (m/s) / CSS (m/s) actually applied (after the decline limit) */
  threshold: number;
  /** threshold straight from this window's fit */
  raw: number;
  /**
   * which rule set the FTP: the CP fit, or an effort it can't sit below — 95 % of the best
   * 20 min, a 30–50 min effort scaled to an hour, or the best hour
   */
  basis?: 'cp' | '20min' | 'long' | '60min';
  /** the effort behind a floor */
  effort?: FtpEffort;
  r2: number;
  points: EffortPoint[];
  /** number of activities with curve data in the window */
  activities: number;
}

export interface FtpEffort {
  /** duration, s */
  t: number;
  /** best power for that duration in the window, W */
  value: number;
  activityId: number | null;
  date: string | null;
}

export const ESTIMATE_CONFIG: Record<ThresholdSport, { tMin: number; tMax: number; factor: number; min: number; max: number; label: string }> = {
  // Two-parameter CP from 3–30 min efforts sits a few % above a true 1-hour FTP
  ride: { tMin: 180, tMax: 1800, factor: 0.96, min: 60, max: 550, label: 'FTP' },
  // Critical speed ≈ threshold pace for runners
  run: { tMin: 120, tMax: 2400, factor: 1, min: 1.5, max: 7, label: 'Threshold pace' },
  // Critical swim speed is, by definition, the critical speed
  swim: { tMin: 60, tMax: 1500, factor: 1, min: 0.4, max: 2.3, label: 'CSS' },
};

export const WINDOW_DAYS = 182;
/**
 * Fitness is lost slowly, but a 6-month window drops a big effort all at once when it ages
 * out. Applied thresholds may therefore fall by at most this fraction per week; rises
 * (new best efforts) apply immediately.
 */
export const MAX_WEEKLY_DECLINE = 0.01;

/** Apply the decline limit across a weekly series (sorted by date). */
export function limitDeclines<T extends { date: string; raw: number; threshold: number }>(series: T[]): T[] {
  let prev: T | null = null;
  return series.map((e) => {
    let threshold = e.raw;
    if (prev) {
      const weeks = Math.max(1, Math.round((Date.parse(e.date) - Date.parse(prev.date)) / (7 * 86400000)));
      threshold = Math.max(e.raw, prev.threshold * (1 - MAX_WEEKLY_DECLINE) ** weeks);
    }
    const out = { ...e, threshold };
    prev = out;
    return out;
  });
}
export const MIN_ACTIVITIES = 4;

/** The classic field test's ratio (an hour ≈ 95 % of 20 minutes) as a power law in time. */
const HOUR_EXPONENT = Math.log(1 / 0.95) / Math.log(3);
/**
 * An hour's power from an all-out effort of `t` seconds (up to an hour): 20 min × 0.95,
 * 30 min × 0.968, 40 min × 0.981, the hour itself in full.
 */
export const hourPower = (power: number, t: number) => power * Math.min(1, t / 3600) ** HOUR_EXPONENT;
/** Efforts this long, scaled to an hour, are floors for FTP (besides the best 20 min), s. */
export const LONG_EFFORTS: [number, number] = [1800, 3600];

/** An FTP estimate in brief: its value, and the rule (and effort) that set it. */
export type FtpEstimate = Pick<ThresholdEstimate, 'date' | 'threshold' | 'raw' | 'cp' | 'basis' | 'effort'>;

/**
 * The rule that set an automatic FTP, in words: "98% of 40 min", or in full "98% of your
 * best 40 minutes (311 W)" (`date` adds when it was ridden). Given the applied threshold, a
 * value held up by the decline limit says so.
 */
export function ftpBasisText(e: Pick<ThresholdEstimate, 'basis'> & Partial<Pick<ThresholdEstimate, 'effort' | 'cp' | 'raw' | 'threshold'>>, opts: { full?: boolean; date?: (d: string) => string } = {}): string {
  const full = !!opts.full;
  if (e.threshold != null && e.raw != null && e.threshold > e.raw + 1e-9) return full ? `the ${Math.round(MAX_WEEKLY_DECLINE * 100)}%-a-week limit on how fast it falls` : 'decline-limited';
  const cpPct = `${Math.round(ESTIMATE_CONFIG.ride.factor * 100)}% of CP`;
  if (!e.basis || e.basis === 'cp') return full ? `the critical-power fit (${cpPct})` : cpPct;
  const t = e.effort?.t ?? (e.basis === '20min' ? 1200 : 3600);
  const v = e.effort?.value;
  const when = e.effort?.date && opts.date ? ` on ${opts.date(e.effort.date)}` : '';
  const what = v != null ? ` (${Math.round(v)} W${when})` : '';
  if (e.basis === '20min' && e.raw != null && e.cp != null && Math.abs(e.raw - e.cp) < 0.01) return full ? `your critical power — 95% of your best 20 minutes${what} is higher, and FTP stays at or below CP` : 'capped at CP';
  if (t >= 3600) return full ? `your best hour${when}` : 'best hour';
  const pct = `${Math.round(hourPower(100, t))}%`;
  return full ? `${pct} of your best ${Math.round(t / 60)} minutes${what}` : `${pct} of ${Math.round(t / 60)} min`;
}

interface Curve {
  values: (number | null)[];
  activityIds?: (number | null)[];
  dates?: (string | null)[];
  durations?: number[];
  /** points copied from a longer effort by the monotonic fill — not distinct efforts */
  filled?: boolean[];
}

/** Hyperbola fitted to the upper envelope of the points (asymmetric squared loss). */
export function envelopeFit(pts: { t: number; value: number }[]): { cp: number; wPrime: number } | null {
  if (pts.length < 2) return null;
  const init = linreg(
    pts.map((p) => p.t),
    pts.map((p) => p.value * p.t),
  );
  const cp0 = init.b > 0 ? init.b : pts[pts.length - 1].value;
  const w0 = init.a > 0 ? init.a : cp0 * 60;
  const loss = ([cp, w]: number[]) => {
    if (cp <= 0 || w < 0) return 1e12;
    let s = 0;
    for (const p of pts) {
      const r = (p.value - (cp + w / p.t)) / p.value;
      s += (r > 0 ? 25 : 1) * r * r; // points above the model are penalised heavily
    }
    return s;
  };
  const [cp, wPrime] = nelderMead(loss, [cp0, w0], { step: [cp0 * 0.05, Math.max(1, w0 * 0.2)], maxIter: 1500 });
  return cp > 0 && wPrime >= 0 ? { cp, wPrime } : null;
}

type Scored = Omit<EffortPoint, 'band'>;

/**
 * Pick the triple of efforts maximising the weakest score, subject to duration spread.
 * Constraints relax step by step if the window has no well-spread triple.
 */
export function choosePoints(scored: Scored[]): EffortPoint[] | null {
  const tiers = [
    { step: 1.6, span: 4 },
    { step: 1.3, span: 3 },
  ];
  for (const { step, span } of tiers) {
    let best: { v: number; pick: Scored[] } | null = null;
    for (let i = 0; i < scored.length; i++)
      for (let j = i + 1; j < scored.length; j++) {
        if (scored[j].t / scored[i].t < step) continue;
        for (let k = j + 1; k < scored.length; k++) {
          const [a, b, c] = [scored[i], scored[j], scored[k]];
          if (c.t / b.t < step || c.t / a.t < span) continue;
          // weakest effort decides; a little credit for spread breaks near-ties
          const v = Math.min(a.score, b.score, c.score) + 0.01 * Math.log(c.t / a.t);
          if (!best || v > best.v) best = { v, pick: [a, b, c] };
        }
      }
    if (best) return best.pick.map((p, band) => ({ ...p, band }));
  }
  return null;
}

export function estimateThreshold(
  sport: ThresholdSport,
  curve: Curve,
  meta: { date: string; windowFrom: string; windowTo: string; activities: number },
): ThresholdEstimate | null {
  const cfg = ESTIMATE_CONFIG[sport];
  const durations = curve.durations ?? CURVE_DURATIONS;
  const cands: Omit<EffortPoint, 'score' | 'band'>[] = [];
  durations.forEach((t, i) => {
    const v = curve.values[i];
    if (v == null || v <= 0 || t < cfg.tMin || t > cfg.tMax || curve.filled?.[i]) return;
    cands.push({ t, value: v, activityId: curve.activityIds?.[i] ?? null, date: curve.dates?.[i] ?? null });
  });
  if (meta.activities < MIN_ACTIVITIES || cands.length < 3) return null;
  const tLo = cands[0].t;
  const tHi = cands[cands.length - 1].t;
  if (tHi / tLo < 3) return null;

  const ref = envelopeFit(cands);
  if (!ref) return null;
  const scored = cands.map((c) => ({ ...c, score: c.value / (ref.cp + ref.wPrime / c.t) }));

  const picks = choosePoints(scored);
  if (!picks) return null;

  const fit = linreg(
    picks.map((p) => p.t),
    picks.map((p) => p.value * p.t),
  );
  let cp = fit.b;
  let wPrime = fit.a;
  // inconsistent picks (e.g. only sub-maximal long efforts): fall back to the envelope fit
  if (!(cp > 0) || !(wPrime > 0)) {
    cp = ref.cp;
    wPrime = ref.wPrime;
  }
  let threshold = cp * cfg.factor;
  let basis: ThresholdEstimate['basis'] = 'cp';
  let effort: FtpEffort | undefined;
  if (sport === 'ride') {
    // FTP can't be below what was actually sustained. The best 20 min and every effort of
    // 30–60 min are floors, scaled to an hour (hourPower): 95 % of 20 min — the classic field
    // test, capped at CP, as for riders with a big W′ it overshoots — 98 % of 40 min, the
    // best hour in full. Without all-out efforts the CP fit times 0.96 alone runs low: a
    // 3 × 20 min session at 107 % of "FTP", below threshold heart rate, or 40 minutes held at
    // 104 %, is the giveaway.
    durations.forEach((t, i) => {
      const v = curve.values[i];
      if (!v || (t !== 1200 && (t < LONG_EFFORTS[0] || t > LONG_EFFORTS[1]))) return;
      const floor = t === 1200 ? Math.min(hourPower(v, t), cp) : hourPower(v, t);
      if (floor > threshold + 1e-9) {
        threshold = floor;
        basis = t === 1200 ? '20min' : t >= 3600 ? '60min' : 'long';
        effort = { t, value: v, activityId: curve.activityIds?.[i] ?? null, date: curve.dates?.[i] ?? null };
      }
    });
  }
  if (threshold < cfg.min || threshold > cfg.max) return null;
  return { sport, ...meta, cp, wPrime, threshold, raw: threshold, r2: fit.r2, points: picks, basis, ...(effort ? { effort } : {}) };
}

// ---------- heart-rate thresholds ----------

export interface HrThresholds {
  lthr: number | null;
  runLthr: number | null;
  maxHr: number | null;
}

/** The second-highest value (robust to one bad reading), or the highest when there are few. */
const robustTop = (xs: number[]) => {
  const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => b - a);
  return s.length >= 4 ? s[1] : s.length ? s[0] : null;
};

/**
 * Heart-rate thresholds from what the athlete has actually sustained, the way a field test
 * would measure them:
 *  - LTHR ≈ the heart rate held through 30 minutes of hard effort (Friel's 30-min test): the
 *    second-highest best-30-min average among the window's rides (the highest when there are
 *    only a few), so one strap glitch can't set it
 *  - run LTHR the same from runs, but never below the bike value: running usually sits a
 *    few beats higher, and a block of easy running would otherwise drag it down
 *  - max HR: the second-highest activity maximum (a single spike can't set it), and at
 *    least a few beats above LTHR
 */
export function estimateHrThresholds(rideBest30: number[], runBest30: number[], maxima: number[]): HrThresholds {
  const plausible = (x: number | null) => (x != null && x >= 110 && x <= 215 ? x : null);
  const lthr = plausible(robustTop(rideBest30));
  const runOwn = plausible(robustTop(runBest30));
  const runLthr = runOwn != null || lthr != null ? Math.max(runOwn ?? 0, lthr ?? 0) : null;
  const top = maxima.filter((x) => x > 0).length >= 5 ? plausible(robustTop(maxima)) : null;
  const floor = Math.max(lthr ?? 0, runLthr ?? 0) + 5;
  const maxHr = top != null ? Math.max(top, floor) : null;
  return { lthr, runLthr, maxHr };
}
