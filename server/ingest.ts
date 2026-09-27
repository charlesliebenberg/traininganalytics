import type { Lap, Source, Sport, Streams } from '../shared/types';
import { computeMetrics, metricsFromSummary, type SummaryInput } from '../shared/analytics/metrics';
import { rollingMean, toFloat } from '../shared/analytics/series';
import { rangeStats } from '../shared/analytics/range';
import { getActivity, loadStreams, log, q, saveStreams, thresholdsFor, transaction } from './db';

export interface LapInput {
  name?: string;
  start: number; // seconds from activity start
  duration: number;
}

export interface ActivityInput {
  source: Source;
  externalId: string | null;
  name: string;
  sport: Sport;
  startTime: string; // ISO
  localDate: string; // YYYY-MM-DD
  trainer?: boolean;
  commute?: boolean;
  description?: string | null;
  device?: string | null;
  rpe?: number | null;
  streams?: Streams | null;
  laps?: LapInput[] | null;
  /** Used when streams are unavailable */
  summary?: SummaryInput & {
    elevationGain?: number | null;
    maxPower?: number | null;
    maxHr?: number | null;
    avgCadence?: number | null;
    maxSpeed?: number | null;
    calories?: number | null;
    work?: number | null;
    polyline?: string | null;
    tss?: number | null;
    intensity?: number | null;
    avgTemp?: number | null;
  };
  raw?: unknown;
}

function buildLaps(s: Streams, laps: LapInput[] | null | undefined): Lap[] | null {
  if (!laps?.length || laps.length < 2) return null;
  const r30 = s.watts ? rollingMean(toFloat(s.watts), 30) : undefined;
  return laps
    .filter((l) => l.duration > 0 && l.start < s.time.length)
    .map((l, i) => {
      const end = Math.min(s.time.length, l.start + l.duration);
      return { ...rangeStats(s, l.start, end, r30), name: l.name || `Lap ${i + 1}` };
    });
}

const ACTIVITY_COLS = [
  'source', 'external_id', 'name', 'sport', 'start_time', 'local_date', 'elapsed_time', 'moving_time', 'distance',
  'elevation_gain', 'avg_power', 'max_power', 'np', 'intensity', 'tss', 'tss_method', 'vi', 'ef', 'decoupling', 'work',
  'calories', 'avg_hr', 'max_hr', 'avg_cadence', 'avg_speed', 'max_speed', 'trimp', 'avg_temp', 'wbal_min', 'has_power',
  'has_hr', 'has_gps', 'trainer', 'commute', 'polyline', 'description', 'rpe', 'device', 'detailed', 'ftp_used', 'zones',
  'best_efforts', 'laps', 'curves', 'summary',
] as const;

type Cols = Record<(typeof ACTIVITY_COLS)[number], unknown>;

