/**
 * The plan ahead, in one place for every page: the training planned (TrainerRoad's, or any
 * other), how closely it's been followed, where it leads fitness and form by the goal race,
 * and two FTP outlooks kept apart: this app's own (its capacity model, riding the planned load)
 * and TrainerRoad's (its FTP and AI FTP's prediction, as TrainerRoad has them). Neither feeds
 * the other; the plan's load is the only thing they share.
 */
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { formZone } from '../shared/analytics/pmc';
import { compareFtp, valueOn, type FtpPoint } from '../shared/analytics/trainerroad';
import { getPreferences, q, rowToEvent } from './db';
import { dailyLoads, pmc, today } from './aggregate';
import { storedSeries } from './estimates';
import { capacityPath } from './comeback';
import { trainerRoadFtp, trainerRoadPlan } from './trainerroad-insights';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
/** weeks of the plan already ridden that are weighed */
const PAST_WEEKS = 8;
/** how far ahead an FTP outlook is drawn when the plan runs on longer */
const MAX_DAYS = 26 * 7;

export interface OutlookWeek {
  start: string;
  end: string;
  /** TrainerRoad's phase that week */
  phase: string | null;
  /** rideTss: the riding in it, the load the capacity model counts */
  planned: { tss: number; rideTss: number; seconds: number; n: number };
  /** what was ridden (all activities) and, of the planned workouts gone by, those done and not */
  done: { tss: number; seconds: number; n: number };
  completed: number;
  missed: number;
  /** past, under way, or to come */
  when: 'past' | 'now' | 'ahead';
}

export interface FtpPathPoint {
  date: string;
  value: number;
  low: number;
  high: number;
}

