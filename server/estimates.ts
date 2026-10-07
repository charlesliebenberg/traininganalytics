/**
 * Rolling threshold history: every week, estimate FTP / run threshold pace / CSS from the
 * previous 6 months of best efforts, store it, and (in auto mode) recompute affected
 * activities so TSS and zones use the threshold that was true at the time.
 */
import { addDays, format, parseISO, startOfWeek, subDays } from 'date-fns';
import { estimateThreshold, limitDeclines, WINDOW_DAYS, type ThresholdEstimate, type ThresholdSport } from '../shared/analytics/thresholds';
import { aggregateCurve, curvesInRange } from './aggregate';
import { getPreferences, log, q, resetEstimateCache, transaction } from './db';
import { recalculate } from './ingest';

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
    resetEstimateCache();
    for (const sport of SPORTS) {
      const from = opts.force ? '0000-01-01' : changedFrom[sport];
      if (!from || !auto[sport]) continue;
      // estimates for a date only apply from that date on; the first estimate is also used
      // to backfill earlier activities, so changes to it affect everything before it
      const first = storedSeries(sport)[0]?.date;
      const start = first && from <= first ? '0000-01-01' : from;
      const ids = q.all('SELECT id FROM activities WHERE sport = ? AND local_date >= ?', sport, start).map((r) => r.id as number);
      if (ids.length) {
        recalculate({ ids });
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

/** Debounced refresh, used after syncs and imports. */
export function scheduleEstimateRefresh(delayMs = 5000) {
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    refreshEstimates().catch((e) => log(null, 'error', `Threshold estimation failed: ${(e as Error).message}`));
  }, delayMs);
}

export const estimateState = () => ({ running: state.running, lastRun: state.lastRun });
