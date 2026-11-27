/**
 * Race-day forecasting: fitness, form and power under alternative ways of training to a date.
 *
 * Every scenario is a day-by-day load from tomorrow to race day. It is ridden through the same
 * PMC as the rest of the app (fitness, fatigue, form) and through the capacity model (long-term
 * load → 20-minute power, see capacity.ts), each of whose plausible time constants gives its own
 * answer — so power comes with a range, not one confident number. The scenarios:
 *
 *  - planned: the calendar as it stands; days with nothing planned are rest
 *  - filled:  the plan, with its empty stretches ridden just enough to arrive fresh (pmc.ts)
 *  - best:    the path within your limits (ramp, weekly hours) that the capacity model expects
 *             to give the most 20-minute power on race day while still arriving fresh
 *  - custom:  weekly loads you set, spread over each week in your own usual rhythm
 */
import { fillForRace, formZone } from './pmc';

export interface ForecastDay {
  date: string;
  /** weekday, 0 Sunday … 6 Saturday */
  dow: number;
  /** start of the calendar week it falls in (the athlete's week) */
  week: string;
  /** load planned for the day, all sports, and the riding part of it */
  planned: number;
  plannedRide: number;
}

/** One of the capacity model's plausible fits, with the long-term load it carries into tomorrow. */
export interface CapacityFitState {
  tau: number;
  a: number;
  b: number;
  ltl0: number;
  /** the fit the model chose */
  best: boolean;
}

/** Today's power-duration model, to turn a change in capacity into race-day power. */
export interface PowerModel {
  ftp: number;
  cp: number;
  wPrime: number;
  pmax: number;
  /** decay beyond 30 minutes (OmPD) */
  a: number;
}

export interface ForecastContext {
  /** fitness and fatigue after today */
  ctl: number;
  atl: number;
  /** fitness at the end of the week before this one, for this week's ramp */
  ctlWeekBefore: number;
  ctlDays: number;
  atlDays: number;
  /** tomorrow through race day */
  days: ForecastDay[];
  /** load already ridden in each week that has begun */
  done: Record<string, number>;
  /** share of a load that is riding, where the plan doesn't say */
  rideShare: number;
  /** a usual week's load by weekday, shares summing to 1 (0 Sunday … 6 Saturday) */
  shape: number[];
  tssPerHour: number;
  capacity: CapacityFitState[] | null;
  power: PowerModel | null;
  /** is the last day a race (whose own load stays as planned), or just the end of the horizon */
  race: boolean;
}

export interface Constraints {
  /** CTL gained a week at most */
  maxRamp: number;
  /** hours a week at most */
  maxHours: number;
  /** form on race morning as a share of fitness: 0.12 is the middle of "fresh" */
  target: number;
}

export interface SimDay {
  date: string;
  load: number;
  ride: number;
  ctl: number;
  atl: number;
  /** form going into the day */
  tsb: number;
  /** 20-minute capacity as a share of today's: the chosen fit and the plausible range */
  cap: number | null;
  capLow: number | null;
  capHigh: number | null;
}

export interface SimWeek {
  start: string;
  /** load in the week: what was ridden before tomorrow plus the scenario's */
  tss: number;
  hours: number;
  /** fitness and form at the week's end (or race day), and fitness gained over the week */
  ctl: number;
  tsb: number;
  ramp: number;
}

export interface RaceSummary {
  date: string;
  ctl: number;
  tsb: number;
  form: string;
  formLabel: string;
  /** capacity on race day as a share of today's */
  ratio: number | null;
  low: number | null;
  high: number | null;
  ftp: number | null;
  ftpLow: number | null;
  ftpHigh: number | null;
  /** power the model expects for 5, 20 and 60 minutes on race day */
  p5: number | null;
  p20: number | null;
  p60: number | null;
}

export interface ScenarioResult {
  id: 'planned' | 'filled' | 'best' | 'custom';
  days: SimDay[];
  weeks: SimWeek[];
  race: RaceSummary;
  totals: { tss: number; hours: number; maxWeekHours: number; maxRamp: number; peakCtl: number };
  warnings: string[];
}

const round = (v: number, step = 1) => Math.round(v / step) * step;

