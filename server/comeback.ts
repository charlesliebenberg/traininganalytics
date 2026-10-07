import { addDays, format, parseISO, subDays, subMonths } from 'date-fns';
import type { PmcPoint, SeasonPlanConfig } from '../shared/types';
import { byEffortDate, ctlForFtp, detectPeaks, effortDate, fitLoadModel, summarizeBuild, type LoadModel } from '../shared/analytics/comeback';
import { generateSeasonPlan } from '../shared/analytics/plan';
import { CURVE_DURATIONS } from '../shared/analytics/series';
import { ACTIVITY_LIST_COLUMNS, getPreferences, getSetting, listThresholds, q, rowToActivity, setSetting, thresholdsFor } from './db';
import { aggregateCurve, firstActivityDate, pmc } from './aggregate';
import { estimateOn, storedSeries } from './estimates';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const today = () => iso(new Date());

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
    ...extra,
  };
}

/** Peaks (auto-detected + pinned), current state and the load model. */
export function overview() {
  const series = storedSeries('ride');
  const auto = detectPeaks(byEffortDate(series), { minGapDays: 120 });
  const pins = getPins();
  const peaks = [
    ...auto.filter((p) => !pins.some((x) => Math.abs(parseISO(x.date).getTime() - parseISO(p.date).getTime()) < 28 * 86400_000)).map((p) => peakCard(p.date, p.value, { rank: p.rank })),
    ...pins.map((p) => peakCard(p.date, null, { pinned: true, label: p.label })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const map = pmcMap();
  const model = fitLoadModel(series, (d) => map.get(d)?.ctl ?? null);
  const recentModel = loadModelSince(series, iso(subDays(new Date(), 365)));
  const latest = series.filter((e) => e.date <= today()).pop() ?? null;
  const nowPt = map.get(today()) ?? [...map.values()].pop();
  const weight = listThresholds().length ? thresholdsFor(today()).weight : null;
  return {
    peaks,
    pins,
    model,
    recentModel,
    now: {
      date: today(),
      ftp: latest ? Math.round(latest.threshold) : null,
      rawFtp: latest ? Math.round(latest.raw) : null,
      wkg: latest && weight ? latest.threshold / weight : null,
      ctl: nowPt ? Math.round(nowPt.ctl) : null,
      atl: nowPt ? Math.round(nowPt.atl) : null,
    },
  };
}

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

export interface ComebackRequest {
  targetCtl: number;
  maxWeeklyHours: number;
  initialRamp: number;
  maxRamp: number;
  pattern: SeasonPlanConfig['pattern'];
  mix?: SeasonPlanConfig['mix'];
  tssPerHour?: number;
}

/**
 * Shortest fitness-goal plan (no race taper) that reaches the target CTL within the ramp
 * and hours limits, plus the FTP the athlete's own load model predicts along the way.
 */
export function planPreview(r: ComebackRequest) {
  const map = pmcMap();
  const nowPt = map.get(today()) ?? [...map.values()].pop();
  const startCtl = Math.round(nowPt?.ctl ?? 20);
  const startAtl = Math.round(nowPt?.atl ?? 20);
  const prefs = getPreferences();
  // the gentle first month is for coming back from a break, not for someone already riding regularly
  const ridingMonths = consistentMonths(today());
  const gentle = ridingMonths < 3;
  const base: SeasonPlanConfig = {
    startDate: today(),
    raceDate: today(),
    startCtl,
    startAtl,
    targetCtl: r.targetCtl,
    maxRamp: r.maxRamp,
    initialRamp: gentle ? r.initialRamp : undefined,
    initialWeeks: gentle ? 4 : 0,
    pattern: r.pattern,
    taperWeeks: 0,
    maxWeeklyHours: r.maxWeeklyHours,
    sport: 'ride',
    goal: 'fitness',
    mix: r.mix,
    tssPerHour: r.tssPerHour ? Math.max(35, Math.min(90, r.tssPerHour)) : undefined,
  };
  type Candidate = { config: SeasonPlanConfig; weeks: ReturnType<typeof generateSeasonPlan>; end: number };
  const tried: Candidate[] = [];
  let hit: Candidate | null = null;
  for (let n = 3; n <= 78; n++) {
    const config = { ...base, raceDate: iso(addDays(new Date(), (n - 1) * 7)) };
    const weeks = generateSeasonPlan(config, [], prefs.ctlDays, prefs.atlDays);
    const c = { config, weeks, end: weeks[weeks.length - 1].ctl };
    tried.push(c);
    if (c.end >= r.targetCtl - 1) {
      hit = c;
      break;
    }
  }
  // unreachable within the limits: the shortest plan that gets within 1 CTL of the best achievable
  const maxEnd = Math.max(...tried.map((c) => c.end));
  const best = hit ?? tried.find((c) => c.end >= maxEnd - 1)!;
  const weeks = best.weeks;
  const reached = !!hit;
  // how FTP responds to load *now* beats the all-time fit when there's enough recent data
  const series = storedSeries('ride');
  const model = loadModelSince(series, iso(subDays(new Date(), 365))) ?? fitLoadModel(series, (d) => map.get(d)?.ctl ?? null);
  // steady-state hours needed to hold the target at an endurance-heavy IF ≈ 0.72
  const hoursToHold = (r.targetCtl * 7) / (base.tssPerHour ?? 0.72 ** 2 * 100);
  return {
    config: best.config,
    weeks: weeks.map((w) => ({ ...w, ftp: model ? Math.round(model.a + model.b * w.ctl) : null })),
    reached,
    gentle,
    ridingMonths,
    startCtl,
    hoursToHold,
    ftpAtTarget: model ? Math.round(model.a + model.b * r.targetCtl) : null,
  };
}

/** The load model fitted on efforts since a date only (e.g. the current comeback). */
function loadModelSince(series: ReturnType<typeof storedSeries>, since: string): LoadModel | null {
  const map = pmcMap();
  return fitLoadModel(
    series.filter((e) => effortDate(e) >= since),
    (d) => map.get(d)?.ctl ?? null,
  );
}

export const ctlForTarget = (model: LoadModel | null, ftp: number) => (model ? ctlForFtp(model, ftp) : null);
