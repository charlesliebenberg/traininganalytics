/**
 * The journal: the training week by week, newest first, everything about each week in one place —
 * its review (load against your normal, the sessions, signs of fitness, what to watch), the plan
 * against what was ridden (done, missed, still to come), fitness, form and FTP across it, and how
 * you slept. Runs of weeks without training fold into one gap.
 */
import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek, subDays } from 'date-fns';
import { readNight } from '../shared/analytics/sleep';
import { getPreferences, listNights, q, thresholdsFor } from './db';
import { dailyLoads, firstActivityDate, pmc, today } from './aggregate';
import { trainingReview } from './sessions';
import { trainerRoadPlan } from './trainerroad-insights';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const avg = (xs: (number | null | undefined)[]) => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};

export function journal(before: string | null, count = 6) {
  const t = today();
  const prefs = getPreferences();
  const startOf = (d: string) => iso(startOfWeek(parseISO(d), { weekStartsOn: prefs.weekStart }));
  const first = firstActivityDate();
  if (!first) return { weeks: [], next: null, season: null };
  const firstWeek = startOf(first);
  const phases = (trainerRoadPlan()?.phases ?? []) as { name: string | null; start: string | null; end: string | null }[];
  const seasonPlan = q.get<{ weeks: string }>('SELECT weeks FROM season_plans ORDER BY id DESC LIMIT 1');
  const planWeeks = seasonPlan ? (JSON.parse(seasonPlan.weeks) as { weekStart: string; phase: string }[]) : [];

  type Entry = NonNullable<ReturnType<typeof weekOf>> | { gap: true; from: string; to: string; weeks: number };
  const out: Entry[] = [];
  let ws = before ? iso(subDays(parseISO(startOf(before)), 7)) : startOf(t);
  let found = 0;
  let empty: string[] = [];
  const flush = () => {
    if (!empty.length) return;
    out.push({ gap: true, from: empty[empty.length - 1], to: iso(addDays(parseISO(empty[0]), 6)), weeks: empty.length });
    empty = [];
  };
  while (found < count && ws >= firstWeek) {
    const we = iso(addDays(parseISO(ws), 6));
    const n = q.get<{ n: number }>('SELECT (SELECT COUNT(*) FROM activities WHERE local_date BETWEEN ? AND ?) + (SELECT COUNT(*) FROM planned_workouts WHERE date BETWEEN ? AND ?) AS n', ws, we, ws, we)?.n ?? 0;
    if (!n) empty.push(ws);
    else {
      flush();
      const w = weekOf(ws, we, t, phases, planWeeks);
      if (w) {
        out.push(w);
        found++;
      }
    }
    ws = iso(subDays(parseISO(ws), 7));
  }
  // the loop only stops inside a gap when history runs out: then the gap is the last thing shown
  const more = ws >= firstWeek;
  if (!more) flush();
  const lastWeek = [...out].reverse().find((e): e is NonNullable<ReturnType<typeof weekOf>> => !('gap' in e));
  return {
    weeks: out,
    /** the week to ask for earlier weeks before, when there are any */
    next: more && lastWeek ? lastWeek.start : null,
    season: before ? null : season(t, startOf),
  };
}

/** One week, with everything about it. */
function weekOf(ws: string, we: string, t: string, phases: { name: string | null; start: string | null; end: string | null }[], planWeeks: { weekStart: string; phase: string }[]) {
  const r = trainingReview(ws, 1);
  if (!r) return null;
  const dayBefore = iso(subDays(parseISO(ws), 1));
  const pts = pmc(dayBefore, r.end);
  const p0 = pts[0];
  const p1 = pts[pts.length - 1];

  // the plan against what was ridden: each planned workout done, missed, or still to come
  const planned = q
    .all<{ id: number; date: string; sport: string; title: string; tss: number | null; dur: number | null; activity_id: number | null; source: string | null }>(
      'SELECT id, date, sport, title, planned_tss AS tss, planned_duration AS dur, activity_id, source FROM planned_workouts WHERE date BETWEEN ? AND ? ORDER BY date, sort_order',
      ws,
      we,
    )
    .map((p) => ({ id: p.id, date: p.date, sport: p.sport, title: p.title, tss: p.tss, duration: p.dur, done: p.activity_id != null, missed: p.activity_id == null && p.date < t, source: p.source }));

  // sleep: the week's nights, and the last one against the athlete's normal
  const nights = listNights(iso(subDays(parseISO(ws), 75)), we);
  const week = nights.filter((n) => n.date >= ws && n.date <= we);
  const read = week.length ? readNight(nights, week[week.length - 1].date) : null;
  const sleep = week.length
    ? {
        nights: week.length,
        asleep: avg(week.map((n) => n.asleep)),
        typical: read?.asleep?.typical ?? null,
        score: avg(week.map((n) => n.score)),
        hrv: avg(week.map((n) => n.hrv)),
        hr: avg(week.map((n) => n.hr)),
        hrvStatus: read?.hrv?.status ?? null,
        hrvVsNormal: read?.hrv?.rollingVsNormal ?? null,
        hrStatus: read?.hr?.status ?? null,
        call: read?.call ?? null,
      }
    : null;

  const phase = phases.find((p) => p.start && p.start <= we && (!p.end || p.end >= ws))?.name ?? planWeeks.find((w) => w.weekStart === ws)?.phase ?? null;
  return {
    start: ws,
    end: we,
    partial: r.end < we,
    phase,
    review: r.review,
    baseline: r.baseline,
    daily: r.daily,
    // form as the PMC has it everywhere: going into the week's last day (or today)
    pmc: { ctl0: p0?.ctl ?? null, ctl1: p1?.ctl ?? null, atl1: p1?.atl ?? null, tsb1: p1?.tsb ?? null },
    ftp: [thresholdsFor(dayBefore).ftp, thresholdsFor(r.end).ftp] as [number, number],
    planned,
    sleep,
  };
}

/** The last 26 weeks at a glance: load, fitness and FTP, week by week. */
function season(t: string, startOf: (d: string) => string) {
  const to = t;
  const from = iso(subDays(parseISO(startOf(t)), 25 * 7));
  const loads = dailyLoads(from, to);
  const pts = new Map(pmc(from, to).map((p) => [p.date, p]));
  const weeks: { start: string; tss: number; hours: number; ctl: number | null; ftp: number }[] = [];
  for (let ws = from; ws <= to; ws = iso(addDays(parseISO(ws), 7))) {
    const we = iso(addDays(parseISO(ws), 6));
    const end = we < t ? we : t;
    const days = loads.filter((l) => l.date >= ws && l.date <= we);
    weeks.push({
      start: ws,
      tss: Math.round(days.reduce((s, l) => s + l.tss, 0)),
      hours: Math.round((days.reduce((s, l) => s + l.duration, 0) / 3600) * 10) / 10,
      ctl: pts.get(end)?.ctl ?? null,
      ftp: thresholdsFor(end).ftp,
    });
  }
  return { weeks, days: differenceInCalendarDays(parseISO(to), parseISO(from)) + 1 };
}
