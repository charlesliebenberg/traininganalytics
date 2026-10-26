import { addDays, differenceInCalendarDays, format, parseISO, startOfMonth, subDays, subMonths } from 'date-fns';
import type { PmcPoint, SeasonPlanConfig } from '../shared/types';
import { byEffortDate, classifySession, detectPeaks, effortDate, summarizeBuild } from '../shared/analytics/comeback';
import { capacityAt, daysToTarget, fitCapacity, informative, ltlSeries, type CapacityDay, type CapacityModel } from '../shared/analytics/capacity';
import { compareHrProfiles, hrProfile, type HrBins } from '../shared/analytics/hrprofile';
import { activityHrBins } from './windows';
import { aerobicThenNow } from './aerobic';
import { generateSeasonPlan } from '../shared/analytics/plan';
import { CURVE_DURATIONS } from '../shared/analytics/series';
import { ACTIVITY_LIST_COLUMNS, getPreferences, getSetting, listThresholds, q, rowToActivity, setSetting, thresholdsFor } from './db';
import { curvesInRange, firstActivityDate, pmc } from './aggregate';
import { estimateOn, storedSeries } from './estimates';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const today = () => iso(new Date());
const DAY = 86400_000;
/** a gap in riding at least this long splits the history into eras (and starts a comeback) */
const BREAK_DAYS = 90;
/** breaks this close together are one break: a few rides in the middle of a layoff don't end it */
const BREAK_MERGE_DAYS = 30;
/** "now": the last 90 days, today included */
const RECENT_DAYS = 90;
/** heart rate is recorded on fewer rides, so "now" looks back further for it */
const HR_RECENT_DAYS = 120;
/** a peak's own period: the 8 weeks before it and the 4 after (peaks are at least 4 months apart) */
const PERIOD_BEFORE = 56;
const PERIOD_AFTER = 28;
/** durability: the best 20 minutes after this much work, kJ */
const DURABILITY_KJ = [1000, 1500, 2000, 2500, 3000];
const P20 = CURVE_DURATIONS.indexOf(1200);

const recentFrom = (days = RECENT_DAYS) => iso(subDays(new Date(), days - 1));

/** A peak's own period, up to today: its numbers come from here, never from a neighbouring peak's efforts. */
function periodOf(date: string) {
  const to = iso(addDays(parseISO(date), PERIOD_AFTER));
  return { from: iso(subDays(parseISO(date), PERIOD_BEFORE)), to: to < today() ? to : today() };
}

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

/**
 * Long breaks between ride dates (sorted, distinct): 90 days or more without a ride. Breaks
 * with only a month or less of riding between them are one break — a holiday's spins in the
 * middle of a layoff don't make a comeback.
 */
function breaks(dates: string[]): Gap[] {
  const out: Gap[] = [];
  for (let i = 1; i < dates.length; i++) {
    const days = differenceInCalendarDays(parseISO(dates[i]), parseISO(dates[i - 1])) - 1;
    if (days < BREAK_DAYS) continue;
    const g = { from: iso(addDays(parseISO(dates[i - 1]), 1)), to: iso(subDays(parseISO(dates[i]), 1)), days };
    const prev = out[out.length - 1];
    if (prev && differenceInCalendarDays(parseISO(g.from), parseISO(prev.to)) <= BREAK_MERGE_DAYS) {
      prev.to = g.to;
      prev.days = differenceInCalendarDays(parseISO(g.to), parseISO(prev.from)) + 1;
    } else out.push(g);
  }
  return out;
}

