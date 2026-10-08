import type { CapacityFit, CapacityValidation } from '../../../shared/analytics/capacity';
import type { HrComparison, HrProfilePoint } from '../../../shared/analytics/hrprofile';
import type { EffortPoint } from '../../../shared/analytics/thresholds';
import type { SeasonWeek } from '../../../shared/types';
import type { Gap } from '../../lib/timeline';
import { fmtDate } from '../../lib/format';

export interface PeakCard {
  date: string;
  ftp: number | null;
  wkg: number | null;
  cp: number | null;
  ctl: number | null;
  p5: number | null;
  p20: number | null;
  p60: number | null;
  durable20: number | null;
  efforts: EffortPoint[];
  windowFrom: string;
  windowTo: string;
  /** modelled 20-min capacity at the peak */
  capacity: number | null;
  /** how far the best efforts around the peak went above capacity (0.11 = +11 %) */
  margin: number | null;
  /** best 20 min from 8 weeks before to 4 weeks after the peak */
  best20: number | null;
  rank?: number;
  pinned?: boolean;
  label?: string;
}

export interface CapacityInfo {
  tau: number;
  a: number;
  b: number;
  quantile: number;
  validation: CapacityValidation | null;
  ltlRange: [number, number];
  observations: number;
  fits: (CapacityFit & { ltlNow: number })[];
}

export interface Now {
  date: string;
  ftp: number | null;
  rawFtp: number | null;
  wkg: number | null;
  ctl: number | null;
  atl: number | null;
  /** best 20-min power in the last 90 days */
  best20: number | null;
  /** average of the last 6 weeks */
  weeklyTss: number;
  weeklyHours: number;
  ltl: number | null;
  capacity: number | null;
}

export interface Overview {
  peaks: PeakCard[];
  pins: { date: string; label: string }[];
  now: Now;
  capacity: CapacityInfo | null;
  comeback: { start: string; breakDays: number } | null;
  ridingMonths: number;
}

export interface StoryWeek {
  week: string;
  hours: number;
  tss: number;
  best: number | null;
  capacity: number | null;
  ltl: number | null;
}
export interface Story {
  weeks: StoryWeek[];
  gaps: Gap[];
  eras: { from: string; to: string; hoursPerWeek: number; best20: number | null }[];
}

export interface MonthRow {
  month: string;
  weeks: number;
  hoursPerWeek: number;
  tssPerWeek: number;
  /** hours per week: Z1–2, Z3, Z4, Z5+, no power */
  zones: [number, number, number, number, number];
  races: number;
  longRides: number;
}
export interface Months {
  then: MonthRow[];
  now: MonthRow[];
  comebackStart: string | null;
}

export interface HrCompareResponse {
  then: HrProfilePoint[];
  now: HrProfilePoint[];
  comparison: HrComparison;
  thenRange: [string, string];
  nowRange: [string, string];
  outdoorOnly: boolean;
  thenRides: number;
  nowRides: number;
  /** then vs now on the aerobic model (heat-, fatigue- and indoor-adjusted) */
  aerobic: { refHr: number; then: { value: number; lo: number; hi: number }; now: { value: number; lo: number; hi: number }; thenDate: string; ratio: number; sd: number } | null;
}

export interface PreviewWeek extends SeasonWeek {
  capacity: number | null;
  low: number | null;
  high: number | null;
}
export interface Preview {
  config: Record<string, unknown>;
  weeks: PreviewWeek[];
  reached: boolean;
  arrival: string | null;
  arrivalRange: [string, string] | null;
  neverFor: number;
  gentle: boolean;
  ridingMonths: number;
  startCtl: number;
  holdHours: number;
}

export const peakName = (p: PeakCard) => p.label ?? fmtDate(p.date, 'MMM yyyy');

/** "2 yr", "9 mo" for a time constant in days */
export const tauText = (days: number) => (days >= 365 ? `${Math.round((days / 365) * 10) / 10} yr` : `${Math.round(days / 30.4)} mo`);

/** Summary of a run of months: per-week averages weighted by the weeks each month covers. */
export function monthSummary(rows: MonthRow[]) {
  const w = rows.reduce((s, r) => s + r.weeks, 0) || 1;
  const avg = (f: (r: MonthRow) => number) => rows.reduce((s, r) => s + f(r) * r.weeks, 0) / w;
  const hours = avg((r) => r.hoursPerWeek);
  const zoned = avg((r) => r.zones[0] + r.zones[1] + r.zones[2] + r.zones[3]) || 1;
  return {
    weeks: w,
    hours,
    tss: avg((r) => r.tssPerWeek),
    z4plus: avg((r) => r.zones[2] + r.zones[3]),
    z3share: avg((r) => r.zones[1]) / zoned,
    z5share: avg((r) => r.zones[3]) / zoned,
    racesPerMonth: rows.reduce((s, r) => s + r.races, 0) / (w / 4.345),
    longRidesPerWeek: rows.reduce((s, r) => s + r.longRides, 0) / w,
  };
}
export type MonthSummary = ReturnType<typeof monthSummary>;
