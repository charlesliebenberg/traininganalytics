/**
 * The headline findings of the Comeback page, worked out from the data so the page can lead
 * with them: how big the gap is, whether the aerobic engine is back, why (long-term load),
 * and how long the way back is at the current load — plus what to change.
 */
import { addDays, format } from 'date-fns';
import { daysToTarget, ltlFor } from '../../../shared/analytics/capacity';
import { fmtDate } from '../../lib/format';
import { monthSummary, peakName, tauText, type HrCompareResponse, type Months, type Overview, type PeakCard } from './types';

export interface Finding {
  key: 'gap' | 'engine' | 'load' | 'way';
  label: string;
  value: string;
  caption: string;
  detail: string;
  tone: 'good' | 'neutral' | 'warning';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r10 = (x: number) => Math.round(x / 10) * 10;
const monthsText = (days: number) => Math.max(1, Math.round(days / 30.4));

/** "Apr – Aug 2027" or "Aug 2027" */
function dateSpan(a: Date, b: Date): string {
  const fa = format(a, 'MMM yyyy');
  const fb = format(b, 'MMM yyyy');
  if (fa === fb) return fa;
  return a.getFullYear() === b.getFullYear() ? `${format(a, 'MMM')} – ${fb}` : `${fa} – ${fb}`;
}

/** When capacity reaches the peak's level at a steady weekly load, across the plausible models. */
export function wayBack(o: Overview, peak: PeakCard, weeklyTss: number) {
  const cap = o.capacity;
  if (!cap || peak.capacity == null) return null;
  const target = peak.capacity;
  const fits = cap.fits.filter((f) => f.plausible);
  const days = fits.map((f) => daysToTarget(f, f.tau, f.ltlNow, weeklyTss / 7, target));
  const finite = days.filter((d) => Number.isFinite(d));
  // the capacity this load levels off at, and the least load that gets there eventually
  const plateau = Math.min(...fits.map((f) => f.a + (f.b * weeklyTss) / 7));
  const minWeekly = Math.max(...fits.map((f) => ltlFor(f, target) * 7));
  return {
    target,
    days,
    reachable: finite.length === days.length && days.length > 0,
    soonest: finite.length ? Math.min(...finite) : null,
    latest: finite.length ? Math.max(...finite) : null,
    plateau,
    minWeekly,
  };
}

export function findings(o: Overview, peak: PeakCard, hr: HrCompareResponse | undefined, months: Months | undefined): { items: Finding[]; advice: string[] } {
  const name = peakName(peak);
  const now = o.now;
  const items: Finding[] = [];

  // 1. the gap
  if (peak.p20 && now.best20) {
    items.push({
      key: 'gap',
      label: 'The gap',
      value: pct(now.best20 / peak.p20),
      caption: `of your ${name} 20-min power`,
      detail: `Best 20 minutes in the last 90 days: ${now.best20} W, against ${peak.p20} W in ${fmtDate(peak.windowFrom, 'MMM yyyy')} – ${fmtDate(peak.windowTo, 'MMM yyyy')}.${peak.ftp && now.ftp ? ` FTP estimate ${now.ftp} W vs ${peak.ftp} W.` : ''}`,
      tone: now.best20 / peak.p20 >= 0.95 ? 'good' : 'neutral',
    });
  } else if (peak.ftp && now.ftp) {
    items.push({ key: 'gap', label: 'The gap', value: pct(now.ftp / peak.ftp), caption: `of your ${name} FTP`, detail: `FTP estimate ${now.ftp} W now vs ${peak.ftp} W then.`, tone: 'neutral' });
  }

  // 2. the aerobic engine: power at the same heart rate — on the model when it can (heat,
  // fatigue and indoor riding taken out of both eras), else from the raw profiles
  const c = hr?.comparison;
  const am = hr?.aerobic;
  const topEnd = c && c.thenTop && c.nowTop && (c.thenTop.hr > c.nowTop.hr || c.thenTop.power > c.nowTop.power * 1.05) ? { then: c.thenTop, now: c.nowTop } : null;
  if (am) {
    const back = am.ratio >= 0.95;
    items.push({
      key: 'engine',
      label: 'Aerobic engine',
      value: pct(am.ratio),
      caption: `of your aerobic power then, at ${am.refHr} bpm`,
      detail:
        `With heat, fatigue and indoor riding taken out of both, you hold ${Math.round(am.now.value)} W at ${am.refHr} bpm, against ${Math.round(am.then.value)} W around ${name} (±${Math.max(1, Math.round(am.sd * 100))}%)${back ? ': the engine is largely back' : ''}.` +
        (topEnd ? ` What's missing is the top end: then you held ${topEnd.then.power} W at ${topEnd.then.hr} bpm for 10+ minutes; lately your hardest steady efforts reach ${topEnd.now.power} W at ${topEnd.now.hr} bpm.` : '') +
        ` Heart rate at a given effort drifts down with age — about ${Math.max(1, Math.round((0.7 * (Date.now() - Date.parse(am.thenDate))) / (365.25 * 86400000)))} bpm since then — which flatters today a little.`,
      tone: back ? 'good' : 'neutral',
    });
  } else if (hr && c && c.ratio != null && c.shared.length >= 3) {
    const lo = c.shared[0].hr;
    const hi = c.shared[c.shared.length - 1].hr;
    const back = c.ratio >= 0.95;
    const top = c.thenTop && c.nowTop && (c.thenTop.hr > c.nowTop.hr || c.thenTop.power > c.nowTop.power * 1.05) ? { then: c.thenTop, now: c.nowTop } : null;
    items.push({
      key: 'engine',
      label: 'Aerobic engine',
      value: pct(c.ratio),
      caption: 'of the power you made then at the same heart rate',
      detail:
        `From ${lo} to ${hi} bpm your steady power is ${c.ratio >= 0.97 ? 'the same as' : c.ratio >= 0.9 ? 'close to' : 'well below'} what it was around ${name}${back ? ': the engine is largely back' : ''}.` +
        (top ? ` What's missing is the top end: then you held ${top.then.power} W at ${top.then.hr} bpm for 10+ minutes; lately your hardest steady efforts reach ${top.now.power} W at ${top.now.hr} bpm.` : '') +
        (hr.outdoorOnly ? ' (Outdoor rides only.)' : ''),
      tone: back ? 'good' : 'neutral',
    });
  } else {
    items.push({
      key: 'engine',
      label: 'Aerobic engine',
      value: '–',
      caption: 'not enough heart-rate data',
      detail: hr && hr.thenRides < 2 ? `There are too few rides with both power and heart rate around ${name} to compare power at the same heart rate.` : 'Comparing power at the same heart rate needs rides with both power and heart rate in both periods.',
      tone: 'neutral',
    });
  }

  // 3. why: long-term load
  const cap = o.capacity;
  if (cap && peak.capacity != null && now.ltl != null) {
    const ltlPeak = ltlFor(cap, peak.capacity);
    const v = cap.validation;
    items.push({
      key: 'load',
      label: 'Long-term load',
      value: ltlPeak > 0 ? pct(now.ltl / ltlPeak) : '–',
      caption: `of your long-term load before ${name}`,
      detail:
        `Your power follows the training of roughly the last ${tauText(cap.tau)}, not the last 6 weeks.` +
        (v ? ` Fitted only on rides before ${fmtDate(v.from, 'MMM yyyy')}, it predicted your monthly bests since within ±${Math.round(v.mae)} W; the 6-week fitness (CTL) model was off by ±${Math.round(v.maeCtl)} W.` : '') +
        (peak.ctl && now.ctl && now.ctl >= peak.ctl * 0.9 ? ` Your 6-week load is already there (CTL ${now.ctl} vs ${peak.ctl}); the months behind it aren't yet.` : ''),
      tone: 'neutral',
    });
  }

  // 4. the way back at the current load
  const w = wayBack(o, peak, now.weeklyTss);
  const maxMargin = Math.max(0, ...o.peaks.map((p) => p.margin ?? 0));
  const sharpest = o.peaks.find((p) => p.margin === maxMargin);
  if (w && now.weeklyTss > 0) {
    const today = new Date();
    if (w.reachable && w.soonest != null && w.latest != null) {
      const span = w.soonest === w.latest ? `${monthsText(w.soonest)} mo` : `${monthsText(w.soonest)}–${monthsText(w.latest)} mo`;
      items.push({
        key: 'way',
        label: 'The way back',
        value: w.latest === 0 ? 'Now' : span,
        caption: `at your current ~${r10(now.weeklyTss)} TSS a week`,
        detail:
          (w.latest === 0
            ? `Your capacity is already at its ${name} level (${Math.round(w.target)} W for 20 minutes).`
            : `Holding the load of your last 6 weeks, your capacity gets back to its ${name} level (${Math.round(w.target)} W for 20 minutes) around ${dateSpan(addDays(today, w.soonest), addDays(today, w.latest))}.`) +
          (sharpest && maxMargin >= 0.05 ? ` Your best results then ran up to ${pct(maxMargin)} above capacity (${peakName(sharpest)}) after racing and hard blocks.` : ''),
        tone: 'neutral',
      });
    } else {
      items.push({
        key: 'way',
        label: 'The way back',
        value: 'Not yet',
        caption: `at your current ~${r10(now.weeklyTss)} TSS a week`,
        detail: `At this load your capacity levels off around ${Math.round(w.plateau)} W for 20 minutes, short of ${Math.round(w.target)} W. Getting back takes at least ~${r10(w.minWeekly)} TSS a week held for many months — the planner below shows how long at more.`,
        tone: 'warning',
      });
    }
  }

  // what to change, most important first
  const advice: string[] = [];
  if (w && now.weeklyTss > 0) {
    if (!w.reachable) advice.push(`Raise your weekly load: ~${r10(now.weeklyTss)} TSS a week tops out below your ${name} capacity.`);
    else if ((w.latest ?? 0) > 0) advice.push(`Keep the load steady for months: at ~${r10(now.weeklyTss)} TSS a week (${now.weeklyHours.toFixed(1)} h) the gap closes, but slowly. More load shortens it — see the planner below.`);
  }
  if (months && months.then.length && months.now.length) {
    const then = monthSummary(months.then.slice(-3));
    const cur = monthSummary(months.now.slice(-3));
    if (cur.z3share - then.z3share >= 0.05 && then.z4plus - cur.z4plus >= 0.3)
      advice.push(
        `Swap some tempo for harder work: ${pct(cur.z3share)} of your riding is in Z3 (${pct(then.z3share)} in the 3 months before ${name}), and you spend ${cur.z4plus.toFixed(1)} h a week at threshold and above vs ${then.z4plus.toFixed(1)} h then.`,
      );
    else if (then.z4plus - cur.z4plus >= 0.5) advice.push(`More time at threshold and above: ${cur.z4plus.toFixed(1)} h a week now vs ${then.z4plus.toFixed(1)} h in the 3 months before ${name}.`);
    if (then.longRidesPerWeek - cur.longRidesPerWeek >= 0.4) advice.push(`Bring back the long ride: ${then.longRidesPerWeek.toFixed(1)} rides of 3 h+ a week before ${name} vs ${cur.longRidesPerWeek.toFixed(1)} now.`);
  }
  if (c && c.ratio != null && c.ratio >= 0.95 && c.shared.length >= 3) advice.push('Your endurance base is back, so the quickest gains are at the top end: threshold and VO2max intervals.');
  if (sharpest && maxMargin >= 0.08) advice.push(`Plan a sharpening block before a goal: ${peakName(sharpest)} came ${pct(maxMargin)} above your capacity at the time, on the back of racing and hard efforts.`);
  return { items, advice: advice.slice(0, 4) };
}
