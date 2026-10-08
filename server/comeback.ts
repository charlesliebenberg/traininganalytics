import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, subDays, subMonths } from 'date-fns';
import type { PmcPoint, SeasonPlanConfig } from '../shared/types';
import { byEffortDate, classifySession, detectPeaks, effortDate, summarizeBuild } from '../shared/analytics/comeback';
import { capacityAt, daysToTarget, fitCapacity, ltlSeries, type CapacityDay, type CapacityModel } from '../shared/analytics/capacity';
import { compareHrProfiles, hrProfile, type HrBins } from '../shared/analytics/hrprofile';
import { activityHrBins } from './hrbins';
import { generateSeasonPlan } from '../shared/analytics/plan';
import { CURVE_DURATIONS } from '../shared/analytics/series';
import { ACTIVITY_LIST_COLUMNS, getPreferences, getSetting, listThresholds, q, rowToActivity, setSetting, thresholdsFor } from './db';
import { aggregateCurve, firstActivityDate, pmc } from './aggregate';
import { estimateOn, storedSeries } from './estimates';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const today = () => iso(new Date());
const DAY = 86400_000;
/** a gap in riding at least this long splits the history into eras (and starts a comeback) */
const BREAK_DAYS = 90;
const P20 = CURVE_DURATIONS.indexOf(1200);

export interface Pin {
  date: string;
  label: string;
}
export const getPins = () => getSetting<Pin[]>('comeback_pins') ?? [];
export function addPin(p: Pin) {
  setSetting('comeback_pins', [...getPins().filter((x) => x.date !== p.date), p].sort((a, b) => a.date.localeCompare(b.date)));
}
export function removePin(date: string) {
  setSetting('comeback_pins', getPins().filter((x) => x.date !== date));
}

/**
 * Whole-history cycling PMC, cached per request burst. Cycling only: FTP responds to riding,
 * and runs would make a mixed-sport present look fitter than a ride-only past.
 */
let pmcCache: { at: number; map: Map<string, PmcPoint> } | null = null;
function pmcMap(): Map<string, PmcPoint> {
  if (pmcCache && Date.now() - pmcCache.at < 30_000) return pmcCache.map;
  const first = firstActivityDate();
  const map = new Map<string, PmcPoint>();
  if (first) for (const p of pmc(first, today(), 'ride')) map.set(p.date, p);
  pmcCache = { at: Date.now(), map };
  return map;
}

// ---------- riding history and the capacity model ----------

interface Gap {
  from: string;
  to: string;
  days: number;
}

interface History {
  at: number;
  /** one entry per day from the first ride to today: ride TSS and best 20-min power */
  days: CapacityDay[];
  hours: Float64Array;
  gaps: Gap[];
  /** first ride after the most recent long break */
  comebackStart: string | null;
  model: CapacityModel | null;
  ltl: (tau: number) => Float64Array;
}

let histCache: History | null = null;
function history(): History {
  if (histCache && Date.now() - histCache.at < 30_000) return histCache;
  const rows = q.all<{ d: string; tss: number; mt: number; p20: number | null }>(
    `SELECT local_date AS d, COALESCE(tss_override, tss, 0) AS tss, moving_time AS mt, json_extract(curves, '$.power[${P20}]') AS p20
     FROM activities WHERE sport = 'ride' ORDER BY local_date`,
  );
  const days: CapacityDay[] = [];
  const gaps: Gap[] = [];
  let hours = new Float64Array(0);
  if (rows.length) {
    const first = parseISO(rows[0].d);
    const n = differenceInCalendarDays(new Date(), first) + 1;
    for (let i = 0; i < n; i++) days.push({ date: iso(addDays(first, i)), load: 0, best: null });
    hours = new Float64Array(n);
    let prev: string | null = null;
    for (const r of rows) {
      const i = differenceInCalendarDays(parseISO(r.d), first);
      if (i < 0 || i >= n) continue;
      days[i].load += r.tss;
      hours[i] += r.mt / 3600;
      if (r.p20) days[i].best = Math.max(days[i].best ?? 0, r.p20);
      if (prev && prev !== r.d) {
        const gap = differenceInCalendarDays(parseISO(r.d), parseISO(prev)) - 1;
        if (gap >= BREAK_DAYS) gaps.push({ from: iso(addDays(parseISO(prev), 1)), to: iso(subDays(parseISO(r.d), 1)), days: gap });
      }
      prev = r.d;
    }
  }
  const comebackStart = gaps.length ? iso(addDays(parseISO(gaps[gaps.length - 1].to), 1)) : null;
  const model = days.length ? fitCapacity(days, { holdoutFrom: comebackStart }) : null;
  const loads = days.map((d) => d.load);
  const ltlCache = new Map<number, Float64Array>();
  const ltl = (tau: number) => {
    if (!ltlCache.has(tau)) ltlCache.set(tau, ltlSeries(loads, tau));
    return ltlCache.get(tau)!;
  };
  histCache = { at: Date.now(), days, hours, gaps, comebackStart, model, ltl };
  return histCache;
}

