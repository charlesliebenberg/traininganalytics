/**
 * What an activity says about fitness, beyond personal bests.
 *
 * Fitness shows up long before an all-time best: an effort close to the best of recent
 * months, the best of the last 90 days, power held deep into a long ride, or an effort the
 * current power–duration model says shouldn't be possible yet. Each is compared only with
 * what came before the activity.
 */
import { CURVE_DURATIONS } from './series';
import { BEST_EFFORT_DISTANCES } from './running';

export type EffortKind = 'pb' | 'model' | 'best90' | 'durability' | 'near';

export interface EffortFinding {
  kind: EffortKind;
  /** seconds (power) or metres (run distances) */
  duration?: number;
  meters?: number;
  /** kJ already done before the effort (durability) */
  kj?: number;
  /** W, or seconds for a run distance */
  value: number;
  /** what it's compared with, in the same unit */
  ref: number;
}

export interface RideHistory {
  date: string;
  power?: (number | null)[] | null;
  fatigue?: Record<string, (number | null)[]> | null;
}

export interface RunHistory {
  date: string;
  efforts?: Record<string, number> | null;
}

const DAY = 86400000;
const KEY_DURATIONS = [60, 300, 1200, 3600];
const DURABILITY = { kj: ['3000', '2000', '1000'], durations: [300, 1200] };
const MODEL_DURATIONS = [180, 300, 600, 1200];
const RUN_KEYS = ['1k', '5k', '10k', 'hm'];
/** within 3 % of the 90-day best counts as close */
const NEAR = 0.97;
/** durability needs this many earlier rides that went that deep, or there's nothing to compare with */
const MIN_DEEP_RIDES = 3;

const idx = (d: number) => CURVE_DURATIONS.indexOf(d);
const within = (date: string, ref: string, days: number) => Date.parse(date) < Date.parse(ref) && Date.parse(date) >= Date.parse(ref) - days * DAY;
const maxOf = (xs: (number | null | undefined)[]) => xs.reduce<number>((m, x) => (x != null && x > m ? x : m), 0);

/** Order of importance: a best ever, then beating the model, then recent bests, then close calls. */
const RANK: Record<EffortKind, number> = { pb: 0, model: 1, best90: 2, durability: 3, near: 4 };

export function rideEffortFindings(cur: RideHistory, history: RideHistory[], model: { cp: number; wPrime: number } | null): EffortFinding[] {
  const before = history.filter((h) => Date.parse(h.date) < Date.parse(cur.date));
  const recent = before.filter((h) => within(h.date, cur.date, 90));
  const out: EffortFinding[] = [];
  for (const d of KEY_DURATIONS) {
    const v = cur.power?.[idx(d)];
    if (!v) continue;
    const ever = maxOf(before.map((h) => h.power?.[idx(d)]));
    const best90 = maxOf(recent.map((h) => h.power?.[idx(d)]));
    if (ever && v > ever) out.push({ kind: 'pb', duration: d, value: v, ref: ever });
    else if (best90 && v > best90) out.push({ kind: 'best90', duration: d, value: v, ref: best90 });
    else if (best90 && v >= NEAR * best90) out.push({ kind: 'near', duration: d, value: v, ref: best90 });
  }
  // durability: the deepest point into a ride where this one beat the last 90 days
  for (const d of DURABILITY.durations) {
    for (const kj of DURABILITY.kj) {
      const v = cur.fatigue?.[kj]?.[idx(d)];
      if (!v) continue;
      const deep = before.filter((h) => within(h.date, cur.date, 365) && h.fatigue?.[kj]?.[idx(d)]);
      if (deep.length < MIN_DEEP_RIDES) continue;
      const best90 = maxOf(recent.map((h) => h.fatigue?.[kj]?.[idx(d)]));
      if (best90 && v > best90) {
        out.push({ kind: 'durability', duration: d, kj: Number(kj), value: v, ref: best90 });
        break;
      }
    }
  }
  // above the current model: the threshold estimate is about to rise
  if (model && model.cp > 0) {
    let top: EffortFinding | null = null;
    for (const d of MODEL_DURATIONS) {
      const v = cur.power?.[idx(d)];
      const pred = model.cp + model.wPrime / d;
      if (v && v > pred && (!top || v / pred > top.value / top.ref)) top = { kind: 'model', duration: d, value: v, ref: Math.round(pred) };
    }
    if (top) out.push(top);
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.duration ?? 0) - (a.duration ?? 0)).slice(0, 4);
}