export function planOutlook() {
  const t = today();
  const weekStart = getPreferences().weekStart;
  const startOf = (d: string) => {
    const x = parseISO(d);
    return iso(subDays(x, (x.getDay() - weekStart + 7) % 7));
  };
  const span = q.get<{ first: string | null; last: string | null; lastRide: string | null; tr: number }>(
    "SELECT MIN(date) AS first, MAX(date) AS last, MAX(CASE WHEN sport = 'ride' THEN date END) AS lastRide, SUM(source = 'trainerroad') AS tr FROM planned_workouts",
  );
  const ahead = q.get<{ n: number }>('SELECT COUNT(*) AS n FROM planned_workouts WHERE date >= ?', t)?.n ?? 0;
  const trPlan = trainerRoadPlan();
  const phases = trPlan?.phases ?? [];
  const phaseOn = (d: string) => phases.find((p: { start: string | null; end: string | null }) => p.start && p.start <= d && (!p.end || p.end >= d))?.name ?? null;

  // the goal: the next A race, else the next event
  const ev = q.get("SELECT * FROM events WHERE date >= ? ORDER BY CASE priority WHEN 'A' THEN 0 ELSE 1 END, date LIMIT 1", t);
  const race = ev ? rowToEvent(ev) : null;

  // ---------- weeks: the last eight with a plan, and the plan ahead ----------
  const weeks: OutlookWeek[] = [];
  if (span?.first && span.last) {
    const from = [startOf(span.first), startOf(iso(subDays(parseISO(t), PAST_WEEKS * 7)))].sort().pop()!;
    const to = span.last > t ? span.last : t;
    const rows = q.all<{ date: string; sport: string; tss: number | null; dur: number | null; done: number | null }>(
      'SELECT date, sport, planned_tss AS tss, planned_duration AS dur, activity_id AS done FROM planned_workouts WHERE date BETWEEN ? AND ?',
      from,
      to,
    );
    const acts = q.all<{ d: string; tss: number; mt: number }>('SELECT local_date AS d, COALESCE(tss_override, tss, 0) AS tss, moving_time AS mt FROM activities WHERE local_date BETWEEN ? AND ?', from, to);
    for (let ws = from; ws <= to; ws = iso(addDays(parseISO(ws), 7))) {
      const we = iso(addDays(parseISO(ws), 6));
      const mine = rows.filter((r) => r.date >= ws && r.date <= we);
      const ridden = acts.filter((a) => a.d >= ws && a.d <= we);
      weeks.push({
        start: ws,
        end: we,
        phase: phaseOn(ws <= t && we >= t ? t : ws),
        planned: { tss: mine.reduce((s, r) => s + (r.tss ?? 0), 0), rideTss: mine.filter((r) => r.sport === 'ride').reduce((s, r) => s + (r.tss ?? 0), 0), seconds: mine.reduce((s, r) => s + (r.dur ?? 0), 0), n: mine.length },
        done: { tss: ridden.reduce((s, a) => s + a.tss, 0), seconds: ridden.reduce((s, a) => s + a.mt, 0), n: ridden.length },
        completed: mine.filter((r) => r.done != null).length,
        // a workout gone by and not matched to anything ridden (today's is still to do)
        missed: mine.filter((r) => r.done == null && r.date < t).length,
        when: we < t ? 'past' : ws > t ? 'ahead' : 'now',
      });
    }
  }
  // how closely the plan's been followed: the weeks gone by that had one
  const followed = weeks.filter((w) => w.when === 'past' && w.planned.n > 0);
  const compliance = followed.length
    ? {
        weeks: followed.length,
        since: followed[0].start,
        plannedTss: followed.reduce((s, w) => s + w.planned.tss, 0),
        doneTss: followed.reduce((s, w) => s + w.done.tss, 0),
        workouts: followed.reduce((s, w) => s + w.planned.n, 0),
        completed: followed.reduce((s, w) => s + w.completed, 0),
        missed: followed.reduce((s, w) => s + w.missed, 0),
      }
    : null;

  // ---------- stretches of four days or more with nothing planned, before the race ----------
  const unplanned: { from: string; to: string; days: number }[] = [];
  if (race && span?.last) {
    const busy = new Set(q.all<{ date: string }>('SELECT DISTINCT date FROM planned_workouts WHERE date > ? AND date < ?', t, race.date).map((r) => r.date));
    let run: string | null = null;
    for (let d = iso(addDays(parseISO(t), 1)); d <= race.date; d = iso(addDays(parseISO(d), 1))) {
      if (d < race.date && !busy.has(d)) run ??= d;
      else if (run) {
        const to = iso(subDays(parseISO(d), 1));
        const days = differenceInCalendarDays(parseISO(to), parseISO(run)) + 1;
        if (days >= 4) unplanned.push({ from: run, to, days });
        run = null;
      }
    }
  }

  // ---------- fitness and form on race day, riding the plan ----------
  let raceDay: { date: string; days: number; ctl: number; atl: number; tsb: number; form: ReturnType<typeof formZone>; ctlNow: number | null } | null = null;
  if (race) {
    const pts = pmc(t, race.date);
    const p = pts.find((x) => x.date === race.date);
    const now = pts.find((x) => x.date === t);
    if (p) raceDay = { date: race.date, days: differenceInCalendarDays(parseISO(race.date), parseISO(t)), ctl: p.ctl, atl: p.atl, tsb: p.tsb, form: formZone(p.tsb, p.ctl), ctlNow: now?.ctl ?? null };
  }

  // ---------- this app's FTP outlook: its own estimate, carried by the capacity model ----------
  const app: FtpPoint[] = storedSeries('ride').map((e) => ({ date: e.date, value: Math.round(e.threshold) }));
  const appNow = valueOn(app, t);
  const tr = trainerRoadFtp();
  const { since } = compareFtp(tr.applied, [], [], t);
  const predicted = tr.others.filter((o) => o.kind === 'predicted' && o.date > t).sort((a, b) => a.date.localeCompare(b.date));
  // as far as rides are planned (after that the model would count no riding), and to any day TrainerRoad predicts
  const until = [span?.lastRide && span.lastRide > t ? span.lastRide : null, ...predicted.map((p) => p.date)].filter((x): x is string => !!x).sort().pop() ?? null;
  const horizon = until ? [until, iso(addDays(parseISO(t), MAX_DAYS))].sort()[0] : null;
  let appPath: FtpPathPoint[] = [];
  let plannedThrough: string | null = span?.lastRide && span.lastRide > t ? span.lastRide : null;
  if (appNow != null && horizon) {
    const planned = new Map(dailyLoads(t, horizon, 'ride').map((l) => [l.date, l.planned]));
    const path = capacityPath(horizon, (d) => planned.get(d) ?? 0) ?? [];
    // weekly, and on the days that matter: TrainerRoad's predictions, the race, the plan's last ride
    const keep = new Set([...predicted.map((p) => p.date), race?.date, plannedThrough].filter((x): x is string => !!x));
    appPath = path
      .filter((p, i) => i % 7 === 6 || keep.has(p.date) || i === path.length - 1)
      .map((p) => ({ date: p.date, value: Math.round(appNow * p.ratio), low: Math.round(appNow * p.range[0]), high: Math.round(appNow * p.range[1]) }));
  }
  if (plannedThrough && horizon && plannedThrough > horizon) plannedThrough = horizon;

  return {
    /** who plans: TrainerRoad when its workouts are in the calendar */
    source: (span?.tr ?? 0) > 0 ? ('trainerroad' as const) : ahead > 0 ? ('calendar' as const) : null,
    plannedAhead: ahead,
    plannedThrough,
    plan: trPlan ? { name: trPlan.name, volume: trPlan.volume, current: trPlan.current, phases } : null,
    race: race ? { id: race.id, name: race.name, date: race.date, priority: race.priority } : null,
    raceDay,
    /** before the race, days with nothing planned: the projections count them as rest */
    unplanned,
    weeks,
    compliance,
    ftp: {
      app: appNow != null ? { now: appNow, path: appPath } : null,
      trainerRoad:
        tr.current != null || tr.applied.length
          ? {
              now: tr.current,
              /** its FTP changes over its current stretch */
              history: tr.applied.filter((p) => !since || p.date >= since),
              predicted: predicted.map((p) => ({ date: p.date, value: p.value })),
            }
          : null,
    },
  };
}
