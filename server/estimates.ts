/**
 * Rolling threshold history: every day, estimate FTP / run threshold pace / CSS from the
 * 6 months of best efforts up to and including that day, store it, and (in auto mode)
 * recompute affected activities so TSS and zones use the threshold that was true at the
 * time — a ride that sets a new best gets the threshold it earned, from that day on.
 */
import { addDays, format, parseISO, subDays } from 'date-fns';
import { cpForReps, estimateHrThresholds, estimateThreshold, HR_DECLINE_PER_YEAR, limitDeclines, MIN_ACTIVITIES, WINDOW_DAYS, type FtpEstimate, type HrThresholds, type ThresholdEstimate, type ThresholdSport } from '../shared/analytics/thresholds';
import { fitPowerDuration, type PdModel } from '../shared/analytics/models';
import { CURVE_DURATIONS, resample1Hz } from '../shared/analytics/series';
import { aggregateCurve, curvesInRange, today, type AggregatedCurve } from './aggregate';
import { estimateAt, getPreferences, getSetting, loadStreams, log, manualThresholds, q, resetEstimateCache, setSetting, transaction } from './db';
import { recalculate, recalculateAsync } from './ingest';

export const SPORTS: ThresholdSport[] = ['ride', 'run', 'swim'];
const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const curveType = (sport: ThresholdSport) => (sport === 'ride' ? 'power' : 'speed') as 'power' | 'speed';

/** The 6 months an estimate for `date` looks at: up to and including that day. */
export const windowOf = (date: string) => ({ windowFrom: iso(subDays(parseISO(date), WINDOW_DAYS - 1)), windowTo: date });

/** Estimate as of `date`, from the 6 months up to and including it. */
export function estimateOn(sport: ThresholdSport, date: string): ThresholdEstimate | null {
  const { windowFrom, windowTo } = windowOf(date);
  const curve = aggregateCurve(curveType(sport), windowFrom, windowTo, sport);
  const activities = curvesInRange(windowFrom, windowTo, sport).filter((r) => r.curves[curveType(sport)]?.some((v) => v != null)).length;
  const sets = sport === 'ride' ? repSets().filter((x) => x.date >= windowFrom && x.date <= windowTo) : [];
  return fitDay(sport, curve, { date, windowFrom, windowTo, activities }, sets);
}

/** A day's estimate: the fit to its best efforts, with CP raised if an interval set in its window needs it. */
function fitDay(sport: ThresholdSport, curve: AggregatedCurve, meta: { date: string; windowFrom: string; windowTo: string; activities: number }, sets: RepSet[]): ThresholdEstimate | null {
  const fit = estimateThreshold(sport, curve, meta);
  if (!fit) return null;
  // the lowest CP that could ride every interval set in the window, with this W′
  let need: { cp: number; set: RepSet } | null = null;
  for (const x of sets) {
    const cp = cpForReps(x.watts, fit.cp, fit.wPrime);
    if (cp > (need?.cp ?? fit.cp) + 0.5) need = { cp, set: x };
  }
  if (!need) return fit;
  const effort = { t: need.set.rep, value: need.set.out, activityId: need.set.id, date: need.set.date };
  return estimateThreshold(sport, curve, meta, { repsCp: { cp: need.cp, effort, set: { reps: need.set.reps, rest: need.set.rest } } }) ?? fit;
}

/** Each day's best-effort curve, kept from the last series computed: [from date, curve] where it changed. */
const dayCurves = new Map<ThresholdSport, { date: string; curve: AggregatedCurve | null }[]>();

/** The window's best-effort curve on `date`, as the daily series saw it. */
export function curveOn(sport: ThresholdSport, date: string): AggregatedCurve | null {
  const list = dayCurves.get(sport);
  if (!list?.length || date < list[0].date) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].date <= date) lo = mid;
    else hi = mid - 1;
  }
  return list[lo].curve;
}

