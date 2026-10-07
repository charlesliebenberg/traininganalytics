/**
 * Performance capacity from long-term training load.
 *
 * Best efforts follow the training accumulated over months, not just the last six weeks:
 * a comeback can match an old CTL within weeks while the power that came with it takes far
 * longer to return. This models the upper envelope of weekly best power (20 min by default)
 * as `a + b · LTL`, where LTL is an exponentially weighted average of daily load (TSS/day,
 * like CTL) whose time constant τ is learned from the athlete's own history:
 *
 *  - envelope: quantile regression (q = 0.85) — most weeks contain no all-out effort, so the
 *    model should describe what the rider could do, not what they happened to do
 *  - τ: rolling-origin cross-validation — fit on everything before each half-year, score that
 *    half-year — choosing between 6 weeks (the CTL time constant) and 2 years
 *  - honesty: every τ that scores within a few % of the best stays "plausible", and
 *    projections report the range across them rather than one confident date
 */
import { differenceInCalendarDays, format, parseISO } from 'date-fns';

export const CAPACITY_QUANTILE = 0.85;
export const CAPACITY_TAUS = [42, 90, 180, 270, 365, 540, 730];
/** a τ scoring within this fraction of the best counts as plausible */
const PLAUSIBLE = 0.03;
const MIN_OBS = 30;

export interface CapacityDay {
  date: string;
  /** training load that day (TSS) */
  load: number;
  /** best power for the modelled duration that day, if any */
  best: number | null;
}

export interface CapacityFit {
  tau: number;
  a: number;
  b: number;
  /** mean cross-validated pinball loss (W) — lower is better */
  loss: number;
  plausible: boolean;
}

export interface CapacityValidation {
  /** first day held out */
  from: string;
  /** mean absolute error of the monthly best vs the model, held-out months (W) */
  mae: number;
  /** same for the classic CTL time constant (42 d) */
  maeCtl: number;
  months: { month: string; observed: number; predicted: number; predictedCtl: number }[];
}

export interface CapacityModel {
  tau: number;
  a: number;
  b: number;
  quantile: number;
  fits: CapacityFit[];
  validation: CapacityValidation | null;
  /** range of LTL seen in the history (best τ) — projections beyond it are extrapolation */
  ltlRange: [number, number];
  observations: number;
  firstDate: string;
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/** Load state after each day: x += (load − x) / τ, the same recursion as CTL. */
export function ltlSeries(loads: ArrayLike<number>, tau: number, start = 0): Float64Array {
  const out = new Float64Array(loads.length);
  let x = start;
  for (let i = 0; i < loads.length; i++) {
    x += (loads[i] - x) / tau;
    out[i] = x;
  }
  return out;
}

export const pinball = (residual: number, q = CAPACITY_QUANTILE) => (residual >= 0 ? q * residual : (q - 1) * residual);

function quantileOf(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}

/**
 * Exact single-predictor quantile regression with a non-negative slope: for a fixed slope
 * the best intercept is the q-quantile of the residuals, and the loss is convex in the slope,
 * so a golden-section search finds the optimum.
 */
export function quantileLine(x: number[], y: number[], q = CAPACITY_QUANTILE): { a: number; b: number } {
  const n = x.length;
  if (!n) return { a: 0, b: 0 };
  const lossAt = (b: number) => {
    const r = y.map((v, i) => v - b * x[i]).sort((u, v) => u - v);
    const a = quantileOf(r, q);
    let s = 0;
    for (const v of r) s += pinball(v - a, q);
    return { a, loss: s / n };
  };
  const xMin = Math.min(...x);
  const xMax = Math.max(...x);
  const yMin = Math.min(...y);
  const yMax = Math.max(...y);
  if (xMax - xMin < 1e-9) return { a: lossAt(0).a, b: 0 };
  let lo = 0;
  let hi = (3 * (yMax - yMin)) / (xMax - xMin) + 1e-6;
  const g = (Math.sqrt(5) - 1) / 2;
  let c = hi - g * (hi - lo);
  let d = lo + g * (hi - lo);
  let fc = lossAt(c).loss;
  let fd = lossAt(d).loss;
  for (let it = 0; it < 80; it++) {
    if (fc <= fd) {
      hi = d;
      d = c;
      fd = fc;
      c = hi - g * (hi - lo);
      fc = lossAt(c).loss;
    } else {
      lo = c;
      c = d;
      fc = fd;
      d = lo + g * (hi - lo);
      fd = lossAt(d).loss;
    }
  }
  const b = (lo + hi) / 2;
  // a flat line can beat a tiny slope at the boundary
  const at0 = lossAt(0);
  const atB = lossAt(b);
  return at0.loss <= atB.loss ? { a: at0.a, b: 0 } : { a: atB.a, b };
}

/** One observation per Monday-based week: that week's best effort and the day it happened. */
export function weeklyBest(days: CapacityDay[]): { i: number; best: number }[] {
  const out: { i: number; best: number }[] = [];
  let cur: { i: number; best: number } | null = null;
  let week = '';
  days.forEach((d, i) => {
    const dt = parseISO(d.date);
    const monday = iso(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7)));
    if (monday !== week) {
      if (cur) out.push(cur);
      cur = null;
      week = monday;
    }
    if (d.best != null && d.best > 0 && (!cur || d.best > cur.best)) cur = { i, best: d.best };
  });
  if (cur) out.push(cur);
  return out;
}

