import { HR_BAND, HRV_BAND, lnHrv, morningAfter, readNight, readings, sleepingHr } from '../shared/analytics/sleep';
import { listNights } from './db';
import { dailyLoads, firstActivityDate, today } from './aggregate';

/**
 * Nights between two dates with their 7-night averages and normal ranges (HRV in ms, heart
 * rate in bpm) and the day's training load, plus how each kind of training day shows in the
 * night after it, over the whole history.
 */
export function sleepTrend(from: string, to: string) {
  const nights = listNights();
  const hrv = new Map(readings(nights, lnHrv).map((r) => [r.date, r]));
  const hr = new Map(readings(nights, sleepingHr).map((r) => [r.date, r]));
  const first = firstActivityDate();
  const t = today();
  const loads = new Map(first ? dailyLoads(first, t).map((l) => [l.date, l.tss]) : []);
  // a day's training load, where the training history reaches it
  const loadOn = (d: string) => (first && d >= first && d <= t ? (loads.get(d) ?? 0) : null);
  return {
    nights: nights
      .filter((n) => n.date >= from && n.date <= to)
      .map((n) => {
        const a = hrv.get(n.date);
        const b = hr.get(n.date);
        return {
          ...n,
          hrvRolling: a ? Math.round(Math.exp(a.rolling) * 10) / 10 : null,
          hrvRange: a?.normal ? [Math.exp(a.normal.mean - HRV_BAND * a.normal.sd), Math.exp(a.normal.mean + HRV_BAND * a.normal.sd)].map((x) => Math.round(x * 10) / 10) : null,
          hrRolling: b ? Math.round(b.rolling * 10) / 10 : null,
          hrRange: b?.normal ? [b.normal.mean - HR_BAND * b.normal.sd, b.normal.mean + HR_BAND * b.normal.sd].map((x) => Math.round(x * 10) / 10) : null,
          /** training load the day you woke up */
          load: loadOn(n.date),
        };
      }),
    morningAfter: morningAfter(nights, loadOn),
  };
}

/** The night before a day's training (the one woken up from that day) against the athlete's normal. */
export const nightBefore = (date: string) => readNight(listNights('0000-01-01', date), date);
