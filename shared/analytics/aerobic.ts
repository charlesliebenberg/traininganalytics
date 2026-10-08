/**
 * Aerobic fitness from heart rate, without needing a maximal effort.
 *
 * The heart rate a steady output costs falls as aerobic fitness improves. It also moves with
 * things that aren't fitness — heat, the fatigue you carry in, riding indoors — and from day
 * to day for reasons nobody measures. So:
 *  1. every steady stretch of an activity gives an output (power, or grade-adjusted speed for
 *     runs) and the heart rate it settled at;
 *  2. a reference curve maps output to heart rate for this athlete;
 *  3. an activity's "heart-rate cost" is how far its stretches sat above or below that curve,
 *     with heat, fatigue and indoor riding taken out — their sizes learned from the athlete's
 *     own data, by comparing activities with their neighbours in time;
 *  4. a Kalman filter follows fitness as a slowly wandering level. Each activity is evidence,
 *     weighed against the day-to-day noise it is measured with; the filter says what the
 *     history predicted before the activity, and how surprising the activity was.
 *
 * Costs are in bpm: lower is fitter. They're reported as the output the athlete would hold at
 * a reference heart rate, under standard conditions (15 °C, outdoors, TSB 0).
 */

export type AerobicSport = 'ride' | 'run';

/** One steady stretch: output (W or m/s) and the heart rate it settled at. */
export interface SteadyWindow {
  /** seconds from the start of the activity (window centre) */
  t: number;
  out: number;
  hr: number;
  /** °C, when the device recorded it */
  temp: number | null;
}

export interface WindowSpec {
  /** window length, s */
  win: number;
  /** skip the warm-up, s */
  skip: number;
  /** heart rate is read over the end of the window, after it has settled, s */
  settle: number;
  /** steadiness is checked chunk by chunk, s */
  chunk: number;
  /** no chunk more than this fraction off the window's mean */
  steady: number;
  /** ignore stretches below this output (coasting, walking) */
  minOut: number;
  step: number;
  decimals: number;
}

/** the two halves of a stretch must match within this fraction of its mean */
const HALVES = 0.1;

export const WINDOW_SPECS: Record<AerobicSport, WindowSpec> = {
  // 10-minute stretches, heart rate over the last 5 (it lags power by a minute or two)
  ride: { win: 600, skip: 600, settle: 300, chunk: 30, steady: 0.2, minOut: 100, step: 60, decimals: 0 },
  // runs are shorter and GPS pace is noisier: 8 minutes, checked a minute at a time
  run: { win: 480, skip: 300, settle: 240, chunk: 60, steady: 0.15, minOut: 1.5, step: 60, decimals: 2 },
};

/** Steady stretches from 1 Hz output, heart rate and (optional) temperature. */
export function steadyWindows(out: ArrayLike<number>, hr: ArrayLike<number | null>, temp: ArrayLike<number | null> | null, spec: WindowSpec): SteadyWindow[] {
  const res: SteadyWindow[] = [];
  const n = Math.min(out.length, hr.length);
  if (n < spec.skip + spec.win) return res;
  const ps = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) ps[i + 1] = ps[i] + (Number.isFinite(out[i]) ? out[i] : 0);
  const mean = (a: number, b: number) => (ps[b] - ps[a]) / (b - a);
  const f = 10 ** spec.decimals;
  for (let st = spec.skip; st + spec.win <= n; st += spec.step) {
    const m = mean(st, st + spec.win);
    if (m < spec.minOut) continue;
    // the heart rate is read at the end: a stretch that steps up or down mid-way would pair
    // the end's heart rate with the whole stretch's average output
    const half = st + spec.win / 2;
    if (Math.abs(mean(half, st + spec.win) - mean(st, half)) > HALVES * m) continue;
    let steady = true;
    for (let c = st; c < st + spec.win; c += spec.chunk) {
      if (Math.abs(mean(c, Math.min(c + spec.chunk, st + spec.win)) - m) > spec.steady * m) {
        steady = false;
        break;
      }
    }
    if (!steady) continue;
    let hs = 0;
    let hn = 0;
    for (let i = st + spec.settle; i < st + spec.win; i++) {
      const h = hr[i];
      if (h != null && h > 40) {
        hs += h;
        hn++;
      }
    }
    if (hn < (spec.win - spec.settle) * 0.9) continue;
    let ts = 0;
    let tn = 0;
    if (temp) {
      for (let i = st; i < st + spec.win; i++) {
        const v = temp[i];
        if (v != null && Number.isFinite(v)) {
          ts += v;
          tn++;
        }
      }
    }
    res.push({ t: st + spec.win / 2, out: Math.round(m * f) / f, hr: Math.round((hs / hn) * 10) / 10, temp: tn > spec.win / 2 ? Math.round((ts / tn) * 10) / 10 : null });
  }
  return res;
}

