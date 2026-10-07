import { addDays, differenceInCalendarDays, format, parseISO, startOfWeek } from 'date-fns';
import type { RaceEvent, SeasonPlanConfig, SeasonWeek, Sport, WorkoutStructure } from '../types';
import { BUILTIN_WORKOUTS } from '../library';
import { dailyTssForCtl } from './pmc';
import { scaleToTss, workoutMetrics } from './workout';

const PHASE_IF: Record<string, number> = {
  Prep: 0.65,
  Base: 0.7,
  Build: 0.76,
  Peak: 0.78,
  Taper: 0.74,
  Race: 0.72,
  Recovery: 0.62,
  Transition: 0.6,
};

export function phaseColorKey(phase: string): string {
  return phase.split(' ')[0];
}

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/**
 * Build a periodised plan (Annual Training Plan style) working backwards from the A race:
 * Race week ← Taper ← Peak ← Build 2 ← Build 1 ← Base 3/2/1 ← Prep, with recovery weeks
 * inserted by the loading pattern (e.g. 3:1). Weekly TSS is derived from the CTL ramp
 * required to hit the target fitness, capped by the ramp rate and weekly hours.
 */
export function generateSeasonPlan(config: SeasonPlanConfig, events: Pick<RaceEvent, 'date' | 'name' | 'priority'>[] = [], ctlDays = 42, atlDays = 7): SeasonWeek[] {
  const start = startOfWeek(parseISO(config.startDate), { weekStartsOn: 1 });
  const race = parseISO(config.raceDate);
  const raceWeekStart = startOfWeek(race, { weekStartsOn: 1 });
  const nWeeks = Math.max(1, Math.round(differenceInCalendarDays(raceWeekStart, start) / 7) + 1);
  const fitnessGoal = config.goal === 'fitness';
  const taper = fitnessGoal ? 0 : Math.min(config.taperWeeks, Math.max(0, nWeeks - 2));
  const loadCycle = config.pattern === '2:1' ? 3 : config.pattern === '4:1' ? 5 : 4;

  // phases, assigned backwards from race week
  const phases: string[] = new Array(nWeeks).fill('Base');
  if (!fitnessGoal) phases[nWeeks - 1] = 'Race';
  for (let i = 0; i < taper; i++) phases[nWeeks - 2 - i] = i === 0 ? 'Taper' : 'Peak';
  let idx = fitnessGoal ? nWeeks - 1 : nWeeks - 2 - taper;
  const blocks: [string, number][] = [
    ['Build 2', 4],
    ['Build 1', 4],
    ['Base 3', 4],
    ['Base 2', 4],
    ['Base 1', 4],
  ];
  for (const [name, len] of blocks) {
    for (let k = 0; k < len && idx >= 0; k++, idx--) phases[idx] = name;
  }
  while (idx >= 0) phases[idx--] = 'Prep';
  // a comeback starts with a few easy "return to riding" weeks whatever the plan length
  if (fitnessGoal && config.initialRamp != null) for (let w = 0; w < Math.min(config.initialWeeks ?? 4, nWeeks - 1); w++) phases[w] = 'Prep';

  // recovery weeks: last week of each load cycle, counting backwards from the taper so
  // the athlete enters the taper after a load week sequence
  const recovery: boolean[] = new Array(nWeeks).fill(false);
  const loadEnd = fitnessGoal ? nWeeks : nWeeks - 1 - taper; // exclusive
  for (let i = loadEnd - 1, c = 1; i >= 0; i--, c++) {
    if (c % loadCycle === 0 && phases[i] !== 'Prep') recovery[i] = true;
  }
  // make sure we start with a load week
  if (nWeeks > 2) recovery[0] = false;

  const loadWeeks = recovery.slice(0, loadEnd).filter((r) => !r).length || 1;
  const recoveryWeeks = recovery.slice(0, loadEnd).filter((r) => r).length;
  // a recovery week typically costs ~2–3 CTL; plan the build to cover it
  const needed = config.targetCtl - config.startCtl + recoveryWeeks * 2.5 + taper * 1.5;
  // the first weeks may ramp more gently; the rest of the build makes up the difference
  const initW = config.initialRamp != null ? recovery.slice(0, Math.min(loadEnd, config.initialWeeks ?? 4)).filter((r) => !r).length : 0;
  const initGain = initW * Math.min(config.initialRamp ?? 0, config.maxRamp);
  // race plans spread the climb to arrive on race day; fitness goals climb at the allowed
  // rate until they reach the target and then hold it
  const ramp = fitnessGoal ? config.maxRamp : Math.max(0, Math.min(config.maxRamp, initW && loadWeeks > initW ? (needed - initGain) / (loadWeeks - initW) : needed / loadWeeks));

  const kc = 1 - Math.exp(-1 / ctlDays);
  const ka = 1 - Math.exp(-1 / atlDays);
  let ctl = config.startCtl;
  let atl = config.startAtl;
  let lastLoadTss = 7 * Math.max(ctl, 20);
  const weeks: SeasonWeek[] = [];

  for (let w = 0; w < nWeeks; w++) {
    const ws = addDays(start, w * 7);
    const phase = recovery[w] ? 'Recovery' : phases[w];
    const baseName = phases[w].split(' ')[0];
    let tss: number;
    if (phase === 'Race') tss = lastLoadTss * 0.5;
    else if (baseName === 'Taper') tss = lastLoadTss * 0.55;
    else if (baseName === 'Peak') tss = lastLoadTss * 0.75;
    else if (phase === 'Recovery') tss = lastLoadTss * 0.6;
    else {
      const r = config.initialRamp != null && w < (config.initialWeeks ?? 4) ? Math.min(config.initialRamp, ramp) : ramp;
      const targetEnd = Math.min(config.targetCtl, ctl + r);
      tss = 7 * dailyTssForCtl(ctl, Math.max(targetEnd, ctl * 0.98), 7, ctlDays);
      if (baseName === 'Prep' && !fitnessGoal) tss = Math.min(tss, 7 * dailyTssForCtl(ctl, ctl + ramp * 0.5, 7, ctlDays));
    }
    const intensity = PHASE_IF[phase === 'Recovery' ? 'Recovery' : baseName] ?? 0.7;
    // TSS per hour: the athlete's own rate when known (scaled a little by phase), else IF² × 100
    const perHour = config.tssPerHour ? config.tssPerHour * (intensity / 0.72) ** 2 : intensity * intensity * 100;
    const maxTss = config.maxWeeklyHours * perHour;
    if (config.maxWeeklyHours > 0) tss = Math.min(tss, maxTss);
    tss = Math.round(tss / 5) * 5;
    if (phase !== 'Recovery' && !['Race', 'Taper', 'Peak'].includes(baseName)) lastLoadTss = tss;
    for (let d = 0; d < 7; d++) {
      ctl += (tss / 7 - ctl) * kc;
      atl += (tss / 7 - atl) * ka;
    }
    const weekEnd = addDays(ws, 6);
    const ev = events.find((e) => {
      const d = parseISO(e.date);
      return d >= ws && d <= weekEnd;
    });
    weeks.push({
      weekStart: iso(ws),
      phase,
      tss,
      hours: Math.round((tss / perHour) * 10) / 10,
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10,
      recovery: phase === 'Recovery',
      event: ev ? `${ev.priority}: ${ev.name}` : null,
    });
  }
  return weeks;
}