let histCache: History | null = null;
function history(): History {
  if (histCache && Date.now() - histCache.at < 30_000) return histCache;
  const rows = q.all<{ d: string; tss: number; mt: number; p20: number | null }>(
    `SELECT local_date AS d, COALESCE(tss_override, tss, 0) AS tss, moving_time AS mt, json_extract(curves, '$.power[${P20}]') AS p20
     FROM activities WHERE sport = 'ride' ORDER BY local_date`,
  );
  const days: CapacityDay[] = [];
  let hours = new Float64Array(0);
  if (rows.length) {
    const first = parseISO(rows[0].d);
    const n = differenceInCalendarDays(new Date(), first) + 1;
    for (let i = 0; i < n; i++) days.push({ date: iso(addDays(first, i)), load: 0, best: null });
    hours = new Float64Array(n);
    for (const r of rows) {
      const i = differenceInCalendarDays(parseISO(r.d), first);
      if (i < 0 || i >= n) continue;
      days[i].load += r.tss;
      hours[i] += r.mt / 3600;
      if (r.p20) days[i].best = Math.max(days[i].best ?? 0, r.p20);
    }
  }
  const gaps = breaks([...new Set(rows.map((r) => r.d))]);
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

/**
 * The capacity model's view of a peak: capacity then — and each plausible model's own, so the
 * way back asks every model the same question — and how far the best efforts of the peak's
 * period went above the capacity of their day.
 */
function capacityAround(h: History, date: string) {
  const m = h.model;
  if (!m || !h.days.length) return { capacity: null, capacities: null, margin: null };
  const i = dayIndex(h, date);
  const capacity = capacityAt(m, ltlBefore(h, m.tau, i));
  const capacities = m.fits.filter((f) => f.plausible).map((f) => ({ tau: f.tau, capacity: capacityAt(f, ltlBefore(h, f.tau, i)) }));
  let margin: number | null = null;
  for (let j = Math.max(0, i - PERIOD_BEFORE); j <= Math.min(h.days.length - 1, i + PERIOD_AFTER); j++) {
    const b = h.days[j].best;
    if (!b) continue;
    const r = b / capacityAt(m, ltlBefore(h, m.tau, j)) - 1;
    if (margin == null || r > margin) margin = r;
  }
  return { capacity, capacities, margin };
}

const at = (curve: { values: (number | null)[] }, t: number) => curve.values[CURVE_DURATIONS.indexOf(t)] ?? null;

/**
 * The best power actually ridden for each duration in a range, and when. Unlike the app's
 * best-effort curves it isn't made monotonic: an interval session holds more for 25 minutes
 * than for any 20 (a recovery falls in every 20-minute window), and copying the 25 down would
 * show a 20 minutes nobody rode — and a different number from the 20 minutes beside it.
 */
function ridden(from: string, to: string) {
  const values: (number | null)[] = CURVE_DURATIONS.map(() => null);
  const dates: (string | null)[] = CURVE_DURATIONS.map(() => null);
  for (const r of curvesInRange(from, to, 'ride'))
    r.curves.power?.forEach((v, i) => {
      if (v != null && (values[i] == null || v > values[i]!)) {
        values[i] = v;
        dates[i] = r.local_date;
      }
    });
  return { values, dates };
}

function peakCard(date: string, ftp: number | null, extra: { rank?: number; pinned?: boolean; label?: string }) {
  // the estimate these efforts set (the best of them), else the one for the date
  const series = storedSeries('ride');
  const bound = series.filter((e) => effortDate(e) === date);
  const est = bound.length ? bound.reduce((a, b) => (b.raw > a.raw ? b : a)) : (series.find((e) => e.date === date) ?? estimateOn('ride', date));
  const { from, to } = periodOf(date);
  const curve = ridden(from, to);
  const pt = pmcMap().get(date);
  // W/kg only when the athlete has recorded their weight (not the built-in default)
  const weight = listThresholds().length ? thresholdsFor(date).weight : null;
  const f = ftp ?? est?.raw ?? null;
  return {
    date,
    ftp: f != null ? Math.round(f) : null,
    wkg: f != null && weight ? f / weight : null,
    cp: est ? Math.round(est.cp) : null,
    ctl: pt ? Math.round(pt.ctl) : null,
    p5: at(curve, 300),
    p20: at(curve, 1200),
    p60: at(curve, 3600),
    /** the day of the period's best 20 minutes */
    p20Date: curve.dates[P20],
    periodFrom: from,
    periodTo: to,
    ...capacityAround(history(), date),
    ...extra,
  };
}

/**
 * The most the athlete has sustained: the best 12-week average of weekly riding load (and its
 * hours) among blocks that ended before the last six weeks, which are the current load it's
 * measured against.
 */
function sustainedLoad(h: History): { tss: number; hours: number; to: string } | null {
  const W = 84;
  let best: { tss: number; hours: number; to: string } | null = null;
  let tss = 0;
  let hours = 0;
  for (let i = 0; i < h.days.length - 42; i++) {
    tss += h.days[i].load;
    hours += h.hours[i];
    if (i >= W) {
      tss -= h.days[i - W].load;
      hours -= h.hours[i - W];
    }
    if (i >= W - 1 && (!best || tss / 12 > best.tss)) best = { tss: tss / 12, hours: hours / 12, to: h.days[i].date };
  }
  return best;
}

/** Peaks (auto-detected + pinned), where things stand now, and the capacity model. */
export function overview() {
  const series = storedSeries('ride');
  // peaks are seasons gone by: one whose period runs into the last 90 days is "now", not "then"
  const cutoff = iso(subDays(parseISO(recentFrom()), PERIOD_AFTER));
  const auto = detectPeaks(byEffortDate(series).filter((x) => x.date < cutoff), { minGapDays: 120 });
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
  let best20: number | null = null;
  let best20Date: string | null = null;
  for (const d of h.days.slice(Math.max(0, n - RECENT_DAYS))) {
    if (d.best && (best20 == null || d.best > best20)) {
      best20 = d.best;
      best20Date = d.date;
    }
  }
  // the current load: the last six weeks, or the time since the comeback began if that's shorter
  const sinceBack = h.comebackStart ? differenceInCalendarDays(new Date(), parseISO(h.comebackStart)) + 1 : Infinity;
  const loadDays = Math.max(14, Math.min(42, sinceBack));
  const weeklyTss = (h.days.slice(Math.max(0, n - loadDays)).reduce((s, d) => s + d.load, 0) * 7) / loadDays;
  const weeklyHours = (h.hours.slice(Math.max(0, n - loadDays)).reduce((s, x) => s + x, 0) * 7) / loadDays;
  let lastRide: string | null = null;
  for (let i = n - 1; i >= 0 && !lastRide; i--) if (h.hours[i] > 0) lastRide = h.days[i].date;
  const ltlNow = m && n ? h.ltl(m.tau)[n - 1] : null;
  const lastGap = h.gaps[h.gaps.length - 1];
  return {
    peaks,
    pins,
    now: {
      date: today(),
      ftp: latest ? Math.round(latest.threshold) : null,
      rawFtp: latest ? Math.round(latest.raw) : null,
      /** the day of the effort the FTP estimate rests on: old when there's been little hard riding since */
      ftpDate: latest ? effortDate(latest) : null,
      wkg: latest && weight ? latest.threshold / weight : null,
      ctl: nowPt ? Math.round(nowPt.ctl) : null,
      atl: nowPt ? Math.round(nowPt.atl) : null,
      best20,
      best20Date,
      weeklyTss,
      weeklyHours,
      /** days the current load is averaged over */
      loadDays,
      lastRide,
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
          informative: informative(m),
          fits: m.fits.map((f) => ({ ...f, ltlNow: n ? h.ltl(f.tau)[n - 1] : 0 })),
        }
      : null,
    comeback: lastGap && h.comebackStart ? { start: h.comebackStart, breakFrom: lastGap.from, breakDays: lastGap.days } : null,
    ridingMonths: consistentMonths(today()),
    sustained: sustainedLoad(h),
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
  if (from > to) return [];
  const rows = q.all<{ id: number; trainer: number; local_date: string; data: string | null }>(
    `SELECT a.id, a.trainer, a.local_date, h.data FROM activities a LEFT JOIN steady_windows h ON h.activity_id = a.id
     WHERE a.sport = 'ride' AND a.has_power = 1 AND a.has_hr = 1 AND a.local_date BETWEEN ? AND ?`,
    from,
    to,
  );
  return rows.map((r) => ({ indoor: !!r.trainer, bins: activityHrBins(r.id, 'ride', r.local_date, r.data) })).filter((r) => Object.keys(r.bins).length);
}

/**
 * Steady power per heart-rate bin around a peak (6 months before to 2 months after — as long
 * after as before when heart rate was recorded on too few rides) vs the last 4 months. "Then"
 * ends before "now" begins. Outdoor rides only when both periods have enough of them:
 * indoors, heat pushes heart rate up at the same power.
 */
export function hrCompare(date: string) {
  const nowFrom = recentFrom(HR_RECENT_DAYS);
  const lastThen = iso(subDays(parseISO(nowFrom), 1));
  const span = (before: number, after: number): [string, string] => {
    const to = iso(addDays(parseISO(date), after));
    return [iso(subDays(parseISO(date), before)), to < lastThen ? to : lastThen];
  };
  let thenRange = span(182, 60);
  let thenRides = ridesWithBins(...thenRange);
  if (thenRides.length < 3) {
    thenRange = span(182, 182);
    thenRides = ridesWithBins(...thenRange);
  }
  const nowRides = ridesWithBins(nowFrom, today());
  const outdoorOnly = thenRides.filter((r) => !r.indoor).length >= 3 && nowRides.filter((r) => !r.indoor).length >= 3;
  const use = (rs: typeof thenRides) => (outdoorOnly ? rs.filter((r) => !r.indoor) : rs);
  const then = hrProfile(use(thenRides).map((r) => r.bins));
  const now = hrProfile(use(nowRides).map((r) => r.bins));
  return {
    then,
    now,
    comparison: compareHrProfiles(then, now),
    thenRange,
    nowRange: [nowFrom, today()],
    outdoorOnly,
    thenRides: use(thenRides).length,
    nowRides: use(nowRides).length,
    // the same question on the aerobic model: heat, fatigue and indoor riding taken out
    aerobic: aerobicThenNow('ride', date),
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

/**
 * Power around a peak (its own period) against the last 90 days, fresh and deep into a ride:
 * the best 20 minutes after each amount of work, with how many rides went that deep — few
 * means it's untested more than lost.
 */
export function compare(date: string) {
  const { from, to } = periodOf(date);
  const nowFrom = recentFrom();
  const then = ridden(from, to);
  const now = ridden(nowFrom, today());
  const deep = (a: string, b: string) => {
    const rides = curvesInRange(a, b, 'ride');
    return DURABILITY_KJ.map((kj) => {
      const vs = rides.map((r) => r.curves.fatigue?.[kj]?.[P20]).filter((v): v is number => v != null);
      return { value: vs.length ? Math.max(...vs) : null, rides: vs.length };
    });
  };
  return {
    durations: CURVE_DURATIONS,
    then: then.values,
    now: now.values,
    from,
    to,
    nowFrom,
    durability: { kj: DURABILITY_KJ, then: deep(from, to), now: deep(nowFrom, today()) },
  };
}

// ---------- the way back ----------

export interface ComebackRequest {
  /** the weekly load to build to and then hold (TSS) */
  weeklyTss: number;
  /** the peak to get back to: each plausible model aims at its own capacity then */
  peak?: string;
  /** else one capacity for every model: 20-min power (W) */
  targetCapacity?: number;
  initialRamp: number;
  maxRamp: number;
  pattern: SeasonPlanConfig['pattern'];
  mix?: SeasonPlanConfig['mix'];
  tssPerHour?: number;
}

const MAX_PLAN_WEEKS = 104;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** A number from a request, or the default when it's missing or not a number. */
const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

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
  // what the page sends, kept to what the planner can build
  const weeklyTss = clamp(num(r.weeklyTss, 500), 70, 1500);
  const maxRamp = clamp(num(r.maxRamp, 5), 1, 12);
  const initialRamp = clamp(num(r.initialRamp, 3), 0.5, maxRamp);
  const pattern = (['2:1', '3:1', '4:1'] as const).find((p) => p === r.pattern) ?? '3:1';
  const tph = clamp(num(r.tssPerHour, 60), 35, 90);
  const mix =
    r.mix && [r.mix.quality, r.mix.vo2Share, r.mix.longRides, r.mix.days].every((x) => typeof x === 'number' && Number.isFinite(x))
      ? { quality: clamp(r.mix.quality, 0, 5), vo2Share: clamp(r.mix.vo2Share, 0, 1), longRides: clamp(r.mix.longRides, 0, 3), days: clamp(r.mix.days, 1, 7) }
      : undefined;
  const base: SeasonPlanConfig = {
    startDate: today(),
    raceDate: today(),
    startCtl,
    startAtl,
    targetCtl: weeklyTss / 7,
    maxRamp,
    initialRamp: gentle ? initialRamp : undefined,
    initialWeeks: gentle ? 4 : 0,
    pattern,
    taperWeeks: 0,
    // the load is the limit here; leave room for harder phases
    maxWeeklyHours: Math.ceil((weeklyTss / tph) * 1.4),
    sport: 'ride',
    goal: 'fitness',
    mix,
    tssPerHour: tph,
  };
  const n = h.days.length;
  const fits = m ? m.fits.filter((f) => f.plausible) : [];
  // each model's own capacity at the peak — or the one target for all
  const peakAt = r.peak && /^\d{4}-\d{2}-\d{2}$/.test(r.peak) && n ? dayIndex(h, r.peak) : -1;
  const targetFor = (f: { tau: number; a: number; b: number }) => (peakAt >= 0 ? capacityAt(f, ltlBefore(h, f.tau, peakAt)) : num(r.targetCapacity, NaN));
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
  if (m && Number.isFinite(targetFor(m))) {
    for (let w = 4; w <= MAX_PLAN_WEEKS; w++) {
      const p = generate(w);
      const last = path(p.weeks, m).pop()!;
      if (last.capacity >= targetFor(m)) {
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
    const target = targetFor(f);
    if (!Number.isFinite(target)) return null;
    const k = p.findIndex((x) => x.capacity >= target);
    if (k >= 0) return iso(addDays(parseISO(plan.weeks[k].weekStart), 6));
    const more = daysToTarget(f, f.tau, p[p.length - 1].ltl, weeklyTss / 7, target);
    return Number.isFinite(more) && more < 3 * 365 ? iso(addDays(parseISO(plan.weeks[plan.weeks.length - 1].weekStart), 6 + more)) : null;
  });
  const known = arrivals.filter((a): a is string => !!a).sort();
  // each model's capacity relative to its own reading of the peak, in the best model's watts:
  // the band crosses the target when each model says it's reached
  const scale = (f: { tau: number; a: number; b: number }) => {
    const own = targetFor(f);
    const main = m ? targetFor(m) : NaN;
    return own > 0 && main > 0 ? main / own : 1;
  };
  return {
    config: plan.config,
    weeks: plan.weeks.map((w, k) => ({
      ...w,
      capacity: best ? Math.round(best[k].capacity) : null,
      low: paths.length ? Math.round(Math.min(...paths.map((x) => x.p[k].capacity * scale(x.f)))) : null,
      high: paths.length ? Math.round(Math.max(...paths.map((x) => x.p[k].capacity * scale(x.f)))) : null,
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
