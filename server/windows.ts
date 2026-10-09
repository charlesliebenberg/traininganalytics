import type { Streams } from '../shared/types';
import { binsFromWindows, kineticBins, KINETIC_TAU, steadyWindows, WINDOW_SPECS, type AerobicSport, type KineticBin, type SteadyWindow } from '../shared/analytics/aerobic';
import type { HrBins } from '../shared/analytics/hrprofile';
import { resample1Hz } from '../shared/analytics/series';
import { cleanRunSpeed, gradeAdjustedSpeed } from '../shared/analytics/running';
import { usableTemp } from '../shared/analytics/metrics';
import { loadStreams, q, thresholdsFor } from './db';

/** Activities that can be read for aerobic fitness: rides with power, runs, both with heart rate. */
export const WINDOW_ACTIVITIES = "a.has_hr = 1 AND a.detailed = 1 AND ((a.sport = 'ride' AND a.has_power = 1) OR a.sport = 'run')";

/** Bump when readings are computed differently, so cached ones are rebuilt. 2: stuck temperature sensors ignored. */
const READINGS_VERSION = 2;

export interface ActivityReadings {
  /** steady stretches */
  windows: SteadyWindow[];
  /** the whole activity, heart rate against lag-smoothed output (see kineticBins) */
  kinetic: KineticBin[];
}

/**
 * Both readings from an activity's streams: power for rides, grade-adjusted speed (GPS
 * glitches out) for runs. The whole-activity reading keeps to aerobic output and heart rate
 * relative to the thresholds of the day.
 */
export function computeReadings(s: Streams | null, sport: string, date: string): ActivityReadings {
  const none = { windows: [], kinetic: [] };
  if (!s?.heartrate || s.time.length < 2 || (sport !== 'ride' && sport !== 'run')) return none;
  const n = s.time[s.time.length - 1] + 1;
  let out: number[] | null = null;
  if (sport === 'ride' && s.watts) out = resample1Hz(s.time, s.watts, n, { gapValue: 0 }).map((v) => v ?? 0);
  else if (sport === 'run' && s.speed) {
    const speed = cleanRunSpeed(s.speed);
    out = resample1Hz(s.time, s.grade ? gradeAdjustedSpeed(speed, s.grade) : speed, n, { gapValue: 0 }).map((v) => v ?? 0);
  }
  if (!out) return none;
  const hr = resample1Hz(s.time, s.heartrate, n, { hold: true });
  const temp = usableTemp(s.temp) ? resample1Hz(s.time, s.temp!, n, { hold: true }) : null;
  const th = thresholdsFor(date);
  const sp = sport as AerobicSport;
  const lthr = sp === 'ride' ? th.lthr : th.runLthr || th.lthr;
  const thr = sp === 'ride' ? th.ftp : th.runThresholdSpeed;
  return {
    windows: steadyWindows(out, hr, temp, WINDOW_SPECS[sp]),
    kinetic: thr > 0 && lthr > 0 ? kineticBins(out, hr, temp, { tau: KINETIC_TAU[sp], skip: WINDOW_SPECS[sp].skip, bin: sp === 'ride' ? 10 : 0.05, out: sp === 'ride' ? [0.4 * thr, 1.1 * thr] : [0.55 * thr, 1.15 * thr], hr: [0.55 * lthr, 0.92 * lthr] }) : [],
  };
}

/** An activity's readings, computed from its streams once and cached (cleared when the streams are saved again). */
export function activityReadings(id: number, sport: string, date: string, cached: string | null): ActivityReadings {
  if (cached) {
    const c = JSON.parse(cached);
    if (c.v === READINGS_VERSION) return c;
  }
  const r = computeReadings(loadStreams(id), sport, date);
  q.run('INSERT INTO steady_windows(activity_id, data) VALUES(?, ?) ON CONFLICT(activity_id) DO UPDATE SET data = excluded.data', id, JSON.stringify({ v: READINGS_VERSION, ...r }));
  return r;
}

/** Steady-stretch output per heart-rate bin (the comeback's heart-rate profile). */
export function activityHrBins(id: number, sport: string, date: string, cached: string | null): HrBins {
  return binsFromWindows(activityReadings(id, sport, date, cached).windows);
}

/** Fill the cache for activities that don't have it yet (or have an older form), yielding between batches. */
export async function warmWindows(): Promise<number> {
  const rows = q.all(`SELECT a.id, a.sport, a.local_date FROM activities a LEFT JOIN steady_windows w ON w.activity_id = a.id WHERE (w.activity_id IS NULL OR w.data NOT LIKE '{"v":${READINGS_VERSION},%') AND ${WINDOW_ACTIVITIES}`);
  for (let i = 0; i < rows.length; i++) {
    activityReadings(rows[i].id as number, rows[i].sport as string, rows[i].local_date as string, null);
    if (i % 10 === 9) await new Promise((r) => setImmediate(r));
  }
  return rows.length;
}