/** Ride part of a day's load: the plan's own split where it has one, else the usual share. */
function rideLoads(ctx: ForecastContext, loads: number[]): number[] {
  return loads.map((l, i) => {
    const d = ctx.days[i];
    const share = d.planned > 0 ? d.plannedRide / d.planned : ctx.rideShare;
    return l * share;
  });
}

/** Ride a day-by-day load through the PMC and every plausible capacity fit. */
export function simulate(ctx: ForecastContext, loads: number[], rides = rideLoads(ctx, loads)): SimDay[] {
  const kc = 1 - Math.exp(-1 / ctx.ctlDays);
  const ka = 1 - Math.exp(-1 / ctx.atlDays);
  let ctl = ctx.ctl;
  let atl = ctx.atl;
  const fits = ctx.capacity?.map((f) => ({ ...f, x: f.ltl0, now: f.a + f.b * f.ltl0 })) ?? null;
  return ctx.days.map((d, i) => {
    const tsb = ctl - atl;
    ctl += (loads[i] - ctl) * kc;
    atl += (loads[i] - atl) * ka;
    let cap: number | null = null;
    let capLow: number | null = null;
    let capHigh: number | null = null;
    if (fits?.length) {
      const ratios = fits.map((f) => {
        f.x += (rides[i] - f.x) / f.tau;
        return (f.a + f.b * f.x) / f.now;
      });
      cap = ratios[Math.max(0, fits.findIndex((f) => f.best))];
      capLow = Math.min(...ratios);
      capHigh = Math.max(...ratios);
    }
    return { date: d.date, load: loads[i], ride: rides[i], ctl, atl, tsb, cap, capLow, capHigh };
  });
}

/** The plan as it stands: what's in the calendar, rest where nothing is. */
export const plannedLoads = (ctx: ForecastContext) => ctx.days.map((d) => d.planned);

/**
 * Weekly loads made into days: each week's target, less what's already ridden, spread over its
 * remaining days — like the plan where it has workouts, else in the athlete's usual rhythm. A
 * race keeps its own planned load on race day.
 */
export function weeksToDays(ctx: ForecastContext, weekly: Record<string, number>): number[] {
  const loads = ctx.days.map((d) => d.planned);
  const byWeek = new Map<string, number[]>();
  ctx.days.forEach((d, i) => {
    if (ctx.race && i === ctx.days.length - 1) return;
    byWeek.set(d.week, [...(byWeek.get(d.week) ?? []), i]);
  });
  for (const [week, idx] of byWeek) {
    const target = weekly[week];
    if (target == null) continue;
    const raceDay = ctx.race && ctx.days[ctx.days.length - 1].week === week ? ctx.days[ctx.days.length - 1].planned : 0;
    const left = Math.max(0, target - (ctx.done[week] ?? 0) - raceDay);
    const planned = idx.reduce((s, i) => s + ctx.days[i].planned, 0);
    const usual = idx.reduce((s, i) => s + ctx.shape[ctx.days[i].dow], 0) || 1;
    for (const i of idx) {
      const w = planned > 0 ? 0.6 * (ctx.days[i].planned / planned) + 0.4 * (ctx.shape[ctx.days[i].dow] / usual) : ctx.shape[ctx.days[i].dow] / usual;
      loads[i] = left * w;
    }
  }
  return loads;
}

/** The weekly totals a day-by-day load makes (with what's been ridden this week). */
export function daysToWeeks(ctx: ForecastContext, loads: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  ctx.days.forEach((d, i) => (out[d.week] = (out[d.week] ?? ctx.done[d.week] ?? 0) + loads[i]));
  return out;
}

/** Runs of four days or more with nothing planned before the race: the plan's gaps. */
export function planGaps(ctx: ForecastContext): boolean[] {
  const free = ctx.days.map(() => false);
  const last = ctx.race ? ctx.days.length - 1 : ctx.days.length;
  for (let i = 0; i < last; ) {
    if (ctx.days[i].planned > 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < last && ctx.days[j].planned === 0) j++;
    if (j - i >= 4) for (let k = i; k < j; k++) free[k] = true;
    i = j;
  }
  return free;
}

