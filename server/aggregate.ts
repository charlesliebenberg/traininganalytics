import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, startOfWeek, subDays } from 'date-fns';
import type { ActivityCurves, DailyLoad, PmcPoint, Sport } from '../shared/types';
import { computePmc } from '../shared/analytics/pmc';
import { CURVE_DURATIONS } from '../shared/analytics/series';
import { fitCp2, fitPowerDuration, curvePoints, type PdModel } from '../shared/analytics/models';
import { polarizationIndex } from '../shared/analytics/zones';
import { BEST_EFFORT_DISTANCES } from '../shared/analytics/running';
import { getPreferences, q, thresholdsFor } from './db';

export const iso = (d: Date) => format(d, 'yyyy-MM-dd');
export const today = () => iso(new Date());

// ---------- curve cache ----------
const curveCache = new Map<number, { updated: string; curves: ActivityCurves | null }>();

interface CurveRow {
  id: number;
  local_date: string;
  sport: Sport;
  name: string;
  curves: ActivityCurves;
}

export function curvesInRange(from: string, to: string, sport?: string | null): CurveRow[] {
  const rows = q.all(
    `SELECT id, local_date, sport, name, updated_at FROM activities WHERE curves IS NOT NULL AND local_date BETWEEN ? AND ? ${sport ? 'AND sport = ?' : ''}`,
    from,
    to,
    ...(sport ? [sport] : []),
  );
  const out: CurveRow[] = [];
  for (const r of rows) {
    let c = curveCache.get(r.id);
    if (!c || c.updated !== r.updated_at) {
      const raw = q.get('SELECT curves FROM activities WHERE id = ?', r.id);
      c = { updated: r.updated_at, curves: raw?.curves ? JSON.parse(raw.curves) : null };
      curveCache.set(r.id, c);
    }
    if (c.curves) out.push({ id: r.id, local_date: r.local_date, sport: r.sport, name: r.name, curves: c.curves });
  }
  return out;
}

export type CurveType = 'power' | 'np' | 'hr' | 'speed' | 'vam' | `fatigue:${number}`;

export interface AggregatedCurve {
  durations: number[];
  values: (number | null)[];
  activityIds: (number | null)[];
  dates: (string | null)[];
}

function pickCurve(c: ActivityCurves, type: CurveType): (number | null)[] | undefined {
  if (type.startsWith('fatigue:')) return c.fatigue?.[type.split(':')[1]];
  return c[type as 'power'];
}

/** Best value at every duration across all activities in the range. */
export function aggregateCurve(type: CurveType, from: string, to: string, sport?: string | null): AggregatedCurve {
  const rows = curvesInRange(from, to, sport);
  const values: (number | null)[] = CURVE_DURATIONS.map(() => null);
  const activityIds: (number | null)[] = CURVE_DURATIONS.map(() => null);
  const dates: (string | null)[] = CURVE_DURATIONS.map(() => null);
  for (const r of rows) {
    const c = pickCurve(r.curves, type);
    if (!c) continue;
    for (let i = 0; i < c.length; i++) {
      const v = c[i];
      if (v != null && (values[i] == null || v > values[i]!)) {
        values[i] = v;
        activityIds[i] = r.id;
        dates[i] = r.local_date;
      }
    }
  }
  // enforce monotonic non-increasing (a longer effort contains a shorter one) for power/hr/speed
  if (type === 'power' || type === 'speed' || type.startsWith('fatigue')) {
    for (let i = values.length - 2; i >= 0; i--) {
      if (values[i + 1] != null && (values[i] == null || values[i]! < values[i + 1]!)) {
        values[i] = values[i + 1];
        activityIds[i] = activityIds[i + 1];
        dates[i] = dates[i + 1];
      }
    }
  }
  return { durations: CURVE_DURATIONS, values, activityIds, dates };
}

export function powerModel(from: string, to: string): { model: PdModel | null; cp2: ReturnType<typeof fitCp2> } {
  const c = aggregateCurve('power', from, to, 'ride');
  return { model: fitPowerDuration(c.values), cp2: fitCp2(curvePoints(c.values)) };
}

/** Rolling eFTP / CP / W' / Pmax estimates (42-day windows, weekly). */
export function modelHistory(from: string, to: string, window = 42) {
  const out: { date: string; eftp: number; cp: number; wPrime: number; pmax: number; ftp: number }[] = [];
  let d = parseISO(from);
  const end = parseISO(to);
  while (d <= end) {
    const ds = iso(d);
    const { model } = powerModel(iso(subDays(d, window)), ds);
    if (model) out.push({ date: ds, eftp: Math.round(model.eftp), cp: Math.round(model.cp), wPrime: Math.round(model.wPrime), pmax: Math.round(model.pmax), ftp: thresholdsFor(ds).ftp });
    d = addDays(d, 7);
  }
  return out;
}

