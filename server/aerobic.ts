import { fitAerobic, fitnessChange, kineticReadable, outputAt, type AerobicFit, type AerobicSport, type Est } from '../shared/analytics/aerobic';
import { rideEffortFindings, runEffortFindings, verdict, type EffortFinding, type Verdict } from '../shared/analytics/insights';
import type { ActivityCurves } from '../shared/types';
import { getPreferences, q } from './db';
import { pmc, today } from './aggregate';
import { storedSeries } from './estimates';
import { activityReadings, WINDOW_ACTIVITIES, warmWindows } from './windows';

const DAY = 86400000;
const cache: Partial<Record<AerobicSport, { key: string; fit: AerobicFit | null }>> = {};

/** Changes whenever an activity of the sport is added, removed or recalculated. */
function dataKey(sport: AerobicSport): string {
  const r = q.get(`SELECT COUNT(*) AS n, MAX(a.updated_at) AS u FROM activities a WHERE a.sport = ? AND ${WINDOW_ACTIVITIES}`, sport);
  const p = getPreferences();
  return `${r?.n}|${r?.u}|${p.ctlDays}|${p.atlDays}`;
}

/** The athlete's aerobic model for a sport, learned from all their steady riding or running. */
export function aerobicFit(sport: AerobicSport): AerobicFit | null {
  const key = dataKey(sport);
  const hit = cache[sport];
  if (hit?.key === key) return hit.fit;
  const rows = q.all(`SELECT a.id, a.local_date, a.trainer, a.intensity, a.vi, w.data FROM activities a LEFT JOIN steady_windows w ON w.activity_id = a.id WHERE a.sport = ? AND ${WINDOW_ACTIVITIES} ORDER BY a.local_date, a.id`, sport);
  let fit: AerobicFit | null = null;
  if (rows.length) {
    // form going into each day: tired legs hold heart rate down
    const tsb = new Map(pmc(rows[0].local_date as string, today()).map((p) => [p.date, p.tsb]));
    fit = fitAerobic(
      rows.map((r) => {
        const rd = activityReadings(r.id as number, sport, r.local_date as string, r.data as string | null);
        const kinetic = kineticReadable(sport, r.intensity as number | null, r.vi as number | null) ? rd.kinetic : undefined;
        return { id: r.id as number, date: r.local_date as string, indoor: !!r.trainer, tsb: tsb.get(r.local_date as string) ?? null, windows: rd.windows, kinetic };
      }),
      sport,
    );
  }
  cache[sport] = { key, fit };
  return fit;
}

/** Compute anything missing in the background (after deploys and syncs), so pages don't wait. */
export async function warmAerobic() {
  await warmWindows();
  aerobicFit('ride');
  await new Promise((r) => setImmediate(r));
  aerobicFit('run');
}

const round = (sport: AerobicSport, v: number) => (sport === 'ride' ? Math.round(v) : Math.round(v * 1000) / 1000);

/** A fitness level (bpm of cost) as output at the reference heart rate, with a ±1 sd band. */
function band(fit: AerobicFit, e: Est) {
  const s = fit.model.sport;
  return { value: round(s, outputAt(fit.model, e.mean)), lo: round(s, outputAt(fit.model, e.mean + e.sd)), hi: round(s, outputAt(fit.model, e.mean - e.sd)) };
}

/** Index where the stretch of training containing point k began (after the last long gap). */
function stretchStart(fit: AerobicFit, k: number) {
  let i = k;
  while (i > 0 && fit.points[i].prior) i--;
  return i;
}

function modelSummary(fit: AerobicFit) {
  const m = fit.model;
  return { refHr: m.refHr, heat: m.heat, fatigue: m.fatigue, indoor: m.indoor, dayNoise: m.dayNoise, drift: m.drift, condition: m.condition, conditionDays: m.conditionDays, activities: m.activities };
}

/** Aerobic fitness through time, for charts: each activity's evidence and the fitness band. */
export function aerobicTrend(sport: AerobicSport) {
  const fit = aerobicFit(sport);
  if (!fit) return null;
  const O = (c: number) => round(sport, outputAt(fit.model, c));
  const points = fit.points.map((p) => ({ id: p.id, date: p.date, value: O(p.cost), ...prefix(band(fit, p.smooth.fitness)), z: p.z, zFitness: p.zFitness, n: p.n }));
  const k = fit.points.length - 1;
  const last = fit.points[k];
  return { sport, unit: sport === 'ride' ? 'W' : 'm/s', model: modelSummary(fit), current: { date: last.date, ...band(fit, last.smooth.fitness) }, change: trendTo(fit, k, 84), change6: trendTo(fit, k, 42), points };
}