/** The plan, its gaps ridden just enough to arrive fresh (null when it has none, or no race). */
export function filledLoads(ctx: ForecastContext, target: number): number[] | null {
  if (!ctx.race) return null;
  const free = planGaps(ctx);
  if (!free.some(Boolean)) return null;
  const r = fillForRace({ ctl: ctx.ctl, atl: ctx.atl, days: ctx.days.map((d, i) => ({ date: d.date, planned: d.planned, free: free[i] })), ctlDays: ctx.ctlDays, atlDays: ctx.atlDays, target });
  return r && r.daily > 0 ? r.load : null;
}

/** Race-morning form as a share of fitness. */
const relForm = (sim: SimDay[]) => {
  const last = sim[sim.length - 1];
  return last.tsb / Math.max(last.ctl, 1);
};

/**
 * One candidate of the "best path" family, built on calendar weeks so its limits hold for the
 * weeks the athlete lives: each week climbs `ramp` CTL (a part week, its share), a recovery week
 * at 60 % every fourth, and no week over the hours limit; then `taperWeeks` weeks at `m` of the
 * build's level and the last seven days before the race at half that. Each week's load is spread
 * in the athlete's usual rhythm.
 */
function candidate(ctx: ForecastContext, c: Constraints, ramp: number, taperWeeks: number, m: number): number[] {
  const n = ctx.days.length;
  const raceIdx = ctx.race ? n - 1 : n;
  const taperFrom = ctx.race ? Math.max(0, raceIdx - 7 * (taperWeeks + 1)) : n;
  const kc = 1 - Math.exp(-1 / ctx.ctlDays);
  const weekCap = c.maxHours * ctx.tssPerHour;
  const loads = ctx.days.map((d) => d.planned);
  // the build: calendar weeks (their days before the taper)
  const groups: number[][] = [];
  for (let i = 0; i < taperFrom; i++) {
    const g = groups[groups.length - 1];
    if (g && ctx.days[g[0]].week === ctx.days[i].week) g.push(i);
    else groups.push([i]);
  }
  let ctl = ctx.ctl;
  let level = Math.max(ctx.ctl, 20);
  groups.forEach((g, k) => {
    const nd = g.length;
    const recovery = k % 4 === 3 && k < groups.length - 1;
    const usual = g.reduce((s, i) => s + ctx.shape[ctx.days[i].dow], 0) || 1;
    const w = g.map((i) => ctx.shape[ctx.days[i].dow] / usual);
    let daily: number;
    if (recovery) daily = level * 0.6;
    else {
      // the load that lifts CTL by the week's share of `ramp` by its last day, spread in the
      // athlete's rhythm: a weekend-heavy week lifts the week's-end CTL more than an even one
      const r = Math.pow(1 - kc, nd);
      const gain = w.reduce((sum, wi, j) => sum + wi * kc * Math.pow(1 - kc, nd - 1 - j), 0);
      daily = Math.max(0, (ctl + (ramp * nd) / 7 - ctl * r) / (nd * gain));
    }
    // the limit holds for the whole calendar week, with what's been ridden in it
    daily = Math.min(daily, Math.max(0, weekCap - (ctx.done[ctx.days[g[0]].week] ?? 0)) / nd);
    if (!recovery) level = daily;
    g.forEach((i, j) => {
      loads[i] = daily * nd * w[j];
      ctl += (loads[i] - ctl) * kc;
    });
  });
  // the taper: `m` of the build's level (never above it), the race's last week at half that
  const depth = Math.min(1, m);
  for (let i = taperFrom; i < raceIdx; i++) {
    const raceWeek = i >= raceIdx - 7;
    loads[i] = level * depth * (raceWeek ? 0.5 : 1) * 7 * ctx.shape[ctx.days[i].dow];
  }
  return withinRamp(ctx, loads, ramp, raceIdx);
}

/**
 * No calendar week climbs more than `ramp` CTL: a week that would (a taper week straight after
 * a recovery week, back at the build's level) is scaled down until it doesn't.
 */