/** A ride's main interval set: 2+ reps of 3 minutes or more, from its first rep to its last (reps and recoveries at their averages). */
interface RepSet {
  id: number;
  date: string;
  watts: number[];
  reps: number;
  /** shortest rep, s */
  rep: number;
  /** the set's mean power over its reps, W */
  out: number;
  rest: number | null;
}
const repSetCache = new Map<number, { updated: string; set: RepSet | null }>();

/** Every ride's main interval set, read from its streams once (until the ride changes). */
function repSets(): RepSet[] {
  const rows = q.all(
    "SELECT id, local_date, updated_at, session FROM activities WHERE sport = 'ride' AND has_power = 1 AND session IS NOT NULL AND json_extract(session, '$.main.kind') IN ('reps', 'ladder')",
  );
  const out: RepSet[] = [];
  for (const r of rows) {
    let c = repSetCache.get(r.id as number);
    if (!c || c.updated !== r.updated_at) {
      let set: RepSet | null = null;
      const m = JSON.parse(r.session as string).main as { reps: { start: number; end: number; out: number }[]; out: number; rest: number | null } | null;
      const rep = m?.reps.length ? Math.min(...m.reps.map((x) => x.end - x.start)) : 0;
      if (m && m.reps.length >= 2 && rep >= 180) {
        const st = loadStreams(r.id as number);
        if (st?.watts && st.time.length > 1) {
          const raw = resample1Hz(st.time, st.watts, st.time[st.time.length - 1] + 1, { gapValue: 0 }).map((v) => v ?? 0);
          // each rep at its average, each recovery at its own: the question is whether these
          // powers can be repeated with these rests, not every surge on a hill (second-by-second
          // variability drains W′ in the model far more than it does the rider)
          const watts: number[] = [];
          m.reps.forEach((x, k) => {
            if (k) {
              const from = m.reps[k - 1].end;
              const mean = raw.slice(from, x.start).reduce((a, b) => a + b, 0) / Math.max(1, x.start - from);
              for (let i = from; i < x.start; i++) watts.push(mean);
            }
            for (let i = x.start; i < x.end; i++) watts.push(x.out);
          });
          set = { id: r.id as number, date: r.local_date as string, watts, reps: m.reps.length, rep, out: m.out, rest: m.rest };
        }
      }
      c = { updated: r.updated_at as string, set };
      repSetCache.set(r.id as number, c);
    }
    if (c.set) out.push(c.set);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Daily estimates from the sport's first activity to today. One pass slides the 6-month
 * window along the activities: a day whose window neither gained nor lost an activity, or
 * whose best efforts came out the same, keeps the fit of the day before. On the bike, the
 * model must also be able to ride every interval set in the window.
 */
export function computeSeries(sport: ThresholdSport): ThresholdEstimate[] {
  const type = curveType(sport);
  const end = today();
  const rows = curvesInRange('0000-01-01', end, sport)
    .map((r) => ({ id: r.id, date: r.local_date, values: r.curves[type] }))
    .filter((r): r is { id: number; date: string; values: (number | null)[] } => !!r.values?.some((v) => v != null))
    .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const curves: { date: string; curve: AggregatedCurve | null }[] = [];
  dayCurves.set(sport, curves);
  if (!rows.length) return [];
  const n = CURVE_DURATIONS.length;
  // best value per duration over rows[lo, hi), as aggregateCurve builds it
  const aggregate = (lo: number, hi: number): AggregatedCurve => {
    const values: (number | null)[] = new Array(n).fill(null);
    const activityIds: (number | null)[] = new Array(n).fill(null);
    const dates: (string | null)[] = new Array(n).fill(null);
    const filled: boolean[] = new Array(n).fill(false);
    for (let k = lo; k < hi; k++) {
      const r = rows[k];
      for (let i = 0; i < r.values.length && i < n; i++) {
        const v = r.values[i];
        if (v != null && (values[i] == null || v > values[i]!)) {
          values[i] = v;
          activityIds[i] = r.id;
          dates[i] = r.date;
        }
      }
    }
    for (let i = n - 2; i >= 0; i--) {
      if (values[i + 1] != null && (values[i] == null || values[i]! < values[i + 1]!)) {
        values[i] = values[i + 1];
        activityIds[i] = activityIds[i + 1];
        dates[i] = dates[i + 1];
        filled[i] = true;
      }
    }
    return { durations: CURVE_DURATIONS, values, activityIds, dates, filled };
  };
  const out: ThresholdEstimate[] = [];
  const sets = sport === 'ride' ? repSets() : [];
  let lo = 0;
  let hi = 0;
  let setLo = 0;
  let setHi = 0;
  let curve: AggregatedCurve | null = null;
  let key = '';
  let fitted = false;
  let fit: ThresholdEstimate | null = null;
  for (let d = parseISO(rows[0].date); iso(d) <= end; d = addDays(d, 1)) {
    const date = iso(d);
    const { windowFrom } = windowOf(date);
    let moved = false;
    while (hi < rows.length && rows[hi].date <= date) {
      hi++;
      moved = true;
    }
    while (lo < hi && rows[lo].date < windowFrom) {
      lo++;
      moved = true;
    }
    // interval sets in the window: a new one needs checking even if no best changed
    while (setHi < sets.length && sets[setHi].date <= date) {
      setHi++;
      fitted = false;
    }
    while (setLo < setHi && sets[setLo].date < windowFrom) {
      setLo++;
      fitted = false;
    }
    const activities = hi - lo;
    if (activities < MIN_ACTIVITIES) {
      if (curve) curves.push({ date, curve: null });
      curve = null;
      key = '';
      continue;
    }
    if (moved || !curve) {
      const c = aggregate(lo, hi);
      const k = `${c.values.join()}|${c.activityIds.join()}|${c.filled.join()}`;
      if (k !== key) {
        curve = c;
        key = k;
        fitted = false;
        curves.push({ date, curve: c });
      }
    }
    const meta = { date, windowFrom, windowTo: date, activities };
    if (!fitted) {
      fit = fitDay(sport, curve!, meta, sets.slice(setLo, setHi));
      fitted = true;
    }
    if (fit) out.push({ ...fit, ...meta });
  }
  return limitDeclines(out);
}

export interface HrEstimate extends HrThresholds {
  date: string;
  rides: number;
  runs: number;
  /** what this day's own windows show, before the best-ever value is carried forward */
  raw: HrThresholds;
}

/**
 * Daily heart-rate thresholds: LTHR from the 6 months up to and including each day, max HR
 * from the 12 months. Heart-rate thresholds are set mostly by age, not fitness, so the best
 * value ever measured carries forward, less 0.7 bpm a year (the age decline of max HR):
 * easy blocks and comebacks don't hold hard 30-minute efforts, and a threshold that drifted
 * down with them would make easy riding look hard.
 */
export function computeHrSeries(): HrEstimate[] {
  const i30 = CURVE_DURATIONS.indexOf(1800);
  const rows = q.all<{ d: string; sport: string; mx: number | null; h30: number | null }>(
    `SELECT local_date AS d, sport, max_hr AS mx, json_extract(curves, '$.hr[${i30}]') AS h30 FROM activities WHERE has_hr = 1 ORDER BY local_date`,
  );
  if (!rows.length) return [];
  const out: HrEstimate[] = [];
  const end = today();
  let lo6 = 0;
  let lo12 = 0;
  let hi = 0;
  const best: Partial<Record<'lthr' | 'runLthr' | 'maxHr', { v: number; d: string }>> = {};
  let e: HrThresholds = { lthr: null, runLthr: null, maxHr: null };
  let rides: number[] = [];
  let runs: number[] = [];
  for (let d = parseISO(rows[0].d); iso(d) <= end; d = addDays(d, 1)) {
    const date = iso(d);
    const from6 = windowOf(date).windowFrom;
    const from12 = iso(subDays(d, 364));
    let moved = date === rows[0].d;
    while (hi < rows.length && rows[hi].d <= date) {
      hi++;
      moved = true;
    }
    while (lo6 < hi && rows[lo6].d < from6) {
      lo6++;
      moved = true;
    }
    while (lo12 < hi && rows[lo12].d < from12) {
      lo12++;
      moved = true;
    }
    // the windows only change when an activity enters or leaves them
    if (moved) {
      const win6 = rows.slice(lo6, hi);
      rides = win6.filter((r) => r.sport === 'ride' && r.h30).map((r) => r.h30!);
      runs = win6.filter((r) => r.sport === 'run' && r.h30).map((r) => r.h30!);
      e = estimateHrThresholds(rides, runs, rows.slice(lo12, hi).map((r) => r.mx ?? 0));
    }
    const carried = (k: 'lthr' | 'runLthr' | 'maxHr') => {
      const b = best[k];
      return b ? b.v - (HR_DECLINE_PER_YEAR * (Date.parse(date) - Date.parse(b.d))) / (365.25 * 86400000) : null;
    };
    const merged: HrThresholds = { lthr: null, runLthr: null, maxHr: null };
    for (const k of ['lthr', 'runLthr', 'maxHr'] as const) {
      const c = carried(k);
      const v = e[k];
      if (v != null && (c == null || v >= c)) best[k] = { v, d: date };
      merged[k] = v != null && c != null ? Math.max(v, c) : (v ?? c);
    }
    if (merged.runLthr != null && merged.lthr != null) merged.runLthr = Math.max(merged.runLthr, merged.lthr);
    if (merged.maxHr != null) merged.maxHr = Math.max(merged.maxHr, Math.max(merged.lthr ?? 0, merged.runLthr ?? 0) + 5);
    if (merged.lthr == null && merged.runLthr == null && merged.maxHr == null) continue;
    out.push({ date, ...merged, rides: rides.length, runs: runs.length, raw: e });
  }
  return out;
}

/** Stored series, parsed once per refresh: daily estimates are thousands of rows. */
const stored = new Map<string, unknown[]>();
function loadStored<T>(sport: string): T[] {
  if (!stored.has(sport)) stored.set(sport, q.all('SELECT data FROM threshold_estimates WHERE sport = ? ORDER BY date', sport).map((r) => JSON.parse(r.data)));
  return [...(stored.get(sport) as T[])];
}

export const storedHrSeries = (): HrEstimate[] => loadStored<HrEstimate>('hr');

export function storedSeries(sport: ThresholdSport): ThresholdEstimate[] {
  return loadStored<ThresholdEstimate>(sport);
}

const brief = (e: ThresholdEstimate): FtpEstimate => ({ date: e.date, threshold: e.threshold, raw: e.raw, cp: e.cp, basis: e.basis ?? 'cp', effort: e.effort, cpRaised: e.cpRaised });

/** The bike estimate in effect on `date`, as thresholdsFor applies it. */
export function rideEstimates(date: string): { now: ThresholdEstimate | null } {
  const at = estimateAt('ride', date, !manualThresholds(date));
  return { now: (at && storedSeries('ride').find((e) => e.date === at.date)) || null };
}

/** A change worth a mention: half a percent, as for recalculating activities. */
export const moved = (a: number, b: number) => Math.abs(b - a) / a > 0.005;

/** The automatic FTP in effect on `date`, and what set it. */
export function ftpEstimates(date: string): { now: FtpEstimate | null } {
  if (!getPreferences().autoThresholds.ride) return { now: null };
  const { now } = rideEstimates(date);
  return { now: now ? brief(now) : null };
}

const models = new Map<AggregatedCurve | string, Map<string, PdModel | null>>();
/**
 * An estimate drawn as one power-duration curve: sprint power (Pmax, fitted to the same 6
 * months of best efforts), then its CP and W′ up to 30 minutes, falling to its FTP at an
 * hour — so the model on Power & Performance tells the same story as Thresholds, W′ balance
 * and the ride insights.
 */
export function estimateModel(e: ThresholdEstimate): PdModel | null {
  // days that share a curve and an estimate share a fit
  const curve = curveOn('ride', e.date);
  const byCurve = curve ?? e.date;
  const key = `${e.cp}|${e.wPrime}|${e.threshold}`;
  if (!models.has(byCurve)) models.set(byCurve, new Map());
  const fits = models.get(byCurve)!;
  if (!fits.has(key)) {
    // OmPD beyond 30 min: P(t) = CP + W′/t − A·ln(t / 30 min); A puts the hour at FTP
    const a = Math.max(0, (e.cp + e.wPrime / 3600 - e.threshold) / Math.log(2));
    const values = (curve ?? aggregateCurve('power', e.windowFrom, e.windowTo, 'ride')).values;
    fits.set(key, fitPowerDuration(values, CURVE_DURATIONS, { cp: e.cp, wPrime: e.wPrime, a }));
  }
  return fits.get(key)!;
}

const state = { running: false, pending: false, timer: null as NodeJS.Timeout | null, lastRun: null as string | null, day: null as string | null };

/**
 * Recompute every sport's series. Where a threshold changed by more than 0.5 % and auto mode
 * is on, re-run the metrics of that sport's activities from the earliest changed week.
 */
export async function refreshEstimates(opts: { force?: boolean } = {}): Promise<Record<string, string | null>> {
  if (state.running) {
    state.pending = true;
    return {};
  }
  state.running = true;
  state.day = today();
  const changedFrom: Record<string, string | null> = {};
  try {
    // one-off backfill: swims synced before swim speed curves existed
    const stale = q.all(`SELECT id FROM activities WHERE sport = 'swim' AND detailed = 1 AND (curves IS NULL OR curves NOT LIKE '%"speed"%')`).map((r) => r.id as number);
    if (stale.length) {
      recalculate({ ids: stale });
      log(null, 'info', `Computed swim pace curves for ${stale.length} swims`);
    }
    const auto = getPreferences().autoThresholds;
    for (const sport of SPORTS) {
      const next = computeSeries(sport);
      const prev = new Map(storedSeries(sport).map((e) => [e.date, e]));
      let earliest: string | null = null;
      const seen = new Set<string>();
      for (const e of next) {
        seen.add(e.date);
        const p = prev.get(e.date);
        // bike CP and W′ drive W′ balance, so they count too
        if (!p || moved(e.threshold, p.threshold) || (sport === 'ride' && (moved(e.cp, p.cp) || moved(e.wPrime, p.wPrime)))) {
          earliest ??= e.date;
          break;
        }
      }
      for (const d of prev.keys()) if (!seen.has(d) && (!earliest || d < earliest)) earliest = d;
      transaction(() => {
        q.run('DELETE FROM threshold_estimates WHERE sport = ?', sport);
        for (const e of next) q.run('INSERT INTO threshold_estimates(sport, date, data) VALUES(?, ?, ?)', sport, e.date, JSON.stringify(e));
      });
      changedFrom[sport] = earliest;
    }
    // heart-rate thresholds
    {
      const next = computeHrSeries();
      const prev = new Map(storedHrSeries().map((e) => [e.date, e]));
      let earliest: string | null = null;
      const differs = (a: number | null | undefined, b: number | null | undefined) => (a ?? 0) !== (b ?? 0) && Math.abs((a ?? 0) - (b ?? 0)) >= 1;
      for (const e of next) {
        const p = prev.get(e.date);
        if (!p || differs(p.lthr, e.lthr) || differs(p.runLthr, e.runLthr) || differs(p.maxHr, e.maxHr)) {
          earliest = e.date;
          break;
        }
      }
      if (!earliest && prev.size !== next.length) earliest = next[0]?.date ?? null;
      transaction(() => {
        q.run("DELETE FROM threshold_estimates WHERE sport = 'hr'");
        for (const e of next) q.run("INSERT INTO threshold_estimates(sport, date, data) VALUES('hr', ?, ?)", e.date, JSON.stringify(e));
      });
      changedFrom.hr = earliest;
    }
    resetEstimateCache();
    stored.clear();
    models.clear();
    if (auto.hr && (opts.force || changedFrom.hr)) {
      // the first estimate also covers everything before it
      const first = storedHrSeries()[0]?.date;
      const from = opts.force || !changedFrom.hr || (first && changedFrom.hr <= first) ? '0000-01-01' : changedFrom.hr;
      const ids = q.all('SELECT id FROM activities WHERE has_hr = 1 AND local_date >= ?', from).map((r) => r.id as number);
      if (ids.length) {
        await recalculateAsync({ ids });
        log(null, 'info', `Updated heart-rate thresholds — recalculated ${ids.length} activities`);
      }
      await new Promise((r) => setImmediate(r));
    }
    for (const sport of SPORTS) {
      const from = opts.force ? '0000-01-01' : changedFrom[sport];
      if (!from || !auto[sport]) continue;
      // estimates for a date only apply from that date on; the first estimate is also used
      // to backfill earlier activities, so changes to it affect everything before it
      const first = storedSeries(sport)[0]?.date;
      const start = first && from <= first ? '0000-01-01' : from;
      const ids = q.all('SELECT id FROM activities WHERE sport = ? AND local_date >= ?', sport, start).map((r) => r.id as number);
      if (ids.length) {
        await recalculateAsync({ ids });
        log(null, 'info', `Updated ${sport} thresholds — recalculated ${ids.length} activities from ${start === '0000-01-01' ? 'the start' : start}`);
      }
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    state.running = false;
    state.lastRun = new Date().toISOString();
  }
  if (state.pending) {
    state.pending = false;
    scheduleEstimateRefresh();
  }
  return changedFrom;
}

/**
 * Bump when activity metrics are computed differently, so stored activities are rebuilt
 * from their streams once after deploy:
 *  2 — moving-time NP/TSS, robust moving detection, CP-based W′ balance, run GPS cleaning,
 *      gated decoupling; FTP floors; heart-rate thresholds
 *  3 — GPS found south of the equator (routes, heatmap); decoupling only when the halves'
 *      output is within 5 %
 *  4 — session analysis (what each session was, its sets and how they went); temperature
 *      ignored from a sensor stuck on one value
 */
const METRICS_VERSION = 4;

/** Rebuild every activity if the metrics changed since they were stored; then refresh estimates. */
export async function upgradeMetrics(): Promise<boolean> {
  const v = getSetting<number>('metrics_version') ?? 1;
  if (v >= METRICS_VERSION) return false;
  log(null, 'info', 'Metrics updated — recomputing every activity from its streams');
  // curves first (cleaned run speed feeds the run threshold), then thresholds from them,
  // which recalculates everything again with the new thresholds
  await recalculateAsync();
  await refreshEstimates({ force: true });
  setSetting('metrics_version', METRICS_VERSION);
  log(null, 'info', 'Recomputed all activities');
  return true;
}

/** Debounced refresh, used after syncs and imports. */
export function scheduleEstimateRefresh(delayMs = 5000) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    refreshEstimates().catch((e) => log(null, 'error', `Threshold estimation failed: ${(e as Error).message}`));
  }, delayMs);
}

export const estimateState = () => ({ running: state.running, lastRun: state.lastRun });

/** Estimates run through today: on a new day, roll them on even if nothing was synced. */
export function refreshOnNewDay() {
  if (state.day && state.day !== today() && !state.running && !state.timer) scheduleEstimateRefresh(0);
}