/**
 * The whole activity, when it has few steady stretches: heart rate against output smoothed
 * with heart rate's own lag (an exponential response, `tau` seconds), gathered into output
 * bins. On activities that have both, it agrees with the steady reading (r = 0.94, bias under
 * 0.5 bpm, a 2–3 bpm spread) — but not on hard, surgy rides, where surges hold heart rate up
 * beyond any lag (+4 bpm at VI ≥ 1.15, +9 at IF ≥ 0.9): those aren't read at all. Runs show
 * no such bias.
 */
export function kineticReadable(sport: AerobicSport, intensity: number | null, vi: number | null): boolean {
  return sport === 'run' || ((intensity ?? 1) < 0.8 && (vi ?? 2) < 1.15);
}
export interface KineticBin {
  /** mean smoothed output in the bin */
  out: number;
  /** median heart rate */
  hr: number;
  /** seconds in the bin */
  sec: number;
  temp: number | null;
}

export interface KineticSpec {
  tau: number;
  skip: number;
  bin: number;
  /** smoothed output and heart rate ranges used (aerobic, below heart rate's ceiling) */
  out: [number, number];
  hr: [number, number];
}

export const KINETIC_TAU: Record<AerobicSport, number> = { ride: 40, run: 30 };

export function kineticBins(out: ArrayLike<number>, hr: ArrayLike<number | null>, temp: ArrayLike<number | null> | null, spec: KineticSpec): KineticBin[] {
  const n = Math.min(out.length, hr.length);
  const a = 1 - Math.exp(-1 / spec.tau);
  const bins = new Map<number, { o: number; h: number[]; t: number; tn: number }>();
  let e = 0;
  for (let i = 0; i < n; i++) {
    e += ((Number.isFinite(out[i]) ? out[i] : 0) - e) * a;
    const h = hr[i];
    if (i < spec.skip || h == null || h < spec.hr[0] || h > spec.hr[1] || e < spec.out[0] || e > spec.out[1]) continue;
    const k = Math.round(e / spec.bin);
    const b = bins.get(k) ?? { o: 0, h: [], t: 0, tn: 0 };
    b.o += e;
    b.h.push(h);
    const tv = temp?.[i];
    if (tv != null && Number.isFinite(tv)) {
      b.t += tv;
      b.tn++;
    }
    bins.set(k, b);
  }
  const f = spec.bin < 1 ? 1000 : 10;
  return [...bins.values()]
    .filter((b) => b.h.length >= 10)
    .map((b) => ({ out: Math.round((b.o / b.h.length) * f) / f, hr: median(b.h), sec: b.h.length, temp: b.tn ? Math.round((b.t / b.tn) * 10) / 10 : null }))
    .sort((x, y) => x.out - y.out);
}

/** Steady-stretch outputs keyed by heart-rate bin (bpm, multiples of `bin`). */
export function binsFromWindows(windows: SteadyWindow[], bin = 5): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const w of windows) (out[String(Math.round(w.hr / bin) * bin)] ??= []).push(w.out);
  return out;
}

// ---------- the model ----------

export interface AerobicActivity {
  id: number;
  date: string;
  indoor: boolean;
  /** form going into the day (yesterday's CTL − ATL) */
  tsb: number | null;
  windows: SteadyWindow[];
  /** the whole-activity reading, for activities with few or no steady stretches */
  kinetic?: KineticBin[];
}