/** Half-year folds (Jan–Jun, Jul–Dec) with enough data on both sides. */
function folds(days: CapacityDay[], obs: { i: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const seen = new Set<string>();
  for (const o of obs) {
    const d = days[o.i].date;
    const key = `${d.slice(0, 4)}-${d.slice(5, 7) <= '06' ? 1 : 2}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [y, h] = key.split('-').map(Number);
    const startDate = `${y}-${h === 1 ? '01' : '07'}-01`;
    const endDate = h === 1 ? `${y}-07-01` : `${y + 1}-01-01`;
    const start = days.findIndex((x) => x.date >= startDate);
    let end = days.findIndex((x) => x.date >= endDate);
    if (end < 0) end = days.length;
    const train = obs.filter((x) => x.i < start).length;
    const test = obs.filter((x) => x.i >= start && x.i < end).length;
    if (train >= 26 && test >= 8) out.push({ start, end });
  }
  return out;
}

const predictor = (ltl: Float64Array, i: number) => (i > 0 ? ltl[i - 1] : 0);

function fitOn(ltl: Float64Array, obs: { i: number; best: number }[]) {
  return quantileLine(
    obs.map((o) => predictor(ltl, o.i)),
    obs.map((o) => o.best),
  );
}

/**
 * Fit the capacity model to a contiguous daily series (one entry per calendar day, oldest
 * first). Returns null without enough history to learn from: at least 30 weekly bests over a
 * year, and at least two half-years that can be predicted from earlier data.
 */
export function fitCapacity(days: CapacityDay[], opts: { taus?: number[]; holdoutFrom?: string | null } = {}): CapacityModel | null {
  const taus = opts.taus ?? CAPACITY_TAUS;
  const obs = weeklyBest(days);
  if (obs.length < MIN_OBS) return null;
  if (differenceInCalendarDays(parseISO(days[obs[obs.length - 1].i].date), parseISO(days[obs[0].i].date)) < 365) return null;
  const fs = folds(days, obs);
  if (fs.length < 2) return null;
  const loads = days.map((d) => d.load);
  const series = new Map(taus.map((t) => [t, ltlSeries(loads, t)]));

  const scored = taus.map((tau) => {
    const ltl = series.get(tau)!;
    const losses = fs.map((f) => {
      const train = obs.filter((o) => o.i < f.start);
      const test = obs.filter((o) => o.i >= f.start && o.i < f.end);
      const { a, b } = fitOn(ltl, train);
      return test.reduce((s, o) => s + pinball(o.best - (a + b * predictor(ltl, o.i))), 0) / test.length;
    });
    const { a, b } = fitOn(ltl, obs);
    return { tau, a, b, loss: losses.reduce((s, x) => s + x, 0) / losses.length };
  });
  const best = scored.reduce((m, s) => (s.loss < m.loss ? s : m));
  const fits: CapacityFit[] = scored.map((s) => ({ ...s, plausible: s.loss <= best.loss * (1 + PLAUSIBLE) }));
  const ltl = series.get(best.tau)!;
  const used = obs.map((o) => predictor(ltl, o.i));

  return {
    tau: best.tau,
    a: best.a,
    b: best.b,
    quantile: CAPACITY_QUANTILE,
    fits,
    validation: validate(days, obs, series.get(best.tau)!, ltlSeries(loads, 42), opts.holdoutFrom ?? null),
    ltlRange: [Math.min(...used), Math.max(...used)],
    observations: obs.length,
    firstDate: days[0].date,
  };
}

/**
 * Hold out the most recent era (from `holdoutFrom`, e.g. the end of the last long break, or
 * else the last six months), fit on everything before it, and compare monthly bests with
 * what the model — and the CTL time constant — predicted.
 */
function validate(days: CapacityDay[], obs: { i: number; best: number }[], ltl: Float64Array, ctl: Float64Array, holdoutFrom: string | null): CapacityValidation | null {
  const last = days[days.length - 1].date;
  const fallback = iso(new Date(parseISO(last).getTime() - 182 * 86400_000));
  const from = holdoutFrom && holdoutFrom < last ? holdoutFrom : fallback;
  const train = obs.filter((o) => days[o.i].date < from);
  const test = obs.filter((o) => days[o.i].date >= from);
  if (train.length < 26 || test.length < 8) return null;
  const m = fitOn(ltl, train);
  const c = fitOn(ctl, train);
  const byMonth = new Map<string, { observed: number; predicted: number; predictedCtl: number }>();
  for (const o of test) {
    const month = days[o.i].date.slice(0, 7);
    const cur = byMonth.get(month) ?? { observed: 0, predicted: 0, predictedCtl: 0 };
    byMonth.set(month, {
      observed: Math.max(cur.observed, o.best),
      predicted: Math.max(cur.predicted, m.a + m.b * predictor(ltl, o.i)),
      predictedCtl: Math.max(cur.predictedCtl, c.a + c.b * predictor(ctl, o.i)),
    });
  }
  const months = [...byMonth].map(([month, v]) => ({ month, ...v }));
  const mae = (k: 'predicted' | 'predictedCtl') => months.reduce((s, x) => s + Math.abs(x.observed - x[k]), 0) / months.length;
  return { from, mae: mae('predicted'), maeCtl: mae('predictedCtl'), months };
}

export const capacityAt = (m: Pick<CapacityModel, 'a' | 'b'>, ltl: number) => m.a + m.b * ltl;

/** LTL needed for a capacity. */
export const ltlFor = (m: Pick<CapacityModel, 'a' | 'b'>, capacity: number) => (m.b > 0 ? (capacity - m.a) / m.b : Infinity);

/** Days of holding a steady daily load until capacity reaches the target (Infinity if never). */
export function daysToTarget(m: Pick<CapacityModel, 'a' | 'b'>, tau: number, ltl0: number, dailyLoad: number, target: number): number {
  const need = ltlFor(m, target);
  if (ltl0 >= need) return 0;
  if (dailyLoad <= need) return Infinity;
  return Math.ceil(Math.log((dailyLoad - need) / (dailyLoad - ltl0)) / Math.log(1 - 1 / tau));
}

/** Steady daily load that reaches the target capacity in `days`. */
export function loadForTarget(m: Pick<CapacityModel, 'a' | 'b'>, tau: number, ltl0: number, target: number, days: number): number {
  const need = ltlFor(m, target);
  const r = Math.pow(1 - 1 / tau, days);
  return Math.max(0, (need - ltl0 * r) / (1 - r));
}

/** Capacity after each day of a load sequence, starting from the current LTL. */
export function projectCapacity(m: Pick<CapacityModel, 'a' | 'b'>, tau: number, ltl0: number, loads: number[]): number[] {
  let x = ltl0;
  return loads.map((l) => {
    x += (l - x) / tau;
    return m.a + m.b * x;
  });
}
