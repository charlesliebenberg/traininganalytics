/**
 * What a session was and how it went.
 *
 * The work intervals in an activity are found from its output (power, or grade-adjusted speed
 * for runs) relative to threshold, and grouped into sets of like repetitions. The main set
 * decides what kind of session it was; for it, how evenly it was ridden or run and how heart
 * rate answered. A hard ride without one is described by its surges.
 */
import { prefixSums, round, toFloat, type Series } from './series';
import { normalizedPower } from './power';

export type SessionSport = 'ride' | 'run';
export type SessionType = 'recovery' | 'endurance' | 'tempo' | 'sweetspot' | 'threshold' | 'vo2' | 'anaerobic' | 'sprint' | 'race' | 'mixed';

/** Bump when the analysis changes, so stored analyses are rebuilt. */
export const SESSION_VERSION = 1;

export interface Rep {
  /** [start, end) seconds from the activity start */
  start: number;
  end: number;
  /** mean output: W, or grade-adjusted m/s for runs */
  out: number;
  /** output as a fraction of threshold */
  rel: number;
  /** mean heart rate over the rep */
  hr: number | null;
  /** mean heart rate over the rep's last 30 s */
  hrEnd: number | null;
  /** how far heart rate fell in the 60 s after the rep (when the recovery lasted that long) */
  hrDrop: number | null;
  /** output over the rep's first quarter, as a fraction of the rep's mean (reps of 2 min or more) */
  opening: number | null;
}

export interface WorkSet {
  /** like repetitions; a ladder of sustained efforts of different lengths; or one sustained effort */
  kind: 'reps' | 'ladder' | 'single';
  reps: Rep[];
  /** median rep duration, s */
  dur: number;
  /** time-weighted mean output of the reps, and as a fraction of threshold */
  out: number;
  rel: number;
  /** median recovery between reps, s, and its output as a fraction of threshold */
  rest: number | null;
  restRel: number | null;
  /** work done before the set began, kJ (rides) */
  kjBefore?: number | null;
}

export interface Execution {
  /** last rep against the first (like reps only): −0.05 = 5 % down */
  fade: number | null;
  /** coefficient of variation of the reps' output */
  cv: number;
  /** reps' first quarter against their mean, averaged (1.08 = opened 8 % hard) */
  opening: number | null;
  /** heart rate at the end of the last rep minus at the end of the first, bpm */
  hrRise: number | null;
  /** heart-rate drop in the 60 s after the first and the last rep that had that long to recover */
  hrDrop: [number, number] | null;
}

export interface Surges {
  /** efforts of 10 s or more at 120 % of FTP and above */
  count: number;
  /** of them, a minute or longer */
  long: number;
  /** seconds spent in them */
  time: number;
  /** moving seconds above FTP */
  aboveFtp: number;
  /** the hardest 5 minutes of the ride */
  peak: { start: number; out: number } | null;
}

export interface SessionAnalysis {
  v: number;
  sport: SessionSport;
  type: SessionType;
  /** a long session for the sport: 2½ hours riding, 75 minutes running */
  long: boolean;
  /** threshold the analysis is relative to: FTP (W) or threshold speed (m/s) */
  thr: number;
  /** moving seconds */
  moving: number;
  /** intensity factor and variability index the type was judged on */
  intensity: number;
  vi: number | null;
  main: WorkSet | null;
  /** every work interval, in order */
  efforts: Rep[];
  execution: Execution | null;
  /** rides with power */
  surges: Surges | null;
  /** continuous runs: mean output over the first and second half of the moving time */
  halves: [number, number] | null;
}

export interface SessionInput {
  sport: SessionSport;
  /** 1 Hz power (rides) or grade-adjusted speed (runs) */
  output: Series;
  hr?: Series | null;
  /** 1 moving, 0 stopped */
  moving?: ArrayLike<number> | null;
  /** FTP (W) or threshold speed (m/s) */
  thr: number;
  /** the activity's own intensity factor and VI, if already known */
  intensity?: number | null;
  vi?: number | null;
}

