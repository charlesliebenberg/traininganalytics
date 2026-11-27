import { describe, expect, it } from 'vitest';
import { addDays, format, parseISO } from 'date-fns';
import { bestLoads, daysToWeeks, filledLoads, forecastScenarios, planGaps, simulate, summarize, weeksToDays, type Constraints, type ForecastContext } from './forecast';
import { computePmc } from './pmc';

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const weekOf = (d: string) => {
  const x = parseISO(d);
  return iso(addDays(x, -((x.getDay() + 6) % 7)));
};

/** Tomorrow a Wednesday, `n` days to a race, with a plan given day by day (all riding). */
function context(n: number, planned: (i: number) => number, extra: Partial<ForecastContext> = {}): ForecastContext {
  const start = parseISO('2026-11-25');
  const days = Array.from({ length: n }, (_, i) => {
    const date = iso(addDays(start, i));
    return { date, dow: parseISO(date).getDay(), week: weekOf(date), planned: planned(i), plannedRide: planned(i) };
  });
  return {
    ctl: 80,
    atl: 85,
    ctlWeekBefore: 79,
    ctlDays: 42,
    atlDays: 7,
    days,
    done: { [weekOf('2026-11-24')]: 150 },
    rideShare: 1,
    shape: [0.2, 0.1, 0.15, 0.1, 0.15, 0.05, 0.25],
    tssPerHour: 60,
    capacity: [
      { tau: 365, a: 200, b: 1.2, ltl0: 60, best: true },
      { tau: 180, a: 190, b: 1.5, ltl0: 65, best: false },
    ],
    power: { ftp: 300, cp: 312, wPrime: 20000, pmax: 1100, a: 25 },
    race: true,
    ...extra,
  };
}
const limits: Constraints = { maxRamp: 5, maxHours: 16, target: 0.12 };