export interface GeneratedWorkout {
  date: string;
  sport: Sport;
  title: string;
  description: string;
  structure: WorkoutStructure;
  tss: number;
  duration: number;
  if: number;
}

type DayPlan = { key: string; share?: number } | null;

// Monday → Sunday templates. `share` marks flexible endurance days that absorb the remaining TSS.
const WEEK_TEMPLATES: Record<string, DayPlan[]> = {
  Prep: [null, { key: 'endurance-2h', share: 1 }, null, { key: 'endurance-2h', share: 1 }, null, { key: 'long-ride', share: 2 }, { key: 'recovery-spin' }],
  Base: [null, { key: 'endurance-2h', share: 1 }, { key: 'tempo-3x15' }, { key: 'endurance-2h', share: 1 }, null, { key: 'long-ride', share: 2.2 }, { key: 'sweetspot-3x15' }],
  Build: [null, { key: 'threshold-2x20' }, { key: 'endurance-2h', share: 1 }, { key: 'vo2-5x5' }, null, { key: 'long-ride', share: 2 }, { key: 'sweetspot-2x30' }],
  Peak: [null, { key: 'vo2-30-30' }, { key: 'endurance-2h', share: 1 }, { key: 'over-unders' }, null, { key: 'long-ride', share: 1.4 }, { key: 'recovery-spin' }],
  Taper: [null, { key: 'vo2-5x5' }, { key: 'recovery-spin' }, { key: 'threshold-4x10' }, null, { key: 'endurance-2h', share: 1 }, { key: 'recovery-spin' }],
  Race: [null, { key: 'sprints' }, { key: 'recovery-spin' }, { key: 'endurance-2h', share: 1 }, null, { key: 'recovery-spin' }, null],
  Recovery: [null, { key: 'recovery-spin' }, { key: 'endurance-2h', share: 1 }, null, { key: 'recovery-spin' }, { key: 'endurance-2h', share: 1.5 }, null],
};

