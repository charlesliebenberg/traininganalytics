/**
 * The forecast's inputs, gathered from everything the app knows — the calendar's plan, the PMC,
 * the capacity model, today's power-duration model, how the athlete usually trains — and its
 * scenarios run (shared/analytics/forecast.ts).
 */
import { addDays, differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { forecastScenarios, type Constraints, type ForecastContext, type ForecastDay } from '../shared/analytics/forecast';
import { formZone } from '../shared/analytics/pmc';
import type { RaceEvent, SeasonPlanConfig, SeasonWeek } from '../shared/types';
import { getPreferences, q, rowToEvent, thresholdsFor } from './db';
import { dailyLoads, planProjection, pmc, today } from './aggregate';
import { estimateModel, rideEstimates } from './estimates';
import { capacityFits, capacitySummary } from './comeback';
import { trainerRoadFtp, trainerRoadPlan } from './trainerroad-insights';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
/** without a race, how far ahead the forecast looks */
const HORIZON_DAYS = 56;
/** how far back "how you usually train" looks */
const RECENT_DAYS = 42;

export interface ForecastRequest {
  eventId?: number | null;
  constraints?: Partial<Constraints>;
  custom?: Record<string, number> | null;
}

export function forecast(r: ForecastRequest = {}) {
  const t = today();
  const prefs = getPreferences();
  const weekOf = (d: string) => {
    const x = parseISO(d);
    return iso(subDays(x, (x.getDay() - prefs.weekStart + 7) % 7));
  };

  // the goal: the race asked for, else the next A race, else the next event; without one, a horizon
  const events: RaceEvent[] = q.all('SELECT * FROM events WHERE date > ? ORDER BY date', t).map(rowToEvent);
  const race = events.find((e) => e.id === r.eventId) ?? events.find((e) => e.priority === 'A') ?? events[0] ?? null;
  const end = race ? race.date : iso(addDays(parseISO(t), HORIZON_DAYS));
  if (differenceInCalendarDays(parseISO(end), parseISO(t)) < 2) return null;

  // where fitness stands: the PMC through today, as every page has it
  const recentFrom = iso(subDays(parseISO(t), RECENT_DAYS));
  const hist = pmc(iso(subDays(parseISO(t), 70)), t);
  const now = hist[hist.length - 1];
  if (!now) return null;
  const thisWeek = weekOf(t);
  const weekBefore = hist.find((p) => p.date === iso(subDays(parseISO(thisWeek), 1)));

  // how the athlete usually trains: the riding share, the week's rhythm, TSS per hour
  const recent = q.all<{ d: string; sport: string; tss: number; mt: number }>('SELECT local_date AS d, sport, COALESCE(tss_override, tss, 0) AS tss, moving_time AS mt FROM activities WHERE local_date > ? AND local_date <= ?', recentFrom, t);
  const total = recent.reduce((s, a) => s + a.tss, 0);
  const rideShare = total > 0 ? recent.filter((a) => a.sport === 'ride').reduce((s, a) => s + a.tss, 0) / total : 1;
  const byDow = new Array(7).fill(0);
  for (const a of recent) byDow[parseISO(a.d).getDay()] += a.tss;
  const shape = byDow.map((v) => (total > 0 ? 0.9 * (v / total) + 0.1 / 7 : 1 / 7));
  const hours = recent.reduce((s, a) => s + a.mt, 0) / 3600;
  const tssPerHour = hours > 2 && total / hours > 20 ? total / hours : 60;
  // the biggest week of the last sixteen, to suggest a weekly limit
  const weeksBack = q.all<{ w: string; h: number }>(
    "SELECT strftime('%Y-%W', local_date) AS w, SUM(moving_time) / 3600.0 AS h FROM activities WHERE local_date > ? AND local_date <= ? GROUP BY w",
    iso(subDays(parseISO(t), 7 * 16)),
    t,
  );
  const biggestWeek = Math.max(0, ...weeksBack.map((w) => w.h));

  // the plan: every day from tomorrow, with a season plan's weekly targets where nothing's scheduled
  const from = iso(addDays(parseISO(t), 1));
  const all = dailyLoads(from, end);
  const ride = dailyLoads(from, end, 'ride');
  const extra = planProjection(end);
  const days: ForecastDay[] = all.map((l, i) => {
    const x = parseISO(l.date);
    const projected = extra.get(l.date) ?? 0;
    return { date: l.date, dow: x.getDay(), week: weekOf(l.date), planned: l.planned + projected, plannedRide: ride[i].planned + projected * rideShare };
  });
  // what this week already holds: ridden, and today's planned when it's still to do (as the PMC has it)
  const done: Record<string, number> = { [thisWeek]: hist.filter((p) => p.date >= thisWeek).reduce((s, p) => s + p.tss, 0) };

  // today's power-duration model, to turn capacity into power
  const th = thresholdsFor(t);
  const est = rideEstimates(t).now;
  const pd = est ? estimateModel(est) : null;
  const power = th.ftp > 0 && pd ? { ftp: th.ftp, cp: pd.cp, wPrime: pd.wPrime, pmax: pd.pmax, a: pd.a } : null;

  const ctx: ForecastContext = {
    ctl: now.ctl,
    atl: now.atl,
    ctlWeekBefore: weekBefore?.ctl ?? now.ctl,
    ctlDays: prefs.ctlDays,
    atlDays: prefs.atlDays,
    days,
    done,
    rideShare,
    shape,
    tssPerHour,
    capacity: capacityFits(),
    power,
    race: !!race,
  };
  const constraints: Constraints = {
    maxRamp: clamp(r.constraints?.maxRamp ?? 5, 0, 12),
    maxHours: clamp(r.constraints?.maxHours ?? Math.max(6, Math.round(biggestWeek * 1.1 * 2) / 2), 2, 40),
    target: clamp(r.constraints?.target ?? 0.12, 0.05, 0.25),
  };
  const scenarios = forecastScenarios(ctx, constraints, sanitize(r.custom));

  // the weeks, with what was planned and ridden in them, and the plan's phase
  const phases = trainerRoadPlan()?.phases ?? [];
  const plannedByWeek = new Map<string, number>();
  for (const d of days) plannedByWeek.set(d.week, (plannedByWeek.get(d.week) ?? 0) + d.planned);
  const weeks = [...new Set(days.map((d) => d.week))].map((w) => ({
    start: w,
    planned: Math.round(plannedByWeek.get(w) ?? 0) + (w === thisWeek ? Math.round(done[w]) : 0),
    done: w === thisWeek ? Math.round(done[w]) : null,
    phase: (phases as { name: string | null; start: string | null; end: string | null }[]).find((p) => p.start && p.start <= w && (!p.end || p.end >= w))?.name ?? null,
  }));

  // TrainerRoad's own outlook, beside this app's: its FTP now and what it predicts
  const tr = trainerRoadFtp();
  const zone = formZone(now.tsb, now.ctl);
  return {
    today: t,
    end,
    race: race ? { id: race.id, name: race.name, date: race.date, priority: race.priority } : null,
    events: events.map((e) => ({ id: e.id, name: e.name, date: e.date, priority: e.priority })),
    now: { ctl: now.ctl, atl: now.atl, tsb: now.tsb, form: zone.id, formLabel: zone.label, ftp: power?.ftp ?? (th.ftp || null), weight: th.weight },
    habits: { rideShare, tssPerHour, biggestWeek, shape },
    constraints,
    history: hist.filter((p) => p.date >= recentFrom).map((p) => ({ date: p.date, ctl: p.ctl, atl: p.atl, tsb: p.tsb, load: p.tss })),
    weeks,
    scenarios: scenarios.map((s) => ({
      ...s,
      // the chart and table need days rounded, not every float
      days: s.days.map((d) => ({ date: d.date, load: Math.round(d.load), ctl: round1(d.ctl), atl: round1(d.atl), tsb: round1(d.tsb), cap: d.cap, capLow: d.capLow, capHigh: d.capHigh })),
      weeks: s.weeks.map((w) => ({ ...w, tss: Math.round(w.tss), hours: round1(w.hours), ctl: round1(w.ctl), tsb: round1(w.tsb), ramp: round1(w.ramp) })),
    })),
    trainerRoad: tr.current != null || tr.others.length ? { now: tr.current, predicted: tr.others.filter((o) => o.kind === 'predicted' && o.date > t).map((o) => ({ date: o.date, value: o.value })) } : null,
    model: capacitySummary(),
  };
}

const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo);
const round1 = (v: number) => Math.round(v * 10) / 10;

