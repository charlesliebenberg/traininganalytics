/**
 * "Comeback" analytics: find past performance peaks and describe the training that led to
 * them. How load turns into performance lives in capacity.ts.
 */
import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek } from 'date-fns';
import type { Activity, PmcPoint } from '../types';
import { polarizationIndex } from './zones';

// ---------- session classification ----------

export type SessionType = 'recovery' | 'endurance' | 'tempo' | 'threshold' | 'vo2' | 'anaerobic' | 'race';
export const SESSION_TYPES: SessionType[] = ['recovery', 'endurance', 'tempo', 'threshold', 'vo2', 'anaerobic', 'race'];
export const SESSION_LABEL: Record<SessionType, string> = {
  recovery: 'Recovery',
  endurance: 'Endurance',
  tempo: 'Tempo / sweet spot',
  threshold: 'Threshold',
  vo2: 'VO2max',
  anaerobic: 'Anaerobic',
  race: 'Race',
};
/** Sessions that count as "quality" (structured hard work). */
export const QUALITY: SessionType[] = ['tempo', 'threshold', 'vo2', 'anaerobic', 'race'];

const RACE_NAME = /\b(race|crit|criterium|fondo|gran fondo|tt|time ?trial|cup|champs?|championships?|classic|hill ?climb|road race|kermesse|stage)\b/i;
const LONG_RIDE_S = 3 * 3600;

type SessionInput = Pick<Activity, 'sport' | 'name' | 'movingTime' | 'intensity' | 'zones'>;

/**
 * Label a session from its intensity factor and time in zones (power zones for rides with
 * power, heart-rate zones otherwise). Thresholds are deliberately simple and readable:
 *  - race: race-like name with IF ≥ 0.8, or IF ≥ 0.95 for 40+ min, or IF ≥ 0.9 for 2.5+ h
 *  - VO2max: ≥ 8 min above 105 % FTP (power Z5) / above LTHR+3 % (HR Z5b+)
 *  - anaerobic: ≥ 4 min in power Z6–Z7
 *  - threshold: ≥ 15 min in Z4
 *  - tempo / sweet spot: ≥ 20 min in Z3–Z4
 *  On long rides the minimums scale with duration (≥ 4 % / 10 % / 25 % of the ride), so a
 *  hilly endurance ride doesn't count as an interval session just because climbs add up.
 *  - recovery: IF < 0.6 and under 75 min
 *  - otherwise endurance
 */
export function classifySession(a: SessionInput): SessionType {
  const IF = a.intensity ?? 0;
  const mins = a.movingTime / 60;
  if ((RACE_NAME.test(a.name) && IF >= 0.8) || (IF >= 0.95 && mins >= 40) || (IF >= 0.9 && mins >= 150)) return 'race';
  const p = a.zones?.power;
  const h = a.zones?.hr;
  if (p && p.reduce((x, y) => x + y, 0) > 0) {
    const m = p.map((s) => s / 60);
    if (m[4] >= Math.max(8, mins * 0.04)) return 'vo2';
    if (m[5] + m[6] >= Math.max(4, mins * 0.02)) return 'anaerobic';
    if (m[3] >= Math.max(15, mins * 0.1)) return 'threshold';
    if (m[2] + m[3] >= Math.max(20, mins * 0.25)) return 'tempo';
  } else if (h && h.reduce((x, y) => x + y, 0) > 0) {
    // Friel HR zones: Z1 Z2 Z3 Z4 Z5a Z5b Z5c
    const m = h.map((s) => s / 60);
    if (m[5] + m[6] >= Math.max(6, mins * 0.04)) return 'vo2';
    if (m[3] + m[4] >= Math.max(15, mins * 0.1)) return 'threshold';
    if (m[2] + m[3] >= Math.max(20, mins * 0.25)) return 'tempo';
  } else if (IF >= 0.85) return 'threshold';
  else if (IF >= 0.76) return 'tempo';
  if (IF > 0 && IF < 0.6 && mins < 75) return 'recovery';
  return 'endurance';
}

// ---------- peaks ----------

export interface Peak {
  date: string;
  value: number;
  /** rank among detected peaks (1 = highest) */
  rank: number;
  pinned?: boolean;
  label?: string;
}

/**
 * Pick the highest points of a weekly series that are at least `minGapDays` apart, so a
 * long block of good form counts once and separate seasons each get their own peak.
 */