/** Levels at which work is looked for (fraction of threshold), smoothing, tolerated dips and minimum length, s. */
const PASSES: Record<SessionSport, { level: number; smooth: number; gap: number; min: number }[]> = {
  ride: [
    { level: 0.8, smooth: 30, gap: 30, min: 150 },
    { level: 1.05, smooth: 10, gap: 6, min: 40 },
    { level: 1.3, smooth: 5, gap: 3, min: 10 },
  ],
  run: [
    { level: 0.88, smooth: 30, gap: 20, min: 150 },
    { level: 1.03, smooth: 10, gap: 6, min: 40 },
    { level: 1.15, smooth: 5, gap: 3, min: 10 },
  ],
};
/** reps of one set: lengths within a factor of 1.25 (or 20 s) and intensities within this of each other */
const SAME_REL: Record<SessionSport, number> = { ride: 0.08, run: 0.05 };
const LONG: Record<SessionSport, number> = { ride: 2.5 * 3600, run: 75 * 60 };

function centered(ps: Float64Array, n: number, w: number): Float64Array {
  const half = Math.floor(w / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(n, i + half + 1);
    out[i] = (ps[b] - ps[a]) / (b - a);
  }
  return out;
}

const avg = (ps: Float64Array, a: number, b: number) => (b > a ? (ps[b] - ps[a]) / (b - a) : 0);

/** Stretches where the smoothed output holds a level, trimmed to where the effort itself starts and ends. */
function runsAbove(ps: Float64Array, n: number, level: number, smooth: number, gap: number, min: number): [number, number][] {
  const s = centered(ps, n, smooth);
  const p5 = centered(ps, n, 5);
  const out: [number, number][] = [];
  let start = -1;
  let last = -1;
  const flush = () => {
    if (start < 0) return;
    // smoothing spreads an effort by half its window either side: find where 5 s output crosses the level
    let a = Math.max(0, start - Math.floor(smooth / 2));
    let b = Math.min(n, last + Math.floor(smooth / 2));
    while (a < b && p5[a] < level) a++;
    while (b > a && p5[b - 1] < level) b--;
    if (b - a >= min && avg(ps, a, b) >= level * 0.97) out.push([a, b]);
    start = -1;
  };
  for (let i = 0; i < n; i++) {
    if (s[i] >= level) {
      if (start < 0) start = i;
      last = i + 1;
    } else if (start >= 0 && i - last > gap) flush();
  }
  flush();
  return out;
}

/** Coefficient of variation of 10 s output within [a, b): steady reps are low, 30/30s high. */
function unsteadiness(ps: Float64Array, a: number, b: number): number {
  const xs: number[] = [];
  for (let i = a; i + 10 <= b; i += 10) xs.push(avg(ps, i, i + 10));
  if (xs.length < 3) return 0;
  const m = xs.reduce((x, y) => x + y, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((x, y) => x + (y - m) ** 2, 0) / xs.length);
  return m > 0 ? sd / m : 0;
}

/**
 * Work intervals, [start, end) in seconds. Sustained efforts first; shorter, harder ones inside
 * a steady sustained effort belong to it, but a sustained "effort" made of on-off bursts
 * (30/30s) is the bursts. A sustained effort broken by a brief or shallow dip (a corner, the
 * top of a rise) is one effort.
 */
export function detectWork(output: Series, thr: number, sport: SessionSport): [number, number][] {
  if (!thr || output.length < 30) return [];
  const n = output.length;
  const ps = prefixSums(toFloat(output));
  const found = PASSES[sport].map((x) => runsAbove(ps, n, x.level * thr, x.smooth, x.gap, x.min));
  const overlaps = (a: [number, number], b: [number, number]) => a[0] < b[1] && b[0] < a[1];
  let kept: [number, number][] = [];
  for (let k = 0; k < found.length; k++) {
    for (const iv of found[k]) if (!kept.some((o) => overlaps(o, iv))) kept.push(iv);
    if (k === 0) {
      const blocks = kept.filter((iv) => unsteadiness(ps, iv[0], iv[1]) > 0.3);
      if (blocks.length) {
        kept = kept.filter((iv) => !blocks.includes(iv));
        const bursts = [...found[1], ...found[2]].sort((u, v) => v[1] - v[0] - (u[1] - u[0]));
        for (const b of blocks) for (const x of bursts) if (x[0] >= b[0] - 5 && x[1] <= b[1] + 5 && !kept.some((o) => overlaps(o, x))) kept.push(x);
      }
    }
  }
  kept.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  const minLen = PASSES[sport][0].min;
  for (const iv of kept) {
    const prev = merged[merged.length - 1];
    if (prev && prev[1] - prev[0] >= minLen && iv[1] - iv[0] >= minLen) {
      const gap = iv[0] - prev[1];
      if (gap <= 30 || (gap <= 75 && avg(ps, prev[1], iv[0]) >= 0.6 * thr)) {
        prev[1] = iv[1];
        continue;
      }
    }
    merged.push([iv[0], iv[1]]);
  }
  return merged;
}