// ---------- daily loads & PMC ----------
export function dailyLoads(from: string, to: string, sport?: string | null): DailyLoad[] {
  const acts = q.all(
    `SELECT local_date, COALESCE(tss_override, tss, 0) AS tss, moving_time, COALESCE(distance, 0) AS distance FROM activities
     WHERE local_date BETWEEN ? AND ? ${sport ? 'AND sport = ?' : ''}`,
    from,
    to,
    ...(sport ? [sport] : []),
  );
  const planned = q.all(
    `SELECT date, COALESCE(planned_tss, 0) AS tss FROM planned_workouts WHERE date BETWEEN ? AND ? AND activity_id IS NULL ${sport ? 'AND sport = ?' : ''}`,
    from,
    to,
    ...(sport ? [sport] : []),
  );
  const map = new Map<string, DailyLoad>();
  const n = differenceInCalendarDays(parseISO(to), parseISO(from));
  for (let i = 0; i <= n; i++) {
    const d = iso(addDays(parseISO(from), i));
    map.set(d, { date: d, tss: 0, planned: 0, duration: 0, distance: 0 });
  }
  for (const a of acts) {
    const r = map.get(a.local_date);
    if (!r) continue;
    r.tss += a.tss;
    r.duration += a.moving_time;
    r.distance += a.distance;
  }
  for (const p of planned) {
    const r = map.get(p.date);
    if (r) r.planned += p.tss;
  }
  return [...map.values()];
}

/**
 * PMC from the first ever activity (so CTL is properly seeded) through `to`.
 * Days after today use planned TSS (projection).
 */
/**
 * Future load from the latest season plan, for weeks with no planned workouts yet, so the
 * PMC can project fitness all the way to race day.
 */
export function planProjection(to: string): Map<string, number> {
  const out = new Map<string, number>();
  const row = q.get('SELECT weeks FROM season_plans ORDER BY id DESC LIMIT 1');
  if (!row) return out;
  const t = today();
  const weeks = JSON.parse(row.weeks) as { weekStart: string; tss: number }[];
  for (const w of weeks) {
    const end = iso(addDays(parseISO(w.weekStart), 6));
    if (end <= t || w.weekStart > to) continue;
    const planned = q.get('SELECT COUNT(*) AS n FROM planned_workouts WHERE date BETWEEN ? AND ?', w.weekStart, end);
    if (Number(planned?.n) > 0) continue;
    for (let i = 0; i < 7; i++) {
      const d = iso(addDays(parseISO(w.weekStart), i));
      if (d > t) out.set(d, w.tss / 7);
    }
  }
  return out;
}

export function pmc(from: string, to: string, sport?: string | null, extraPlanned?: Map<string, number>): PmcPoint[] {
  const prefs = getPreferences();
  if (!extraPlanned && !sport && to > today()) extraPlanned = planProjection(to);
  const first = q.get('SELECT MIN(local_date) AS d FROM activities')?.d as string | undefined;
  const start = first && first < from ? first : from;
  const t = today();
  const loads = dailyLoads(start, to, sport);
  const days = loads.map((l) => {
    const future = l.date > t;
    const planned = l.planned + (extraPlanned?.get(l.date) ?? 0);
    const todayPending = l.date === t && l.tss === 0 && planned > 0;
    return { date: l.date, tss: future || todayPending ? planned : l.tss, projected: future || todayPending };
  });
  const pts = computePmc(days, { ctlDays: prefs.ctlDays, atlDays: prefs.atlDays });
  return pts.filter((p) => p.date >= from);
}

