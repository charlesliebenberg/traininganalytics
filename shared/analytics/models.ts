import { CURVE_DURATIONS, linreg } from './series';

/** Minimal Nelder–Mead simplex optimiser. */
export function nelderMead(f: (x: number[]) => number, x0: number[], opts: { maxIter?: number; step?: number[] } = {}): number[] {
  const n = x0.length;
  const maxIter = opts.maxIter ?? 800;
  let simplex: { x: number[]; v: number }[] = [{ x: x0.slice(), v: f(x0) }];
  for (let i = 0; i < n; i++) {
    const x = x0.slice();
    x[i] += opts.step?.[i] ?? (x[i] !== 0 ? x[i] * 0.1 : 0.1);
    simplex.push({ x, v: f(x) });
  }
  for (let it = 0; it < maxIter; it++) {
    simplex.sort((a, b) => a.v - b.v);
    const best = simplex[0];
    const worst = simplex[n];
    if (Math.abs(worst.v - best.v) < 1e-10 * (Math.abs(best.v) + 1e-12)) break;
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) centroid[j] += simplex[i].x[j] / n;
    const along = (t: number) => centroid.map((c, j) => c + t * (worst.x[j] - c));
    const xr = along(-1);
    const vr = f(xr);
    if (vr < best.v) {
      const xe = along(-2);
      const ve = f(xe);
      simplex[n] = ve < vr ? { x: xe, v: ve } : { x: xr, v: vr };
    } else if (vr < simplex[n - 1].v) {
      simplex[n] = { x: xr, v: vr };
    } else {
      const xc = vr < worst.v ? along(-0.5) : along(0.5);
      const vc = f(xc);
      if (vc < Math.min(vr, worst.v)) simplex[n] = { x: xc, v: vc };
      else {
        simplex = simplex.map((s, i) =>
          i === 0 ? s : (() => {
            const x = s.x.map((v, j) => best.x[j] + 0.5 * (v - best.x[j]));
            return { x, v: f(x) };
          })(),
        );
      }
    }
  }
  simplex.sort((a, b) => a.v - b.v);
  return simplex[0].x;
}

export interface CurvePoint {
  t: number;
  p: number;
}

export function curvePoints(values: (number | null | undefined)[], durations = CURVE_DURATIONS): CurvePoint[] {
  const pts: CurvePoint[] = [];
  values.forEach((p, i) => {
    if (p != null && p > 0) pts.push({ t: durations[i], p });
  });
  return pts;
}

/** Classic 2-parameter critical power model fitted to work–time over 3–20 min. */
export function fitCp2(points: CurvePoint[]): { cp: number; wPrime: number; r2: number } | null {
  const use = points.filter((pt) => pt.t >= 180 && pt.t <= 1200);
  if (use.length < 3) return null;
  const { a, b, r2 } = linreg(
    use.map((p) => p.t),
    use.map((p) => p.p * p.t),
  );
  if (b <= 0 || a <= 0) return null;
  return { cp: b, wPrime: a, r2 };
}

export interface PdModel {
  cp: number;
  wPrime: number;
  pmax: number;
  /** long-duration decay coefficient */
  a: number;
  /** estimated FTP — the model's critical power (maximal quasi-steady-state power) */
  eftp: number;
  /** modelled 60-minute power */
  p60: number;
  /** longest duration the athlete has actually sustained eFTP, seconds */
  tte: number | null;
  /** RMS relative error of the fit to the curve envelope */
  error: number;
}

const TCP_MAX = 1800;

/**
 * Omni-domain power–duration model (Puchowicz, Baker & Clarke 2020):
 *   P(t) = W'/t · (1 − e^(−t·(Pmax−CP)/W')) + CP                  , t ≤ 30 min
 *   P(t) = … − A · ln(t / 30 min)                                  , t > 30 min
 */
export function ompd(t: number, m: Pick<PdModel, 'cp' | 'wPrime' | 'pmax' | 'a'>): number {
  const base = (m.wPrime / t) * (1 - Math.exp((-t * (m.pmax - m.cp)) / m.wPrime)) + m.cp;
  return t > TCP_MAX ? base - m.a * Math.log(t / TCP_MAX) : base;
}

/**
 * Fit the OmPD model to a mean-max curve. Uses asymmetric loss so the model hugs the
 * upper envelope (sub-maximal points are penalised far less than points above the model).
 */