function buildRow(input: ActivityInput): Cols {
  const th = thresholdsFor(input.localDate);
  const base = {
    source: input.source,
    external_id: input.externalId,
    name: input.name || 'Activity',
    sport: input.sport,
    start_time: input.startTime,
    local_date: input.localDate,
    trainer: input.trainer ? 1 : 0,
    commute: input.commute ? 1 : 0,
    description: input.description ?? null,
    rpe: input.rpe ?? null,
    device: input.device ?? null,
    summary: input.raw ? JSON.stringify(input.raw) : null,
  };
  if (input.streams && input.streams.time.length > 1) {
    const m = computeMetrics(input.streams, input.sport, th);
    const laps = buildLaps(input.streams, input.laps);
    return {
      ...base,
      elapsed_time: m.elapsedTime,
      moving_time: m.movingTime,
      distance: m.distance,
      elevation_gain: m.elevationGain,
      avg_power: m.avgPower,
      max_power: m.maxPower,
      np: m.np,
      intensity: m.intensity,
      tss: m.tss,
      tss_method: m.tssMethod,
      vi: m.vi,
      ef: m.ef,
      decoupling: m.decoupling,
      work: m.work,
      calories: m.calories,
      avg_hr: m.avgHr,
      max_hr: m.maxHr,
      avg_cadence: m.avgCadence,
      avg_speed: m.avgSpeed,
      max_speed: m.maxSpeed,
      trimp: m.trimp,
      avg_temp: m.avgTemp,
      wbal_min: m.wbalMin,
      has_power: m.hasPower ? 1 : 0,
      has_hr: m.hasHr ? 1 : 0,
      has_gps: m.hasGps ? 1 : 0,
      polyline: m.polyline ?? input.summary?.polyline ?? null,
      detailed: 1,
      ftp_used: m.ftpUsed,
      zones: m.zones ? JSON.stringify(m.zones) : null,
      best_efforts: m.bestEfforts && Object.keys(m.bestEfforts).length ? JSON.stringify(m.bestEfforts) : null,
      laps: laps ? JSON.stringify(laps) : null,
      curves: JSON.stringify(m.curves),
    };
  }
  const s = input.summary;
  if (!s) throw new Error('Activity needs streams or summary');
  const m = metricsFromSummary(s, th);
  return {
    ...base,
    elapsed_time: s.elapsedTime,
    moving_time: s.movingTime,
    distance: s.distance ?? null,
    elevation_gain: s.elevationGain ?? null,
    avg_power: s.avgPower ?? null,
    max_power: s.maxPower ?? null,
    np: s.weightedPower ?? null,
    intensity: s.intensity ?? m.intensity,
    tss: s.tss ?? m.tss,
    tss_method: s.tss != null ? 'manual' : m.method,
    vi: s.weightedPower && s.avgPower ? s.weightedPower / s.avgPower : null,
    ef: m.ef,
    decoupling: null,
    work: s.work ?? null,
    calories: s.calories ?? null,
    avg_hr: s.avgHr ?? null,
    max_hr: s.maxHr ?? null,
    avg_cadence: s.avgCadence ?? null,
    avg_speed: s.avgSpeed ?? null,
    max_speed: s.maxSpeed ?? null,
    trimp: null,
    avg_temp: s.avgTemp ?? null,
    wbal_min: null,
    has_power: s.avgPower ? 1 : 0,
    has_hr: s.avgHr ? 1 : 0,
    has_gps: s.polyline ? 1 : 0,
    polyline: s.polyline ?? null,
    detailed: 0,
    ftp_used: s.weightedPower ? th.ftp : null,
    zones: null,
    best_efforts: null,
    laps: null,
    curves: null,
  };
}

/** Find an activity from another source that is the same workout (e.g. Strava + TrainingPeaks copies). */
function findDuplicate(input: ActivityInput, elapsed: number): { id: number; detailed: number; source: string } | undefined {
  const t = Date.parse(input.startTime);
  const lo = new Date(t - 120_000).toISOString();
  const hi = new Date(t + 120_000).toISOString();
  const rows = q.all(
    'SELECT id, detailed, source, elapsed_time FROM activities WHERE start_time BETWEEN ? AND ? AND NOT (source = ? AND external_id IS ?)',
    lo,
    hi,
    input.source,
    input.externalId,
  );
  return rows.find((r) => Math.abs(r.elapsed_time - elapsed) <= Math.max(120, elapsed * 0.1)) as any;
}

/**
 * Insert or update an activity, computing all metrics and storing streams.
 * Returns the activity id, or null if it was skipped as a duplicate.
 */
