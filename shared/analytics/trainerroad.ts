/**
 * TrainerRoad workouts in this app's terms. TrainerRoad gives a workout's profile as its target
 * power over time, % of FTP: sampled each second, or at the points where it changes. It's read
 * back into steps, ramps and repeats, so a TrainerRoad workout draws, describes and exports like
 * any other planned workout.
 */
import type { WorkoutBlock, WorkoutIntent, WorkoutStep, WorkoutStructure } from '../types';

export interface ProfilePoint {
  /** from the start: seconds, or milliseconds */
  seconds: number;
  /** target, % of FTP */
  ftpPercent: number;
}

/** how far the steps may stray from the profile, % of FTP */
const TOLERANCE = 1;
/** a change bigger than this from one second to the next starts a new step */
const JUMP = 2.5;

const median = (xs: number[]) => {
  const y = [...xs].sort((a, b) => a - b);
  return y[y.length >> 1];
};

/** The profile as one value a second. */
function perSecond(points: ProfilePoint[]): number[] {
  // milliseconds: every time a whole number of seconds, and longer than a minute read that way
  const ms = points.every((p) => p.seconds % 1000 === 0) && points[points.length - 1].seconds >= 60_000;
  const pts = points.map((p) => ({ t: ms ? p.seconds / 1000 : p.seconds, v: p.ftpPercent }));
  const spacing = median(pts.slice(1).map((p, i) => p.t - pts[i].t));
  const dense = spacing <= 2;
  // breakpoints given twice at a jump draw lines between them; otherwise each holds until the next
  const lines = !dense && pts.some((p, i) => i > 0 && p.t === pts[i - 1].t);
  const end = Math.round(pts[pts.length - 1].t + (dense ? spacing : 0));
  const out: number[] = [];
  let j = 0;
  for (let t = 0; t < end; t++) {
    while (j + 1 < pts.length && pts[j + 1].t <= t) j++;
    const a = pts[j];
    const b = pts[j + 1];
    out.push(lines && b && b.t > a.t ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : a.v);
  }
  return out;
}