function repStats(ps: Float64Array, hps: Float64Array | null, a: number, b: number, thr: number, next: number): Rep {
  const out = avg(ps, a, b);
  const d = b - a;
  let hr: number | null = null,
    hrEnd: number | null = null,
    hrDrop: number | null = null;
  if (hps) {
    hr = avg(hps, a, b);
    hrEnd = avg(hps, Math.max(a, b - 30), b);
    // the 10 s around a minute after the rep, if nothing hard started before then
    if (next - b >= 70 && b + 65 < hps.length) hrDrop = avg(hps, b - 10, b) - avg(hps, b + 55, b + 65);
  }
  const opening = d >= 120 && out > 0 ? avg(ps, a, a + Math.floor(d / 4)) / out : null;
  return { start: a, end: b, out, rel: out / thr, hr, hrEnd, hrDrop, opening };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};
const total = (reps: Rep[]) => reps.reduce((t, r) => t + r.end - r.start, 0);

function makeSet(reps: Rep[], kind: WorkSet['kind'], ps: Float64Array, thr: number): WorkSet {
  const gaps = reps.slice(1).map((r, i) => [reps[i].end, r.start] as const);
  const out = reps.reduce((s, r) => s + r.out * (r.end - r.start), 0) / total(reps);
  return {
    kind,
    reps,
    dur: median(reps.map((r) => r.end - r.start)),
    out,
    rel: out / thr,
    rest: gaps.length ? median(gaps.map(([a, b]) => b - a)) : null,
    restRel: gaps.length ? median(gaps.map(([a, b]) => avg(ps, a, b))) / thr : null,
  };
}

/** Sets of like repetitions, in order; an effort unlike its neighbours stays single. */
export function groupSets(reps: Rep[], sport: SessionSport, ps: Float64Array, thr: number): WorkSet[] {
  const sets: Rep[][] = [];
  for (const r of reps) {
    const cur = sets[sets.length - 1];
    if (cur) {
      const d = median(cur.map((x) => x.end - x.start));
      const rel = median(cur.map((x) => x.rel));
      const len = r.end - r.start;
      const like = (Math.abs(len - d) <= 20 || Math.max(len, d) / Math.min(len, d) <= 1.25) && Math.abs(r.rel - rel) <= SAME_REL[sport] && r.start - cur[cur.length - 1].end <= Math.max(2.5 * d, 600);
      if (like) {
        cur.push(r);
        continue;
      }
    }
    sets.push([r]);
  }
  return sets.map((s) => makeSet(s, s.length > 1 ? 'reps' : 'single', ps, thr));
}

/** Load of a set, like TSS: seconds × intensity². */
const load = (s: WorkSet) => s.reps.reduce((t, r) => t + (r.end - r.start) * r.rel * r.rel, 0);

/**
 * Whether a set is big enough for its intensity to be what the session was for: two 3-minute
 * rises in an endurance ride are terrain; 3 × 10 minutes at threshold is a workout.
 */
export function substantial(s: WorkSet, sport: SessionSport): boolean {
  const n = s.reps.length;
  const t = total(s.reps);
  const { rel: r, dur: d } = s;
  if (s.kind === 'single') return d >= 720 && r >= (sport === 'ride' ? 0.85 : 0.9);
  if (sport === 'ride') {
    if (r >= 1.5 && d <= 30) return n >= 3;
    if (r >= 1.2 && d <= 150) return n >= 3 && t >= 120;
    if (r >= 1.05 && d < 480) return d >= 90 && t >= 480;
    if (r >= 0.95) return d >= 240 && t >= 720;
    if (r >= 0.88) return d >= 300 && t >= 900;
    return d >= 480 && t >= 1200;
  }
  // strides at the end of an easy run are not an interval session
  if (r >= 1.15 && d <= 90) return n >= 6 && t >= 240;
  if (r >= 1.03 && d < 480) return d >= 60 && t >= 360;
  if (r >= 0.97) return d >= 240 && t >= 720;
  return d >= 480 && t >= 1200;
}