function withinRamp(ctx: ForecastContext, loads: number[], ramp: number, raceIdx: number): number[] {
  const kc = 1 - Math.exp(-1 / ctx.ctlDays);
  const out = [...loads];
  let ctl = ctx.ctl;
  let weekStartCtl = ctx.ctlWeekBefore;
  for (let i = 0; i < ctx.days.length; ) {
    let j = i;
    while (j < ctx.days.length && ctx.days[j].week === ctx.days[i].week) j++;
    // CTL at the week's end: what it carries in, decayed, plus each day's load by its weight
    const nd = j - i;
    const carried = ctl * Math.pow(1 - kc, nd);
    const weight = (k: number) => kc * Math.pow(1 - kc, j - 1 - k);
    const free = (k: number) => k < raceIdx;
    const fixed = Array.from({ length: nd }, (_, x) => i + x).reduce((sum, k) => sum + (free(k) ? 0 : out[k] * weight(k)), 0);
    const movable = Array.from({ length: nd }, (_, x) => i + x).reduce((sum, k) => sum + (free(k) ? out[k] * weight(k) : 0), 0);
    const allowed = weekStartCtl + ramp;
    if (movable > 0 && carried + fixed + movable > allowed) {
      const scale = Math.max(0, (allowed - carried - fixed) / movable);
      for (let k = i; k < j; k++) if (free(k)) out[k] *= scale;
    }
    for (let k = i; k < j; k++) ctl += (out[k] - ctl) * kc;
    weekStartCtl = ctl;
    i = j;
  }
  return out;
}

/**
 * The best path within the limits: of every build rate up to the ramp limit and taper of zero to
 * two weeks (each tapered to arrive at the target form), the one the capacity model expects to
 * give the most 20-minute power on race day — or, without a model, the most fitness. Of those
 * within 0.3 % of the best, the one with the least load: the gentlest way to the same place.
 */
export function bestLoads(ctx: ForecastContext, c: Constraints): number[] {
  const score = (sim: SimDay[]) => {
    const last = sim[sim.length - 1];
    return last.cap ?? last.ctl / Math.max(ctx.ctl, 1);
  };
  type Option = { loads: number[]; score: number; total: number; fresh: boolean };
  const options: Option[] = [];
  const ramps = Array.from({ length: Math.max(0, Math.floor(c.maxRamp)) + 1 }, (_, r) => r);
  for (const ramp of ramps) {
    for (const taper of ctx.race ? [0, 1, 2] : [0]) {
      let loads = candidate(ctx, c, ramp, taper, 1);
      if (ctx.race) {
        // the taper's depth that meets the form target: more load, less form
        let lo = 0.05;
        let hi = 1;
        const at = (m: number) => relForm(simulate(ctx, candidate(ctx, c, ramp, taper, m)));
        if (at(lo) < c.target) hi = lo;
        else if (at(hi) > c.target) lo = hi;
        else
          for (let k = 0; k < 30; k++) {
            const mid = (lo + hi) / 2;
            if (at(mid) > c.target) lo = mid;
            else hi = mid;
          }
        loads = candidate(ctx, c, ramp, taper, (lo + hi) / 2);
      }
      const sim = simulate(ctx, loads);
      const rel = relForm(sim);
      options.push({ loads, score: score(sim), total: loads.reduce((a, b) => a + b, 0), fresh: !ctx.race || (rel >= 0.05 && rel < 0.25) });
    }
  }
  const pool = options.some((o) => o.fresh) ? options.filter((o) => o.fresh) : options;
  const top = Math.max(...pool.map((o) => o.score));
  return pool.filter((o) => o.score >= top - 0.003 * Math.abs(top)).sort((a, b) => a.total - b.total)[0].loads;
}

/** Power for a duration from today's model, every part of it moved by the change in capacity. */
function powerAt(p: PowerModel, ratio: number, t: number): number {
  const cp = p.cp * ratio;
  const w = p.wPrime * ratio;
  const base = (w / t) * (1 - Math.exp((-t * (p.pmax - cp)) / w)) + cp;
  return t > 1800 ? base - p.a * ratio * Math.log(t / 1800) : base;
}