export function detectPeaks(series: { date: string; value: number }[], opts: { minGapDays?: number; max?: number; minRatio?: number } = {}): Peak[] {
  const { minGapDays = 180, max = 6, minRatio = 0.85 } = opts;
  if (!series.length) return [];
  const best = Math.max(...series.map((s) => s.value));
  const sorted = [...series].sort((a, b) => b.value - a.value);
  const picks: { date: string; value: number }[] = [];
  for (const s of sorted) {
    if (s.value < best * minRatio || picks.length >= max) break;
    if (picks.some((p) => Math.abs(differenceInCalendarDays(parseISO(p.date), parseISO(s.date))) < minGapDays)) continue;
    picks.push(s);
  }
  return picks.map((p, i) => ({ ...p, rank: i + 1 })).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- the build-up to a peak ----------

export interface BuildWeek {
  weekStart: string;
  tss: number;
  hours: number;
  rides: number;
  days: number;
  sessions: Record<SessionType, number>;
  longRides: number;
  ctl: number | null;
}

export interface SessionMix {
  /** quality sessions per week (tempo, threshold, VO2, anaerobic, race) */
  quality: number;
  /** share of quality sessions that are VO2max / anaerobic */
  vo2Share: number;
  /** long rides (3 h+) per week */
  longRides: number;
  /** training days per week */
  days: number;
}

export interface BuildSummary {
  from: string;
  to: string;
  weeks: BuildWeek[];
  avgHours: number;
  avgTss: number;
  /** mechanical work per week (kJ): unlike TSS, independent of the FTP at the time */
  avgKj: number;
  /** consecutive months (up to the date) with at least ~15 h of riding; filled in by the server */
  consistentMonths?: number;
  /** best 4-week average weekly TSS */
  peakBlockTss: number;
  ctlStart: number | null;
  ctlPeak: number | null;
  tsbAtPeak: number | null;
  /** mean CTL gain per week across the build */
  avgRamp: number | null;
  maxRamp: number | null;
  /** typical load-cycle length if a recovery-week rhythm is visible (e.g. 4 → "3:1") */
  cycle: number | null;
  daysPerWeek: number;
  missedWeeks: number;
  longestBreak: number;
  sessionsPerWeek: Record<SessionType, number>;
  mix: SessionMix;
  seiler: number[];
  polarization: number | null;
  longRide: { perWeek: number; avgHours: number; longestHours: number };
  keySessions: { id: number; date: string; name: string; type: SessionType; tss: number; minutes: number; intensity: number | null }[];
}

const emptySessions = () => Object.fromEntries(SESSION_TYPES.map((t) => [t, 0])) as Record<SessionType, number>;
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/**
 * Summarise the training in [to − weeks, to): load, ramp, rhythm, session mix, intensity
 * distribution, long rides and consistency. `pmc` must cover the window (daily points).
 */
export function summarizeBuild(acts: Activity[], pmc: PmcPoint[], to: string, weeks: number, sport = 'ride'): BuildSummary {
  const end = parseISO(to);
  const start = startOfWeek(addDays(end, -weeks * 7), { weekStartsOn: 1 });
  const from = iso(start);
  const inWin = acts.filter((a) => a.localDate >= from && a.localDate < to);
  const pmcByDate = new Map(pmc.map((p) => [p.date, p]));
  const rows: BuildWeek[] = [];
  for (let w = start; w < end; w = addDays(w, 7)) {
    const ws = iso(w);
    const we = iso(addDays(w, 7));
    const wa = inWin.filter((a) => a.localDate >= ws && a.localDate < we);
    const sport_ = wa.filter((a) => a.sport === sport);
    const sessions = emptySessions();
    sport_.forEach((a) => sessions[classifySession(a)]++);
    const lastDay = iso(addDays(w, 6)) < to ? iso(addDays(w, 6)) : iso(addDays(end, -1));
    rows.push({
      weekStart: ws,
      tss: wa.reduce((s, a) => s + (a.tss ?? 0), 0),
      hours: wa.reduce((s, a) => s + a.movingTime, 0) / 3600,
      rides: sport_.length,
      days: new Set(wa.map((a) => a.localDate)).size,
      sessions,
      longRides: sport_.filter((a) => a.movingTime >= LONG_RIDE_S).length,
      ctl: pmcByDate.get(lastDay)?.ctl ?? null,
    });
  }
  const n = rows.length || 1;
  const sum = (f: (r: BuildWeek) => number) => rows.reduce((s, r) => s + f(r), 0);
  let peakBlockTss = 0;
  for (let i = 0; i + 4 <= rows.length; i++) peakBlockTss = Math.max(peakBlockTss, rows.slice(i, i + 4).reduce((s, r) => s + r.tss, 0) / 4);

  const ctlStart = pmcByDate.get(iso(addDays(start, -1)))?.ctl ?? pmcByDate.get(from)?.ctl ?? null;
  const peakPt = pmcByDate.get(to) ?? pmcByDate.get(iso(addDays(end, -1)));
  const ramps: number[] = [];
  rows.forEach((r, i) => {
    const prev = i ? rows[i - 1].ctl : ctlStart;
    if (r.ctl != null && prev != null) ramps.push(r.ctl - prev);
  });

  // recovery-week rhythm: weeks well below the previous three, and the spacing between them
  const lows: number[] = [];
  rows.forEach((r, i) => {
    if (i < 3) return;
    const prev = (rows[i - 1].tss + rows[i - 2].tss + rows[i - 3].tss) / 3;
    if (prev > 0 && r.tss < prev * 0.72) lows.push(i);
  });
  let cycle: number | null = null;
  if (lows.length >= 2) {
    const gaps = lows.slice(1).map((v, i) => v - lows[i]).sort((a, b) => a - b);
    const med = gaps[Math.floor(gaps.length / 2)];
    if (med >= 2 && med <= 6) cycle = med;
  }

  // consistency
  const days = [...new Set(inWin.map((a) => a.localDate))].sort();
  let longestBreak = 0;
  for (let i = 1; i < days.length; i++) longestBreak = Math.max(longestBreak, differenceInCalendarDays(parseISO(days[i]), parseISO(days[i - 1])) - 1);

  const sessionsPerWeek = emptySessions();
  for (const t of SESSION_TYPES) sessionsPerWeek[t] = sum((r) => r.sessions[t]) / n;
  const quality = QUALITY.reduce((s, t) => s + sessionsPerWeek[t], 0);
  const hard = sessionsPerWeek.vo2 + sessionsPerWeek.anaerobic;

  const seiler = [0, 0, 0];
  inWin.filter((a) => a.sport === sport).forEach((a) => a.zones?.seiler?.forEach((s, i) => (seiler[i] += s)));

  const long = inWin.filter((a) => a.sport === sport && a.movingTime >= LONG_RIDE_S);
  const keySessions = inWin
    .filter((a) => a.sport === sport)
    .map((a) => ({ a, type: classifySession(a) }))
    .filter((x) => QUALITY.includes(x.type) || x.a.movingTime >= LONG_RIDE_S)
    .sort((x, y) => (y.a.tss ?? 0) - (x.a.tss ?? 0))
    .slice(0, 10)
    .map(({ a, type }) => ({ id: a.id, date: a.localDate, name: a.name, type, tss: Math.round(a.tss ?? 0), minutes: Math.round(a.movingTime / 60), intensity: a.intensity }));

  return {
    from,
    to,
    weeks: rows,
    avgHours: sum((r) => r.hours) / n,
    avgTss: sum((r) => r.tss) / n,
    avgKj: inWin.filter((a) => a.sport === sport).reduce((s, a) => s + (a.work ?? 0), 0) / n,
    peakBlockTss,
    ctlStart,
    ctlPeak: peakPt?.ctl ?? null,
    tsbAtPeak: peakPt?.tsb ?? null,
    avgRamp: ramps.length ? ramps.reduce((s, x) => s + x, 0) / ramps.length : null,
    maxRamp: ramps.length ? Math.max(...ramps) : null,
    cycle,
    daysPerWeek: sum((r) => r.days) / n,
    missedWeeks: rows.filter((r) => r.days < 2).length,
    longestBreak,
    sessionsPerWeek,
    mix: { quality, vo2Share: quality > 0 ? Math.min(1, hard / quality) : 0, longRides: long.length / n, days: sum((r) => r.days) / n },
    seiler,
    polarization: polarizationIndex(seiler),
    longRide: {
      perWeek: long.length / n,
      avgHours: long.length ? long.reduce((s, a) => s + a.movingTime, 0) / long.length / 3600 : 0,
      longestHours: long.length ? Math.max(...long.map((a) => a.movingTime)) / 3600 : 0,
    },
    keySessions,
  };
}

// ---------- dating estimates by their efforts ----------

/**
 * When an estimate was actually earned: the day after its most recent effort. A 6-month
 * rolling estimate keeps reporting old efforts long after training stops, so its own date
 * says little about when the athlete was that fit.
 */
export function effortDate(e: { date: string; points?: { date: string | null }[] }): string {
  const last = (e.points ?? []).map((p) => p.date).filter((d): d is string => !!d).sort().pop();
  return last ? iso(addDays(parseISO(last), 1)) : e.date;
}

/** One value per distinct effort date (the best estimate that relied on it), dated by effortDate. */
export function byEffortDate<T extends { date: string; raw: number; points?: { date: string | null }[] }>(estimates: T[]): { date: string; value: number }[] {
  const best = new Map<string, number>();
  for (const e of estimates) {
    const d = effortDate(e);
    best.set(d, Math.max(best.get(d) ?? 0, e.raw));
  }
  return [...best].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
}
