import { addDays, differenceInCalendarDays, parseISO, startOfWeek } from 'date-fns';
import { progression, summarizeSet, type Progression, type SessionAnalysis, type SetSummary, type WorkSet } from '../shared/analytics/session';
import { reviewPeriod, weekStats, type ReviewActivity } from '../shared/analytics/review';
import { rideEffortFindings, runEffortFindings, type EffortFinding } from '../shared/analytics/insights';
import { firstActivityDate, curvesInRange, iso, pmc, today } from './aggregate';
import { getPreferences, q, thresholdsFor } from './db';
import { storedSeries } from './estimates';
import { aerobicChange, aerobicScores } from './aerobic';

// ---------- main sets ----------
const setCache: Record<string, { key: string; sets: SetSummary[] }> = {};

/** Every main set of a sport, oldest first (cached until an activity of the sport changes). */
export function allSets(sport: string): SetSummary[] {
  const k = q.get('SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM activities WHERE sport = ? AND session IS NOT NULL', sport);
  const key = `${k?.n}|${k?.u}`;
  if (setCache[sport]?.key === key) return setCache[sport].sets;
  const sets = q
    .all("SELECT id, local_date, session, avg_temp FROM activities WHERE sport = ? AND json_extract(session, '$.main') IS NOT NULL ORDER BY local_date, id", sport)
    .map((r) => summarizeSet(r.id as number, r.local_date as string, JSON.parse(r.session as string) as SessionAnalysis & { main: WorkSet }, r.avg_temp as number | null));
  setCache[sport] = { key, sets };
  return sets;
}

export type SetProgress = Progression & { current: SetSummary };

/** How an activity's main set compared with the comparable sets of the year before it. */
export function setProgression(id: number, sport: string): SetProgress | null {
  const sets = allSets(sport);
  const cur = sets.find((s) => s.id === id);
  if (!cur) return null;
  const p = progression(cur, sets);
  return p ? { ...p, current: cur } : null;
}

/** Main sets in a date range, each with its change on the last comparable set (for the progression chart). */
export function keySets(sport: string, from: string, to: string) {
  const sets = allSets(sport);
  return sets
    .filter((s) => s.date >= from && s.date <= to)
    .map((s) => {
      const p = progression(s, sets);
      return { ...s, change: p?.change ?? null, lastId: p?.last?.id ?? null };
    });
}

// ---------- efforts in context, in bulk ----------
function findingsFor(acts: { id: number; sport: string; date: string; curves: string | null; bestEfforts: string | null }[]): Map<number, EffortFinding[]> {
  const out = new Map<number, EffortFinding[]>();
  const rides = acts.filter((a) => a.sport === 'ride' && a.curves);
  if (rides.length) {
    const history = curvesInRange('0000-01-01', '9999-12-31', 'ride').map((r) => ({ id: r.id, date: r.local_date, power: r.curves.power, fatigue: r.curves.fatigue }));
    const models = storedSeries('ride');
    for (const a of rides) {
      const c = JSON.parse(a.curves!);
      const est = models.filter((e) => e.date <= a.date).pop();
      out.set(a.id, rideEffortFindings({ date: a.date, power: c.power, fatigue: c.fatigue }, history.filter((h) => h.id !== a.id), est ? { cp: est.cp, wPrime: est.wPrime } : null));
    }
  }
  const runs = acts.filter((a) => a.sport === 'run' && a.bestEfforts);
  if (runs.length) {
    const history = q.all("SELECT id, local_date, best_efforts FROM activities WHERE sport = 'run' AND best_efforts IS NOT NULL").map((r) => ({ id: r.id as number, date: r.local_date as string, efforts: JSON.parse(r.best_efforts as string) }));
    for (const a of runs) out.set(a.id, runEffortFindings({ date: a.date, efforts: JSON.parse(a.bestEfforts!) }, history.filter((h) => h.id !== a.id)));
  }
  return out;
}

// ---------- training review ----------
const LONG_MIN_WEEKS = 4;

/**
 * Review the week containing `date` (or the `weeks` weeks ending with it): load against the
 * athlete's normal over the weeks before, the sessions, how the key ones compared with the
 * last time, fitness signals and recovery.
 */
