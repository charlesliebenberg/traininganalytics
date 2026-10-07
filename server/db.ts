import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { config } from './config';
import type {
  Activity,
  ActivityCurves,
  PlannedWorkout,
  Preferences,
  RaceEvent,
  SeasonPlan,
  Streams,
  Thresholds,
  WorkoutTemplate,
} from '../shared/types';

// node:sqlite is stable enough for our needs; silence its experimental warning.
const origEmit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (String(typeof w === 'string' ? w : w.message).includes('SQLite')) return;
  return (origEmit as (...a: unknown[]) => void)(w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');

mkdirSync(config.dataDir, { recursive: true });
export const db = new DatabaseSync(process.env.DB_PATH ?? join(config.dataDir, 'training.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS thresholds (date TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
  provider TEXT PRIMARY KEY,
  access_token TEXT, refresh_token TEXT, expires_at INTEGER,
  athlete_id TEXT, athlete_name TEXT, scope TEXT,
  last_sync_at TEXT, last_error TEXT, cursor TEXT, webhook_id TEXT
);
CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL, external_id TEXT, name TEXT NOT NULL, sport TEXT NOT NULL,
  start_time TEXT NOT NULL, local_date TEXT NOT NULL,
  elapsed_time INTEGER NOT NULL DEFAULT 0, moving_time INTEGER NOT NULL DEFAULT 0,
  distance REAL, elevation_gain REAL, avg_power REAL, max_power REAL, np REAL, intensity REAL,
  tss REAL, tss_method TEXT NOT NULL DEFAULT 'none', tss_override REAL, vi REAL, ef REAL, decoupling REAL,
  work REAL, calories REAL, avg_hr REAL, max_hr REAL, avg_cadence REAL, avg_speed REAL, max_speed REAL,
  trimp REAL, avg_temp REAL, wbal_min REAL,
  has_power INTEGER NOT NULL DEFAULT 0, has_hr INTEGER NOT NULL DEFAULT 0, has_gps INTEGER NOT NULL DEFAULT 0,
  trainer INTEGER NOT NULL DEFAULT 0, commute INTEGER NOT NULL DEFAULT 0,
  polyline TEXT, description TEXT, rpe INTEGER, feel INTEGER, device TEXT,
  detailed INTEGER NOT NULL DEFAULT 0, ftp_used REAL,
  zones TEXT, best_efforts TEXT, laps TEXT, curves TEXT, planned_id INTEGER,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(local_date);
CREATE INDEX IF NOT EXISTS idx_activities_start ON activities(start_time);
CREATE TABLE IF NOT EXISTS streams (activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS planned_workouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL, sport TEXT NOT NULL, title TEXT NOT NULL, description TEXT, structure TEXT,
  planned_duration INTEGER, planned_distance REAL, planned_tss REAL, planned_if REAL,
  activity_id INTEGER, source TEXT NOT NULL DEFAULT 'manual', external_id TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  plan_id INTEGER,
  UNIQUE(source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_planned_date ON planned_workouts(date);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, name TEXT NOT NULL, sport TEXT NOT NULL,
  priority TEXT NOT NULL, description TEXT, target_ctl REAL
);
CREATE TABLE IF NOT EXISTS workout_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sport TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', structure TEXT NOT NULL, builtin_key TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS season_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, config TEXT NOT NULL, weeks TEXT NOT NULL,
  event_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
  payload TEXT, attempts INTEGER NOT NULL DEFAULT 0, not_before INTEGER NOT NULL DEFAULT 0, priority INTEGER NOT NULL DEFAULT 0,
  sort_key INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, kind, external_id)
);
CREATE TABLE IF NOT EXISTS threshold_estimates (
  sport TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (sport, date)
);
CREATE TABLE IF NOT EXISTS sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), provider TEXT, level TEXT NOT NULL, message TEXT NOT NULL
);
`);

type Row = Record<string, any>;

export const q = {
  all: <T = Row>(sql: string, ...params: any[]): T[] => db.prepare(sql).all(...params) as T[],
  get: <T = Row>(sql: string, ...params: any[]): T | undefined => db.prepare(sql).get(...params) as T | undefined,
  run: (sql: string, ...params: any[]) => db.prepare(sql).run(...params),
};

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const json = <T>(v: unknown): T | null => (v == null ? null : (JSON.parse(String(v)) as T));

// ---------- preferences ----------
export const DEFAULT_PREFERENCES: Preferences = {
  units: 'metric',
  ctlDays: 42,
  atlDays: 7,
  weekStart: 1,
  athleteName: 'Athlete',
  crankLength: 172.5,
  autoThresholds: { ride: true, run: true, swim: true },
};

let prefCache: Preferences | null = null;
export function getPreferences(): Preferences {
  if (!prefCache) {
    const row = q.get('SELECT value FROM settings WHERE key = ?', 'preferences');
    const saved = row ? JSON.parse(row.value) : {};
    prefCache = { ...DEFAULT_PREFERENCES, ...saved, autoThresholds: { ...DEFAULT_PREFERENCES.autoThresholds, ...(saved.autoThresholds ?? {}) } };
  }
  return prefCache!;
}

export function setPreferences(p: Partial<Preferences>): Preferences {
  const next = { ...getPreferences(), ...p };
  prefCache = null;
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', 'preferences', JSON.stringify(next));
  return next;
}

export function getSetting<T>(key: string): T | null {
  const row = q.get('SELECT value FROM settings WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : null;
}
export function setSetting(key: string, value: unknown) {
  q.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
}

// ---------- thresholds ----------
export const DEFAULT_THRESHOLDS: Thresholds = {
  date: '1970-01-01',
  ftp: 250,
  wPrime: 20000,
  lthr: 165,
  runLthr: 170,
  maxHr: 190,
  restHr: 50,
  runThresholdSpeed: 1000 / 270, // 4:30 /km
  swimCss: 100 / 105, // 1:45 /100m
  weight: 72,
};

let thresholdCache: Thresholds[] | null = null;

export function listThresholds(): Thresholds[] {
  if (!thresholdCache) {
    thresholdCache = q
      .all('SELECT date, data FROM thresholds ORDER BY date')
      .map((r) => ({ ...DEFAULT_THRESHOLDS, ...JSON.parse(r.data), date: r.date }));
  }
  return thresholdCache;
}

/** Weekly rolling estimates per sport, sorted by date (loaded from threshold_estimates). */
type EstimateRow = { date: string; threshold: number; wPrime: number };
let estimateCache: Record<string, EstimateRow[]> | null = null;

export function estimatesFor(sport: string): EstimateRow[] {
  if (!estimateCache) {
    estimateCache = {};
    for (const r of q.all('SELECT sport, date, data FROM threshold_estimates ORDER BY date')) {
      const d = JSON.parse(r.data);
      (estimateCache[r.sport] ??= []).push({ date: r.date, threshold: d.threshold, wPrime: d.wPrime });
    }
  }
  return estimateCache[sport] ?? [];
}
export const resetEstimateCache = () => (estimateCache = null);

/** Latest estimate on or before `date`; before the first estimate, the first one (better than a default). */
function estimateAt(sport: string, date: string, allowBackfill: boolean): EstimateRow | null {
  const list = estimatesFor(sport);
  if (!list.length) return null;
  let found: EstimateRow | null = null;
  for (const e of list) {
    if (e.date <= date) found = e;
    else break;
  }
  return found ?? (allowBackfill ? list[0] : null);
}

export function manualThresholds(date: string): Thresholds | null {
  const all = listThresholds();
  if (!all.length) return null;
  let found = all[0];
  for (const t of all) if (t.date <= date) found = t;
  return found;
}

/**
 * Thresholds in effect on a date: the manual entry for that date, with FTP / run threshold
 * pace / CSS replaced by the rolling 6-month estimate where auto mode is on.
 */
export function thresholdsFor(date: string): Thresholds {
  const manual = manualThresholds(date);
  const base: Thresholds = { ...(manual ?? DEFAULT_THRESHOLDS) };
  const src = manual ? 'manual' : 'default';
  const sources: NonNullable<Thresholds['sources']> = { ftp: src, run: src, swim: src };
  const auto = getPreferences().autoThresholds;
  // if the athlete entered values themselves, use them before the first estimate exists
  const backfill = !manual;
  if (auto.ride) {
    const e = estimateAt('ride', date, backfill);
    if (e) {
      base.ftp = Math.round(e.threshold);
      if (e.wPrime >= 3000 && e.wPrime <= 60000) base.wPrime = Math.round(e.wPrime);
      sources.ftp = 'auto';
    }
  }
  if (auto.run) {
    const e = estimateAt('run', date, backfill);
    if (e) {
      base.runThresholdSpeed = e.threshold;
      sources.run = 'auto';
    }
  }
  if (auto.swim) {
    const e = estimateAt('swim', date, backfill);
    if (e) {
      base.swimCss = e.threshold;
      sources.swim = 'auto';
    }
  }
  return { ...base, sources };
}

export function upsertThresholds(t: Thresholds) {
  const { date, ...data } = t;
  q.run('INSERT INTO thresholds(date, data) VALUES(?, ?) ON CONFLICT(date) DO UPDATE SET data = excluded.data', date, JSON.stringify(data));
  thresholdCache = null;
}

export function deleteThresholds(date: string) {
  q.run('DELETE FROM thresholds WHERE date = ?', date);
  thresholdCache = null;
}

// ---------- activities ----------
export const ACTIVITY_LIST_COLUMNS = `id, source, external_id, name, sport, start_time, local_date, elapsed_time, moving_time, distance,
  elevation_gain, avg_power, max_power, np, intensity, tss, tss_method, tss_override, vi, ef, decoupling, work, calories, avg_hr,
  max_hr, avg_cadence, avg_speed, max_speed, trimp, avg_temp, wbal_min, has_power, has_hr, has_gps, trainer, commute, polyline,
  description, rpe, feel, device, detailed, ftp_used, zones, best_efforts, laps, planned_id`;

export function rowToActivity(r: Row): Activity {
  return {
    id: r.id,
    source: r.source,
    externalId: r.external_id,
    name: r.name,
    sport: r.sport,
    startTime: r.start_time,
    localDate: r.local_date,
    elapsedTime: r.elapsed_time,
    movingTime: r.moving_time,
    distance: r.distance,
    elevationGain: r.elevation_gain,
    avgPower: r.avg_power,
    maxPower: r.max_power,
    np: r.np,
    intensity: r.intensity,
    tss: r.tss_override ?? r.tss,
    tssMethod: r.tss_override != null ? 'manual' : r.tss_method,
    vi: r.vi,
    ef: r.ef,
    decoupling: r.decoupling,
    work: r.work,
    calories: r.calories,
    avgHr: r.avg_hr,
    maxHr: r.max_hr,
    avgCadence: r.avg_cadence,
    avgSpeed: r.avg_speed,
    maxSpeed: r.max_speed,
    trimp: r.trimp,
    avgTemp: r.avg_temp,
    wbalMin: r.wbal_min,
    hasPower: !!r.has_power,
    hasHr: !!r.has_hr,
    hasGps: !!r.has_gps,
    trainer: !!r.trainer,
    commute: !!r.commute,
    polyline: r.polyline,
    description: r.description,
    rpe: r.rpe,
    feel: r.feel,
    device: r.device,
    detailed: !!r.detailed,
    ftpUsed: r.ftp_used,
    zones: json(r.zones),
    bestEfforts: json(r.best_efforts),
    laps: json(r.laps),
    plannedId: r.planned_id,
  };
}

export function getActivity(id: number): Activity | null {
  const r = q.get(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities WHERE id = ?`, id);
  return r ? rowToActivity(r) : null;
}