export function saveActivity(input: ActivityInput): number | null {
  const row = buildRow(input);
  return transaction(() => {
    const existing = input.externalId
      ? q.get('SELECT id, rpe, description, name, sport FROM activities WHERE source = ? AND external_id = ?', input.source, input.externalId)
      : undefined;
    if (!existing) {
      const dup = findDuplicate(input, Number(row.elapsed_time));
      if (dup) {
        // keep the richer copy
        if (dup.detailed || !row.detailed) return null;
        q.run('DELETE FROM activities WHERE id = ?', dup.id);
      }
    }
    let id: number;
    if (existing) {
      // preserve user edits (rpe/description) when re-syncing
      if (existing.rpe != null && row.rpe == null) row.rpe = existing.rpe;
      if (existing.description && !row.description) row.description = existing.description;
      const sets = ACTIVITY_COLS.map((c) => `${c} = ?`).join(', ');
      q.run(`UPDATE activities SET ${sets}, updated_at = datetime('now') WHERE id = ?`, ...ACTIVITY_COLS.map((c) => row[c] as any), existing.id);
      id = existing.id;
    } else {
      const res = q.run(
        `INSERT INTO activities (${ACTIVITY_COLS.join(', ')}) VALUES (${ACTIVITY_COLS.map(() => '?').join(', ')})`,
        ...ACTIVITY_COLS.map((c) => row[c] as any),
      );
      id = Number(res.lastInsertRowid);
    }
    if (input.streams && input.streams.time.length > 1) saveStreams(id, input.streams);
    linkPlanned(id);
    return id;
  });
}

/** Link a completed activity to a same-day, same-sport planned workout. */
export function linkPlanned(activityId: number) {
  const a = getActivity(activityId);
  if (!a || a.plannedId) return;
  const p = q.get(
    'SELECT id FROM planned_workouts WHERE date = ? AND sport = ? AND activity_id IS NULL ORDER BY sort_order LIMIT 1',
    a.localDate,
    a.sport,
  );
  if (!p) return;
  q.run('UPDATE planned_workouts SET activity_id = ? WHERE id = ?', activityId, p.id);
  q.run('UPDATE activities SET planned_id = ? WHERE id = ?', p.id, activityId);
}

/** Recompute metrics for activities (e.g. after thresholds changed). */
export function recalculate(filter?: { from?: string; ids?: number[] }, onProgress?: (done: number, total: number) => void): number {
  const cols = 'id, source, external_id, name, sport, start_time, local_date, trainer, commute, description, device, rpe, laps, detailed';
  const rows = filter?.ids
    ? q.all(`SELECT ${cols} FROM activities WHERE id IN (${filter.ids.map(() => '?').join(',') || 'NULL'})`, ...filter.ids)
    : q.all(`SELECT ${cols} FROM activities WHERE local_date >= ? ORDER BY id`, filter?.from ?? '0000');
  let done = 0;
  for (const r of rows) {
    try {
      const laps: Lap[] | null = r.laps ? JSON.parse(r.laps) : null;
      const streams = r.detailed ? loadStreams(r.id) : null;
      const base: ActivityInput = {
        source: r.source,
        externalId: r.external_id,
        name: r.name,
        sport: r.sport,
        startTime: r.start_time,
        localDate: r.local_date,
        trainer: !!r.trainer,
        commute: !!r.commute,
        description: r.description,
        device: r.device,
        rpe: r.rpe,
        laps: laps?.map((l) => ({ name: l.name, start: l.start, duration: l.duration })),
      };
      if (streams) {
        const row = buildRow({ ...base, streams });
        updateRow(r.id, row);
      } else {
        const a = getActivity(r.id)!;
        const th = thresholdsFor(a.localDate);
        const m = metricsFromSummary(
          { sport: a.sport, elapsedTime: a.elapsedTime, movingTime: a.movingTime, distance: a.distance, avgPower: a.avgPower, weightedPower: a.np, avgHr: a.avgHr, avgSpeed: a.avgSpeed },
          th,
        );
        if (a.tssMethod !== 'manual') q.run('UPDATE activities SET tss = ?, intensity = ?, tss_method = ? WHERE id = ?', m.tss, m.intensity, m.method, r.id);
      }
    } catch (e) {
      log(null, 'error', `Recalculate ${r.id} failed: ${(e as Error).message}`);
    }
    onProgress?.(++done, rows.length);
  }
  return done;
}

function updateRow(id: number, row: Cols) {
  const cols = ACTIVITY_COLS.filter((c) => !['source', 'external_id', 'name', 'description', 'rpe', 'summary', 'trainer', 'commute', 'device'].includes(c));
  q.run(`UPDATE activities SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`, ...cols.map((c) => row[c] as any), id);
}