/** Weekly loads from the client: dates to sane numbers, nothing else. */
function sanitize(custom: unknown): Record<string, number> | null {
  if (!custom || typeof custom !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(custom as Record<string, unknown>)) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && Number.isFinite(v)) out[k] = clamp(v, 0, 3000);
  return Object.keys(out).length ? out : null;
}

/**
 * A scenario kept as the active season plan: the Calendar shows its weekly targets, and every
 * projection (the PMC, readiness, the forecast's plan) rides them in weeks with nothing scheduled.
 * Where workouts are planned — TrainerRoad's included — they stay in charge.
 */
export function saveScenario(r: ForecastRequest & { scenario: 'planned' | 'filled' | 'best' | 'custom'; name?: string }) {
  const f = forecast(r);
  const s = f?.scenarios.find((x) => x.id === r.scenario);
  if (!f || !s) return null;
  const last = s.weeks.length - 1;
  const byDate = new Map(s.days.map((d) => [d.date, d.load]));
  const weeks: SeasonWeek[] = s.weeks.map((w, i) => {
    // phases read from the load: the race's week, the drop before it, recovery dips, and building
    const phase = f.race && i === last ? 'Race' : f.race && i === last - 1 && w.ramp < 0 ? 'Taper' : w.ramp < -2 ? 'Recovery' : w.ramp > 0.5 ? 'Build' : 'Base';
    // the scenario's own days, so projections ride it as the forecast did
    const days = Array.from({ length: 7 }, (_, k) => {
      const v = byDate.get(format(addDays(parseISO(w.start), k), 'yyyy-MM-dd'));
      return v == null ? null : Math.round(v);
    });
    return { weekStart: w.start, phase, tss: Math.round(w.tss), hours: Math.round(w.hours * 10) / 10, ctl: w.ctl, atl: Math.round((w.ctl - w.tsb) * 10) / 10, tsb: w.tsb, recovery: phase === 'Recovery', event: f.race && i === last ? `${f.race.priority}: ${f.race.name}` : null, days };
  });
  const config: SeasonPlanConfig = {
    startDate: weeks[0].weekStart,
    raceDate: f.end,
    startCtl: Math.round(f.now.ctl),
    startAtl: Math.round(f.now.atl),
    targetCtl: Math.round(s.race.ctl),
    maxRamp: f.constraints.maxRamp,
    pattern: '3:1',
    taperWeeks: 1,
    maxWeeklyHours: f.constraints.maxHours,
    sport: 'ride',
    goal: f.race ? 'race' : 'fitness',
    tssPerHour: Math.round(f.habits.tssPerHour),
  };
  const names = { planned: 'As planned', filled: 'Plan, gaps filled', best: 'Best path', custom: 'My plan' };
  const name = (r.name?.trim() || `${names[r.scenario]}${f.race ? ` to ${f.race.name}` : ''}`).slice(0, 80);
  const res = q.run('INSERT INTO season_plans(name, config, weeks, event_id) VALUES(?, ?, ?, ?)', name, JSON.stringify(config), JSON.stringify(weeks), f.race?.id ?? null);
  return { id: Number(res.lastInsertRowid), name, weeks: weeks.length };
}
