/**
 * Rolling threshold history: every week, estimate FTP / run threshold pace / CSS from the
 * previous 6 months of best efforts, store it, and (in auto mode) recompute affected
 * activities so TSS and zones use the threshold that was true at the time.
 */
import { addDays, format, parseISO, startOfWeek, subDays } from 'date-fns';
import { estimateHrThresholds, estimateThreshold, limitDeclines, WINDOW_DAYS, type HrThresholds, type ThresholdEstimate, type ThresholdSport } from '../shared/analytics/thresholds';
import { CURVE_DURATIONS } from '../shared/analytics/series';
import { aggregateCurve, curvesInRange } from './aggregate';
import { getPreferences, getSetting, log, q, resetEstimateCache, setSetting, transaction } from './db';
import { recalculate, recalculateAsync } from './ingest';

export const SPORTS: ThresholdSport[] = ['ride', 'run', 'swim'];
const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const curveType = (sport: ThresholdSport) => (sport === 'ride' ? 'power' : 'speed') as 'power' | 'speed';

/** Estimate as of `date`, using the 6 months that end the day before. */
export function estimateOn(sport: ThresholdSport, date: string): ThresholdEstimate | null {
  const windowTo = iso(subDays(parseISO(date), 1));
  const windowFrom = iso(subDays(parseISO(date), WINDOW_DAYS));
  const curve = aggregateCurve(curveType(sport), windowFrom, windowTo, sport);
  const activities = curvesInRange(windowFrom, windowTo, sport).filter((r) => r.curves[curveType(sport)]?.some((v) => v != null)).length;
  return estimateThreshold(sport, curve, { date, windowFrom, windowTo, activities });
}

/** Weekly estimates (Mondays) from the sport's first activity until next Monday. */
export function computeSeries(sport: ThresholdSport): ThresholdEstimate[] {
  const first = q.get('SELECT MIN(local_date) AS d FROM activities WHERE sport = ? AND curves IS NOT NULL', sport)?.d as string | undefined;
  if (!first) return [];
  const out: ThresholdEstimate[] = [];
  const end = addDays(new Date(), 7);
  for (let d = startOfWeek(addDays(parseISO(first), 7), { weekStartsOn: 1 }); d <= end; d = addDays(d, 7)) {
    const e = estimateOn(sport, iso(d));
    if (e) out.push(e);
  }
  return limitDeclines(out);
}

export interface HrEstimate extends HrThresholds {
  date: string;
  rides: number;
  runs: number;
  /** what this week's own windows show, before the best-ever value is carried forward */
  raw: HrThresholds;
}

/**
 * Weekly heart-rate thresholds: LTHR from the 6 months before each Monday, max HR from the
 * 12 months before. Heart-rate thresholds are set mostly by age, not fitness, so the best
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
  const end = addDays(new Date(), 7);
  let lo6 = 0;
  let lo12 = 0;
  let hi = 0;
  const best: Partial<Record<'lthr' | 'runLthr' | 'maxHr', { v: number; d: string }>> = {};
  for (let d = startOfWeek(addDays(parseISO(rows[0].d), 7), { weekStartsOn: 1 }); d <= end; d = addDays(d, 7)) {
    const date = iso(d);
    const from6 = iso(subDays(d, WINDOW_DAYS));
    const from12 = iso(subDays(d, 365));
    while (hi < rows.length && rows[hi].d < date) hi++;
    while (lo6 < hi && rows[lo6].d < from6) lo6++;
    while (lo12 < hi && rows[lo12].d < from12) lo12++;
    const win6 = rows.slice(lo6, hi);
    const rides = win6.filter((r) => r.sport === 'ride' && r.h30).map((r) => r.h30!);
    const runs = win6.filter((r) => r.sport === 'run' && r.h30).map((r) => r.h30!);
    const maxima = rows.slice(lo12, hi).map((r) => r.mx ?? 0);
    const e = estimateHrThresholds(rides, runs, maxima);
    const carried = (k: 'lthr' | 'runLthr' | 'maxHr') => {
      const b = best[k];
      return b ? b.v - (0.7 * (Date.parse(date) - Date.parse(b.d))) / (365.25 * 86400000) : null;
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

export const storedHrSeries = (): HrEstimate[] => q.all("SELECT data FROM threshold_estimates WHERE sport = 'hr' ORDER BY date").map((r) => JSON.parse(r.data));

export function storedSeries(sport: ThresholdSport): ThresholdEstimate[] {
  return q.all('SELECT data FROM threshold_estimates WHERE sport = ? ORDER BY date', sport).map((r) => JSON.parse(r.data));
}

const state = { running: false, pending: false, timer: null as NodeJS.Timeout | null, lastRun: null as string | null };

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
      const prev = new Map(storedSeries(sport).map((e) => [e.date, e.threshold]));
      let earliest: string | null = null;
      const seen = new Set<string>();
      for (const e of next) {
        seen.add(e.date);
        const p = prev.get(e.date);
        if (p == null || Math.abs(p - e.threshold) / e.threshold > 0.005) {
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
 */
const METRICS_VERSION = 3;

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