/**
 * The set that defines the session: the biggest (by load) substantial set of repetitions or
 * sustained effort — or, without a set of repetitions, a compact ladder of sustained efforts
 * (a pyramid, or a run of climbs) if that was bigger.
 */
export function mainSet(sets: WorkSet[], sport: SessionSport, ps: Float64Array, thr: number): WorkSet | null {
  const candidates = sets.filter((s) => substantial(s, sport));
  if (!candidates.some((s) => s.kind === 'reps')) {
    const floor = sport === 'ride' ? 0.85 : 0.9;
    const sustained = sets.flatMap((s) => s.reps).filter((r) => r.end - r.start >= 240 && r.rel >= floor);
    // close together: no more than twice the shorter effort, or 10 minutes, between them
    let best: Rep[] = [];
    let cur: Rep[] = [];
    for (const r of sustained) {
      const prev = cur[cur.length - 1];
      if (prev && r.start - prev.end > Math.max(600, 2 * Math.min(r.end - r.start, prev.end - prev.start))) cur = [];
      cur.push(r);
      if (cur.length > best.length) best = [...cur];
    }
    if (best.length >= 2 && total(best) >= 900) candidates.push(makeSet(best, 'ladder', ps, thr));
  }
  return candidates.length ? candidates.reduce((a, b) => (load(b) > load(a) ? b : a)) : null;
}

function execution(set: WorkSet): Execution | null {
  const reps = set.reps;
  if (reps.length < 2) return null;
  const outs = reps.map((r) => r.out);
  const m = outs.reduce((a, b) => a + b, 0) / outs.length;
  const openings = reps.map((r) => r.opening).filter((x): x is number => x != null);
  const first = reps[0].hrEnd;
  const last = reps[reps.length - 1].hrEnd;
  const drops = reps.map((r) => r.hrDrop).filter((x): x is number => x != null);
  return {
    fade: set.kind === 'reps' ? outs[outs.length - 1] / outs[0] - 1 : null,
    cv: Math.sqrt(outs.reduce((a, b) => a + (b - m) ** 2, 0) / outs.length) / m,
    opening: openings.length ? openings.reduce((a, b) => a + b, 0) / openings.length : null,
    hrRise: set.kind === 'reps' && first != null && last != null ? last - first : null,
    hrDrop: drops.length >= 2 ? [drops[0], drops[drops.length - 1]] : null,
  };
}

function surges(ps: Float64Array, n: number, ftp: number, p: Float64Array, moving: ArrayLike<number> | null | undefined): Surges {
  const bursts = runsAbove(ps, n, 1.2 * ftp, 5, 3, 10);
  let above = 0;
  for (let i = 0; i < n; i++) if (p[i] > ftp && (!moving || moving[i])) above++;
  let peak: Surges['peak'] = null;
  for (let i = 0; i + 300 <= n; i++) {
    const v = (ps[i + 300] - ps[i]) / 300;
    if (!peak || v > peak.out) peak = { start: i, out: v };
  }
  return { count: bursts.length, long: bursts.filter(([a, b]) => b - a >= 60).length, time: bursts.reduce((t, [a, b]) => t + b - a, 0), aboveFtp: above, peak };
}

/** What kind of session: its main set if it had one, else how it was ridden or run. */
export function classify(sport: SessionSport, main: WorkSet | null, intensity: number, vi: number | null, s: Surges | null, moving: number): SessionType {
  const v = vi ?? 1;
  const perHour = s ? s.count / Math.max(0.5, moving / 3600) : 0;
  // a hard, surging ride: its efforts are part of the surging — unless a set of repetitions
  // carried a good part of its load (3 × 10 minutes inside a ride with the bunch)
  const surging = sport === 'ride' && !!s && moving >= 1200 && intensity >= 0.8 && ((v >= 1.18 && perHour >= 6) || (v >= 1.13 && perHour >= 10));
  if (surging && !(main?.kind === 'reps' && load(main) >= 0.25 * moving * intensity * intensity)) return 'race';
  if (main) {
    const r = main.rel;
    if (sport === 'ride') {
      if (r >= 1.5 && main.dur <= 30) return 'sprint';
      if (r >= 1.2 && main.dur <= 150) return 'anaerobic';
      if (r >= 1.05 && main.dur < 480) return 'vo2';
      if (r >= 0.95) return 'threshold';
      if (r >= 0.88) return 'sweetspot';
      return 'tempo';
    }
    if (r >= 1.15 && main.dur <= 90) return 'anaerobic';
    if (r >= 1.03 && main.dur < 480) return 'vo2';
    if (r >= 0.97) return 'threshold';
    return 'tempo';
  }
  if (sport === 'ride') {
    if (intensity < 0.6) return moving <= 75 * 60 ? 'recovery' : 'endurance';
    if (intensity < 0.78) return 'endurance';
    if (intensity < 0.88) return v <= 1.12 ? 'tempo' : 'mixed';
    if (moving >= 1200 && v > 1.1) return 'race';
    return v <= 1.1 ? 'threshold' : 'mixed';
  }
  if (intensity < 0.78) return 'recovery';
  if (intensity < 0.88) return 'endurance';
  if (intensity < 0.97) return 'tempo';
  return 'threshold';
}