// ---------- trends ----------
export function trends(from: string, to: string, bucket: 'week' | 'month') {
  const rows = q.all(
    `SELECT id, local_date, sport, moving_time, distance, elevation_gain, COALESCE(tss_override, tss) AS tss, work, zones, ef, decoupling, intensity, np, avg_hr, trainer
     FROM activities WHERE local_date BETWEEN ? AND ? ORDER BY local_date`,
    from,
    to,
  );
  const prefs = getPreferences();
  const keyOf = (d: string) =>
    iso(bucket === 'week' ? startOfWeek(parseISO(d), { weekStartsOn: prefs.weekStart }) : startOfMonth(parseISO(d)));
  type Bucket = {
    start: string;
    sports: Record<string, { time: number; distance: number; elevation: number; tss: number; count: number; work: number }>;
    power: number[];
    hr: number[];
    seiler: number[];
    polarization: number | null;
    efRide: number | null;
    efRun: number | null;
    decoupling: number | null;
  };
  const buckets = new Map<string, Bucket & { _ef: number[]; _efr: number[]; _dec: number[] }>();
  // pre-create empty buckets so gaps show as zero
  let d = parseISO(keyOf(from));
  while (iso(d) <= to) {
    const k = iso(d);
    buckets.set(k, { start: k, sports: {}, power: [], hr: [], seiler: [0, 0, 0], polarization: null, efRide: null, efRun: null, decoupling: null, _ef: [], _efr: [], _dec: [] });
    d = bucket === 'week' ? addDays(d, 7) : startOfMonth(addDays(d, 32));
  }
  const add = (arr: number[], v: number[] | undefined) => v?.forEach((x, i) => (arr[i] = (arr[i] ?? 0) + x));
  for (const r of rows) {
    const b = buckets.get(keyOf(r.local_date));
    if (!b) continue;
    const s = (b.sports[r.sport] ??= { time: 0, distance: 0, elevation: 0, tss: 0, count: 0, work: 0 });
    s.time += r.moving_time;
    s.distance += r.distance ?? 0;
    s.elevation += r.elevation_gain ?? 0;
    s.tss += r.tss ?? 0;
    s.work += r.work ?? 0;
    s.count++;
    const z = r.zones ? JSON.parse(r.zones) : null;
    if (z) {
      add(b.power, z.power);
      add(b.hr, z.hr);
      add(b.seiler, z.seiler);
    }
    // aerobic efficiency: only steady, aerobic sessions are comparable
    if (r.ef && r.intensity && r.intensity < 0.82 && r.moving_time > 2700) (r.sport === 'ride' ? b._ef : r.sport === 'run' ? b._efr : []).push(r.ef);
    if (r.decoupling != null && r.intensity && r.intensity < 0.8 && r.moving_time > 3600) b._dec.push(r.decoupling);
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  return [...buckets.values()].map(({ _ef, _efr, _dec, ...b }) => ({
    ...b,
    polarization: polarizationIndex(b.seiler),
    efRide: avg(_ef),
    efRun: avg(_efr),
    decoupling: avg(_dec),
  }));
}

// ---------- records ----------
export function records() {
  const runs = q.all("SELECT id, local_date, name, best_efforts FROM activities WHERE best_efforts IS NOT NULL AND sport = 'run'");
  const bestRun: Record<string, { time: number; id: number; date: string; name: string; byYear: Record<string, number> }> = {};
  for (const r of runs) {
    const be = JSON.parse(r.best_efforts) as Record<string, number>;
    const year = r.local_date.slice(0, 4);
    for (const [k, t] of Object.entries(be)) {
      const cur = (bestRun[k] ??= { time: Infinity, id: r.id, date: r.local_date, name: r.name, byYear: {} });
      if (t < cur.time) Object.assign(cur, { time: t, id: r.id, date: r.local_date, name: r.name });
      if (!cur.byYear[year] || t < cur.byYear[year]) cur.byYear[year] = t;
    }
  }
  const years = q.all("SELECT DISTINCT substr(local_date, 1, 4) AS y FROM activities ORDER BY y").map((r) => r.y as string);
  const peakDurations = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 5400, 7200];
  const peaks = peakDurations.map((dur) => {
    const idx = CURVE_DURATIONS.indexOf(dur);
    const row: Record<string, unknown> = { duration: dur };
    for (const y of years) {
      const c = aggregateCurve('power', `${y}-01-01`, `${y}-12-31`, 'ride');
      row[y] = c.values[idx] != null ? { value: c.values[idx], id: c.activityIds[idx], date: c.dates[idx] } : null;
    }
    const all = aggregateCurve('power', '0000-01-01', '9999-12-31', 'ride');
    row.all = all.values[idx] != null ? { value: all.values[idx], id: all.activityIds[idx], date: all.dates[idx] } : null;
    return row;
  });
  const top = (sql: string) => q.get(sql) ?? null;
  const highlights = {
    longestRide: top("SELECT id, name, local_date, distance AS value FROM activities WHERE sport = 'ride' ORDER BY distance DESC LIMIT 1"),
    longestRun: top("SELECT id, name, local_date, distance AS value FROM activities WHERE sport = 'run' ORDER BY distance DESC LIMIT 1"),
    mostClimbing: top('SELECT id, name, local_date, elevation_gain AS value FROM activities ORDER BY elevation_gain DESC LIMIT 1'),
    biggestTss: top('SELECT id, name, local_date, COALESCE(tss_override, tss) AS value FROM activities ORDER BY value DESC LIMIT 1'),
    mostWork: top('SELECT id, name, local_date, work AS value FROM activities ORDER BY work DESC LIMIT 1'),
    highestNp: top("SELECT id, name, local_date, np AS value FROM activities WHERE sport = 'ride' AND moving_time > 1800 ORDER BY np DESC LIMIT 1"),
  };
  return {
    years,
    run: BEST_EFFORT_DISTANCES.filter((d) => bestRun[d.key]).map((d) => ({ ...d, ...bestRun[d.key] })),
    peaks,
    highlights,
  };
}

