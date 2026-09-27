import type { Lap, Streams } from '../types';
import { normalizedPowerRange } from './power';
import { maxDefined, meanDefined, rollingMean, toFloat } from './series';
import { elevationGain } from './metrics';

/** Stats for a sub-range [start, end) of an activity (laps, intervals, selections). */
export function rangeStats(s: Streams, start: number, end: number, rolling30?: Float64Array): Lap {
  const w = s.watts;
  const r30 = rolling30 ?? (w ? rollingMean(toFloat(w), 30) : undefined);
  const dist = s.distance;
  const d0 = dist?.[start] ?? null;
  const d1 = dist?.[Math.max(start, end - 1)] ?? null;
  const distance = d0 != null && d1 != null ? d1 - d0 : null;
  const duration = end - start;
  return {
    name: '',
    start,
    duration,
    distance,
    avgPower: w ? meanDefined(w, null, start, end) : null,
    np: w && r30 && duration >= 30 ? normalizedPowerRange(r30, start, end) : null,
    avgHr: s.heartrate ? meanDefined(s.heartrate, null, start, end) : null,
    maxHr: s.heartrate ? maxDefined(s.heartrate, start, end) : null,
    avgCadence: s.cadence ? meanDefined(s.cadence.slice(start, end).map((c) => (c && c > 0 ? c : null))) : null,
    avgSpeed: distance != null && duration ? distance / duration : null,
    elevationGain: s.altitude ? elevationGain(s.altitude.slice(start, end)) : null,
  };
}