export function trainingReview(date: string, weeks: number) {
  const prefs = getPreferences();
  const weekStart = startOfWeek(parseISO(date), { weekStartsOn: prefs.weekStart });
  const from = iso(addDays(weekStart, -(weeks - 1) * 7));
  const to = iso(addDays(weekStart, 6));
  const t = today();
  const end = to < t ? to : t;
  if (end < from) return null;
  const days = differenceInCalendarDays(parseISO(end), parseISO(from)) + 1;
  // the athlete's normal: the weeks before (at least four), but not before they started
  const first = firstActivityDate();
  const bw = Math.max(LONG_MIN_WEEKS, weeks);
  const bFrom = iso(addDays(parseISO(from), -bw * 7));
  const baseWeeks = first ? Math.min(bw, Math.floor(differenceInCalendarDays(parseISO(from), parseISO(first)) / 7)) : 0;

  const rows = q.all(
    `SELECT id, local_date, sport, name, moving_time, COALESCE(tss_override, tss, 0) AS tss, zones, session, curves, best_efforts
     FROM activities WHERE local_date BETWEEN ? AND ? ORDER BY start_time`,
    bFrom,
    end,
  );
  const parse = (r: (typeof rows)[number]) => {
    const s = r.session ? (JSON.parse(r.session as string) as SessionAnalysis) : null;
    return {
      id: r.id as number,
      date: r.local_date as string,
      sport: r.sport as string,
      name: r.name as string,
      moving: r.moving_time as number,
      tss: r.tss as number,
      type: s?.type ?? null,
      long: !!s?.long,
      seiler: r.zones ? ((JSON.parse(r.zones as string).seiler as number[] | undefined) ?? null) : null,
      main: !!s?.main,
      curves: r.curves as string | null,
      bestEfforts: r.best_efforts as string | null,
    };
  };
  const all = rows.map(parse);
  const inPeriod = all.filter((a) => a.date >= from);
  const before = all.filter((a) => a.date < from && a.date >= iso(addDays(parseISO(from), -baseWeeks * 7)));

  const findings = findingsFor(inPeriod);
  const scores = { ride: aerobicScores('ride'), run: aerobicScores('run') };
  const acts: ReviewActivity[] = inPeriod.map((a) => {
    let set: ReviewActivity['set'] = null;
    if (a.main) {
      const p = setProgression(a.id, a.sport);
      const cur = p?.current ?? allSets(a.sport).find((s) => s.id === a.id);
      if (cur) set = { ...cur, change: p?.change ?? null, hrChange: p?.hrChange ?? null, rank: p?.rank ?? 1, of: p?.of ?? 1, lastDate: p?.last?.date ?? null, lastOut: p?.last?.out ?? null };
    }
    const sc = a.sport === 'ride' || a.sport === 'run' ? scores[a.sport].get(a.id) : undefined;
    return { id: a.id, date: a.date, sport: a.sport, name: a.name, moving: a.moving, tss: a.tss, type: a.type, long: a.long, set, findings: findings.get(a.id) ?? [], z: sc?.z ?? null, zFitness: sc?.zFitness ?? null, seiler: a.seiler };
  });

  let baseline = null;
  if (baseWeeks >= 2) {
    const s = weekStats(before, baseWeeks * 7);
    baseline = { weeks: baseWeeks, tss: s.tss / baseWeeks, hours: s.hours / baseWeeks, sessions: s.sessions / baseWeeks, hard: s.hard / baseWeeks, long: s.long / baseWeeks, intensity: s.intensity, restDays: s.restDays / baseWeeks };
  }
  // weeks in a row, going back, that held a long session
  let longStreak = 0;
  for (let w = 1; w <= baseWeeks; w++) {
    const ws = iso(addDays(parseISO(from), -w * 7));
    const we = iso(addDays(parseISO(from), -(w - 1) * 7 - 1));
    if (before.some((a) => a.long && a.date >= ws && a.date <= we)) longStreak++;
    else break;
  }

  const p = pmc(iso(addDays(parseISO(from), -1)), end);
  const p0 = p[0];
  const p1 = p[p.length - 1];
  const ride = aerobicChange('ride', from, end);
  const run = aerobicChange('run', from, end);
  const aerobic = ride && (!run || ride.readings >= run.readings) ? ride : run;
  const ftp0 = thresholdsFor(from).ftp;
  const ftp1 = thresholdsFor(end).ftp;
  const review = reviewPeriod({
    from,
    to,
    weeks,
    days,
    acts,
    baseline,
    ctl: [p0?.ctl ?? 0, p1?.ctl ?? 0],
    atl: p1?.atl ?? 0,
    tsb: p1?.tsb ?? 0,
    aerobic: aerobic ? { sport: aerobic.sport, pct: aerobic.pct, sdPct: aerobic.sdPct } : null,
    ftp: inPeriod.some((a) => a.sport === 'ride') ? [ftp0, ftp1] : null,
    longStreak,
  });
  const daily = Array.from({ length: weeks * 7 }, (_, i) => {
    const d = iso(addDays(parseISO(from), i));
    const list = acts.filter((a) => a.date === d);
    return { date: d, future: d > end, tss: list.reduce((s, a) => s + a.tss, 0), acts: list.map((a) => ({ id: a.id, sport: a.sport, name: a.name, type: a.type, long: a.long, tss: Math.round(a.tss), moving: a.moving })) };
  });
  const pmcDaily = p.slice(1).map((x) => ({ date: x.date, ctl: x.ctl, atl: x.atl, tsb: x.tsb }));
  return { from, to, end, weeks, days, review, daily, pmc: pmcDaily, baseline };
}

export type TrainingReview = NonNullable<ReturnType<typeof trainingReview>>;