/**
 * Change in fitness over the `days` before point k (within its stretch of training — or since
 * the stretch began, if that's more recent), as % of output with a ±1 sd.
 */
function trendTo(fit: AerobicFit, k: number, days: number) {
  const start = stretchStart(fit, k);
  const cutoff = Date.parse(fit.points[k].date) - days * DAY;
  let then = start;
  for (let i = start; i < k; i++) if (Date.parse(fit.points[i].date) <= cutoff) then = i;
  if (then >= k || Date.parse(fit.points[k].date) - Date.parse(fit.points[then].date) < 21 * DAY) return null;
  const d = fitnessChange(fit, then, k);
  if (!d) return null;
  const v0 = outputAt(fit.model, fit.points[then].smooth.fitness.mean);
  const v1 = outputAt(fit.model, fit.points[k].smooth.fitness.mean);
  const perBpm = outputAt(fit.model, fit.points[k].smooth.fitness.mean - 1) / v1 - 1;
  return { pct: (v1 / v0 - 1) * 100, sdPct: d.sd * perBpm * 100, from: fit.points[then].date, fromValue: round(fit.model.sport, v0) };
}

/** {value, lo, hi} → {fitness, lo, hi} for trend points. */
const prefix = (b: { value: number; lo: number; hi: number }) => ({ fitness: b.value, lo: b.lo, hi: b.hi });

/** What one activity's heart rate says, against the athlete's fitness and recent condition. */
function aerobicInsight(fit: AerobicFit, k: number) {
  const p = fit.points[k];
  const m = fit.model;
  const s = m.sport;
  const O = (c: number) => round(s, outputAt(m, c));
  const start = stretchStart(fit, k);
  const from = Date.parse(p.date) - 56 * DAY;
  const recent = fit.points.slice(start, k + 1).filter((x) => Date.parse(x.date) >= from);
  const fitAfter = outputAt(m, p.post.fitness.mean);
  // how this activity ranks among the stretch so far, after adjustments
  const pool = fit.points.slice(start, k + 1);
  const better = pool.filter((x) => x.cost > p.cost).length;
  return {
    sport: s,
    unit: s === 'ride' ? 'W' : 'm/s',
    refHr: m.refHr,
    /** read from steady stretches, or from the whole activity allowing for heart rate's lag */
    method: p.method,
    /** this activity's output at the reference heart rate, under standard conditions */
    value: O(p.cost),
    expected: p.prior ? band(fit, p.prior.expected) : null,
    fitnessBefore: p.prior ? band(fit, p.prior.fitness) : null,
    fitnessAfter: band(fit, p.post.fitness),
    z: p.z,
    zFitness: p.zFitness,
    /** recent condition as a share of output: + = running better than fitness */
    conditionPct: (outputAt(m, p.post.fitness.mean + p.post.condition) / fitAfter - 1) * 100,
    /** how much of the stretch this activity beat (0–1), and of how many */
    rank: { beat: pool.length > 1 ? better / (pool.length - 1) : null, of: pool.length },
    raw: { hr: Math.round(p.hr), out: round(s, p.out), n: p.n, cost: p.raw, expectedHr: Math.round(p.hr - p.raw) },
    adjust: { heat: p.adj.heat, fatigue: p.adj.fatigue, indoor: p.adj.indoor, temp: p.temp, tsb: p.tsb, isIndoor: p.indoor },
    model: modelSummary(fit),
    /** fitness change over the 12 weeks to this activity (in hindsight) */
    trend: trendTo(fit, k, 84),
    stretchFrom: fit.points[start].date,
    recent: recent.map((x) => ({ id: x.id, date: x.date, value: O(x.cost), ...prefix(band(fit, x.smooth.fitness)) })),
  };
}

export type AerobicInsight = ReturnType<typeof aerobicInsight>;

export interface ActivityInsights {
  verdict: Verdict;
  aerobic: AerobicInsight | null;
  /** why there's no heart-rate reading, when the activity has heart rate */
  unread: 'hard' | 'short' | null;
  efforts: EffortFinding[];
  /** form going into the day, for context */
  tsb: number | null;
}

