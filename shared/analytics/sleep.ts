/**
 * Sleep and recovery next to training: each night's heart-rate variability, heart rate and
 * sleep (from a bed sensor) against the athlete's own normal, what that means for today's
 * training, and how training shows up in the night after it.
 *
 * Nights are read the way HRV-guided training reads them (Plews et al. 2012; Javaloyes et al.
 * 2019): HRV on a log scale, as a 7-night rolling average — single nights are noisy — against
 * a normal range from the 60 days before: the mean ± half a standard deviation of the nightly
 * values, the smallest change that matters. Below the range, recovery is behind: keep it
 * easy. Within it or above, train as planned. Heart rate asleep is read the same way in bpm,
 * where a rise of a whole standard deviation counts.
 */
import type { SleepNight } from '../types';

export const NORMAL_DAYS = 60;
export const ROLLING_DAYS = 7;
/** nights needed in the 60 days before a normal range is drawn */
export const MIN_NORMAL = 14;
/** the HRV range: half a standard deviation each side */
export const HRV_BAND = 0.5;
/** heart rate asleep: a standard deviation */
export const HR_BAND = 1;

const DAY = 86400000;
const dayNum = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY);
/** The day before a date (yyyy-mm-dd). */
export const dayBefore = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) - DAY).toISOString().slice(0, 10);

export interface Normal {
  mean: number;
  sd: number;
  n: number;
}

function normalOf(xs: number[]): Normal | null {
  if (xs.length < MIN_NORMAL) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
  return { mean, sd, n: xs.length };
}

const median = (xs: number[]) => {
  const y = [...xs].sort((a, b) => a - b);
  const m = y.length >> 1;
  return y.length % 2 ? y[m] : (y[m - 1] + y[m]) / 2;
};

/** HRV on a log scale: it's skewed, and changes in it are relative. */
export const lnHrv = (n: SleepNight) => (n.hrv && n.hrv > 0 ? Math.log(n.hrv) : null);
export const sleepingHr = (n: SleepNight) => (n.hr && n.hr > 0 ? n.hr : null);

export interface Reading {
  date: string;
  value: number;
  /** average of the nights in the 7 days to this one */
  rolling: number;
  /** the nights of the 60 days before it */
  normal: Normal | null;
}

/**
 * Each night's reading of a measure against the athlete's normal: its value, the 7-night
 * rolling average, and the normal from the 60 days before — what was known that morning. Looking
 * back instead (`around`), the normal is the nights a month either side, so a trend in fitness
 * doesn't tilt every night the same way. Nights without the measure are skipped.
 */
export function readings(nights: SleepNight[], measure: (n: SleepNight) => number | null, opts: { around?: boolean } = {}): Reading[] {
  const pts = nights
    .map((n) => ({ date: n.date, d: dayNum(n.date), v: measure(n) }))
    .filter((p): p is { date: string; d: number; v: number } => p.v != null && Number.isFinite(p.v))
    .sort((a, b) => a.d - b.d);
  const out: Reading[] = [];
  const reach = opts.around ? NORMAL_DAYS / 2 : NORMAL_DAYS;
  let lo = 0;
  let hi = 0;
  let wk = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    while (pts[lo].d < p.d - reach) lo++;
    while (hi < pts.length && pts[hi].d <= p.d + reach) hi++;
    while (pts[wk].d <= p.d - ROLLING_DAYS) wk++;
    const week = pts.slice(wk, i + 1);
    const pool = opts.around ? [...pts.slice(lo, i), ...pts.slice(i + 1, hi)] : pts.slice(lo, i);
    out.push({ date: p.date, value: p.v, rolling: week.reduce((s, x) => s + x.v, 0) / week.length, normal: normalOf(pool.map((x) => x.v)) });
  }
  return out;
}

export type Status = 'low' | 'normal' | 'high';

/** Where a reading's 7-night average sits against its normal range, `band` standard deviations each side. */
export function status(r: Reading, band: number): Status | null {
  if (!r.normal) return null;
  if (r.rolling < r.normal.mean - band * r.normal.sd) return 'low';
  return r.rolling > r.normal.mean + band * r.normal.sd ? 'high' : 'normal';
}