export function getCurves(id: number): ActivityCurves | null {
  const r = q.get('SELECT curves FROM activities WHERE id = ?', id);
  return r ? json<ActivityCurves>(r.curves) : null;
}

export function saveStreams(activityId: number, streams: Streams) {
  const blob = gzipSync(Buffer.from(JSON.stringify(streams)));
  q.run('INSERT INTO streams(activity_id, data) VALUES(?, ?) ON CONFLICT(activity_id) DO UPDATE SET data = excluded.data', activityId, blob);
}

export function loadStreams(activityId: number): Streams | null {
  const r = q.get('SELECT data FROM streams WHERE activity_id = ?', activityId);
  if (!r) return null;
  return JSON.parse(gunzipSync(Buffer.from(r.data as Uint8Array)).toString('utf8'));
}

// ---------- planned workouts ----------
export function rowToPlanned(r: Row): PlannedWorkout {
  return {
    id: r.id,
    date: r.date,
    sport: r.sport,
    title: r.title,
    description: r.description,
    structure: json(r.structure),
    plannedDuration: r.planned_duration,
    plannedDistance: r.planned_distance,
    plannedTss: r.planned_tss,
    plannedIf: r.planned_if,
    activityId: r.activity_id,
    source: r.source,
    externalId: r.external_id,
    sortOrder: r.sort_order,
  };
}

export function rowToEvent(r: Row): RaceEvent {
  return {
    id: r.id,
    date: r.date,
    name: r.name,
    sport: r.sport,
    priority: r.priority,
    description: r.description,
    targetCtl: r.target_ctl,
  };
}

export function rowToTemplate(r: Row): WorkoutTemplate {
  return {
    id: r.id,
    name: r.name,
    sport: r.sport,
    category: r.category,
    description: r.description,
    structure: JSON.parse(r.structure),
    builtin: !!r.builtin_key,
  };
}

export function rowToPlan(r: Row): SeasonPlan {
  const cfg = JSON.parse(r.config);
  return {
    id: r.id,
    name: r.name,
    startDate: cfg.startDate,
    eventId: r.event_id,
    config: cfg,
    weeks: JSON.parse(r.weeks),
    createdAt: r.created_at,
  };
}

export function log(provider: string | null, level: 'info' | 'warn' | 'error', message: string) {
  q.run('INSERT INTO sync_log(provider, level, message) VALUES(?, ?, ?)', provider, level, message);
  q.run('DELETE FROM sync_log WHERE id < (SELECT MAX(id) - 500 FROM sync_log)');
  if (level !== 'info') console.warn(`[${provider ?? 'app'}] ${message}`);
}