/** Everything an activity says about fitness: heart-rate evidence and efforts in context. */
export function activityInsights(id: number): ActivityInsights | null {
  const a = q.get('SELECT id, sport, local_date, curves, best_efforts, has_hr, has_power, intensity, vi FROM activities WHERE id = ?', id);
  if (!a) return null;
  const date = a.local_date as string;
  const sport = a.sport === 'ride' || a.sport === 'run' ? (a.sport as AerobicSport) : null;
  let aerobic: AerobicInsight | null = null;
  let unread: ActivityInsights['unread'] = null;
  if (sport) {
    const fit = aerobicFit(sport);
    const k = fit ? fit.points.findIndex((p) => p.id === id) : -1;
    if (fit && k >= 0) aerobic = aerobicInsight(fit, k);
    else if (a.has_hr && (sport === 'run' || a.has_power)) unread = kineticReadable(sport, a.intensity as number | null, a.vi as number | null) ? 'short' : 'hard';
  }
  let efforts: EffortFinding[] = [];
  if (a.sport === 'ride' && a.curves) {
    const c = JSON.parse(a.curves as string) as ActivityCurves;
    const history = q
      .all("SELECT local_date, curves FROM activities WHERE sport = 'ride' AND curves IS NOT NULL AND id != ? AND local_date < ?", id, date)
      .map((r) => {
        const h = JSON.parse(r.curves as string) as ActivityCurves;
        return { date: r.local_date as string, power: h.power, fatigue: h.fatigue };
      });
    // the model in effect that day was fitted to the six months before it
    const est = storedSeries('ride')
      .filter((e) => e.date <= date)
      .pop();
    efforts = rideEffortFindings({ date, power: c.power, fatigue: c.fatigue }, history, est ? { cp: est.cp, wPrime: est.wPrime } : null);
  } else if (a.sport === 'run' && a.best_efforts) {
    const history = q
      .all("SELECT local_date, best_efforts FROM activities WHERE sport = 'run' AND best_efforts IS NOT NULL AND id != ? AND local_date < ?", id, date)
      .map((r) => ({ date: r.local_date as string, efforts: JSON.parse(r.best_efforts as string) }));
    efforts = runEffortFindings({ date, efforts: JSON.parse(a.best_efforts as string) }, history);
  }
  const tsb = pmc(date, date).pop()?.tsb ?? null;
  return { verdict: verdict(aerobic, efforts), aerobic, unread, efforts, tsb };
}

/**
 * Aerobic fitness around a past date (the peak of a season) against now, on the same model:
 * the same curve, with heat, fatigue and indoor riding taken out of both. Eras are separate
 * stretches of training, so their uncertainties add.
 */
export function aerobicThenNow(sport: AerobicSport, date: string) {
  const fit = aerobicFit(sport);
  if (!fit || !fit.points.length) return null;
  const t = Date.parse(date);
  // the reading nearest the date, within two months of it
  let k = -1;
  fit.points.forEach((p, i) => {
    const d = Math.abs(Date.parse(p.date) - t);
    if (d <= 60 * DAY && (k < 0 || d < Math.abs(Date.parse(fit.points[k].date) - t))) k = i;
  });
  if (k < 0) return null;
  const last = fit.points.length - 1;
  if (stretchStart(fit, last) <= k) return null; // same stretch: not a then-and-now
  const a = fit.points[k].smooth.fitness;
  const b = fit.points[last].smooth.fitness;
  const v0 = outputAt(fit.model, a.mean);
  const v1 = outputAt(fit.model, b.mean);
  const perBpm = outputAt(fit.model, b.mean - 1) / v1 - 1;
  return {
    refHr: fit.model.refHr,
    then: band(fit, a),
    now: band(fit, b),
    thenDate: fit.points[k].date,
    ratio: v1 / v0,
    /** ±1 sd of the ratio */
    sd: Math.hypot(a.sd, b.sd) * perBpm,
  };
}

/** The most recent ride or run, what it says, and where aerobic fitness stands. */
export function latestInsights() {
  const a = q.get("SELECT id, sport FROM activities WHERE sport IN ('ride', 'run') ORDER BY start_time DESC LIMIT 1");
  if (!a) return null;
  const insights = activityInsights(a.id as number);
  if (!insights) return null;
  const t = aerobicTrend(a.sport as AerobicSport);
  return { id: a.id as number, ...insights, fitness: t ? { sport: t.sport, refHr: t.model.refHr, current: t.current, change: t.change } : null };
}