/** What a day-by-day load comes to: weeks, race day, totals and what to watch. */
export function summarize(ctx: ForecastContext, id: ScenarioResult['id'], loads: number[], c: Constraints): ScenarioResult {
  const days = simulate(ctx, loads);
  const last = days[days.length - 1];
  // weeks: what's been ridden in them, the scenario's load, and where they leave fitness
  const weeks: SimWeek[] = [];
  let prevCtl = ctx.ctlWeekBefore;
  ctx.days.forEach((d, i) => {
    const w = weeks[weeks.length - 1];
    if (!w || w.start !== d.week) weeks.push({ start: d.week, tss: (ctx.done[d.week] ?? 0) + loads[i], hours: 0, ctl: days[i].ctl, tsb: days[i].ctl - days[i].atl, ramp: 0 });
    else {
      w.tss += loads[i];
      w.ctl = days[i].ctl;
      w.tsb = days[i].ctl - days[i].atl;
    }
  });
  for (const w of weeks) {
    w.ramp = w.ctl - prevCtl;
    prevCtl = w.ctl;
    w.hours = ctx.tssPerHour > 0 ? w.tss / ctx.tssPerHour : 0;
  }
  const zone = formZone(last.tsb, last.ctl);
  const ratio = last.cap;
  const p = ctx.power;
  const race: RaceSummary = {
    date: last.date,
    ctl: last.ctl,
    tsb: last.tsb,
    form: zone.id,
    formLabel: zone.label,
    ratio,
    low: last.capLow,
    high: last.capHigh,
    ftp: p && ratio != null ? p.ftp * ratio : null,
    ftpLow: p && last.capLow != null ? p.ftp * last.capLow : null,
    ftpHigh: p && last.capHigh != null ? p.ftp * last.capHigh : null,
    p5: p && ratio != null ? powerAt(p, ratio, 300) : null,
    p20: p && ratio != null ? powerAt(p, ratio, 1200) : null,
    p60: p && ratio != null ? powerAt(p, ratio, 3600) : null,
  };
  // full weeks only for ramp and hours: a week cut short by the race or the horizon isn't one
  const full = weeks.filter((_, i) => i < weeks.length - 1 || !ctx.race);
  const warnings: string[] = [];
  const steep = full.filter((w) => w.ramp > Math.max(8, c.maxRamp + 1));
  if (steep.length) warnings.push(`Fitness climbs ${round(Math.max(...steep.map((w) => w.ramp)), 0.5)} CTL in a week: above 8 a week, injury and illness risk climb`);
  const long = full.filter((w) => w.hours > c.maxHours * 1.05);
  if (long.length) warnings.push(`${long.length === 1 ? 'A week' : `${long.length} weeks`} over your ${round(c.maxHours, 0.5)} h limit`);
  const spike = days.find((d) => d.ctl > 20 && d.atl / d.ctl > 1.5);
  if (spike) warnings.push(`Fatigue runs past 1.5 × fitness (${spike.date}): a load spike`);
  if (ctx.race && zone.id === 'transition') warnings.push('Arrives detrained: too much rest before the race');
  else if (ctx.race && zone.id !== 'fresh') warnings.push(`Arrives ${zone.label.toLowerCase()}, not fresh`);
  return {
    id,
    days,
    weeks,
    race,
    totals: {
      tss: loads.reduce((a, b) => a + b, 0),
      hours: ctx.tssPerHour > 0 ? loads.reduce((a, b) => a + b, 0) / ctx.tssPerHour : 0,
      maxWeekHours: Math.max(0, ...full.map((w) => w.hours)),
      maxRamp: Math.max(0, ...full.map((w) => w.ramp)),
      peakCtl: Math.max(...days.map((d) => d.ctl)),
    },
    warnings,
  };
}

/** Every scenario there is for this context: the plan, its gaps filled, the best path, and yours. */
export function forecastScenarios(ctx: ForecastContext, c: Constraints, custom?: Record<string, number> | null): ScenarioResult[] {
  const out = [summarize(ctx, 'planned', plannedLoads(ctx), c)];
  const filled = filledLoads(ctx, c.target);
  if (filled) out.push(summarize(ctx, 'filled', filled, c));
  out.push(summarize(ctx, 'best', bestLoads(ctx, c), c));
  if (custom && Object.keys(custom).length) out.push(summarize(ctx, 'custom', weeksToDays(ctx, custom), c));
  return out;
}