describe('forecast', () => {
  it('rides a load through the same PMC as the app, and capacity through every plausible fit', () => {
    const ctx = context(30, (i) => (i % 7 === 3 ? 0 : 90));
    const loads = ctx.days.map((d) => d.planned);
    const sim = simulate(ctx, loads);
    const pmc = computePmc(loads.map((tss, i) => ({ date: ctx.days[i].date, tss })), { startCtl: 80, startAtl: 85 });
    sim.forEach((d, i) => {
      expect(d.ctl).toBeCloseTo(pmc[i].ctl, 9);
      expect(d.tsb).toBeCloseTo(pmc[i].tsb, 9);
    });
    // capacity: the chosen fit, with the range across the plausible ones
    let x = 60;
    for (const l of loads) x += (l - x) / 365;
    expect(sim[29].cap).toBeCloseTo((200 + 1.2 * x) / (200 + 1.2 * 60), 9);
    expect(sim[29].capLow!).toBeLessThanOrEqual(sim[29].cap!);
    expect(sim[29].capHigh!).toBeGreaterThanOrEqual(sim[29].cap!);
  });

  it('spreads weekly loads in the usual rhythm, counting what is ridden and keeping race day', () => {
    const ctx = context(20, (i) => (i === 19 ? 120 : 0));
    const weeks = [...new Set(ctx.days.map((d) => d.week))];
    const target = Object.fromEntries(weeks.map((w) => [w, 500]));
    const loads = weeksToDays(ctx, target);
    const back = daysToWeeks(ctx, loads);
    // every week but the race's lands on 500 with what was already ridden; race day stays planned
    const raceWeek = ctx.days[19].week;
    for (const w of weeks.filter((x) => x !== raceWeek)) expect(back[w]).toBeCloseTo(500, 6);
    expect(loads[19]).toBe(120);
    // heavier days where the athlete usually trains harder (Sunday 0.25 vs Friday 0.05)
    const sunday = ctx.days.findIndex((d, i) => d.dow === 0 && i > 6);
    const friday = ctx.days.findIndex((d, i) => d.dow === 5 && i > 6);
    expect(loads[sunday]).toBeGreaterThan(loads[friday] * 3);
  });

  it('fills only the plan’s gaps, just enough to arrive fresh', () => {
    // a plan that stops two weeks out
    const ctx = context(35, (i) => (i < 21 ? 100 : 0));
    const gaps = planGaps(ctx);
    expect(gaps.slice(0, 21).every((g) => !g)).toBe(true);
    expect(gaps.slice(21, 34).every(Boolean)).toBe(true);
    const filled = filledLoads(ctx, 0.12)!;
    expect(filled.slice(0, 21)).toEqual(ctx.days.slice(0, 21).map((d) => d.planned));
    const r = summarize(ctx, 'filled', filled, limits).race;
    expect(r.tsb / r.ctl).toBeCloseTo(0.12, 2);
    expect(r.form).toBe('fresh');
    // and is worth more than leaving them empty
    const rest = summarize(ctx, 'planned', ctx.days.map((d) => d.planned), limits).race;
    expect(r.ctl).toBeGreaterThan(rest.ctl);
    expect(r.ftp!).toBeGreaterThan(rest.ftp!);
  });

  it('finds the best path within the limits, and arrives fresh', () => {
    const ctx = context(50, (i) => (i < 20 ? 90 : 0));
    const best = summarize(ctx, 'best', bestLoads(ctx, limits), limits);
    const full = best.weeks.slice(0, -1);
    for (const w of full) {
      expect(w.ramp).toBeLessThanOrEqual(limits.maxRamp + 1e-6);
      expect(w.hours).toBeLessThanOrEqual(limits.maxHours + 1e-6);
    }
    expect(best.race.form).toBe('fresh');
    expect(best.warnings).toEqual([]);
    // more power on race day than the plan as it stands, or its gaps filled
    const planned = summarize(ctx, 'planned', ctx.days.map((d) => d.planned), limits);
    const filled = summarize(ctx, 'filled', filledLoads(ctx, 0.12)!, limits);
    expect(best.race.ftp!).toBeGreaterThan(filled.race.ftp!);
    expect(filled.race.ftp!).toBeGreaterThan(planned.race.ftp!);
    // tighter limits, less to gain
    const tight = summarize(ctx, 'best', bestLoads(ctx, { ...limits, maxRamp: 2, maxHours: 10 }), limits);
    expect(tight.race.ftp!).toBeLessThan(best.race.ftp!);
  });

  it('says what to watch: steep ramps, long weeks, arriving detrained', () => {
    const ctx = context(30, () => 0);
    const planned = summarize(ctx, 'planned', ctx.days.map(() => 0), limits);
    expect(planned.race.form).toBe('transition');
    expect(planned.warnings.join(' ')).toMatch(/detrained/);
    const weeks = Object.fromEntries([...new Set(ctx.days.map((d) => d.week))].map((w) => [w, 1600]));
    const big = summarize(ctx, 'custom', weeksToDays(ctx, weeks), limits);
    expect(big.warnings.join(' ')).toMatch(/CTL in a week/);
    expect(big.warnings.join(' ')).toMatch(/over your 16 h limit/);
  });

  it('turns capacity into race-day power, and copes without a model', () => {
    const ctx = context(30, () => 100);
    const s = forecastScenarios(ctx, limits);
    const best = s.find((x) => x.id === 'best')!;
    expect(best.race.p5!).toBeGreaterThan(best.race.p20!);
    expect(best.race.p20!).toBeGreaterThan(best.race.p60!);
    expect(best.race.ftp).toBeCloseTo(300 * best.race.ratio!, 9);
    const none = forecastScenarios({ ...ctx, capacity: null, power: null }, limits);
    expect(none.find((x) => x.id === 'best')!.race.ftp).toBeNull();
    expect(none.map((x) => x.id)).toEqual(['planned', 'best']);
  });
});