const roundRep = (r: Rep, sport: SessionSport): Rep => ({
  start: r.start,
  end: r.end,
  out: round(r.out, sport === 'ride' ? 1 : 3)!,
  rel: round(r.rel, 3)!,
  hr: round(r.hr, 1),
  hrEnd: round(r.hrEnd, 1),
  hrDrop: round(r.hrDrop, 1),
  opening: round(r.opening, 3),
});

/** Analyse a session from its 1 Hz output and heart rate. */
export function analyzeSession(x: SessionInput): SessionAnalysis | null {
  const { sport, thr } = x;
  const n = x.output.length;
  if (!thr || n < 300) return null;
  const p = toFloat(x.output);
  const ps = prefixSums(p);
  let hps: Float64Array | null = null;
  if (x.hr && x.hr.length === n) {
    const h = toFloat(x.hr);
    // hold the last reading through dropouts so averages don't fall towards zero
    let seen = false;
    for (let i = 0; i < n; i++) {
      if (h[i] > 0) seen = true;
      else if (i > 0) h[i] = h[i - 1];
    }
    if (seen) {
      let f = 0;
      while (f < n && !h[f]) f++;
      for (let i = 0; i < f; i++) h[i] = h[f];
      hps = prefixSums(h);
    }
  }
  const mv = x.moving;
  const movingOut: number[] = [];
  for (let i = 0; i < n; i++) if (!mv || mv[i]) movingOut.push(p[i]);
  const moving = movingOut.length;
  if (moving < 300) return null;
  const mean = movingOut.reduce((a, b) => a + b, 0) / moving;
  const np = normalizedPower(movingOut);
  const intensity = x.intensity ?? (np ?? mean) / thr;
  const vi = x.vi !== undefined ? x.vi : np && mean > 0 ? np / mean : null;

  const ivs = detectWork(p, thr, sport);
  const reps = ivs.map(([a, b], i) => repStats(ps, hps, a, b, thr, ivs[i + 1]?.[0] ?? n));
  const sets = groupSets(reps, sport, ps, thr);
  let main = mainSet(sets, sport, ps, thr);
  const sg = sport === 'ride' ? surges(ps, n, thr, p, mv) : null;
  // short reps among many other surges: sprints in a bunch ride, not a session of sprints
  if (main?.kind === 'reps' && main.dur <= 150 && sg && sg.count > 2 * main.reps.length + 3) main = null;
  const type = classify(sport, main, intensity, vi, sg, moving);
  const kept = type === 'race' ? null : main;
  const half = Math.floor(moving / 2);
  const halfMean = (a: number, b: number) => movingOut.slice(a, b).reduce((s, v) => s + v, 0) / (b - a);
  const r = (rep: Rep) => roundRep(rep, sport);
  return {
    v: SESSION_VERSION,
    sport,
    type,
    long: moving >= LONG[sport],
    thr,
    moving,
    intensity: round(intensity, 3)!,
    vi: round(vi, 3),
    main: kept
      ? { ...kept, reps: kept.reps.map(r), out: round(kept.out, sport === 'ride' ? 1 : 3)!, rel: round(kept.rel, 3)!, restRel: round(kept.restRel, 3), kjBefore: sport === 'ride' ? Math.round(ps[kept.reps[0].start] / 1000) : null }
      : null,
    efforts: reps.map(r),
    execution: kept ? execution(kept) : null,
    surges: sg ? { ...sg, peak: sg.peak ? { start: sg.peak.start, out: Math.round(sg.peak.out) } : null } : null,
    halves: sport === 'run' && !kept && moving >= 1200 ? [round(halfMean(0, half), 3)!, round(halfMean(half, moving), 3)!] : null,
  };
}