/**
 * Week template built from a session mix (e.g. copied from a past peak): N quality days,
 * a long ride if the athlete did them, endurance on the remaining training days.
 * Base/Prep phases use tempo/sweet spot for the quality slots; build phases split them
 * between threshold and VO2 according to the mix.
 */
function templateFromMix(phase: string, mix: NonNullable<SeasonPlanConfig['mix']>): DayPlan[] {
  const tpl: DayPlan[] = new Array(7).fill(null);
  const quality = Math.max(1, Math.min(3, Math.round(mix.quality)));
  const long = mix.longRides >= 0.4;
  const days = Math.max(quality + (long ? 1 : 0), Math.min(7, Math.round(mix.days)));
  const build = phase === 'Build' || phase === 'Peak';
  // returning weeks: a single steady tempo session, everything else easy
  if (phase === 'Prep') {
    tpl[2] = { key: 'tempo-3x15' };
    tpl[5] = { key: long ? 'long-ride' : 'endurance-2h', share: long ? 2 : 1.5 };
    for (const d of [1, 3, 6]) tpl[d] = { key: 'endurance-2h', share: 1 };
    return tpl;
  }
  const vo2 = build ? Math.round(quality * mix.vo2Share) : 0;
  const qKeys: string[] = [];
  for (let i = 0; i < quality; i++) {
    if (i < vo2) qKeys.push(i % 2 ? 'vo2-30-30' : 'vo2-5x5');
    else if (build) qKeys.push(['threshold-2x20', 'over-unders', 'threshold-4x10'][i % 3]);
    else qKeys.push(['sweetspot-3x15', 'tempo-3x15', 'sweetspot-2x30'][i % 3]);
  }
  // Tue, Thu, then Sun (or Sat if no long ride) for quality; Sat long ride
  const qDays = [1, 3, long ? 6 : 5];
  qKeys.forEach((k, i) => (tpl[qDays[i]] = { key: k }));
  if (long) tpl[5] = { key: 'long-ride', share: 2.2 };
  let toFill = days - quality - (long ? 1 : 0);
  for (const d of [2, 6, 4, 0, 5]) {
    if (toFill <= 0) break;
    if (!tpl[d]) {
      tpl[d] = { key: 'endurance-2h', share: 1 };
      toFill--;
    }
  }
  // the TSS of a week always needs somewhere flexible to go
  if (!tpl.some((d) => d?.share)) tpl[tpl.findIndex((d) => !d)] = { key: 'endurance-2h', share: 1 };
  return tpl;
}

/** Fill a week with concrete structured workouts that sum to roughly the planned TSS. */
export function generateWeekWorkouts(week: SeasonWeek, mix?: SeasonPlanConfig['mix']): GeneratedWorkout[] {
  const base = week.recovery ? 'Recovery' : week.phase.split(' ')[0];
  const useMix = mix && ['Prep', 'Base', 'Build', 'Peak'].includes(base);
  const tpl = [...(useMix ? templateFromMix(base, mix!) : WEEK_TEMPLATES[base] ?? WEEK_TEMPLATES.Base)];
  const lib = new Map(BUILTIN_WORKOUTS.map((w) => [w.key, w]));
  const fixed = tpl.map((d) => (d && !d.share ? workoutMetrics(lib.get(d.key)!.structure).tss : 0));
  const fixedTotal = fixed.reduce((a, b) => a + b, 0);
  const remaining = Math.max(0, week.tss - fixedTotal);
  // don't pile the week's load onto one or two days: add endurance days until no flexible
  // day needs much more than ~200 TSS per share (≈ 3–4 h of endurance)
  const PER_SHARE = 200;
  for (const d of [2, 4, 6, 0, 1, 3, 5]) {
    if (tpl.reduce((a, x) => a + (x?.share ?? 0), 0) * PER_SHARE >= remaining) break;
    if (!tpl[d]) tpl[d] = { key: 'endurance-2h', share: 1 };
  }
  const shares = tpl.reduce((a, d) => a + (d?.share ?? 0), 0);
  const out: GeneratedWorkout[] = [];
  tpl.forEach((d, i) => {
    if (!d) return;
    const w = lib.get(d.key)!;
    let structure = w.structure;
    if (d.share && shares > 0) structure = scaleToTss(structure, Math.max(25, (remaining * d.share) / shares));
    const m = workoutMetrics(structure);
    out.push({
      date: iso(addDays(parseISO(week.weekStart), i)),
      sport: w.sport,
      title: w.name.replace(/ \d+h$/, '') + (d.share ? ` ${Math.round((m.duration / 3600) * 4) / 4}h` : ''),
      description: w.description,
      structure,
      tss: Math.round(m.tss),
      duration: m.duration,
      if: m.if,
    });
  });
  return out;
}
