/**
 * The headline findings of the Comeback page, worked out from the data so the page can lead
 * with them: how big the gap is, how fast it's closing, whether the aerobic engine is back,
 * why it takes time (long-term load), and how long the way back is at the current load —
 * plus what to change.
 */
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { daysToTarget, loadForTarget, ltlFor } from '../../../shared/analytics/capacity';
import { fmtDate, fmtNum } from '../../lib/format';
import { monthSummary, peakName, tauText, type Compare, type HrCompareResponse, type Months, type Overview, type PeakCard, type Story } from './types';

export interface Finding {
  key: 'gap' | 'progress' | 'engine' | 'load' | 'way';
  label: string;
  value: string;
  caption: string;
  detail: string;
  tone: 'good' | 'neutral' | 'warning';
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r10 = (x: number) => Math.round(x / 10) * 10;
const monthsText = (days: number) => Math.max(1, Math.round(days / 30.4));
/** "5.8 years", "7 months" */
const offText = (days: number) => (days >= 365 ? `${(days / 365).toFixed(1)} years` : `${monthsText(days)} months`);

/**
 * What the out-of-sample check says, in words: the model fitted only on the rides before a
 * date, against the monthly bests since — and against the 6-week CTL model on the same test.
 * When it does no better than CTL, say so rather than offer it as support.
 */
export function validationText(v: NonNullable<Overview['capacity']>['validation']): string {
  if (!v) return '';
  const head = `Fitted only on rides before ${fmtDate(v.from, 'MMM yyyy')}, it predicted your monthly bests since within ±${Math.round(v.mae)} W`;
  return v.mae < v.maeCtl * 0.9 ? `${head}; the 6-week fitness (CTL) model was off by ±${Math.round(v.maeCtl)} W.` : `${head}, no better than the 6-week fitness (CTL) model (±${Math.round(v.maeCtl)} W), so take its dates loosely.`;
}
const daysAgo = (d: string) => differenceInCalendarDays(new Date(), parseISO(d));
const isoDay = (d: Date) => format(d, 'yyyy-MM-dd');

/** "Apr – Aug 2027" or "Aug 2027" */
export function dateSpan(a: Date, b: Date): string {
  const fa = format(a, 'MMM yyyy');
  const fb = format(b, 'MMM yyyy');
  if (fa === fb) return fa;
  return a.getFullYear() === b.getFullYear() ? `${format(a, 'MMM')} – ${fb}` : `${fa} – ${fb}`;
}

/**
 * The plausible models, each with its own capacity at the peak as the level to get back to:
 * models with different time constants read the same history differently, so each is asked
 * when it gets back to where it says the peak was. None when load doesn't move capacity.
 */
export function targets(o: Overview, peak: PeakCard) {
  const cap = o.capacity;
  if (!cap?.informative || peak.capacity == null) return [];
  return cap.fits.filter((f) => f.plausible).map((f) => ({ ...f, target: peak.capacities?.find((c) => c.tau === f.tau)?.capacity ?? peak.capacity! }));
}

/** When capacity reaches the peak's level at a steady weekly load, across the plausible models. */
export function wayBack(o: Overview, peak: PeakCard, weeklyTss: number) {
  const fits = targets(o, peak);
  if (!fits.length) return null;
  const days = fits.map((f) => daysToTarget(f, f.tau, f.ltlNow, weeklyTss / 7, f.target));
  const finite = days.filter((d) => Number.isFinite(d));
  return {
    target: peak.capacity!,
    reachable: finite.length === days.length,
    soonest: finite.length ? Math.min(...finite) : null,
    latest: finite.length ? Math.max(...finite) : null,
    // the capacity this load levels off at, and the least load that gets there (and keeps it)
    plateau: Math.min(...fits.map((f) => f.a + (f.b * weeklyTss) / 7)),
    minWeekly: Math.max(...fits.map((f) => ltlFor(f, f.target) * 7)),
  };
}

/** The steady weekly load that gets back by a date, across the plausible models. */
export function loadToBeBackBy(o: Overview, peak: PeakCard, when: Date) {
  const fits = targets(o, peak);
  if (!fits.length) return null;
  const days = differenceInCalendarDays(when, new Date());
  const loads = fits.map((f) => loadForTarget(f, f.tau, f.ltlNow, f.target, days) * 7);
  return { low: Math.min(...loads), high: Math.max(...loads) };
}

/** Above the most the athlete has sustained for 12 weeks (with a little room). */
export const beyondSustained = (o: Overview, weeklyTss: number) => !!o.sustained && weeklyTss > o.sustained.tss * 1.05;

/**
 * How the comeback is going: 20-minute capacity (the model's reading of the training) and the
 * best 20 minutes ridden, since the comeback began — over the last six months without one —
 * and how fast capacity has moved over the last three months.
 */
export function progress(o: Overview, story: Story | undefined) {
  const weeks = story?.weeks ?? [];
  if (!weeks.length) return null;
  const comeback = !!o.comeback && daysAgo(o.comeback.start) <= 730;
  const since = comeback ? o.comeback!.start : isoDay(subDays(new Date(), 182));
  const days = daysAgo(since) + 1;
  // weeks are Mondays; capacity is at the end of each (today, for this one)
  const k0 = weeks.findIndex((w) => w.week > isoDay(subDays(parseISO(since), 7)));
  if (k0 < 0) return null;
  const last = weeks.length - 1;
  const capAt = (k: number) => weeks[Math.max(0, Math.min(last, k))].capacity;
  // capacity going into the period: the week before it began
  const capStart = capAt(k0 - 1);
  const capNow = o.now.capacity ?? capAt(last);
  const back = Math.min(13, last - k0 + 1);
  const capThen = capAt(last - back);
  const perMonth = capNow != null && capThen != null && back > 0 ? ((capNow - capThen) / (back * 7)) * 30.4 : null;
  // the best 20 minutes of the first four weeks back
  const first = weeks.slice(k0, k0 + 4).reduce<number | null>((b, w) => (w.best && (b == null || w.best > b) ? w.best : b), null);
  return { since, comeback, days, capStart, capNow, perMonth, firstBest: first };
}

/** Kept (now ÷ then) at a few durations of the best-power comparison. */
export function curveKept(cmp: Compare | undefined) {
  if (!cmp) return [];
  return [5, 60, 300, 1200, 3600]
    .map((t) => {
      const i = cmp.durations.indexOf(t);
      const a = cmp.then[i];
      const b = cmp.now[i];
      return { t, then: a, now: b, kept: a && b ? b / a : null };
    })
    .filter((x) => x.kept != null) as { t: number; then: number; now: number; kept: number }[];
}

/**
 * Durability: the best 20 minutes deep into a ride, then and now, at the depth where it kept
 * the least of then — counting only depths both periods reached on at least three rides.
 */
export function durability(cmp: Compare | undefined) {
  if (!cmp) return null;
  const i20 = cmp.durations.indexOf(1200);
  const fresh = cmp.then[i20] && cmp.now[i20] ? cmp.now[i20]! / cmp.then[i20]! : null;
  let worst: { kj: number; then: number; now: number; kept: number; rides: number } | null = null;
  cmp.durability.kj.forEach((kj, i) => {
    const a = cmp.durability.then[i];
    const b = cmp.durability.now[i];
    if (!a.value || !b.value || a.rides < 3 || b.rides < 3) return;
    const kept = b.value / a.value;
    if (!worst || kept < worst.kept) worst = { kj, then: a.value, now: b.value, kept, rides: b.rides };
  });
  return { fresh, worst: worst as { kj: number; then: number; now: number; kept: number; rides: number } | null };
}

/** The aerobic engine, judged once for the whole page: on the model, allowing for age, when it can. */
export function engine(hr: HrCompareResponse | undefined) {
  const am = hr?.aerobic;
  if (am) {
    // a year or two apart, heart rate's drift with age is worth allowing for
    const aged = am.ageBpm >= 1;
    return { ratio: aged ? am.ageRatio : am.ratio, model: true, aged };
  }
  const c = hr?.comparison;
  if (c?.ratio != null && c.shared.length >= 3) return { ratio: c.ratio, model: false, aged: false };
  return null;
}

export function findings(
  o: Overview,
  peak: PeakCard,
  hr: HrCompareResponse | undefined,
  months: Months | undefined,
  story: Story | undefined,
  cmp: Compare | undefined,
): { items: Finding[]; advice: string[] } {
  const name = peakName(peak);
  const now = o.now;
  const items: Finding[] = [];
  const riding = !!now.lastRide && daysAgo(now.lastRide) <= 28;
  // the first eight weeks back are for building up, not for fine-tuning the training
  const sinceBack = o.comeback ? daysAgo(o.comeback.start) : null;
  const early = sinceBack != null && sinceBack < 56;
  const settled = riding && !early;

  // 1. the gap
  if (peak.p20 && now.best20) {
    const r = now.best20 / peak.p20;
    // training that supports more than has been ridden: untested rather than lost
    const untested = now.capacity != null && now.capacity > now.best20 * 1.04;
    items.push({
      key: 'gap',
      label: 'The gap',
      value: pct(r),
      caption: `of your ${name} 20-min power`,
      detail:
        `Your best 20 minutes in the last 90 days: ${now.best20} W${now.best20Date ? ` (${fmtDate(now.best20Date, 'd MMM')})` : ''}, against ${peak.p20} W ${peak.p20Date ? `on ${fmtDate(peak.p20Date, 'd MMM yyyy')}` : `around ${name}`}.` +
        (peak.ftp && now.ftp ? ` FTP ${now.ftp} W vs ${peak.ftp} W.` : '') +
        (untested ? ` Your training supports about ${Math.round(now.capacity!)} W, more than you've ridden lately: a hard 20 minutes would likely show it.` : ''),
      tone: r >= 0.95 ? 'good' : 'neutral',
    });
  } else if (peak.ftp && now.ftp && now.ftpDate && daysAgo(now.ftpDate) <= 90) {
    items.push({
      key: 'gap',
      label: 'The gap',
      value: pct(now.ftp / peak.ftp),
      caption: `of your ${name} FTP`,
      detail: `FTP estimate ${now.ftp} W now vs ${peak.ftp} W then. There's no 20-minute effort in the last 90 days to compare directly.`,
      tone: 'neutral',
    });
  } else {
    items.push({
      key: 'gap',
      label: 'The gap',
      value: '–',
      caption: 'nothing recent to compare',
      detail: now.lastRide ? `There's no hard effort in the last 90 days${riding ? '' : `: your last ride was on ${fmtDate(now.lastRide, 'd MMM yyyy')}`}.` : 'No rides with power yet.',
      tone: 'neutral',
    });
  }

  // 2. progress: how fast the gap is closing
  const pg = progress(o, story);
  if (pg && pg.comeback && pg.days < 42) {
    items.push({
      key: 'progress',
      label: 'Progress',
      value: `${Math.max(1, Math.round(pg.days / 7))} wk`,
      caption: 'since you came back',
      detail: `You came back on ${fmtDate(pg.since, 'd MMM')} after ${offText(o.comeback!.breakDays)} off. A trend needs a few more weeks${pg.capNow != null ? `; capacity is ${Math.round(pg.capNow)} W${peak.capacity ? `, ${pct(pg.capNow / peak.capacity)} of what it was at ${name}` : ''}` : ''}.`,
      tone: 'neutral',
    });
  } else if (pg && pg.capStart != null && pg.capNow != null) {
    const gain = pg.capNow - pg.capStart;
    const rate = pg.perMonth ?? 0;
    items.push({
      key: 'progress',
      label: 'Progress',
      value: `${gain >= 0 ? '+' : '−'}${Math.abs(Math.round(gain))} W`,
      caption: pg.comeback ? `20-min capacity since ${fmtDate(pg.since, 'MMM yyyy')}` : '20-min capacity in the last 6 months',
      detail:
        `Your capacity went from ${Math.round(pg.capStart)} W ${pg.comeback ? 'when you came back' : 'six months ago'} to ${Math.round(pg.capNow)} W, ` +
        (Math.abs(rate) >= 1 ? `and is ${rate > 0 ? 'rising' : 'falling'} about ${Math.abs(Math.round(rate))} W a month` : 'and is level lately') +
        (peak.capacity ? `: ${pct(pg.capNow / peak.capacity)} of what it was at ${name}.` : '.') +
        (pg.comeback && pg.days >= 56 && pg.firstBest && now.best20 && now.best20 !== pg.firstBest ? ` Your best 20 minutes went from ${pg.firstBest} W in your first month back to ${now.best20} W.` : ''),
      tone: rate >= 1 ? 'good' : rate <= -2 ? 'warning' : 'neutral',
    });
  }

  // 3. the aerobic engine: power at the same heart rate — on the model when it can (heat,
  // fatigue and indoor riding taken out of both eras, and allowing for age), else from the
  // raw profiles
  const c = hr?.comparison;
  const am = hr?.aerobic;
  const eng = engine(hr);
  const topEnd = c && c.thenTop && c.nowTop && (c.thenTop.hr > c.nowTop.hr || c.thenTop.power > c.nowTop.power * 1.05) ? { then: c.thenTop, now: c.nowTop } : null;
  const topEndText = topEnd ? ` What's furthest behind is the top end: your hardest steady efforts then held ${topEnd.then.power} W (at ${topEnd.then.hr} bpm), lately ${topEnd.now.power} W (at ${topEnd.now.hr} bpm).` : '';
  if (am && eng) {
    const back = eng.ratio >= 0.95;
    const when = Math.abs(differenceInCalendarDays(parseISO(am.thenDate), parseISO(peak.date))) > 21 ? `in ${fmtDate(am.thenDate, 'MMM yyyy')}, the nearest heart-rate reading to ${name}` : `around ${name}`;
    items.push({
      key: 'engine',
      label: 'Aerobic engine',
      value: pct(eng.ratio),
      caption: eng.aged ? 'of your aerobic power then, allowing for age' : `of your aerobic power then, at ${am.refHr} bpm`,
      detail:
        `With heat, fatigue and indoor riding taken out, you hold ${Math.round(am.now.value)} W at ${am.refHr} bpm, against ${Math.round(am.then.value)} W ${when} (${pct(am.ratio)}, ±${Math.max(1, Math.round(am.sd * 100))}%).` +
        (eng.aged ? ` Heart rate at a given effort falls with age, about ${Math.round(am.ageBpm)} bpm at ${am.refHr} since then, so ${am.refHr} bpm is a harder effort now than it was; allowing for that, ${pct(am.ageRatio)}.` : '') +
        (eng.ratio >= 1.02 ? ' Your engine is past where it was.' : back ? ' The engine is largely back.' : '') +
        topEndText,
      tone: back ? 'good' : 'neutral',
    });
  } else if (hr && c && eng) {
    const lo = c.shared[0].hr;
    const hi = c.shared[c.shared.length - 1].hr;
    const back = eng.ratio >= 0.95;
    items.push({
      key: 'engine',
      label: 'Aerobic engine',
      value: pct(eng.ratio),
      caption: 'of the power you made then at the same heart rate',
      detail:
        `From ${lo} to ${hi} bpm your steady power is ${eng.ratio >= 0.97 ? 'the same as' : eng.ratio >= 0.9 ? 'close to' : 'well below'} what it was around ${name}${back ? ': the engine is largely back' : ''}.` +
        topEndText +
        (hr.outdoorOnly ? ' (Outdoor rides only.)' : '') +
        ' Heart rate at a given effort falls a little with age, which flatters today.',
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

  // 4. why: long-term load
  const cap = o.capacity;
  if (cap && !cap.informative) {
    items.push({
      key: 'load',
      label: 'Long-term load',
      value: '–',
      caption: "doesn't explain your power",
      detail: `Across your history, your 20-minute power hasn't risen and fallen with your training load clearly enough to model (${Math.round(cap.b * (cap.ltlRange[1] - cap.ltlRange[0]))} W between your lightest and heaviest training), so there's no projection below.`,
      tone: 'neutral',
    });
  } else if (cap && peak.capacity != null && now.ltl != null) {
    const ltlPeak = ltlFor(cap, peak.capacity);
    const v = cap.validation;
    items.push({
      key: 'load',
      label: 'Long-term load',
      value: ltlPeak > 0 ? pct(now.ltl / ltlPeak) : '–',
      caption: `of your long-term load before ${name}`,
      detail:
        `Your power follows the training of roughly the last ${tauText(cap.tau)}, not the last 6 weeks.` +
        (v ? ` ${validationText(v)}` : '') +
        (peak.ctl && now.ctl && now.ctl >= peak.ctl * 0.9 ? ` Your 6-week load is already there (CTL ${now.ctl} vs ${peak.ctl})${now.ltl < ltlPeak * 0.95 ? "; the months behind it aren't yet" : ', and so are the months behind it'}.` : ''),
      tone: ltlPeak > 0 && now.ltl >= ltlPeak * 0.95 ? 'good' : 'neutral',
    });
  }

  // 5. the way back at the current load
  const w = wayBack(o, peak, now.weeklyTss);
  const sus = o.sustained;
  const atCeiling = !!sus && now.weeklyTss >= sus.tss * 0.95;
  const ceilingText = sus ? `${r10(sus.tss)} TSS a week for 12 weeks, to ${fmtDate(sus.to, 'MMM yyyy')}` : '';
  const loadWhen = now.loadDays < 42 ? `your ${Math.round(now.loadDays / 7)} weeks back` : 'your last 6 weeks';
  const today = new Date();
  if (w && now.weeklyTss > 0) {
    if (w.reachable && w.soonest != null && w.latest != null) {
      const [ms, ml] = [monthsText(w.soonest), monthsText(w.latest)];
      items.push({
        key: 'way',
        label: 'The way back',
        value: w.latest === 0 ? 'Now' : ms === ml ? `${ml} mo` : `${ms}–${ml} mo`,
        caption: `at your current ~${r10(now.weeklyTss)} TSS a week`,
        detail:
          (w.latest === 0
            ? `Your capacity is already at its ${name} level (${Math.round(w.target)} W for 20 minutes).`
            : `Holding the load of ${loadWhen}, your capacity gets back to its ${name} level (${Math.round(w.target)} W for 20 minutes) around ${dateSpan(addDays(today, w.soonest), addDays(today, w.latest))}.`) +
          (w.latest > 60 && atCeiling ? ` You're already training at about the most you've ever sustained (${ceilingText}): time, more than load, is what closes the gap now.` : ''),
        tone: w.latest === 0 ? 'good' : 'neutral',
      });
    } else {
      items.push({
        key: 'way',
        label: 'The way back',
        value: 'Not yet',
        caption: `at your current ~${r10(now.weeklyTss)} TSS a week`,
        detail: `At this load your capacity levels off around ${Math.round(w.plateau)} W for 20 minutes, short of ${Math.round(w.target)} W. Getting back takes at least ~${r10(w.minWeekly)} TSS a week held for many months${sus ? ` (the most you've sustained: ${ceilingText})` : ''}. The planner below shows how long at more.`,
        tone: 'warning',
      });
    }
  } else if (w) {
    items.push({
      key: 'way',
      label: 'The way back',
      value: '–',
      caption: riding ? 'no regular riding yet' : 'not riding at the moment',
      detail: `Keeping your ${name} capacity takes about ${r10(w.minWeekly)} TSS a week over the long run. The planner below shows how long a steady load takes to get there.`,
      tone: 'neutral',
    });
  }

  // what to change, most important first — for where the athlete is: coming back after time
  // off, it's how to build up; only once riding is settled does the training's make-up matter
  const advice: string[] = [];
  if (!riding && now.lastRide) advice.push(`Start back gently: you haven't ridden since ${fmtDate(now.lastRide, 'd MMM yyyy')}. The plan below opens with an easy month, as tendons and joints adapt slower than fitness.`);
  if (w && now.weeklyTss > 0 && riding) {
    if (early && (w.latest ?? 1) > 0) {
      advice.push(
        `Build your load gradually: ${Math.max(1, Math.round(sinceBack! / 7))} weeks back, you're at ~${r10(now.weeklyTss)} TSS a week. Getting back to your ${name} capacity takes ~${r10(w.minWeekly)} or more held for months; the plan below ramps there at a rate tendons and joints can absorb.`,
      );
    } else if (!w.reachable) {
      advice.push(
        sus && w.minWeekly > sus.tss * 1.05
          ? `Pick a goal your load can reach: getting back needs ~${r10(w.minWeekly)} TSS a week for many months, more than you've ever sustained (${ceilingText}).`
          : `Raise your weekly load: ~${r10(now.weeklyTss)} TSS a week tops out below your ${name} capacity; it takes ~${r10(w.minWeekly)}${sus ? `, within what you've sustained before (${r10(sus.tss)})` : ''}.`,
      );
    } else if ((w.latest ?? 0) > 0) {
      const when = dateSpan(addDays(today, w.soonest ?? 0), addDays(today, w.latest ?? 0));
      advice.push(
        atCeiling
          ? `Hold your load rather than raise it: ~${r10(now.weeklyTss)} TSS a week (${now.weeklyHours.toFixed(1)} h) is already the most you've sustained, and kept up it gets you back around ${when}. Consistency over the coming months is what's left.`
          : `Keep the load steady for months: at ~${r10(now.weeklyTss)} TSS a week (${now.weeklyHours.toFixed(1)} h) the gap closes around ${when}. More shortens it${sus ? `, up to the ~${r10(sus.tss)} you've sustained before` : ''}: see the planner below.`,
      );
    }
  }
  // the earliest sign of the engine coming back needs heart rate on the rides
  if (riding && hr && hr.thenRides >= 3 && hr.nowRides < 3) advice.push("Ride with a heart-rate strap: power at the same heart rate is the earliest sign of your aerobic engine coming back, and there's too little of it lately to read.");
  if (!settled) return { items, advice: advice.slice(0, 4) };
  // deep into a ride against fresh: durability lags in most comebacks
  const du = durability(cmp);
  const longGap = months && months.then.length && months.now.length ? { then: monthSummary(months.then.slice(-3)).longRidesPerWeek, now: monthSummary(months.now.slice(-3)).longRidesPerWeek } : null;
  const moreLong = longGap && longGap.then - longGap.now >= 0.4;
  if (du?.worst && du.fresh != null && du.worst.kept <= du.fresh - 0.06) {
    advice.push(
      `Train durability: after ${fmtNum(du.worst.kj)} kJ your best 20 minutes is ${du.worst.now} W against ${du.worst.then} W around ${name} (${pct(du.worst.kept)}, while fresh you're at ${pct(du.fresh)}).` +
        (moreLong ? ` Long rides are down too: ${longGap!.now.toFixed(1)} rides of 3 h+ a week vs ${longGap!.then.toFixed(1)} before ${name}. Put hard efforts late in them.` : ' Put hard efforts late in your long rides.'),
    );
  } else if (moreLong) advice.push(`Bring back the long ride: ${longGap!.then.toFixed(1)} rides of 3 h+ a week before ${name} vs ${longGap!.now.toFixed(1)} now.`);
  // where the power-duration gap is widest
  const kept = curveKept(cmp);
  const worstDur = kept.length >= 3 ? kept.reduce((a, b) => (b.kept < a.kept ? b : a)) : null;
  const hour = kept.find((x) => x.t === 3600);
  const topEndLags = !!worstDur && (worstDur.t === 300 || worstDur.t === 1200) && (!hour || worstDur.kept <= hour.kept - 0.05);
  if (topEndLags && (!eng || eng.ratio >= 0.88))
    advice.push(
      `Work on the top end: your ${worstDur!.t === 300 ? '5-minute' : '20-minute'} power is furthest behind (${pct(worstDur!.kept)}${hour ? `, against ${pct(hour.kept)} for an hour` : ''})${eng && eng.ratio > worstDur!.kept ? ` and your aerobic engine is closer (${pct(eng.ratio)})` : ''}, so threshold and VO2max intervals close the gap fastest.`,
    );
  else if (eng && eng.ratio >= 0.95 && topEnd) advice.push('Your endurance base is back, so the quickest gains are at the top end: threshold and VO2max intervals.');
  if (months && months.then.length && months.now.length) {
    const then = monthSummary(months.then.slice(-3));
    const cur = monthSummary(months.now.slice(-3));
    if (cur.z3share - then.z3share >= 0.05 && then.z4plus - cur.z4plus >= 0.3)
      advice.push(
        `Swap some tempo for harder work: ${pct(cur.z3share)} of your riding is in Z3 (${pct(then.z3share)} in the 3 months before ${name}), and you spend ${cur.z4plus.toFixed(1)} h a week at threshold and above vs ${then.z4plus.toFixed(1)} h then.`,
      );
    else if (!topEndLags && then.z4plus - cur.z4plus >= 0.5) advice.push(`More time at threshold and above: ${cur.z4plus.toFixed(1)} h a week now vs ${then.z4plus.toFixed(1)} h in the 3 months before ${name}.`);
  }
  const maxMargin = Math.max(0, ...o.peaks.map((p) => p.margin ?? 0));
  const sharpest = o.peaks.find((p) => p.margin === maxMargin);
  if (sharpest && maxMargin >= 0.08) advice.push(`Plan a sharpening block before a goal: around ${peakName(sharpest)} your best efforts ran ${pct(maxMargin)} above the capacity your training supported.`);
  return { items, advice: advice.slice(0, 4) };
}
