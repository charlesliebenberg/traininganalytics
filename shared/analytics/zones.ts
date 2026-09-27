import type { Series } from './series';

export interface ZoneDef {
  id: string;
  name: string;
  /** Upper bound as a fraction of threshold (exclusive). Last zone uses Infinity. */
  max: number;
}

/** Coggan 7-zone power model, fraction of FTP. */
export const POWER_ZONES: ZoneDef[] = [
  { id: 'Z1', name: 'Active Recovery', max: 0.55 },
  { id: 'Z2', name: 'Endurance', max: 0.75 },
  { id: 'Z3', name: 'Tempo', max: 0.9 },
  { id: 'Z4', name: 'Threshold', max: 1.05 },
  { id: 'Z5', name: 'VO2max', max: 1.2 },
  { id: 'Z6', name: 'Anaerobic', max: 1.5 },
  { id: 'Z7', name: 'Neuromuscular', max: Infinity },
];

/** Friel heart-rate zones, fraction of LTHR. */
export const HR_ZONES: ZoneDef[] = [
  { id: 'Z1', name: 'Recovery', max: 0.81 },
  { id: 'Z2', name: 'Aerobic', max: 0.9 },
  { id: 'Z3', name: 'Tempo', max: 0.94 },
  { id: 'Z4', name: 'Sub-threshold', max: 1.0 },
  { id: 'Z5a', name: 'Super-threshold', max: 1.03 },
  { id: 'Z5b', name: 'Aerobic capacity', max: 1.06 },
  { id: 'Z5c', name: 'Anaerobic capacity', max: Infinity },
];

/** Run pace zones, fraction of threshold speed. */
export const PACE_ZONES: ZoneDef[] = [
  { id: 'Z1', name: 'Recovery', max: 0.78 },
  { id: 'Z2', name: 'Endurance', max: 0.88 },
  { id: 'Z3', name: 'Tempo', max: 0.95 },
  { id: 'Z4', name: 'Threshold', max: 1.01 },
  { id: 'Z5', name: 'VO2max', max: 1.07 },
  { id: 'Z6', name: 'Anaerobic', max: Infinity },
];

/** Seiler 3-zone model (below LT1 / between thresholds / above LT2). */
export const SEILER_ZONES: ZoneDef[] = [
  { id: 'Z1', name: 'Low (< LT1)', max: 0.8 },
  { id: 'Z2', name: 'Moderate', max: 1.0 },
  { id: 'Z3', name: 'High (> LT2)', max: Infinity },
];
/** HR fractions of LTHR for the 3-zone model. */
export const SEILER_HR_BOUNDS = [0.88, 1.0];

export function zoneIndex(fraction: number, zones: ZoneDef[]): number {
  for (let i = 0; i < zones.length; i++) if (fraction < zones[i].max) return i;
  return zones.length - 1;
}

/** Seconds spent in each zone. Samples where mask is 0 or value is null are ignored. */
export function timeInZones(
  values: Series,
  threshold: number,
  zones: ZoneDef[] | number[],
  mask?: ArrayLike<number> | null,
): number[] {
  const bounds = (zones as (ZoneDef | number)[]).map((z) => (typeof z === 'number' ? z : z.max));
  const nZones = typeof zones[0] === 'number' ? bounds.length + 1 : bounds.length;
  const out = new Array(nZones).fill(0);
  if (!threshold) return out;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null || Number.isNaN(v)) continue;
    if (mask && !mask[i]) continue;
    const f = v / threshold;
    let z = 0;
    while (z < bounds.length && f >= bounds[z]) z++;
    out[Math.min(z, nZones - 1)]++;
  }
  return out;
}

/**
 * Polarization index (Treff et al. 2019). > 2.0 indicates a polarized distribution.
 * Returns null when the index is undefined (no high or moderate intensity work).
 */
export function polarizationIndex(z: number[]): number | null {
  const total = z[0] + z[1] + z[2];
  if (!total) return null;
  const f1 = z[0] / total;
  const f2 = z[1] / total;
  const f3 = z[2] / total;
  if (f3 <= 0 || f2 <= 0 || f1 <= 0) return null;
  const pi = Math.log10((f1 / f2) * f3 * 100);
  return Number.isFinite(pi) ? pi : null;
}

export function zoneBounds(threshold: number, zones: ZoneDef[]): { id: string; name: string; low: number; high: number }[] {
  let lo = 0;
  return zones.map((z) => {
    const r = { id: z.id, name: z.name, low: lo * threshold, high: z.max * threshold };
    lo = z.max;
    return r;
  });
}