export function fitPowerDuration(values: (number | null | undefined)[], durations = CURVE_DURATIONS): PdModel | null {
  const pts = curvePoints(values, durations).filter((p) => p.t <= 4 * 3600);
  if (pts.length < 12 || !pts.some((p) => p.t >= 600) || !pts.some((p) => p.t <= 10)) return null;
  // weight each point by the log-time span it represents so the dense short end doesn't dominate
  const w = pts.map((pt, i) => {
    const prev = pts[i - 1]?.t ?? pt.t / 1.2;
    const next = pts[i + 1]?.t ?? pt.t * 1.2;
    return Math.log(next / prev) / 2;
  });
  const p1 = pts[0].p;
  const p20 = pts.find((p) => p.t >= 1200)?.p ?? pts[pts.length - 1].p;
  const loss = (x: number[]) => {
    const [cp, wp, pmax, a] = x;
    if (cp <= 20 || wp < 1000 || wp > 80000 || pmax <= cp * 1.2 || a < 0 || a > cp * 0.5) return 1e12;
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const m = ompd(pts[i].t, { cp, wPrime: wp, pmax, a });
      const r = (pts[i].p - m) / pts[i].p;
      s += w[i] * (r > 0 ? 12 : 1) * r * r;
    }
    return s;
  };
  let best: number[] | null = null;
  let bestV = Infinity;
  for (const wp0 of [12000, 20000, 30000]) {
    const x = nelderMead(loss, [p20 * 0.95, wp0, p1 * 1.05, 25], { step: [p20 * 0.05, 3000, p1 * 0.05, 10], maxIter: 1500 });
    const v = loss(x);
    if (v < bestV) {
      bestV = v;
      best = x;
    }
  }
  if (!best || bestV >= 1e12) return null;
  const [cp, wPrime, pmax, a] = best;
  const model = { cp, wPrime, pmax, a };
  const eftp = cp;
  const p60 = ompd(3600, model);
  let tte: number | null = null;
  for (const pt of pts) if (pt.p >= eftp * 0.995) tte = pt.t;
  const wsum = w.reduce((s, x) => s + x, 0);
  let err = 0;
  pts.forEach((pt, i) => (err += w[i] * ((pt.p - ompd(pt.t, model)) / pt.p) ** 2));
  return { cp, wPrime, pmax, a, eftp, p60, tte: tte && tte >= 600 ? tte : null, error: Math.sqrt(err / wsum) };
}

/** Classic power-profile benchmark (Coggan) for 5 s, 1 min, 5 min and FTP in W/kg (male). */
export const POWER_PROFILE: { label: string; t: number; bands: number[] }[] = [
  // bands: untrained, fair, moderate, good, very good, excellent, exceptional, world class
  { label: '5 s', t: 5, bands: [10.2, 12.1, 14.0, 15.9, 17.8, 19.7, 21.6, 24.0] },
  { label: '1 min', t: 60, bands: [5.6, 6.3, 7.0, 7.8, 8.6, 9.4, 10.2, 11.5] },
  { label: '5 min', t: 300, bands: [2.8, 3.4, 4.1, 4.8, 5.5, 6.2, 6.9, 7.6] },
  { label: 'FTP', t: 3600, bands: [2.3, 2.9, 3.5, 4.1, 4.7, 5.3, 5.8, 6.4] },
];
export const PROFILE_LEVELS = ['Untrained', 'Fair', 'Moderate', 'Good', 'Very good', 'Excellent', 'Exceptional', 'World class'];

export function profileLevel(wkg: number, bands: number[]): { level: number; label: string; fraction: number } {
  let lvl = 0;
  for (let i = 0; i < bands.length; i++) if (wkg >= bands[i]) lvl = i;
  const lo = bands[lvl];
  const hi = bands[lvl + 1] ?? bands[lvl] * 1.1;
  const within = Math.max(0, Math.min(1, (wkg - lo) / (hi - lo)));
  return { level: lvl, label: PROFILE_LEVELS[lvl], fraction: (lvl + (wkg >= bands[0] ? within : 0)) / bands.length };
}

/**
 * Banister impulse–response performance model. Fits k1, k2 (τ1/τ2 fixed at 42/7) to
 * performance markers (e.g. eFTP samples) given daily loads. Returns predicted series.
 */
export function banisterFit(
  loads: number[],
  markers: { day: number; value: number }[],
  tau1 = 42,
  tau2 = 7,
): { p0: number; k1: number; k2: number; predict: (day: number) => number; series: number[] } | null {
  if (markers.length < 3) return null;
  const fit = new Array(loads.length).fill(0);
  const fat = new Array(loads.length).fill(0);
  let f = 0,
    g = 0;
  for (let i = 0; i < loads.length; i++) {
    f = f * Math.exp(-1 / tau1) + loads[i];
    g = g * Math.exp(-1 / tau2) + loads[i];
    fit[i] = f;
    fat[i] = g;
  }
  const p0Guess = Math.min(...markers.map((m) => m.value));
  const loss = (x: number[]) => {
    const [p0, k1, k2] = x;
    if (k1 < 0 || k2 < 0) return 1e12;
    let s = 0;
    for (const m of markers) s += (m.value - (p0 + k1 * fit[m.day] - k2 * fat[m.day])) ** 2;
    return s;
  };
  const [p0, k1, k2] = nelderMead(loss, [p0Guess, 0.02, 0.05], { step: [5, 0.01, 0.02] });
  const predict = (day: number) => p0 + k1 * (fit[day] ?? 0) - k2 * (fat[day] ?? 0);
  return { p0, k1, k2, predict, series: loads.map((_, i) => predict(i)) };
}