export interface AerobicModel {
  sport: AerobicSport;
  /** output → heart rate under standard conditions, at the reference fitness (knots, increasing) */
  curve: [number, number][];
  /** heart rate the aerobic output is reported at */
  refHr: number;
  /** bpm per °C above `tempRef` (outdoors) */
  heat: number;
  tempRef: number;
  /** bpm per point of TSB: tired legs hold heart rate down */
  fatigue: number;
  /** bpm when indoors */
  indoor: number;
  /** sd of an activity's cost around fitness and condition (the day-to-day noise), bpm */
  dayNoise: number;
  /** sd of a single steady stretch around its activity's cost, bpm */
  windowNoise: number;
  /** random-walk sd of fitness per √day, bpm: fitness moves slowly */
  drift: number;
  /** sd of condition — good and bad spells that come and go over days (sleep, weather, a cold) */
  condition: number;
  /** how many days a spell takes to fade (e-folding time) */
  conditionDays: number;
  /** activities the model was learned from */
  activities: number;
}

/** A level and its sd, in bpm of heart-rate cost (lower = fitter). */
export interface Est {
  mean: number;
  sd: number;
}

export interface AerobicPoint {
  id: number;
  date: string;
  /** steady stretches in the activity */
  n: number;
  /** read from steady stretches, or from the whole activity allowing for heart rate's lag */
  method: 'steady' | 'kinetic';
  /** median cost against the curve, before adjustments (bpm) */
  raw: number;
  /** bpm taken out for each condition */
  adj: { heat: number; fatigue: number; indoor: number };
  /** adjusted cost (bpm above the curve; lower = fitter) */
  cost: number;
  /** measurement sd of `cost` */
  sd: number;
  /**
   * What the history up to the activity said (null for the first, or after a long gap):
   * fitness, the condition carried in from recent days, and the cost they predicted together.
   */
  prior: { fitness: Est; condition: number; expected: Est } | null;
  /** surprise against everything expected (fitness and recent condition); negative = better */
  z: number | null;
  /** surprise against fitness alone: how unusual for your fitness, whatever recent days were like */
  zFitness: number | null;
  /** after the activity (filtered), and in hindsight (smoothed, using later activities too) */
  post: { fitness: Est; condition: number };
  smooth: { fitness: Est; condition: number };
  temp: number | null;
  tsb: number | null;
  indoor: boolean;
  /** mean output and heart rate over the steady stretches */
  out: number;
  hr: number;
}

export interface AerobicFit {
  model: AerobicModel;
  points: AerobicPoint[];
  /** log-likelihood of the one-step predictions (higher = the model forecasts better) */
  ll: number;
  /** smoother gains (2×2, row-major) linking each point to the next; null across a restart */
  gains: (number[] | null)[];
  /** smoothed covariances [ff, fc, cc] */
  smoothCov: [number, number, number][];
}

/**
 * Change in fitness between two points (j after i), in bpm of cost, with its sd. The two
 * estimates share most of their evidence, so their errors are correlated: the change is known
 * better than either level. Null when a restart separates them.
 */
export function fitnessChange(fit: AerobicFit, i: number, j: number): { diff: number; sd: number } | null {
  if (j <= i) return null;
  // Cov(x_i, x_j | all) = C_i C_{i+1} … C_{j−1} P_j
  let M = [1, 0, 0, 1];
  for (let k = i; k < j; k++) {
    const C = fit.gains[k];
    if (!C) return null;
    M = [M[0] * C[0] + M[1] * C[2], M[0] * C[1] + M[1] * C[3], M[2] * C[0] + M[3] * C[2], M[2] * C[1] + M[3] * C[3]];
  }
  const [ff, fc, cc] = fit.smoothCov[j];
  const covFF = M[0] * ff + M[1] * fc; // (M P_j)[0][0]
  void cc;
  const v = fit.smoothCov[i][0] + ff - 2 * covFF;
  return { diff: fit.points[j].smooth.fitness.mean - fit.points[i].smooth.fitness.mean, sd: Math.sqrt(Math.max(0, v)) };
}

