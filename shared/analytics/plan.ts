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
  const taper = Math.min(config.taperWeeks, Math.max(0, nWeeks - 2));
  const loadCycle = config.pattern === '2:1' ? 3 : config.pattern === '4:1' ? 5 : 4;

  // phases, assigned backwards from race week
  const phases: string[] = new Array(nWeeks).fill('Base');
  phases[nWeeks - 1] = 'Race';
  for (let i = 0; i < taper; i++) phases[nWeeks - 2 - i] = i === 0 ? 'Taper' : 'Peak';
  let idx = nWeeks - 2 - taper;
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

  // recovery weeks: last week of each load cycle, counting backwards from the taper so
  // the athlete enters the taper after a load week sequence
  const recovery: boolean[] = new Array(nWeeks).fill(false);
  const loadEnd = nWeeks - 1 - taper; // exclusive
  for (let i = loadEnd - 1, c = 1; i >= 0; i--, c++) {
    if (c % loadCycle === 0 && phases[i] !== 'Prep') recovery[i] = true;
  }
  // make sure we start with a load week
  if (nWeeks > 2) recovery[0] = false;

  const loadWeeks = recovery.slice(0, loadEnd).filter((r) => !r).length || 1;
  const recoveryWeeks = recovery.slice(0, loadEnd).filter((r) => r).length;
  // a recovery week typically costs ~2–3 CTL; plan the build to cover it
  const needed = config.targetCtl - config.startCtl + recoveryWeeks * 2.5 + taper * 1.5;
  const ramp = Math.max(0, Math.min(config.maxRamp, needed / loadWeeks));

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
      const targetEnd = Math.min(config.targetCtl, ctl + ramp);
      tss = 7 * dailyTssForCtl(ctl, Math.max(targetEnd, ctl * 0.98), 7, ctlDays);
      if (baseName === 'Prep') tss = Math.min(tss, 7 * dailyTssForCtl(ctl, ctl + ramp * 0.5, 7, ctlDays));
    }
    const intensity = PHASE_IF[phase === 'Recovery' ? 'Recovery' : baseName] ?? 0.7;
    const maxTss = config.maxWeeklyHours * intensity * intensity * 100;
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
      hours: Math.round((tss / (intensity * intensity * 100)) * 10) / 10,
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

/** Fill a week with concrete structured workouts that sum to roughly the planned TSS. */
export function generateWeekWorkouts(week: SeasonWeek): GeneratedWorkout[] {
  const base = week.recovery ? 'Recovery' : week.phase.split(' ')[0];
  const tpl = WEEK_TEMPLATES[base] ?? WEEK_TEMPLATES.Base;
  const lib = new Map(BUILTIN_WORKOUTS.map((w) => [w.key, w]));
  const fixed = tpl.map((d) => (d && !d.share ? workoutMetrics(lib.get(d.key)!.structure).tss : 0));
  const fixedTotal = fixed.reduce((a, b) => a + b, 0);
  const shares = tpl.reduce((a, d) => a + (d?.share ?? 0), 0);
  const remaining = Math.max(0, week.tss - fixedTotal);
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