/** Runs: best efforts over standard distances (seconds — lower is better). */
export function runEffortFindings(cur: RunHistory, history: RunHistory[]): EffortFinding[] {
  const before = history.filter((h) => Date.parse(h.date) < Date.parse(cur.date));
  const recent = before.filter((h) => within(h.date, cur.date, 90));
  const out: EffortFinding[] = [];
  const minOf = (hs: RunHistory[], k: string) => hs.reduce<number>((m, h) => (h.efforts?.[k] && h.efforts[k] < m ? h.efforts[k] : m), Infinity);
  for (const key of RUN_KEYS) {
    const v = cur.efforts?.[key];
    if (!v) continue;
    const meters = BEST_EFFORT_DISTANCES.find((d) => d.key === key)!.meters;
    const ever = minOf(before, key);
    const best90 = minOf(recent, key);
    if (Number.isFinite(ever) && v < ever) out.push({ kind: 'pb', meters, value: v, ref: ever });
    else if (Number.isFinite(best90) && v < best90) out.push({ kind: 'best90', meters, value: v, ref: best90 });
    else if (Number.isFinite(best90) && v <= best90 / NEAR) out.push({ kind: 'near', meters, value: v, ref: best90 });
  }
  return out.sort((a, b) => RANK[a.kind] - RANK[b.kind] || (b.meters ?? 0) - (a.meters ?? 0)).slice(0, 3);
}

export type Tone = 'up' | 'flat' | 'down' | 'none';

export interface Verdict {
  tone: Tone;
  /** short title, e.g. "Fitter than your recent level" */
  title: string;
}

/**
 * One line for the activity: the strongest sign in either direction. Aerobic evidence is two
 * surprise scores (negative = a lower heart-rate cost than predicted): against fitness alone,
 * and against everything expected (fitness plus the condition of recent days). Efforts are
 * the findings above.
 */
export function verdict(aerobic: { z: number | null; zFitness: number | null } | null, efforts: EffortFinding[]): Verdict {
  const zf = aerobic?.zFitness ?? null;
  const z = aerobic?.z ?? null;
  const has = (k: EffortKind, minDuration = 0) => efforts.some((e) => e.kind === k && (e.duration ?? Infinity) >= minDuration);
  if (has('pb', 60)) return { tone: 'up', title: 'A new best' };
  if (has('model')) return { tone: 'up', title: 'Beyond what your model expected' };
  if (zf != null && zf <= -1.5) return { tone: 'up', title: 'Fitter than your recent level' };
  if (has('best90', 300) || has('durability')) return { tone: 'up', title: 'Best of the last 90 days' };
  if ((zf != null && zf <= -1) || (z != null && z <= -1.5)) return { tone: 'up', title: 'Better than expected' };
  if ((zf != null && zf >= 1.5) || (z != null && z >= 1.5)) return { tone: 'down', title: 'Heart rate ran high for the effort' };
  if (has('best90') || has('near')) return { tone: 'flat', title: 'Close to your best' };
  if (zf != null && zf <= -0.5) return { tone: 'flat', title: 'A good day for your fitness' };
  if (zf != null && zf >= 0.5) return { tone: 'flat', title: 'A little below your fitness' };
  if (zf != null) return { tone: 'flat', title: 'In line with your fitness' };
  return { tone: 'none', title: 'Nothing here to judge fitness by' };
}