const TEMP_REF = 15;
const MIN_ACTIVITIES = 8;
/** fewer steady stretches than this, and the whole-activity reading is used when there is one */
const MIN_STEADY = 5;
/** the whole-activity reading needs this much usable time (s) */
const MIN_KINETIC_SEC = 600;
/** its extra spread against the steady reading (sd, bpm), measured on activities with both */
const KINETIC_NOISE: Record<AerobicSport, number> = { ride: 2, run: 3.3 };
/** a gap this long restarts the filter: months off change fitness more than a random walk allows */
const RESET_DAYS = 60;
const BIN: Record<AerobicSport, number> = { ride: 20, run: 0.1 };
/** least slope of the curve (bpm per unit of output): keeps it invertible */
const MIN_SLOPE: Record<AerobicSport, number> = { ride: 0.03, run: 1 };
const SLOPE_RANGE: Record<AerobicSport, [number, number]> = { ride: [0.1, 0.6], run: [4, 40] };

const median = (x: number[]) => {
  if (!x.length) return NaN;
  const y = [...x].sort((a, b) => a - b);
  const m = y.length >> 1;
  return y.length % 2 ? y[m] : (y[m - 1] + y[m]) / 2;
};
const weightedMedian = (x: number[], w: number[]) => {
  const idx = x.map((_, i) => i).sort((a, b) => x[a] - x[b]);
  const total = w.reduce((s, v) => s + v, 0);
  let acc = 0;
  for (const i of idx) {
    acc += w[i];
    if (acc >= total / 2) return x[i];
  }
  return NaN;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const DAY = 86400000;
const dayNum = (d: string) => Date.parse(d) / DAY;

/** Heart rate on the curve at an output (linear between knots, extended by the end slopes). */
export function curveHr(curve: [number, number][], out: number): number {
  const n = curve.length;
  if (out <= curve[0][0]) return curve[0][1] - (curve[0][0] - out) * slopeAt(curve, 0);
  for (let i = 1; i < n; i++) if (out <= curve[i][0]) return curve[i - 1][1] + ((out - curve[i - 1][0]) / (curve[i][0] - curve[i - 1][0])) * (curve[i][1] - curve[i - 1][1]);
  return curve[n - 1][1] + (out - curve[n - 1][0]) * slopeAt(curve, n - 1);
}

/** Output on the curve at a heart rate (its inverse). */
export function curveOut(curve: [number, number][], hr: number): number {
  const n = curve.length;
  if (hr <= curve[0][1]) return curve[0][0] - (curve[0][1] - hr) / slopeAt(curve, 0);
  for (let i = 1; i < n; i++) if (hr <= curve[i][1]) return curve[i - 1][0] + ((hr - curve[i - 1][1]) / (curve[i][1] - curve[i - 1][1])) * (curve[i][0] - curve[i - 1][0]);
  return curve[n - 1][0] + (hr - curve[n - 1][1]) / slopeAt(curve, n - 1);
}

/** End slopes: the curve's average slope (the ends of the data are its thinnest part). */
function slopeAt(curve: [number, number][], _i: number): number {
  const n = curve.length;
  return (curve[n - 1][1] - curve[0][1]) / (curve[n - 1][0] - curve[0][0]);
}

/** Output the athlete holds at the model's reference heart rate, at a fitness level (cost). */
export function outputAt(model: AerobicModel, cost: number): number {
  return curveOut(model.curve, model.refHr - cost);
}

/** Pool-adjacent-violators: the weighted increasing fit to points sorted by x. */
function isotonic(ys: number[], ws: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  for (let i = 0; i < ys.length; i++) {
    blocks.push({ v: ys[i], w: ws[i], n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
      const b = blocks.pop()!;
      const a = blocks.pop()!;
      blocks.push({ v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, n: a.n + b.n });
    }
  }
  return blocks.flatMap((b) => new Array(b.n).fill(b.v));
}

function buildCurve(sport: AerobicSport, items: { out: number; hr: number; id: number }[]): [number, number][] | null {
  const width = BIN[sport];
  const bins = new Map<number, { hr: number[]; ids: Set<number> }>();
  for (const it of items) {
    const k = Math.round(it.out / width) * width;
    const b = bins.get(k) ?? { hr: [], ids: new Set<number>() };
    b.hr.push(it.hr);
    b.ids.add(it.id);
    bins.set(k, b);
  }
  const pts = [...bins.entries()]
    .filter(([, b]) => b.hr.length >= 6 && b.ids.size >= 2)
    .map(([k, b]) => ({ x: k, y: median(b.hr), w: b.hr.length }))
    .sort((a, b) => a.x - b.x);
  if (pts.length < 3) return null;
  const fit = isotonic(
    pts.map((p) => p.y),
    pts.map((p) => p.w),
  );
  const curve: [number, number][] = pts.map((p, i) => [p.x, fit[i]]);
  // strictly increasing, so it can be inverted
  for (let i = 1; i < curve.length; i++) curve[i][1] = Math.max(curve[i][1], curve[i - 1][1] + MIN_SLOPE[sport] * (curve[i][0] - curve[i - 1][0]));
  // a curve whose overall slope is implausible means too little spread in the data
  const [lo, hi] = SLOPE_RANGE[sport];
  const s = slopeAt(curve, 0);
  if (!(s >= lo && s <= hi)) return null;
  return curve;
}

interface Obs {
  a: AerobicActivity;
  t: number;
  raw: number;
  n: number;
  method: 'steady' | 'kinetic';
  neff: number;
  temp: number | null;
  out: number;
  hr: number;
}

function conditions(m: Pick<AerobicModel, 'heat' | 'fatigue' | 'indoor' | 'tempRef'>, o: { a: AerobicActivity; temp: number | null }) {
  const heat = !o.a.indoor && o.temp != null ? m.heat * (clamp(o.temp, -5, 40) - m.tempRef) : 0;
  const fatigue = o.a.tsb != null ? m.fatigue * clamp(o.a.tsb, -60, 30) : 0;
  const indoor = o.a.indoor ? m.indoor : 0;
  return { heat, fatigue, indoor };
}

type Cov = [number, number, number]; // [ff, fc, cc]

interface FilterParams {
  /** fitness random-walk sd per √day */
  drift: number;
  /** condition sd and e-folding days */
  cond: number;
  condDays: number;
}

interface FilterStep {
  reset: boolean;
  priorM: [number, number];
  priorP: Cov;
  /** predicted cost and its variance (incl. measurement noise) */
  expected: number;
  s: number;
  z: number | null;
  zFit: number | null;
  postM: [number, number];
  postP: Cov;
  /** decay of condition from the previous step (for the smoother) */
  phi: number;
}

/**
 * Two-state Kalman filter: fitness (a slow random walk) plus condition (spells that fade over
 * days), observed together with day-to-day noise. Then a Rauch–Tung–Striebel smoother.
 */
function runFilter(obs: Obs[], costs: number[], vars: number[], par: FilterParams) {
  const n = obs.length;
  const steps: FilterStep[] = [];
  const q = par.drift * par.drift;
  const c2 = par.cond * par.cond;
  let ll = 0;
  let m: [number, number] = [0, 0];
  let P: Cov = [0, 0, 0];
  for (let k = 0; k < n; k++) {
    const dt = k ? Math.max(0, obs[k].t - obs[k - 1].t) : Infinity;
    const reset = dt > RESET_DAYS;
    const phi = reset ? 0 : par.condDays > 0 ? Math.exp(-dt / par.condDays) : 0;
    // predict
    const pm: [number, number] = reset ? [costs[k], 0] : [m[0], phi * m[1]];
    const pP: Cov = reset ? [1e4, 0, c2] : [P[0] + q * dt, phi * P[1], phi * phi * P[2] + c2 * (1 - phi * phi)];
    const expected = pm[0] + pm[1];
    const sv = pP[0] + 2 * pP[1] + pP[2] + vars[k];
    const innov = costs[k] - expected;
    let z: number | null = null;
    let zFit: number | null = null;
    if (!reset) {
      z = innov / Math.sqrt(sv);
      // against fitness alone: the condition could be anything it usually is
      zFit = (costs[k] - pm[0]) / Math.sqrt(pP[0] + c2 + vars[k]);
      ll += -0.5 * (Math.log(2 * Math.PI * sv) + (innov * innov) / sv);
    }
    // update
    const kf = (pP[0] + pP[1]) / sv;
    const kc = (pP[1] + pP[2]) / sv;
    m = [pm[0] + kf * innov, pm[1] + kc * innov];
    P = [pP[0] - kf * kf * sv, pP[1] - kf * kc * sv, pP[2] - kc * kc * sv];
    steps.push({ reset, priorM: pm, priorP: pP, expected, s: sv, z, zFit, postM: m, postP: P, phi });
  }
  // RTS smoother: C = P_k F' (P⁻_{k+1})⁻¹, F = diag(1, φ)
  const sm: [number, number][] = steps.map((st) => [...st.postM] as [number, number]);
  const sP: Cov[] = steps.map((st) => [...st.postP] as Cov);
  const gains: (number[] | null)[] = new Array(n).fill(null);
  for (let k = n - 2; k >= 0; k--) {
    const nx = steps[k + 1];
    if (nx.reset) continue; // a restart: the past isn't linked to what follows
    const [a, b, d] = steps[k].postP;
    const phi = nx.phi;
    // P_k F' = [[a, φb], [b, φd]]
    const pf = [a, phi * b, b, phi * d];
    const [e, f, g] = nx.priorP;
    const det = e * g - f * f;
    let inv: number[];
    if (det > 1e-9) inv = [g / det, -f / det, -f / det, e / det];
    // no condition component: its variance is zero, so smooth fitness alone (pseudo-inverse)
    else if (e > 1e-12 && g < 1e-9) inv = [1 / e, 0, 0, 0];
    else continue;
    const C = [pf[0] * inv[0] + pf[1] * inv[2], pf[0] * inv[1] + pf[1] * inv[3], pf[2] * inv[0] + pf[3] * inv[2], pf[2] * inv[1] + pf[3] * inv[3]];
    gains[k] = C;
    const dm = [sm[k + 1][0] - nx.priorM[0], sm[k + 1][1] - nx.priorM[1]];
    sm[k] = [steps[k].postM[0] + C[0] * dm[0] + C[1] * dm[1], steps[k].postM[1] + C[2] * dm[0] + C[3] * dm[1]];
    // P_s = P_k + C (P_s,k+1 − P⁻_{k+1}) C'
    const D = [sP[k + 1][0] - e, sP[k + 1][1] - f, sP[k + 1][2] - g];
    const CD = [C[0] * D[0] + C[1] * D[1], C[0] * D[1] + C[1] * D[2], C[2] * D[0] + C[3] * D[1], C[2] * D[1] + C[3] * D[2]];
    sP[k] = [a + CD[0] * C[0] + CD[1] * C[1], b + CD[0] * C[2] + CD[1] * C[3], d + CD[2] * C[2] + CD[3] * C[3]];
  }
  return { steps, sm, sP, gains, ll };
}

/**
 * Learn the athlete's curve, condition effects and noise from their activities, and follow
 * aerobic fitness through them. Returns null when there's too little steady data.
 */
export function fitAerobic(activities: AerobicActivity[], sport: AerobicSport, grid: { day?: number[]; drift?: number[]; cond?: number[]; condDays?: number[] } = {}): AerobicFit | null {
  const kineticSec = (a: AerobicActivity) => (a.kinetic ?? []).reduce((s, b) => s + b.sec, 0);
  const useKinetic = (a: AerobicActivity) => a.windows.length < MIN_STEADY && kineticSec(a) >= MIN_KINETIC_SEC;
  const acts = activities.filter((a) => a.windows.length || useKinetic(a)).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  // the curve is learned from steady stretches only
  if (acts.filter((a) => a.windows.length).length < MIN_ACTIVITIES) return null;
  const spec = WINDOW_SPECS[sport];
  const indoorCount = acts.filter((a) => a.indoor).length;
  const hasTemp = acts.filter((a) => !a.indoor && a.windows.some((w) => w.temp != null)).length >= MIN_ACTIVITIES;

  let model: AerobicModel = { sport, curve: [], refHr: 0, heat: 0, tempRef: TEMP_REF, fatigue: 0, indoor: 0, dayNoise: 4, windowNoise: 3, drift: 0.2, condition: 0, conditionDays: 7, activities: acts.length };
  // fitness at each activity (for the condition effects) and fitness + condition (for the curve)
  let level = new Map<number, number>(acts.map((a) => [a.id, 0]));
  let dayLevel = new Map<number, number>(acts.map((a) => [a.id, 0]));
  let best: { obs: Obs[]; costs: number[]; vars: number[]; f: ReturnType<typeof runFilter> } | null = null;

  for (let iter = 0; iter < 4; iter++) {
    // 1. reference curve, from heart rates brought to standard conditions and the level of the day
    const items: { out: number; hr: number; id: number }[] = [];
    for (const a of acts) {
      const temp = activityTemp(a);
      const c = conditions(model, { a, temp });
      const shift = (dayLevel.get(a.id) ?? 0) + c.heat + c.fatigue + c.indoor;
      for (const w of a.windows) items.push({ out: w.out, hr: w.hr - shift, id: a.id });
    }
    const curve = buildCurve(sport, items);
    if (!curve) return null;
    model = { ...model, curve };

    // 2. each activity's raw cost against the curve
    const obs: Obs[] = acts.map((a) => {
      if (useKinetic(a)) {
        const bins = a.kinetic!;
        const sec = bins.reduce((s, b) => s + b.sec, 0);
        const temps = bins.filter((b) => b.temp != null);
        const tsec = temps.reduce((s, b) => s + b.sec, 0);
        return {
          a,
          t: dayNum(a.date),
          raw: weightedMedian(
            bins.map((b) => b.hr - curveHr(curve, b.out)),
            bins.map((b) => b.sec),
          ),
          n: a.windows.length,
          method: 'kinetic' as const,
          neff: Math.max(1, sec / spec.win),
          temp: tsec > sec / 2 ? temps.reduce((s, b) => s + (b.temp as number) * b.sec, 0) / tsec : null,
          out: bins.reduce((s, b) => s + b.out * b.sec, 0) / sec,
          hr: bins.reduce((s, b) => s + b.hr * b.sec, 0) / sec,
        };
      }
      const res = a.windows.map((w) => w.hr - curveHr(curve, w.out));
      return {
        a,
        t: dayNum(a.date),
        raw: median(res),
        n: a.windows.length,
        method: 'steady' as const,
        neff: Math.max(1, (a.windows.length * spec.step) / spec.win),
        temp: activityTemp(a),
        out: a.windows.reduce((s, w) => s + w.out, 0) / a.windows.length,
        hr: a.windows.reduce((s, w) => s + w.hr, 0) / a.windows.length,
      };
    });
    // stretch-to-stretch noise within an activity (independent stretches only)
    const within: number[] = [];
    for (const o of obs) {
      if (o.method !== 'steady' || o.n < 3) continue;
      const res = o.a.windows.map((w) => w.hr - curveHr(curve, w.out) - o.raw);
      const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / (res.length - 1));
      within.push(sd);
    }
    const windowNoise = within.length ? clamp(median(within), 1, 10) : 3;

    // 3. condition effects: what's left after the level of the time, regressed on conditions
    const cov = fitConditions(obs, level, { indoor: indoorCount >= 4, heat: hasTemp }, (o) => 1 / (model.dayNoise ** 2 + windowNoise ** 2 / o.neff));
    model = { ...model, windowNoise, heat: cov.heat, fatigue: cov.fatigue, indoor: cov.indoor };

    // 4. noise, drift and condition by maximum likelihood, then follow fitness and condition.
    // What separates them is time: condition is what fades within a week (sleep, a hot spell,
    // a cold coming on); fitness is what lasts — up to ~4 bpm (~6 % of output) in six weeks
    // at one sd, as in a comeback. Left free, a "condition" lasting weeks swallows fitness.
    const costs = obs.map((o) => {
      const c = conditions(model, o);
      return o.raw - c.heat - c.fatigue - c.indoor;
    });
    let top: { day: number; par: FilterParams; f: ReturnType<typeof runFilter>; vars: number[] } | null = null;
    for (const day of grid.day ?? [2, 3, 4, 5, 6]) {
      const vars = obs.map((o) => day * day + (windowNoise * windowNoise) / o.neff + (o.method === 'kinetic' ? KINETIC_NOISE[sport] ** 2 : 0) + (!o.a.indoor && o.temp == null && model.heat ? (model.heat * 6) ** 2 : 0));
      for (const drift of grid.drift ?? [0.15, 0.2, 0.3, 0.45, 0.65]) {
        for (const cond of grid.cond ?? [0, 2, 3, 4, 5, 6]) {
          for (const condDays of cond ? (grid.condDays ?? [2, 4, 7]) : [7]) {
            const par = { drift, cond, condDays };
            const f = runFilter(obs, costs, vars, par);
            if (!top || f.ll > top.f.ll) top = { day, par, f, vars };
          }
        }
      }
    }
    const t = top!;
    model = { ...model, dayNoise: t.day, drift: t.par.drift, condition: t.par.cond, conditionDays: t.par.condDays };
    level = new Map(obs.map((o, k) => [o.a.id, t.f.sm[k][0]]));
    dayLevel = new Map(obs.map((o, k) => [o.a.id, t.f.sm[k][0] + t.f.sm[k][1]]));
    best = { obs, costs, vars: t.vars, f: t.f };
  }

  const { obs, costs, vars, f } = best!;
  // report output at the heart rate where most of the steady riding happens
  const outs = acts.flatMap((a) => a.windows.map((w) => w.out));
  model.refHr = Math.round(curveHr(model.curve, median(outs)) / 5) * 5;
  const points: AerobicPoint[] = obs.map((o, k) => {
    const c = conditions(model, o);
    const st = f.steps[k];
    return {
      id: o.a.id,
      date: o.a.date,
      n: o.n,
      method: o.method,
      raw: o.raw,
      adj: c,
      cost: costs[k],
      sd: Math.sqrt(vars[k]),
      prior: st.reset ? null : { fitness: { mean: st.priorM[0], sd: Math.sqrt(st.priorP[0]) }, condition: st.priorM[1], expected: { mean: st.expected, sd: Math.sqrt(st.s) } },
      z: st.z,
      zFitness: st.zFit,
      post: { fitness: { mean: st.postM[0], sd: Math.sqrt(Math.max(0, st.postP[0])) }, condition: st.postM[1] },
      smooth: { fitness: { mean: f.sm[k][0], sd: Math.sqrt(Math.max(0, f.sP[k][0])) }, condition: f.sm[k][1] },
      temp: o.temp,
      tsb: o.a.tsb,
      indoor: o.a.indoor,
      out: o.out,
      hr: o.hr,
    };
  });
  return { model, points, ll: f.ll, gains: f.gains, smoothCov: f.sP };
}

function activityTemp(a: AerobicActivity): number | null {
  const t = a.windows.map((w) => w.temp).filter((v): v is number => v != null);
  return t.length ? median(t) : null;
}

/**
 * Condition effects by weighted least squares on each activity's cost minus the level of its
 * time — so slow changes in fitness don't masquerade as the weather or the training load.
 * Bounded to what's physiologically plausible.
 */
function fitConditions(obs: Obs[], level: Map<number, number>, use: { indoor: boolean; heat: boolean }, weight: (o: Obs) => number) {
  const cols: ((o: Obs) => number)[] = [];
  const names: ('heat' | 'fatigue' | 'indoor')[] = [];
  if (use.heat) {
    cols.push((o) => (!o.a.indoor && o.temp != null ? clamp(o.temp, -5, 40) - TEMP_REF : 0));
    names.push('heat');
  }
  cols.push((o) => (o.a.tsb != null ? clamp(o.a.tsb, -60, 30) : 0));
  names.push('fatigue');
  if (use.indoor) {
    cols.push((o) => (o.a.indoor ? 1 : 0));
    names.push('indoor');
  }
  const k = cols.length;
  // normal equations with an intercept (the level absorbs the mean, but not exactly)
  const p = k + 1;
  const A = Array.from({ length: p }, () => new Array<number>(p).fill(0));
  const b = new Array<number>(p).fill(0);
  for (const o of obs) {
    const w = weight(o);
    const x = [1, ...cols.map((c) => c(o))];
    const y = o.raw - (level.get(o.a.id) ?? 0);
    for (let i = 0; i < p; i++) {
      b[i] += w * x[i] * y;
      for (let j = 0; j < p; j++) A[i][j] += w * x[i] * x[j];
    }
  }
  // a little ridge, so a coefficient the data can't pin down stays near zero
  for (let i = 1; i < p; i++) A[i][i] += 1e-3 * (A[i][i] || 1);
  const beta = solve(A, b) ?? new Array<number>(p).fill(0);
  const out = { heat: 0, fatigue: 0, indoor: 0 };
  names.forEach((nm, i) => (out[nm] = beta[i + 1]));
  out.heat = clamp(out.heat, 0, 1.5);
  out.fatigue = clamp(out.fatigue, 0, 0.4);
  out.indoor = clamp(out.indoor, -10, 10);
  return out;
}

function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
