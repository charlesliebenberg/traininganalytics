import { hrOutputWindows, hrPowerWindows, type HrBins } from '../shared/analytics/hrprofile';
import { cleanRunSpeed, gradeAdjustedSpeed } from '../shared/analytics/running';
import { loadStreams, q } from './db';

/**
 * Steady-window output per heart-rate bin for one activity — power (W) for rides,
 * grade-adjusted speed (m/s, GPS glitches removed) for runs — computed from its streams once
 * and cached in hr_power (cleared when the streams are saved again).
 */
export function activityHrBins(id: number, sport: string, cached: string | null): HrBins {
  if (cached) return JSON.parse(cached);
  const s = loadStreams(id);
  let bins: HrBins = {};
  if (s?.heartrate) {
    if (sport === 'ride' && s.watts) bins = hrPowerWindows(s);
    else if (sport === 'run' && s.speed) {
      const speed = cleanRunSpeed(s.speed);
      const gap = s.grade ? gradeAdjustedSpeed(speed, s.grade) : speed;
      bins = hrOutputWindows(gap, s.heartrate, 1.5, 2);
    }
  }
  q.run('INSERT INTO hr_power(activity_id, data) VALUES(?, ?) ON CONFLICT(activity_id) DO UPDATE SET data = excluded.data', id, JSON.stringify(bins));
  return bins;
}