/** Index of a date in the history (clamped), and the LTL carried into it. */
function dayIndex(h: History, date: string): number {
  if (!h.days.length) return -1;
  return Math.max(0, Math.min(h.days.length - 1, differenceInCalendarDays(parseISO(date), parseISO(h.days[0].date))));
}
const ltlBefore = (h: History, tau: number, i: number) => (i > 0 ? h.ltl(tau)[i - 1] : 0);

/** The capacity model's view of a date: capacity then, and how far the best efforts around it went above it. */
function capacityAround(h: History, date: string) {
  const m = h.model;
  if (!m || !h.days.length) return { capacity: null, margin: null, best: null };
  const i = dayIndex(h, date);
  const capacity = capacityAt(m, ltlBefore(h, m.tau, i));
  // best efforts from 8 weeks before to 4 weeks after the date, relative to capacity at the time
  let margin: number | null = null;
  let best: number | null = null;
  for (let j = Math.max(0, i - 56); j <= Math.min(h.days.length - 1, i + 28); j++) {
    const b = h.days[j].best;
    if (!b) continue;
    const r = b / capacityAt(m, ltlBefore(h, m.tau, j)) - 1;
    if (margin == null || r > margin) margin = r;
    if (best == null || b > best) best = b;
  }
  return { capacity, margin, best };
}

const at = (curve: { values: (number | null)[] }, t: number) => curve.values[CURVE_DURATIONS.indexOf(t)] ?? null;

function peakCard(date: string, ftp: number | null, extra: { rank?: number; pinned?: boolean; label?: string }) {
  // the estimate that first reported these efforts, else a fresh one for the date
  const est = storedSeries('ride').find((e) => effortDate(e) === date) ?? storedSeries('ride').find((e) => e.date === date) ?? estimateOn('ride', date);
  const from = est?.windowFrom ?? iso(subDays(parseISO(date), 182));
  const to = est?.windowTo ?? iso(subDays(parseISO(date), 1));
  const curve = aggregateCurve('power', from, to, 'ride');
  const durable = aggregateCurve('fatigue:2000', from, to, 'ride');
  const pt = pmcMap().get(date);
  // W/kg only when the athlete has recorded their weight (not the built-in default)
  const weight = listThresholds().length ? thresholdsFor(date).weight : null;
  const f = ftp ?? est?.raw ?? null;
  const cap = capacityAround(history(), date);
  return {
    date,
    ftp: f != null ? Math.round(f) : null,
    wkg: f != null && weight ? f / weight : null,
    cp: est ? Math.round(est.cp) : null,
    ctl: pt ? Math.round(pt.ctl) : null,
    p5: at(curve, 300),
    p20: at(curve, 1200),
    p60: at(curve, 3600),
    durable20: at(durable, 1200),
    efforts: est?.points ?? [],
    windowFrom: from,
    windowTo: to,
    capacity: cap.capacity,
    margin: cap.margin,
    /** best 20 min from 8 weeks before to 4 weeks after the date */
    best20: cap.best,
    ...extra,
  };
}