/** A reading as a change on its normal: HRV relative (0.08 = 8 % above), heart rate in bpm. */
export const hrvVsNormal = (r: Reading | undefined, of: 'value' | 'rolling' = 'value') => (r?.normal ? Math.exp(r[of] - r.normal.mean) - 1 : null);
export const hrVsNormal = (r: Reading | undefined, of: 'value' | 'rolling' = 'value') => (r?.normal ? r[of] - r.normal.mean : null);

export interface SleepRead {
  night: SleepNight;
  hrv: {
    value: number;
    /** last night and the 7-night average, against the normal */
    vsNormal: number | null;
    rollingVsNormal: number | null;
    status: Status | null;
    /** the normal range, ms */
    range: [number, number] | null;
  } | null;
  hr: { value: number; vsNormal: number | null; rollingVsNormal: number | null; status: Status | null } | null;
  /** time asleep, and the median of the 60 nights before */
  asleep: { value: number; typical: number | null } | null;
  /** from the 7-night HRV and heart rate against normal: train as planned, or keep it easy */
  call: 'train' | 'easy' | null;
  /** nights in the 60 days before (a normal range needs MIN_NORMAL) */
  history: number;
}

/** A night (the latest, or the one woken up on `date`) against the athlete's normal. */
export function readNight(nights: SleepNight[], date?: string): SleepRead | null {
  const sorted = [...nights].filter((n) => !date || n.date <= date).sort((a, b) => a.date.localeCompare(b.date));
  const night = sorted[sorted.length - 1];
  if (!night || (date && night.date !== date)) return null;
  const h = readings(sorted, lnHrv).pop();
  const r = readings(sorted, sleepingHr).pop();
  const hrv = h && h.date === night.date ? h : undefined;
  const hr = r && r.date === night.date ? r : undefined;
  const hrvStatus = hrv ? status(hrv, HRV_BAND) : null;
  const hrStatus = hr ? status(hr, HR_BAND) : null;
  const since = dayNum(night.date) - NORMAL_DAYS;
  const before = sorted.slice(0, -1).filter((n) => dayNum(n.date) >= since);
  const slept = before.map((n) => n.asleep).filter((x): x is number => x != null);
  return {
    night,
    hrv: hrv
      ? {
          value: night.hrv!,
          vsNormal: hrvVsNormal(hrv),
          rollingVsNormal: hrvVsNormal(hrv, 'rolling'),
          status: hrvStatus,
          range: hrv.normal ? [Math.exp(hrv.normal.mean - HRV_BAND * hrv.normal.sd), Math.exp(hrv.normal.mean + HRV_BAND * hrv.normal.sd)] : null,
        }
      : null,
    hr: hr ? { value: night.hr!, vsNormal: hrVsNormal(hr), rollingVsNormal: hrVsNormal(hr, 'rolling'), status: hrStatus } : null,
    asleep: night.asleep != null ? { value: night.asleep, typical: slept.length >= MIN_NORMAL ? median(slept) : null } : null,
    call: hrvStatus == null && hrStatus == null ? null : hrvStatus === 'low' || hrStatus === 'high' ? 'easy' : 'train',
    history: before.length,
  };
}

/** A change in %, signed: "+4%", "−8%", "0%". */
export const signedPct = (x: number) => {
  const r = Math.round(x * 100);
  return r === 0 ? '0%' : `${r > 0 ? '+' : '−'}${Math.abs(r)}%`;
};
const pct = signedPct;
const hours = (s: number) => `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`;

