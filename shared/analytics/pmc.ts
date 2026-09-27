import type { PmcPoint } from '../types';

export interface PmcOptions {
  ctlDays?: number;
  atlDays?: number;
  startCtl?: number;
  startAtl?: number;
}

/**
 * Performance Management Chart (Banister / Coggan).
 *   CTL (fitness) & ATL (fatigue) are exponentially-weighted averages of daily TSS.
 *   TSB (form) is yesterday's CTL − ATL, i.e. how fresh you are going into the day.
 * `days` must be consecutive calendar days.
 */
export function computePmc(
  days: { date: string; tss: number; projected?: boolean }[],
  opts: PmcOptions = {},
): PmcPoint[] {
  const { ctlDays = 42, atlDays = 7, startCtl = 0, startAtl = 0 } = opts;
  const kc = 1 - Math.exp(-1 / ctlDays);
  const ka = 1 - Math.exp(-1 / atlDays);
  let ctl = startCtl;
  let atl = startAtl;
  const out: PmcPoint[] = [];
  for (let i = 0; i < days.length; i++) {
    const tsb = ctl - atl;
    ctl += (days[i].tss - ctl) * kc;
    atl += (days[i].tss - atl) * ka;
    const ramp = i >= 7 ? ctl - out[i - 7].ctl : 0;
    out.push({ date: days[i].date, tss: days[i].tss, ctl, atl, tsb, ramp, projected: !!days[i].projected });
  }
  return out;
}

export type FormZone = 'transition' | 'fresh' | 'neutral' | 'optimal' | 'overload';

export const FORM_ZONES: { id: FormZone; label: string; min: number; max: number; hint: string }[] = [
  { id: 'transition', label: 'Transition', min: 0.25, max: Infinity, hint: 'Very fresh — fitness is being lost' },
  { id: 'fresh', label: 'Fresh', min: 0.05, max: 0.25, hint: 'Race-ready form' },
  { id: 'neutral', label: 'Grey zone', min: -0.1, max: 0.05, hint: 'Maintaining, low stimulus' },
  { id: 'optimal', label: 'Optimal training', min: -0.3, max: -0.1, hint: 'Productive overload' },
  { id: 'overload', label: 'High risk', min: -Infinity, max: -0.3, hint: 'Excessive fatigue — back off' },
];

/** Classify form using TSB relative to fitness (TSB / CTL), which scales with the athlete. */
export function formZone(tsb: number, ctl: number): (typeof FORM_ZONES)[number] {
  const rel = ctl > 5 ? tsb / ctl : tsb / 30;
  return FORM_ZONES.find((z) => rel >= z.min && rel < z.max) ?? FORM_ZONES[2];
}

/** Foster's training monotony & strain over rolling 7-day windows. */
export function monotonyStrain(dailyTss: number[]): { monotony: number | null; strain: number | null; weekly: number }[] {
  return dailyTss.map((_, i) => {
    if (i < 6) return { monotony: null, strain: null, weekly: 0 };
    const w = dailyTss.slice(i - 6, i + 1);
    const total = w.reduce((a, b) => a + b, 0);
    const m = total / 7;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 7);
    const monotony = sd > 0 ? m / sd : null;
    return { monotony, strain: monotony != null ? total * monotony : null, weekly: total };
  });
}

/**
 * Daily TSS required to move CTL from `from` to `to` in `days` days at constant load.
 */
export function dailyTssForCtl(from: number, to: number, days: number, ctlDays = 42): number {
  const a = Math.exp(-days / ctlDays);
  return Math.max(0, (to - from * a) / (1 - a));
}

/** Acute:chronic workload ratio (ATL/CTL). */
export function acwr(atl: number, ctl: number): number | null {
  return ctl > 1 ? atl / ctl : null;
}