/** The fewest points (indices) whose straight lines stay within the tolerance of `v[from..to]`. */
function corners(v: number[], from: number, to: number): number[] {
  const keep = new Set([from, to]);
  const stack: [number, number][] = [[from, to]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let most = TOLERANCE;
    for (let i = a + 1; i < b; i++) {
      const off = Math.abs(v[i] - (v[a] + ((v[b] - v[a]) * (i - a)) / (b - a)));
      if (off > most) {
        most = off;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}

interface Piece {
  duration: number;
  low: number;
  high: number;
  ramp: boolean;
}

/** Steady stretches and ramps, % of FTP. */
function pieces(v: number[]): Piece[] {
  const out: Piece[] = [];
  const add = (from: number, to: number, low: number, high: number) => {
    const ramp = Math.abs(high - low) > 1.5;
    const flat = v.slice(from, to).reduce((s, x) => s + x, 0) / (to - from);
    const last = out[out.length - 1];
    // a steady stretch next to one at much the same level is the same step
    if (!ramp && last && !last.ramp && Math.abs(last.low - flat) <= TOLERANCE) {
      const d = last.duration + to - from;
      last.low = last.high = (last.low * last.duration + flat * (to - from)) / d;
      last.duration = d;
    } else out.push(ramp ? { duration: to - from, low, high, ramp } : { duration: to - from, low: flat, high: flat, ramp });
  };
  let start = 0;
  for (let i = 1; i <= v.length; i++) {
    if (i < v.length && Math.abs(v[i] - v[i - 1]) <= JUMP) continue;
    // between jumps: straight lines through the corners
    const k = corners(v, start, i - 1);
    if (k.length === 1) add(start, i, v[start], v[start]);
    for (let n = 0; n + 1 < k.length; n++) add(k[n], n + 2 === k.length ? i : k[n + 1], v[k[n]], v[k[n + 1]]);
    start = i;
  }
  return out;
}

/** Warm-up and cool-down around the work, recoveries between: by level against the hardest part. */
function intents(steps: Piece[]): WorkoutIntent[] {
  const level = (s: Piece) => (s.low + s.high) / 2;
  const peak = Math.max(...steps.map(level));
  // tempo and up is work; on an endurance ride, its main level
  const work = peak >= 76 ? 76 : Math.max(56, peak - 5);
  const first = steps.findIndex((s) => level(s) >= work);
  const last = steps.length - 1 - [...steps].reverse().findIndex((s) => level(s) >= work);
  return steps.map((s, i) => (first < 0 ? 'active' : i < first ? 'warmup' : i > last ? 'cooldown' : level(s) < 60 ? 'recovery' : 'active'));
}

/** Runs of the same steps, as repeats: 3 × (8 min, 4 min) rather than six steps. */
function repeats(steps: WorkoutStep[]): WorkoutBlock[] {
  const same = (a: WorkoutStep, b: WorkoutStep) => Math.abs(a.duration - b.duration) <= 1 && Math.abs(a.low - b.low) <= 0.005 && Math.abs(a.high - b.high) <= 0.005 && !!a.ramp === !!b.ramp;
  const out: WorkoutBlock[] = [];
  let i = 0;
  while (i < steps.length) {
    let best = { len: 0, count: 1 };
    for (let len = 1; len <= 4 && i + 2 * len <= steps.length; len++) {
      let count = 1;
      while (i + (count + 1) * len <= steps.length && steps.slice(i, i + len).every((s, k) => same(s, steps[i + count * len + k]))) count++;
      if (count > 1 && len * count > best.len * best.count) best = { len, count };
    }
    if (best.count > 1) {
      out.push({ kind: 'repeat', id: `r${i}`, count: best.count, steps: steps.slice(i, i + best.len) });
      i += best.len * best.count;
    } else out.push(steps[i++]);
  }
  return out;
}

// ---------- TrainerRoad's FTP beside this app's ----------

export interface FtpPoint {
  date: string;
  value: number;
}

/** One of TrainerRoad's FTP records: what it applied, what AI FTP Detection found or predicts. */
export interface TrFtpRecord extends FtpPoint {
  /** applied: in use from that day (set by hand, by a test, or AI FTP's and accepted); detected: AI FTP's, not taken; predicted: expected by a future day; pending: waiting to be accepted */
  kind: 'applied' | 'detected' | 'predicted' | 'pending';
  /** TrainerRoad's own code for where it came from */
  source: number | string | null;
  lowConfidence: boolean | null;
}

/** Where an FTP record came from, as TrainerRoad's own app words it (its FitnessThresholdSource). */
export const FTP_SOURCES: Record<number, string> = {
  0: 'Unknown',
  1: 'Legacy API: FTP update from older apps',
  2: 'AI FTP 1.0: detected',
  3: 'Ramp Test',
  4: 'Manual FTP entry (profile)',
  5: 'Fitness slider (onboarding)',
  6: 'Manual FTP entry (onboarding)',
  7: '8-minute test',
  8: '20-minute test',
  9: 'AI FTP 2.0: onboarding',
  10: 'Reset',
  11: '+9 FTP adjustment: Specialty',
  12: '−2 FTP adjustment: failed workout',
  13: 'AI FTP 1.0: post workout',
  14: 'AI FTP 1.0: +9 post workout',
  15: 'AI FTP 1.0: auto',
  16: 'Zwift Ramp Test',
  17: 'AI FTP 2.0: failed workout',
  18: 'AI FTP 2.0: no RPE workouts found',
  19: 'AI FTP 2.0: post workout',
  20: 'AI FTP 2.0: auto',
  21: 'AI FTP 1.0: prediction',
  22: 'AI FTP 3.0: prediction',
  23: 'AI FTP 3.0: hard fail',
  24: 'AI FTP 3.0: breakthrough',
  25: 'AI FTP 3.0: mid-phase',
  26: 'Estimated from backfill',
};

/**
 * The sources that are AI FTP's findings and predictions: the athlete takes them or leaves them,
 * and TrainerRoad marks the ones taken as applied. It doesn't mark any other: an FTP set by hand,
 * by a test or before it kept sources (0) was in use from the day it was set.
 */
export const AI_FTP_SOURCES = new Set([2, 9, 13, 14, 15, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26]);

/** Why AI FTP Detection can't run now (its CannotUseAiFtpReason). */
export const AI_FTP_REASONS: Record<number, string> = {
  0: 'an error',
  1: 'no valid date of birth',
  2: 'not enough data yet',
  3: 'the FTP changed too recently',
  4: 'a detection was looked at too recently',
  5: 'no valid weight',
};

export interface FtpEvent extends TrFtpRecord {
  /** this app's FTP that day (none for a day still to come), and TrainerRoad's less it */
  app: number | null;
  diff: number | null;
}

export interface FtpAgreement {
  /** days both had an FTP, from the start of TrainerRoad's current stretch */
  days: number;
  /** TrainerRoad's less this app's, on average (W), its share of this app's, and the typical gap either way */
  mean: number;
  meanPct: number;
  meanAbs: number;
}

/** The value in effect on a day from a series of changes (sorted by date). */
export function valueOn(series: FtpPoint[], date: string): number | null {
  let lo = 0;
  let hi = series.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].date <= date) {
      found = series[mid].value;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

const DAY = 86400000;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
/** a year or more without a change ends a stretch of TrainerRoad's FTP: one left that long wasn't being kept up */
const STALE_DAYS = 365;

/**
 * TrainerRoad's FTP records against this app's FTP estimate of the same day, and how closely
 * the FTP each had in effect agreed, day by day, over TrainerRoad's current stretch (`since`:
 * from the first change after the last year without one). `applied` is TrainerRoad's FTP
 * history, two changes on a day in the order made; `others` its records (applied ones are in the history).
 */
export function compareFtp(applied: FtpPoint[], others: TrFtpRecord[], app: FtpPoint[], today: string): { events: FtpEvent[]; agreement: FtpAgreement | null; since: string | null } {
  // a stable sort: the last change of a day stays last
  const history = [...applied].sort((a, b) => a.date.localeCompare(b.date));
  const series = [...app].sort((a, b) => a.date.localeCompare(b.date));
  const records: TrFtpRecord[] = [
    // a change in the history that TrainerRoad also recorded on its own is told by that record, which says where it came from
    ...history.filter((p) => !others.some((o) => o.kind === 'applied' && o.date === p.date && Math.abs(p.value - o.value) < 1)).map((p): TrFtpRecord => ({ ...p, kind: 'applied', source: null, lowConfidence: null })),
    ...others,
  ].sort((a, b) => a.date.localeCompare(b.date));
  const events = records.map((r): FtpEvent => {
    const a = r.date <= today ? valueOn(series, r.date) : null;
    return { ...r, app: a, diff: a != null ? r.value - a : null };
  });
  let start = 0;
  for (let i = 1; i < history.length; i++) if (Date.parse(history[i].date) - Date.parse(history[i - 1].date) >= STALE_DAYS * DAY) start = i;
  const since = history[start]?.date ?? null;
  let agreement: FtpAgreement | null = null;
  if (since && series.length) {
    let n = 0;
    let sum = 0;
    let pct = 0;
    let abs = 0;
    for (let d = since; d <= today; d = nextDay(d)) {
      const t = valueOn(history, d);
      const a = valueOn(series, d);
      if (t == null || a == null) continue;
      n++;
      sum += t - a;
      pct += (t - a) / a;
      abs += Math.abs(t - a);
    }
    if (n) agreement = { days: n, mean: sum / n, meanPct: pct / n, meanAbs: abs / n };
  }
  return { events, agreement, since };
}

// ---------- progression levels ----------

/** TrainerRoad's progression ids, as its zones */
export const PROGRESSION_ZONES: [number, string][] = [
  [33, 'Endurance'],
  [16, 'Tempo'],
  [84, 'Sweet Spot'],
  [83, 'Threshold'],
  [85, 'VO2 Max'],
  [79, 'Anaerobic'],
];

export interface ZoneLevel {
  id: number;
  zone: string;
  /** where it stands (1–10), and where TrainerRoad expects it by the end of the plan */
  level: number | null;
  predicted: number | null;
  /** its last change */
  changed: { date: string | null; from: number | null; to: number | null; reason: string | number | null } | null;
  /** were AI FTP Detection's FTP accepted: the level now, and after */
  ai: { from: number | null; to: number | null } | null;
}

const numOr = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Progression levels by zone, from TrainerRoad's levels and AI FTP Detection's projection of them. */
export function progressionLevels(levels: unknown, detection: unknown): ZoneLevel[] {
  // TrainerRoad's shapes, read defensively
  const raw = ((levels as { levels?: Record<string, unknown> } | null)?.levels ?? {}) as Record<string, { recent?: unknown; predicted?: unknown; changeEvent?: { date?: unknown; reason?: unknown; level?: { from?: unknown; to?: unknown } } }>;
  const det = (detection ?? {}) as { currentProgressionLevels?: { progressionId?: unknown; previousDisplayLevel?: unknown }[]; projectedProgressionLevels?: { progressionId?: unknown; displayFinalLevel?: unknown }[] };
  const now = new Map((Array.isArray(det.currentProgressionLevels) ? det.currentProgressionLevels : []).map((x) => [Number(x.progressionId), numOr(x.previousDisplayLevel)]));
  const after = new Map((Array.isArray(det.projectedProgressionLevels) ? det.projectedProgressionLevels : []).map((x) => [Number(x.progressionId), numOr(x.displayFinalLevel)]));
  const order = new Map(PROGRESSION_ZONES.map(([id], i) => [id, i]));
  const name = new Map(PROGRESSION_ZONES);
  return Object.entries(raw)
    .map(([key, v]): ZoneLevel => {
      const id = Number(key);
      const c = v?.changeEvent;
      const from = numOr(c?.level?.from);
      const to = numOr(c?.level?.to);
      const predicted = numOr(v?.predicted);
      return {
        id,
        zone: name.get(id) ?? `Progression ${key}`,
        level: numOr(v?.recent),
        // 0: none expected
        predicted: predicted != null && predicted > 0 ? predicted : null,
        // a change that left the level where it was isn't one
        changed: c && to != null && from !== to ? { date: typeof c.date === 'string' ? c.date.slice(0, 10) : null, from, to, reason: (c.reason as string | number | null) ?? null } : null,
        ai: now.has(id) || after.has(id) ? { from: now.get(id) ?? null, to: after.get(id) ?? null } : null,
      };
    })
    .sort((a, b) => (order.get(a.id) ?? 99 + a.id) - (order.get(b.id) ?? 99 + b.id));
}

/** A workout's structure from its TrainerRoad profile; null when there's nothing to read. */
export function structureFromProfile(points: ProfilePoint[]): WorkoutStructure | null {
  const pts = points.filter((p) => Number.isFinite(p?.seconds) && Number.isFinite(p?.ftpPercent) && p.seconds >= 0).sort((a, b) => a.seconds - b.seconds);
  if (pts.length < 2) return null;
  const v = perSecond(pts);
  if (v.length < 60) return null;
  // a second or two between levels is the change from one to the next, not a step
  const ps = pieces(v).reduce<Piece[]>((out, p, i, all) => {
    if (p.duration < 5 && all.length > 1) {
      if (i + 1 < all.length) all[i + 1].duration += p.duration;
      else out[out.length - 1].duration += p.duration;
    } else out.push(p);
    return out;
  }, []);
  const kinds = intents(ps);
  const round = (x: number) => Math.round(x * 10) / 1000;
  // ids by position, so the same profile always reads the same
  const steps = ps.map((p, i): WorkoutStep => ({ kind: 'step', id: `s${i}`, intent: kinds[i], duration: p.duration, low: round(p.low), high: round(p.high), ...(p.ramp ? { ramp: true } : {}) }));
  return { target: 'power', blocks: repeats(steps) };
}
