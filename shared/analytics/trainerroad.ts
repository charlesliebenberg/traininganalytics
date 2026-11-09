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