/** Peaks (auto-detected + pinned), where things stand now, and the capacity model. */
export function overview() {
  const series = storedSeries('ride');
  const auto = detectPeaks(byEffortDate(series), { minGapDays: 120 });
  const pins = getPins();
  const peaks = [
    ...auto.filter((p) => !pins.some((x) => Math.abs(parseISO(x.date).getTime() - parseISO(p.date).getTime()) < 28 * DAY)).map((p) => peakCard(p.date, p.value, { rank: p.rank })),
    ...pins.map((p) => peakCard(p.date, null, { pinned: true, label: p.label })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const map = pmcMap();
  const latest = series.filter((e) => e.date <= today()).pop() ?? null;
  const nowPt = map.get(today()) ?? [...map.values()].pop();
  const weight = listThresholds().length ? thresholdsFor(today()).weight : null;
  const h = history();
  const n = h.days.length;
  const m = h.model;
  const recent = (k: number) => h.days.slice(Math.max(0, n - k));
  const weeklyTss = recent(42).reduce((s, d) => s + d.load, 0) / 6;
  const weeklyHours = h.hours.slice(Math.max(0, n - 42)).reduce((s, x) => s + x, 0) / 6;
  const best20 = recent(90).reduce<number | null>((b, d) => (d.best && (b == null || d.best > b) ? d.best : b), null);
  const ltlNow = m && n ? h.ltl(m.tau)[n - 1] : null;
  return {
    peaks,
    pins,
    now: {
      date: today(),
      ftp: latest ? Math.round(latest.threshold) : null,
      rawFtp: latest ? Math.round(latest.raw) : null,
      wkg: latest && weight ? latest.threshold / weight : null,
      ctl: nowPt ? Math.round(nowPt.ctl) : null,
      atl: nowPt ? Math.round(nowPt.atl) : null,
      best20,
      weeklyTss,
      weeklyHours,
      ltl: ltlNow,
      capacity: m && ltlNow != null ? capacityAt(m, ltlNow) : null,
    },
    capacity: m
      ? {
          tau: m.tau,
          a: m.a,
          b: m.b,
          quantile: m.quantile,
          validation: m.validation,
          ltlRange: m.ltlRange,
          observations: m.observations,
          fits: m.fits.map((f) => ({ ...f, ltlNow: n ? h.ltl(f.tau)[n - 1] : 0 })),
        }
      : null,
    comeback: h.comebackStart ? { start: h.comebackStart, breakDays: h.gaps[h.gaps.length - 1].days } : null,
    ridingMonths: consistentMonths(today()),
  };
}

/**
 * The whole riding history week by week — hours, load, best 20-min power and modelled
 * capacity — with long breaks marked so the chart can collapse them, and eras between them.
 */
export function story() {
  const h = history();
  const m = h.model;
  const weeks: { week: string; hours: number; tss: number; best: number | null; capacity: number | null; ltl: number | null }[] = [];
  const ltl = m ? h.ltl(m.tau) : null;
  h.days.forEach((d, i) => {
    const dt = parseISO(d.date);
    const monday = iso(new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - ((dt.getDay() + 6) % 7)));
    let w = weeks[weeks.length - 1];
    if (!w || w.week !== monday) {
      w = { week: monday, hours: 0, tss: 0, best: null, capacity: null, ltl: null };
      weeks.push(w);
    }
    w.hours += h.hours[i];
    w.tss += d.load;
    if (d.best && (w.best == null || d.best > w.best)) w.best = d.best;
    if (m && ltl) {
      w.ltl = ltl[i];
      w.capacity = capacityAt(m, ltl[i]);
    }
  });
  for (const w of weeks) {
    w.hours = Math.round(w.hours * 10) / 10;
    w.tss = Math.round(w.tss);
    if (w.capacity != null) w.capacity = Math.round(w.capacity * 10) / 10;
    if (w.ltl != null) w.ltl = Math.round(w.ltl * 10) / 10;
  }
  // eras: stretches of riding between long breaks
  const bounds = [h.days[0]?.date, ...h.gaps.flatMap((g) => [iso(subDays(parseISO(g.from), 1)), iso(addDays(parseISO(g.to), 1))]), h.days[h.days.length - 1]?.date].filter(Boolean) as string[];
  const eras: { from: string; to: string; hoursPerWeek: number; best20: number | null }[] = [];
  for (let k = 0; k + 1 < bounds.length; k += 2) {
    const [from, to] = [bounds[k], bounds[k + 1]];
    const ws = weeks.filter((w) => w.week >= iso(subDays(parseISO(from), 6)) && w.week <= to);
    eras.push({
      from,
      to,
      hoursPerWeek: ws.reduce((s, w) => s + w.hours, 0) / Math.max(1, ws.length),
      best20: ws.reduce<number | null>((b, w) => (w.best && (b == null || w.best > b) ? w.best : b), null),
    });
  }
  return { weeks, gaps: h.gaps, eras };
}

// ---------- the year before a peak, month by month ----------

export interface MonthRow {
  month: string;
  /** days of this month inside the range, as weeks (partial months count partially) */
  weeks: number;
  hoursPerWeek: number;
  tssPerWeek: number;
  /** hours per week by power zone group: Z1–2, Z3, Z4, Z5+, and riding without power */
  zones: [number, number, number, number, number];
  races: number;
  longRides: number;
}

function monthRows(from: string, to: string): MonthRow[] {
  const acts = q.all(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities WHERE sport = 'ride' AND local_date BETWEEN ? AND ?`, from, to).map(rowToActivity);
  const out = new Map<string, MonthRow>();
  for (let d = startOfMonth(parseISO(from)); iso(d) <= to; d = startOfMonth(addDays(d, 32))) {
    const key = format(d, 'yyyy-MM');
    const first = iso(d) < from ? from : iso(d);
    const lastOfMonth = iso(subDays(startOfMonth(addDays(d, 32)), 1));
    const last = lastOfMonth > to ? to : lastOfMonth;
    const weeks = (differenceInCalendarDays(parseISO(last), parseISO(first)) + 1) / 7;
    out.set(key, { month: key, weeks, hoursPerWeek: 0, tssPerWeek: 0, zones: [0, 0, 0, 0, 0], races: 0, longRides: 0 });
  }
  for (const a of acts) {
    const r = out.get(a.localDate.slice(0, 7));
    if (!r) continue;
    const hrs = a.movingTime / 3600;
    r.hoursPerWeek += hrs;
    r.tssPerWeek += a.tss ?? 0;
    const z = a.zones?.power;
    const total = z ? z.reduce((s, x) => s + x, 0) : 0;
    if (z && total > 0) {
      // zone seconds, scaled so the groups add up to the ride's moving time
      const k = hrs / (total / 3600);
      r.zones[0] += ((z[0] + z[1]) / 3600) * k;
      r.zones[1] += (z[2] / 3600) * k;
      r.zones[2] += (z[3] / 3600) * k;
      r.zones[3] += ((z[4] + z[5] + z[6]) / 3600) * k;
    } else r.zones[4] += hrs;
    if (classifySession(a) === 'race') r.races++;
    if (a.movingTime >= 3 * 3600) r.longRides++;
  }
  return [...out.values()].map((r) => ({
    ...r,
    hoursPerWeek: r.hoursPerWeek / r.weeks,
    tssPerWeek: r.tssPerWeek / r.weeks,
    zones: r.zones.map((x) => x / r.weeks) as MonthRow['zones'],
  }));
}

/** The 12 months up to a peak, and the comeback so far (or the last 12 months). */
export function months(date: string) {
  const h = history();
  const thenFrom = iso(startOfMonth(subMonths(parseISO(date), 11)));
  const yearAgo = iso(startOfMonth(subMonths(new Date(), 11)));
  const nowFrom = h.comebackStart && h.comebackStart > yearAgo ? h.comebackStart : yearAgo;
  return { then: monthRows(thenFrom, date), now: monthRows(nowFrom, today()), comebackStart: h.comebackStart };
}

// ---------- power at the same heart rate ----------

/** Steady-window bins per ride, computed from streams once and cached. */
function ridesWithBins(from: string, to: string): { indoor: boolean; bins: HrBins }[] {
  const rows = q.all<{ id: number; trainer: number; data: string | null }>(
    `SELECT a.id, a.trainer, h.data FROM activities a LEFT JOIN hr_power h ON h.activity_id = a.id
     WHERE a.sport = 'ride' AND a.has_power = 1 AND a.has_hr = 1 AND a.local_date BETWEEN ? AND ?`,
    from,
    to,
  );
  return rows.map((r) => ({ indoor: !!r.trainer, bins: activityHrBins(r.id, 'ride', r.data) }));
}

/**
 * Steady power per heart-rate bin around a peak (6 months before to 2 months after) vs the
 * last 4 months. Outdoor rides only when both periods have enough of them: indoors, heat
 * pushes heart rate up at the same power.
 */
export function hrCompare(date: string) {
  const thenFrom = iso(subDays(parseISO(date), 182));
  const after = iso(addDays(parseISO(date), 60));
  const thenTo = after < today() ? after : today();
  const nowFrom = iso(subDays(new Date(), 120));
  const thenRides = ridesWithBins(thenFrom, thenTo).filter((r) => Object.keys(r.bins).length);
  const nowRides = ridesWithBins(nowFrom, today()).filter((r) => Object.keys(r.bins).length);
  const outdoorOnly = thenRides.filter((r) => !r.indoor).length >= 3 && nowRides.filter((r) => !r.indoor).length >= 3;
  const use = (rs: typeof thenRides) => (outdoorOnly ? rs.filter((r) => !r.indoor) : rs);
  const then = hrProfile(use(thenRides).map((r) => r.bins));
  const now = hrProfile(use(nowRides).map((r) => r.bins));
  return {
    then,
    now,
    comparison: compareHrProfiles(then, now),
    thenRange: [thenFrom, thenTo],
    nowRange: [nowFrom, today()],
    outdoorOnly,
    thenRides: use(thenRides).length,
    nowRides: use(nowRides).length,
  };
}

// ---------- the build before a peak ----------

/** The training in the weeks before a date. */
export function build(date: string, weeks: number) {
  const from = iso(subDays(parseISO(date), weeks * 7 + 7));
  const acts = q.all(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities WHERE local_date >= ? AND local_date < ? ORDER BY start_time`, from, date).map(rowToActivity);
  const map = pmcMap();
  const pts = [...map.values()].filter((p) => p.date >= from && p.date <= date);
  return { ...summarizeBuild(acts, pts, date, weeks), consistentMonths: consistentMonths(date) };
}

/** Unbroken months of regular riding (≥ 15 h a month) leading up to a date: training age. */
function consistentMonths(date: string): number {
  const rows = q.all(
    `SELECT substr(local_date, 1, 7) AS m, SUM(moving_time) / 3600.0 AS h FROM activities WHERE sport = 'ride' AND local_date < ? GROUP BY m`,
    date,
  ) as { m: string; h: number }[];
  const hours = new Map(rows.map((r) => [r.m, r.h]));
  let d = parseISO(date);
  // the month the date falls in only counts if it's already well under way
  if (d.getDate() < 20) d = subMonths(d, 1);
  let n = 0;
  while ((hours.get(format(d, 'yyyy-MM')) ?? 0) >= 15) {
    n++;
    d = subMonths(d, 1);
  }
  return n;
}

/** Power curve at the peak (its estimate window) vs the last 90 days. */
export function compare(date: string) {
  const card = peakCard(date, null, {});
  const then = aggregateCurve('power', card.windowFrom, card.windowTo, 'ride');
  const now = aggregateCurve('power', iso(subDays(new Date(), 90)), today(), 'ride');
  return { durations: CURVE_DURATIONS, then: then.values, now: now.values, windowFrom: card.windowFrom, windowTo: card.windowTo };
}

// ---------- the way back ----------

export interface ComebackRequest {
  /** the weekly load to build to and then hold (TSS) */
  weeklyTss: number;
  /** capacity to reach: 20-min power (W) */
  targetCapacity: number;
  initialRamp: number;
  maxRamp: number;
  pattern: SeasonPlanConfig['pattern'];
  mix?: SeasonPlanConfig['mix'];
  tssPerHour?: number;
}

const MAX_PLAN_WEEKS = 104;

/**
 * A fitness-goal plan (no race taper) that ramps to the requested weekly load and holds it
 * until the capacity model says the target is reached. Capacity along the way comes from
 * every plausible time constant, so the arrival is a range of dates rather than one.
 */
export function planPreview(r: ComebackRequest) {
  const map = pmcMap();
  const nowPt = map.get(today()) ?? [...map.values()].pop();
  const startCtl = Math.round(nowPt?.ctl ?? 20);
  const startAtl = Math.round(nowPt?.atl ?? 20);
  const prefs = getPreferences();
  const h = history();
  const m = h.model;
  // the gentle first month is for coming back from a break, not for someone already riding regularly
  const ridingMonths = consistentMonths(today());
  const gentle = ridingMonths < 3;
  const weeklyTss = Math.max(70, Math.min(1500, r.weeklyTss));
  const tph = Math.max(35, Math.min(90, r.tssPerHour ?? 60));
  const base: SeasonPlanConfig = {
    startDate: today(),
    raceDate: today(),
    startCtl,
    startAtl,
    targetCtl: weeklyTss / 7,
    maxRamp: r.maxRamp,
    initialRamp: gentle ? r.initialRamp : undefined,
    initialWeeks: gentle ? 4 : 0,
    pattern: r.pattern,
    taperWeeks: 0,
    // the load is the limit here; leave room for harder phases
    maxWeeklyHours: Math.ceil((weeklyTss / tph) * 1.4),
    sport: 'ride',
    goal: 'fitness',
    mix: r.mix,
    tssPerHour: tph,
  };
  const n = h.days.length;
  const fits = m ? m.fits.filter((f) => f.plausible) : [];
  // capacity at the end of each planned week, per plausible time constant
  const path = (weeks: { tss: number }[], f: { tau: number; a: number; b: number }) => {
    let x = n ? h.ltl(f.tau)[n - 1] : 0;
    return weeks.map((w) => {
      for (let d = 0; d < 7; d++) x += (w.tss / 7 - x) / f.tau;
      return { capacity: capacityAt(f, x), ltl: x };
    });
  };
  const generate = (weeks: number) => {
    const config = { ...base, raceDate: iso(addDays(new Date(), (weeks - 1) * 7)) };
    return { config, weeks: generateSeasonPlan(config, [], prefs.ctlDays, prefs.atlDays) };
  };
  let plan = generate(26);
  let reached = false;
  if (m) {
    for (let w = 4; w <= MAX_PLAN_WEEKS; w++) {
      const p = generate(w);
      const last = path(p.weeks, m).pop()!;
      if (last.capacity >= r.targetCapacity) {
        plan = p;
        reached = true;
        break;
      }
      if (w === 52) plan = p; // not reachable: show a year of it
    }
  }
  const paths = fits.map((f) => ({ f, p: path(plan.weeks, f) }));
  const best = m ? path(plan.weeks, m) : null;
  // when each plausible model gets there: within the plan, or by holding the load after it
  const arrivals = paths.map(({ f, p }) => {
    const k = p.findIndex((x) => x.capacity >= r.targetCapacity);
    if (k >= 0) return iso(addDays(parseISO(plan.weeks[k].weekStart), 6));
    const more = daysToTarget(f, f.tau, p[p.length - 1].ltl, weeklyTss / 7, r.targetCapacity);
    return Number.isFinite(more) && more < 3 * 365 ? iso(addDays(parseISO(plan.weeks[plan.weeks.length - 1].weekStart), 6 + more)) : null;
  });
  const known = arrivals.filter((a): a is string => !!a).sort();
  return {
    config: plan.config,
    weeks: plan.weeks.map((w, k) => ({
      ...w,
      capacity: best ? Math.round(best[k].capacity) : null,
      low: paths.length ? Math.round(Math.min(...paths.map((x) => x.p[k].capacity))) : null,
      high: paths.length ? Math.round(Math.max(...paths.map((x) => x.p[k].capacity))) : null,
    })),
    reached,
    arrival: reached ? iso(addDays(parseISO(plan.weeks[plan.weeks.length - 1].weekStart), 6)) : null,
    arrivalRange: known.length ? [known[0], known[known.length - 1]] : null,
    neverFor: arrivals.length - known.length,
    gentle,
    ridingMonths,
    startCtl,
    holdHours: weeklyTss / tph,
  };
}