/** What last night means for today's training, with the form (TSB) the training has left you in. */
export function sleepAdvice(read: SleepRead, tsb: number | null): { title: string; detail: string; tone: 'good' | 'neutral' | 'warning' } {
  const { hrv, hr, asleep } = read;
  const short = asleep?.typical != null && asleep.value < asleep.typical - 3600 ? ` You slept ${hours(asleep.value)}, ${hours(asleep.typical - asleep.value)} less than usual.` : '';
  const form = tsb != null ? Math.round(tsb) : null;
  if (!read.call) {
    return {
      title: 'Learning your normal',
      detail: `A normal range for HRV and heart rate needs ${MIN_NORMAL} nights in the last ${NORMAL_DAYS} days; there are ${read.history} so far.${short}`,
      tone: 'neutral',
    };
  }
  if (read.call === 'easy') {
    const why = [
      hrv?.status === 'low' && hrv.rollingVsNormal != null ? `your HRV over the last week is below your normal range (${pct(hrv.rollingVsNormal)})` : null,
      hr?.status === 'high' && hr.rollingVsNormal != null ? `your heart rate asleep over the last week is up ${Math.round(hr.rollingVsNormal * 10) / 10} bpm on your normal` : null,
    ]
      .filter(Boolean)
      .join(' and ');
    const because = why.charAt(0).toUpperCase() + why.slice(1);
    return form != null && form <= -20
      ? { title: 'Recovery is behind the training', detail: `${because}, with form at ${form}: the load is catching up with you. Keep today easy, or rest.${short}`, tone: 'warning' }
      : {
          title: 'Keep it easy today',
          detail: `${because}${form != null ? `, though training hasn't been heavy (form ${form})` : ''}: something besides training — short sleep, illness, stress, alcohol, heat, travel — may be costing you recovery.${short}`,
          tone: 'warning',
        };
  }
  if (form != null && form <= -20)
    return { title: 'Absorbing the load', detail: `Form is ${form}, but your HRV is holding in its normal range: you're absorbing the training. Train as planned.${short}`, tone: 'good' };
  if (form != null && form >= -10)
    return { title: 'Ready to go', detail: `Your HRV is in its normal range${hrv?.status === 'high' ? ' or above' : ''} and you're fresh (form ${form}): a good day for a hard session.${short}`, tone: 'good' };
  return { title: 'Train as planned', detail: `Your HRV and heart rate asleep are within your normal range.${short}`, tone: 'good' };
}

export const LOAD_BUCKETS = [
  { key: 'rest', label: 'Rest day', max: 0 },
  { key: 'easy', label: 'Up to 60 TSS', max: 60 },
  { key: 'moderate', label: '60–120 TSS', max: 120 },
  { key: 'hard', label: '120–180 TSS', max: 180 },
  { key: 'big', label: 'Over 180 TSS', max: Infinity },
] as const;

export interface MorningAfter {
  key: (typeof LOAD_BUCKETS)[number]['key'];
  label: string;
  nights: number;
  /** medians: HRV against the normal of the time (relative), heart rate asleep against it (bpm), sleep score, seconds asleep */
  hrv: number | null;
  hr: number | null;
  score: number | null;
  asleep: number | null;
}

/**
 * How a day's training shows in the night after it: nights grouped by the training load of
 * the day before (`loadOn`, all sports; null where the training history doesn't reach), with
 * each group's median HRV and heart rate against the nights around it, sleep score and time
 * asleep. A group needs 3 nights to say anything.
 */
export function morningAfter(nights: SleepNight[], loadOn: (date: string) => number | null): MorningAfter[] {
  const hrv = new Map(readings(nights, lnHrv, { around: true }).map((r) => [r.date, r]));
  const hr = new Map(readings(nights, sleepingHr, { around: true }).map((r) => [r.date, r]));
  const groups = LOAD_BUCKETS.map((b) => ({ ...b, rows: [] as SleepNight[] }));
  for (const n of nights) {
    const load = loadOn(dayBefore(n.date));
    if (load != null) groups.find((g) => load <= g.max)!.rows.push(n);
  }
  const med = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null);
    return v.length >= 3 ? median(v) : null;
  };
  return groups.map((g) => ({
    key: g.key,
    label: g.label,
    nights: g.rows.length,
    hrv: med(g.rows.map((n) => hrvVsNormal(hrv.get(n.date)))),
    hr: med(g.rows.map((n) => hrVsNormal(hr.get(n.date)))),
    score: med(g.rows.map((n) => n.score)),
    asleep: med(g.rows.map((n) => n.asleep)),
  }));
}