// ---------- progression ----------

/** A set's structure in words: "3 × 10 min", "40 min", "3 efforts". */
export function setLabel(s: { kind: WorkSet['kind']; reps: number | Rep[]; dur: number }): string {
  const n = typeof s.reps === 'number' ? s.reps : s.reps.length;
  const d = (sec: number) => (sec < 90 ? `${Math.round(sec / 5) * 5} s` : sec < 300 ? `${Math.round(sec / 30) / 2} min` : `${Math.round(sec / 60)} min`);
  if (s.kind === 'single') return d(s.dur);
  if (s.kind === 'ladder') return `${n} efforts`;
  return `${n} × ${d(s.dur)}`;
}

/** The main set of an earlier session, as compared with. */
export interface SetSummary {
  id: number;
  date: string;
  type: SessionType;
  kind: WorkSet['kind'];
  reps: number;
  /** median rep length, s */
  dur: number;
  /** time-weighted mean output of the reps */
  out: number;
  /** mean heart rate over the reps' last 30 s */
  hrEnd: number | null;
  /** the day's mean temperature, °C */
  temp: number | null;
  /** work done before the set began, kJ (rides) */
  kjBefore: number | null;
}

export interface Progression {
  /** comparable sets in the year before, oldest first, then this one */
  series: SetSummary[];
  /** the most recent comparable set before this one */
  last: SetSummary | null;
  /** output against the last comparable set, as a fraction (0.03 = 3 % more) */
  change: number | null;
  /** end-of-rep heart rate against the last comparable set, bpm */
  hrChange: number | null;
  /** best comparable set before this one, by output */
  best: SetSummary | null;
  /** this set's place among them by output (1 = best) */
  rank: number;
  of: number;
}

export function summarizeSet(id: number, date: string, a: Pick<SessionAnalysis, 'type' | 'main'> & { main: WorkSet }, temp: number | null = null): SetSummary {
  const s = a.main;
  const ends = s.reps.map((r) => r.hrEnd).filter((x): x is number => x != null);
  return { id, date, type: a.type, kind: s.kind, reps: s.reps.length, dur: s.dur, out: s.out, hrEnd: ends.length === s.reps.length ? ends.reduce((x, y) => x + y, 0) / ends.length : null, temp, kjBefore: s.kjBefore ?? null };
}

const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);
const totalDur = (s: SetSummary) => s.dur * s.reps;

/**
 * The same workout, near enough: the same kind of session and of set, output within 15 %,
 * and a similar dose — rep counts within one, rep lengths within 30 % and total time within
 * 60 %. 2 × 10 and 3 × 10 minutes at threshold compare; 2 × 10 and 3 × 12 don't, nor
 * 3 × 10 at threshold and 2 × 20 at tempo.
 */
export function comparableSets(a: SetSummary, b: SetSummary): boolean {
  if (a.type !== b.type || a.kind !== b.kind) return false;
  if (Math.abs(Math.log(a.out / b.out)) > 0.15) return false;
  if (a.kind === 'single') return ratio(a.dur, b.dur) <= 1.3;
  if (Math.abs(a.reps - b.reps) > 1 || ratio(totalDur(a), totalDur(b)) > 1.6) return false;
  return a.kind === 'ladder' ? ratio(totalDur(a), totalDur(b)) <= 1.3 : ratio(a.dur, b.dur) <= 1.3;
}

/** This session's main set against the comparable sets of the year before it. */
export function progression(cur: SetSummary, past: SetSummary[]): Progression | null {
  const from = Date.parse(cur.date) - 365 * 86400000;
  const before = past.filter((p) => p.id !== cur.id && Date.parse(p.date) <= Date.parse(cur.date) && Date.parse(p.date) >= from && comparableSets(cur, p)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  if (!before.length) return null;
  const last = before[before.length - 1];
  const best = before.reduce((a, b) => (b.out > a.out ? b : a));
  return {
    series: [...before, cur],
    last,
    change: cur.out / last.out - 1,
    hrChange: cur.hrEnd != null && last.hrEnd != null ? cur.hrEnd - last.hrEnd : null,
    best,
    rank: 1 + before.filter((p) => p.out > cur.out).length,
    of: before.length + 1,
  };
}
