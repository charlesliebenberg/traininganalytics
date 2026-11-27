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

export const formZoneById = (id: FormZone) => FORM_ZONES.find((z) => z.id === id) ?? FORM_ZONES[2];

/** Classify form using TSB relative to fitness (TSB / CTL), which scales with the athlete. */
export function formZone(tsb: number, ctl: number): (typeof FORM_ZONES)[number] {
  const rel = ctl > 5 ? tsb / ctl : tsb / 30;
  return FORM_ZONES.find((z) => rel >= z.min && rel < z.max) ?? FORM_ZONES[2];
}

/** How fresh you were for a day's riding: its TSB, from before that day's own load, and the zone. */
export interface DayForm {
  tsb: number;
  zone: FormZone;
}

/** A PMC day's form, as the PMC chart shows it. */
export function dayForm(p: PmcPoint): DayForm {
  return { tsb: Math.round(p.tsb * 10) / 10, zone: formZone(p.tsb, p.ctl).id };
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

/**
 * What to ride on the days with nothing planned before a race, so race-day form lands in the
 * fresh range rather than wherever an unfinished plan leaves it. `days` runs from tomorrow to
 * race day: each day's planned load, and whether it is free (in a stretch with nothing planned).
 * Free days get one daily load, halved in the race's last `taperDays`; it is solved so form on
 * race morning (TSB, from the day before) is `target` × fitness. Race-day CTL includes the
 * race's own planned load, as the PMC shows it.
 */
export function fillForRace(o: {
  ctl: number;
  atl: number;
  days: { date: string; planned: number; free: boolean }[];
  ctlDays?: number;
  atlDays?: number;
  /** TSB as a fraction of CTL on race morning: 0.12 is the middle of "fresh" */
  target?: number;
  taperDays?: number;
}): { daily: number; ctl: number; tsb: number; load: number[] } | null {
  const { ctlDays = 42, atlDays = 7, target = 0.12, taperDays = 7 } = o;
  const n = o.days.length;
  if (!n || !o.days.some((d) => d.free)) return null;
  const kc = 1 - Math.exp(-1 / ctlDays);
  const ka = 1 - Math.exp(-1 / atlDays);
  const loadFor = (daily: number) => o.days.map((d, i) => d.planned + (d.free && i < n - 1 ? daily * (i >= n - 1 - taperDays ? 0.5 : 1) : 0));
  const run = (daily: number) => {
    const load = loadFor(daily);
    let ctl = o.ctl;
    let atl = o.atl;
    let tsb = 0;
    for (let i = 0; i < n; i++) {
      if (i === n - 1) tsb = ctl - atl;
      ctl += (load[i] - ctl) * kc;
      atl += (load[i] - atl) * ka;
    }
    return { ctl, tsb, load };
  };
  const rel = (r: { ctl: number; tsb: number }) => r.tsb / Math.max(r.ctl, 1);
  // form falls as load rises: bisect for the load that meets the target
  let lo = 0;
  let hi = 400;
  if (rel(run(lo)) <= target) return { daily: 0, ...run(0) };
  if (rel(run(hi)) > target) return { daily: hi, ...run(hi) };
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (rel(run(mid)) > target) lo = mid;
    else hi = mid;
  }
  return { daily: hi, ...run(hi) };
}
