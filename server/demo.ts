/**
 * Synthetic athlete generator. Produces ~18 months of physiologically plausible training
 * (power physics, heart-rate lag & drift, GPS loops, periodisation, tests, races) so every
 * analysis in the app can be explored without connecting an account.
 */
import { addDays, format, subDays } from 'date-fns';
import { normalizeStreams, type RawSamples } from '../shared/analytics/metrics';
import { flatten, workoutMetrics, step, repeat } from '../shared/analytics/workout';
import { gradeCostFactor } from '../shared/analytics/running';
import { BUILTIN_WORKOUTS } from '../shared/library';
import { generateSeasonPlan } from '../shared/analytics/plan';
import type { Sport, Thresholds, WorkoutStructure } from '../shared/types';
import { DEFAULT_THRESHOLDS, deleteThresholds, resetEstimateCache, q, setPreferences, transaction, upsertThresholds } from './db';
import { saveActivity, type LapInput } from './ingest';

// ---------- randomness ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(42);
const rand = (a = 0, b = 1) => a + (b - a) * rnd();
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const chance = (p: number) => rnd() < p;
const pick = <T>(arr: T[]) => arr[Math.floor(rnd() * arr.length)];
function gauss() {
  const u = Math.max(1e-9, rnd());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

const lib = (key: string) => BUILTIN_WORKOUTS.find((w) => w.key === key)!;

// ---------- athlete state ----------
const HOME = { lat: 41.9794, lng: 2.8214 }; // Girona
const REST_HR = 48;
const MAX_HR = 189;
const LTHR = 168;
const RUN_LTHR = 173;
const WEIGHT = 71;

interface DayPlan {
  sport: Sport;
  title: string;
  structure: WorkoutStructure;
  indoor: boolean;
  terrain: 'flat' | 'rolling' | 'hilly' | 'mountain';
  race?: 'road' | 'fondo' | 'crit' | 'run10k';
  hour: number;
}

// ---------- terrain / routes ----------
interface Route {
  alt: (d: number) => number;
  pos: (d: number) => [number, number];
}

function makeRoute(terrain: DayPlan['terrain'], lengthM: number): Route {
  // [amplitude m, wavelength m] per terrain; gain per km ≈ Σ 2A / λ
  const spec: Record<DayPlan['terrain'], [number, number][]> = {
    flat: [[4, 9000], [1.5, 2500], [0.4, 700]],
    rolling: [[18, 7000], [6, 2600], [1, 800]],
    hilly: [[55, 11000], [10, 3200], [1.5, 900]],
    mountain: [[330, 24000], [25, 5000], [2, 900]],
  };
  const waves = spec[terrain].map(([a, l]) => ({ a: a * rand(0.8, 1.2), l: l * rand(0.85, 1.2), p: rand(0, 6.28) }));
  const amp = waves[0].a;
  const base = 80 + rand(0, 40);
  const alt = (d: number) => base + amp + waves.reduce((s, w) => s + w.a * Math.sin((2 * Math.PI * d) / w.l + w.p), 0);
  // loop around home with lobes, oriented randomly
  const R = Math.max(2500, lengthM / (2 * Math.PI)) / 111_000;
  const rot = rand(0, 2 * Math.PI);
  const lobes = randInt(2, 4);
  const lobePhase = rand(0, 6.28);
  const off = { lat: Math.sin(rot) * R * 0.9, lng: (Math.cos(rot) * R * 0.9) / Math.cos((HOME.lat * Math.PI) / 180) };
  const dir = chance(0.5) ? 1 : -1;
  const ph2 = rand(0, 6.28);
  const ph3 = rand(0, 6.28);
  const pos = (d: number): [number, number] => {
    const th = rot + Math.PI + (dir * 2 * Math.PI * d) / lengthM;
    const r = R * (1 + 0.26 * Math.sin(lobes * th + lobePhase) + 0.12 * Math.sin(5 * th + ph2) + 0.05 * Math.sin(11 * th + ph3));
    const wig = 0.0007 * Math.sin(d / 420 + ph2) + 0.0003 * Math.sin(d / 130) + 0.00012 * Math.sin(d / 41);
    return [HOME.lat + off.lat + r * Math.sin(th) + wig, HOME.lng + off.lng + (r * Math.cos(th)) / Math.cos((HOME.lat * Math.PI) / 180) + wig];
  };
  return { alt, pos };
}

// ---------- physics ----------
const RHO = 1.2;
const G = 9.81;
function speedForPower(p: number, grade: number, cda: number, mass: number, crr = 0.0042): number {
  const resist = mass * G * (crr + grade);
  if (p <= 5) {
    if (resist >= 0) return 0.5;
    return Math.min(17, Math.sqrt((-2 * resist) / (RHO * cda)));
  }
  let v = 8;
  for (let i = 0; i < 12; i++) {
    const f = 0.5 * RHO * cda * v ** 3 + resist * v - p * 0.975;
    const df = 1.5 * RHO * cda * v * v + resist;
    const nv = v - f / (Math.abs(df) < 1e-3 ? 1e-3 : df);
    v = Math.max(0.8, Math.min(22, nv));
  }
  return v;
}

// ---------- stream synthesis ----------
function targetSeries(structure: WorkoutStructure): { t: number[]; laps: LapInput[] } {
  const t: number[] = [];
  const laps: LapInput[] = [];
  for (const s of flatten(structure)) {
    laps.push({ name: s.label ?? (s.intent === 'active' ? 'Work' : s.intent[0].toUpperCase() + s.intent.slice(1)), start: t.length, duration: s.duration });
    for (let i = 0; i < s.duration; i++) t.push(s.ramp ? s.low + ((s.high - s.low) * i) / Math.max(1, s.duration - 1) : s.low + (s.high - s.low) * rand(0.35, 0.65));
  }
  return { t, laps };
}

interface Physio {
  ftp: number;
  runThr: number; // m/s
  ctl: number;
  temp: number;
}

function hrModel(frac: number[], lthr: number, fitness: number, heat: number): number[] {
  const out: number[] = [];
  let hr = REST_HR + 25;
  let smoothed = frac[0] ?? 0;
  let drift = 0;
  for (let i = 0; i < frac.length; i++) {
    smoothed += (frac[i] - smoothed) / 12;
    const f = Math.max(0, smoothed);
    if (f > 0.5) drift += 0.0005 * (f - 0.45) * (1 + heat);
    const target = Math.min(MAX_HR - 1, REST_HR + (lthr - REST_HR) * (0.32 + 0.68 * f) + drift - fitness);
    hr += (target - hr) / (target > hr ? 22 : 38);
    out.push(Math.round(hr + gauss() * 0.8));
  }
  return out;
}

function synthRide(plan: DayPlan, ph: Physio) {
  const { t: target, laps } = targetSeries(plan.structure);
  let n = target.length;
  const race = plan.race;
  // races: build a stochastic target instead
  let tgt = target;
  if (race) {
    const dur = race === 'crit' ? 3600 : race === 'road' ? 3 * 3600 + randInt(0, 1800) : 4.6 * 3600 + randInt(0, 2400);
    tgt = [];
    let base = race === 'crit' ? 0.92 : race === 'road' ? 0.74 : 0.72;
    while (tgt.length < dur) {
      const surge = chance(race === 'crit' ? 0.35 : 0.12);
      const len = surge ? randInt(race === 'crit' ? 8 : 15, race === 'crit' ? 40 : 150) : randInt(60, 420);
      const lvl = surge ? rand(1.12, race === 'crit' ? 1.8 : 1.4) : base + rand(-0.12, 0.08);
      for (let i = 0; i < len; i++) tgt.push(lvl);
      base -= 0.002;
    }
    // finale: hard final km + sprint
    const end = tgt.length;
    for (let i = end - 300; i < end - 20; i++) tgt[i] = rand(1.05, 1.2);
    for (let i = end - 20; i < end - 5; i++) tgt[i] = rand(2.8, 3.5);
    n = tgt.length;
  }
  const indoor = plan.indoor;
  const lengthGuess = n * (indoor ? 9 : 8.2);
  const route = makeRoute(plan.terrain, lengthGuess);
  const cda = indoor ? 0.3 : race ? 0.29 : 0.33;
  const mass = WEIGHT + 8.5;
  const watts: number[] = [];
  const speed: number[] = [];
  const dist: number[] = [];
  const alt: number[] = [];
  const cad: (number | null)[] = [];
  const lat: number[] = [];
  const lng: number[] = [];
  let v = 0.5;
  let d = 0;
  let e = 0;
  let stopUntil = -1;
  let coastUntil = -1;
  const sprints = !indoor && !race && chance(0.4) ? Array.from({ length: randInt(1, 4) }, () => randInt(600, Math.max(700, n - 300))) : [];
  const fatigueOnset = ph.ctl * 45; // kJ after which power fades slightly (durability)
  let kj = 0;
  for (let i = 0; i < n; i++) {
    const a0 = route.alt(d);
    const a1 = route.alt(d + 10);
    const grade = indoor ? 0 : Math.max(-0.14, Math.min(0.14, (a1 - a0) / 10));
    let frac = tgt[i];
    if (!indoor && frac < 0.85 && !race) {
      frac *= Math.max(0, Math.min(1.35, 1 + grade * 6));
      if (grade < -0.035) frac = chance(0.85) ? 0 : frac * 0.3;
    }
    if (sprints.some((s) => i >= s && i < s + 12)) frac = rand(2.6, 3.6) * (1 - (i % 12) * 0.03);
    e = 0.93 * e + gauss() * (indoor ? 0.012 : 0.03);
    // late-ride fade once work exceeds what this athlete's durability supports
    const fade = kj > fatigueOnset ? Math.max(0.9, 1 - (kj - fatigueOnset) / 40000) : 1;
    let p = Math.max(0, frac * ph.ftp * (1 + e) * fade);
    if (!indoor && i > stopUntil && chance(0.0006) && !race) stopUntil = i + randInt(20, 240); // traffic light / cafe
    if (!indoor && chance(0.004)) coastUntil = i + randInt(2, 8);
    const stopped = i <= stopUntil;
    if (stopped || i <= coastUntil) p = 0;
    p = Math.round(p);
    kj += p / 1000;
    const vt = stopped ? 0 : indoor ? speedForPower(p, 0, cda, mass) : speedForPower(p, grade, cda, mass);
    v += (vt - v) * (stopped ? 0.4 : 0.12);
    if (v < 0.3 && stopped) v = 0;
    d += v;
    watts.push(p);
    speed.push(v);
    dist.push(d);
    alt.push(indoor ? 0 : a0);
    cad.push(p > 0 && !stopped ? Math.round(Math.max(55, 88 + (frac > 1.4 ? 12 : 0) - grade * 120 + gauss() * 3)) : 0);
    if (!indoor) {
      const [la, lo] = route.pos(d);
      lat.push(la);
      lng.push(lo);
    }
  }
  const frac = watts.map((p) => p / ph.ftp);
  const heartrate = hrModel(frac, LTHR, (ph.ctl - 55) * 0.12, Math.max(0, (ph.temp - 18) / 15));
  const raw: RawSamples = {
    time: watts.map((_, i) => i),
    watts,
    heartrate,
    cadence: cad,
    speed,
    distance: dist,
    altitude: indoor ? undefined : alt,
    lat: indoor ? undefined : lat,
    lng: indoor ? undefined : lng,
    temp: watts.map((_, i) => Math.round((ph.temp + (indoor ? 4 : 0) + Math.sin(i / 3000) * 1.5) * 10) / 10),
  };
  return { raw, laps: race ? null : laps };
}

function synthRun(plan: DayPlan, ph: Physio) {
  const { t: target, laps } = targetSeries(plan.structure);
  let tgt = target;
  if (plan.race === 'run10k') {
    tgt = new Array(Math.round(10000 / (ph.runThr * 1.03)) + 30).fill(1.03);
    for (let i = tgt.length - 120; i < tgt.length; i++) tgt[i] = 1.12;
  }
  const n = tgt.length;
  const route = makeRoute(plan.terrain === 'mountain' ? 'hilly' : plan.terrain, n * ph.runThr * 0.8);
  const speed: number[] = [];
  const dist: number[] = [];
  const alt: number[] = [];
  const cad: number[] = [];
  const lat: number[] = [];
  const lng: number[] = [];
  let v = 1.5;
  let d = 0;
  let e = 0;
  for (let i = 0; i < n; i++) {
    const a0 = route.alt(d);
    const grade = Math.max(-0.12, Math.min(0.12, (route.alt(d + 8) - a0) / 8));
    e = 0.95 * e + gauss() * 0.012;
    const gapTarget = tgt[i] * ph.runThr * (1 + e);
    const vt = gapTarget / gradeCostFactor(grade);
    v += (vt - v) * 0.15;
    d += v;
    speed.push(v);
    dist.push(d);
    alt.push(a0);
    cad.push(Math.round(84 + tgt[i] * 6 + gauss() * 1.5));
    const [la, lo] = route.pos(d);
    lat.push(la);
    lng.push(lo);
  }
  const frac = speed.map((s, i) => (s * gradeCostFactor((route.alt(dist[i] + 8) - alt[i]) / 8)) / ph.runThr);
  const heartrate = hrModel(frac, RUN_LTHR, (ph.ctl - 55) * 0.08, Math.max(0, (ph.temp - 16) / 12));
  return {
    raw: {
      time: speed.map((_, i) => i),
      heartrate,
      cadence: cad,
      speed,
      distance: dist,
      altitude: alt,
      lat,
      lng,
      temp: speed.map(() => ph.temp),
    } as RawSamples,
    laps: plan.race ? null : laps,
  };
}

function synthSwim(plan: DayPlan, ph: Physio) {
  const { t: target } = targetSeries(plan.structure);
  const css = 1.02 + ph.ctl * 0.002;
  const speed: number[] = [];
  const dist: number[] = [];
  let d = 0;
  for (let i = 0; i < target.length; i++) {
    const resting = i % 300 > 280;
    const v = resting ? 0 : css * target[i] * (1 + gauss() * 0.02);
    d += v;
    speed.push(v);
    dist.push(d);
  }
  const heartrate = hrModel(speed.map((s) => s / css), LTHR - 10, 0, 0);
  return { raw: { time: speed.map((_, i) => i), speed, distance: dist, heartrate } as RawSamples, laps: null };
}

function synthStrength(minutes: number) {
  const n = minutes * 60;
  const frac = Array.from({ length: n }, (_, i) => (i % 180 < 50 ? 0.85 : 0.35));
  return { raw: { time: frac.map((_, i) => i), heartrate: hrModel(frac, LTHR, 0, 0) } as RawSamples, laps: null };
}

// ---------- the season ----------
type Phase = 'Base' | 'Build' | 'Peak' | 'Race' | 'Transition' | 'Recovery';

const RACES: { offset: number; name: string; kind: NonNullable<DayPlan['race']>; priority: 'A' | 'B' | 'C'; sport: Sport }[] = [
  { offset: -441, name: 'Spring Road Race', kind: 'road', priority: 'B', sport: 'ride' },
  { offset: -413, name: 'Pyrenees Gran Fondo', kind: 'fondo', priority: 'A', sport: 'ride' },
  { offset: -161, name: 'City 10K', kind: 'run10k', priority: 'C', sport: 'run' },
  { offset: -133, name: 'Criterium Series #2', kind: 'crit', priority: 'C', sport: 'ride' },
  { offset: -77, name: 'Mountain Gran Fondo', kind: 'fondo', priority: 'A', sport: 'ride' },
  { offset: -21, name: 'Autumn Road Race', kind: 'road', priority: 'B', sport: 'ride' },
];

function phaseFor(daysAgo: number): Phase {
  // daysAgo positive = past. Season arcs relative to today.
  const d = -daysAgo;
  if (d < -480) return 'Build';
  if (d < -420) return 'Peak';
  if (d < -405) return 'Race';
  if (d < -380) return 'Transition';
  if (d < -330) return 'Base';
  if (d < -270) return 'Transition';
  if (d < -180) return 'Base';
  if (d < -95) return 'Build';
  if (d < -80) return 'Peak';
  if (d < -70) return 'Race';
  if (d < -55) return 'Transition';
  return 'Build';
}

const KEY_RIDES: Record<Phase, string[]> = {
  Base: ['sweetspot-3x15', 'tempo-3x15', 'sweetspot-2x30'],
  Build: ['threshold-2x20', 'over-unders', 'vo2-5x5', 'threshold-4x10', 'sweetspot-2x30'],
  Peak: ['vo2-30-30', 'anaerobic-8x1', 'vo2-5x5', 'over-unders'],
  Race: ['vo2-5x5', 'sprints'],
  Transition: ['endurance-2h', 'recovery-spin'],
  Recovery: ['recovery-spin', 'endurance-2h'],
};

function endurance(minutes: number, low = 0.62, high = 0.72, tempoMinutes = 0): WorkoutStructure {
  const blocks: WorkoutStructure['blocks'] = [step('warmup', 10, 0.45, 0.62, { ramp: true, label: 'Warm up' })];
  const main = Math.max(20, minutes - 20 - tempoMinutes);
  blocks.push(step('active', main, low, high, { label: 'Endurance' }));
  if (tempoMinutes) blocks.push(step('active', tempoMinutes, 0.8, 0.86, { label: 'Tempo' }));
  blocks.push(step('cooldown', 10, 0.6, 0.45, { ramp: true, label: 'Cool down' }));
  return { target: 'power', blocks };
}

function runStructure(minutes: number, kind: 'easy' | 'long' | 'tempo' | 'intervals'): WorkoutStructure {
  if (kind === 'tempo') return lib('run-tempo').structure;
  if (kind === 'intervals') return pick([lib('run-threshold').structure, lib('run-vo2').structure]);
  const lo = kind === 'long' ? 0.74 : 0.72;
  return { target: 'pace', blocks: [step('warmup', 8, 0.66, 0.7), step('active', minutes - 13, lo, lo + 0.07), step('cooldown', 5, 0.66, 0.66)] };
}

function planDay(date: Date, daysAgo: number, weekIndex: number): DayPlan[] {
  const dow = (date.getDay() + 6) % 7; // 0 = Monday
  const month = date.getMonth();
  const winter = month >= 10 || month <= 1;
  let phase = phaseFor(daysAgo);
  const recoveryWeek = weekIndex % 4 === 3 && phase !== 'Transition';
  if (recoveryWeek) phase = 'Recovery';
  const race = RACES.find((r) => r.offset === -daysAgo);
  const vol = { Base: 1, Build: 1.05, Peak: 0.9, Race: 0.7, Transition: 0.55, Recovery: 0.6 }[phase];
  const indoorWeekday = winter ? chance(0.8) : chance(0.2);
  const hour = dow >= 5 ? randInt(7, 9) : randInt(17, 18);
  const ride = (title: string, structure: WorkoutStructure, indoor: boolean, terrain: DayPlan['terrain'] = 'rolling'): DayPlan => ({
    sport: 'ride',
    title,
    structure,
    indoor,
    terrain,
    hour,
  });
  const out: DayPlan[] = [];

  if (race) {
    const r: DayPlan =
      race.sport === 'run'
        ? { sport: 'run', title: race.name, structure: runStructure(45, 'easy'), indoor: false, terrain: 'flat', race: race.kind, hour: 9 }
        : { sport: 'ride', title: race.name, structure: endurance(60), indoor: false, terrain: race.kind === 'fondo' ? 'mountain' : race.kind === 'crit' ? 'flat' : 'hilly', race: race.kind, hour: 8 };
    return [r];
  }
  if (RACES.some((r) => r.offset === -daysAgo + 1)) {
    return [ride('Openers', { target: 'power', blocks: [step('active', 35, 0.6, 0.7), repeat(3, [step('active', 1, 1.2, 1.2), step('recovery', 2, 0.5)]), step('cooldown', 10, 0.55, 0.5)] }, false, 'flat')];
  }
  // periodic FTP tests at the start of blocks
  if (dow === 1 && [470, 320, 250, 173, 110, 44].some((o) => daysAgo <= o && daysAgo > o - 7)) {
    return [ride('FTP Test', lib('ftp-test-20').structure, true, 'flat')];
  }
  if (chance(phase === 'Transition' ? 0.25 : 0.07)) return []; // life happens

  switch (dow) {
    case 0:
      if (chance(0.35)) out.push({ sport: 'swim', title: 'Pool swim', structure: { target: 'pace', blocks: [step('active', randInt(35, 50), 0.82, 0.9)] }, indoor: true, terrain: 'flat', hour: 7 });
      break;
    case 1:
    case 3: {
      const key = pick(KEY_RIDES[phase]);
      const w = lib(key);
      if (phase === 'Transition' || phase === 'Recovery') out.push(ride(key === 'recovery-spin' ? 'Recovery spin' : 'Easy endurance', key === 'recovery-spin' ? w.structure : endurance(Math.round(70 * vol) + 20), indoorWeekday, 'flat'));
      else out.push(ride(w.name, w.structure, indoorWeekday, 'rolling'));
      if (dow === 3 && winter && chance(0.5)) out.push({ sport: 'strength', title: 'Strength & mobility', structure: endurance(45), indoor: true, terrain: 'flat', hour: 7 });
      break;
    }
    case 2:
      if (chance(0.55)) {
        const kind = phase === 'Build' && chance(0.35) ? pick<'tempo' | 'intervals'>(['tempo', 'intervals']) : 'easy';
        const title = kind === 'tempo' ? 'Tempo run' : kind === 'intervals' ? 'Run intervals' : 'Easy run';
        out.push({ sport: 'run', title, structure: runStructure(Math.round(randInt(35, 55) * vol) + 10, kind), indoor: false, terrain: 'rolling', hour: 7 });
      }
      else out.push(ride('Endurance ride', endurance(Math.round(randInt(70, 100) * vol)), indoorWeekday, 'rolling'));
      break;
    case 4:
      if (chance(0.3)) out.push({ sport: 'swim', title: 'Technique swim', structure: { target: 'pace', blocks: [step('active', randInt(30, 45), 0.8, 0.88)] }, indoor: true, terrain: 'flat', hour: 7 });
      else if (winter && chance(0.4)) out.push({ sport: 'strength', title: 'Gym session', structure: endurance(50), indoor: true, terrain: 'flat', hour: 18 });
      break;
    case 5: {
      const long = Math.round(randInt(160, 250) * vol);
      const terrain = pick<DayPlan['terrain']>(['rolling', 'hilly', 'hilly', 'mountain']);
      const indoor = winter && chance(0.35);
      const tempo = phase === 'Build' || phase === 'Base' ? randInt(0, 3) * 15 : 0;
      out.push(ride(indoor ? 'Long indoor endurance' : pick(['Long ride', 'Hilly loop', 'Coffee ride', 'Group ride', 'Coast road loop']), endurance(indoor ? Math.min(150, long) : long, 0.62, 0.72, tempo), indoor, indoor ? 'flat' : terrain));
      break;
    }
    case 6:
      if (chance(0.5)) out.push({ sport: 'run', title: 'Long run', structure: runStructure(Math.round(randInt(60, 95) * vol) + 10, 'long'), indoor: false, terrain: pick(['rolling', 'hilly']), hour: 8 });
      if (out.length === 0 || chance(0.4)) out.push(ride('Sunday endurance', endurance(Math.round(randInt(90, 150) * vol)), false, pick(['flat', 'rolling', 'hilly'])));
      if (out.length === 2) out[1].hour = 14;
      break;
  }
  return out;
}

export async function loadDemo(onProgress?: (msg: string) => void): Promise<number> {
  rnd = mulberry32(42);
  clearDemo();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const START = 540;
  setPreferences({ athleteName: 'Alex Rider' });

  // Precompute plan for every day so we can derive thresholds (tests) and planned workouts
  const days: { date: Date; daysAgo: number; plans: DayPlan[] }[] = [];
  for (let ago = START; ago >= -21; ago--) {
    const date = subDays(today, ago);
    const weekIndex = Math.floor((START - ago + ((subDays(today, START).getDay() + 6) % 7)) / 7);
    days.push({ date, daysAgo: ago, plans: planDay(date, ago, weekIndex) });
  }

  // simple fitness model drives true FTP / run threshold
  let ctl = 42;
  let atl = 45;
  let ftp = 238;
  let runThr = 3.55;
  let count = 0;
  let testedFtp = 240;
  upsertThresholds({ ...demoThresholds(format(subDays(today, START), 'yyyy-MM-dd'), testedFtp, runThr) });

  // planned workouts: last 3 weeks (compliance) & next 3 weeks
  const iso = (d: Date) => format(d, 'yyyy-MM-dd');
  transaction(() => {
    for (const d of days) {
      if (d.daysAgo > 21) continue;
      d.plans.forEach((p, i) => {
        const m = workoutMetrics(p.structure);
        const isRace = !!p.race;
        q.run(
          `INSERT INTO planned_workouts(date, sport, title, description, structure, planned_duration, planned_tss, planned_if, source, sort_order)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'demo', ?)`,
          iso(d.date),
          p.sport,
          p.title,
          isRace ? 'Race day — execute the plan.' : null,
          p.sport === 'strength' || isRace ? null : JSON.stringify(p.structure),
          isRace ? (p.race === 'run10k' ? 2400 : 4 * 3600) : m.duration,
          isRace ? (p.race === 'run10k' ? 70 : 280) : Math.round(m.tss),
          isRace ? null : m.if,
          i,
        );
      });
    }
  });

  let lastMsg = 0;
  for (const d of days) {
    if (d.daysAgo <= 0) break;
    const month = d.date.getMonth();
    const temp = 13 + 11 * Math.sin(((month - 3) / 12) * 2 * Math.PI) + rand(-3, 3);
    let dayTss = 0;
    for (const plan of d.plans) {
      const ph: Physio = { ftp, runThr, ctl, temp };
      const start = new Date(d.date);
      start.setHours(plan.hour, randInt(0, 50), 0, 0);
      let synth;
      if (plan.sport === 'ride') synth = synthRide(plan, ph);
      else if (plan.sport === 'run') synth = synthRun(plan, ph);
      else if (plan.sport === 'swim') synth = synthSwim(plan, ph);
      else synth = synthStrength(randInt(40, 55));
      const streams = normalizeStreams(synth.raw);
      if (!streams) continue;
      const id = saveActivity({
        source: 'demo',
        externalId: `${iso(d.date)}-${count}`,
        name: plan.title,
        sport: plan.sport,
        startTime: start.toISOString(),
        localDate: iso(d.date),
        trainer: plan.indoor && plan.sport === 'ride',
        streams,
        laps: synth.laps,
        device: plan.sport === 'ride' ? (plan.indoor ? 'Wahoo KICKR' : 'Garmin Edge 840') : plan.sport === 'strength' ? 'Garmin Forerunner 965' : 'Garmin Forerunner 965',
        rpe: plan.race ? 9 : chance(0.3) ? randInt(3, 8) : null,
      });
      count++;
      if (id) {
        const t = q.get('SELECT tss, np FROM activities WHERE id = ?', id);
        dayTss += t?.tss ?? 0;
        // FTP test → new threshold entry
        if (plan.title === 'FTP Test' && streams.watts) {
          const w = streams.watts;
          let best = 0;
          let s = 0;
          for (let i = 0; i < w.length; i++) {
            s += w[i];
            if (i >= 1200) s -= w[i - 1200];
            if (i >= 1199) best = Math.max(best, s / 1200);
          }
          testedFtp = Math.round(best * 0.95);
          upsertThresholds(demoThresholds(iso(addDays(d.date, 1)), testedFtp, runThr));
        }
      }
      if (Date.now() - lastMsg > 400) {
        lastMsg = Date.now();
        onProgress?.(`Generating ${iso(d.date)} (${count} activities)`);
      }
      await new Promise((r) => setImmediate(r));
    }
    // update physiology
    ctl += (dayTss - ctl) * (1 - Math.exp(-1 / 42));
    atl += (dayTss - atl) * (1 - Math.exp(-1 / 7));
    const trueFtp = 190 + 1.12 * ctl + (START - d.daysAgo) * 0.025;
    ftp += (trueFtp - ftp) * 0.05;
    runThr += (3.35 + 0.006 * ctl - runThr) * 0.04;
  }

  // races & a season plan for the upcoming A race
  const future = [
    { offset: 49, name: 'Autumn Classic', priority: 'A', sport: 'ride' },
    { offset: 28, name: 'Hill Climb Championship', priority: 'C', sport: 'ride' },
  ];
  transaction(() => {
    for (const r of [...RACES.map((r) => ({ ...r, offset: r.offset })), ...future]) {
      q.run(
        "INSERT INTO events(date, name, sport, priority, description) VALUES(?, ?, ?, ?, 'demo')",
        iso(addDays(today, r.offset)),
        r.name,
        r.sport,
        r.priority,
      );
    }
  });
  const raceDate = iso(addDays(today, 49));
  const cfg = {
    startDate: iso(today),
    raceDate,
    startCtl: Math.round(ctl),
    startAtl: Math.round(atl),
    targetCtl: Math.round(ctl + 14),
    maxRamp: 5,
    pattern: '3:1' as const,
    taperWeeks: 2,
    maxWeeklyHours: 14,
    sport: 'ride' as const,
  };
  const weeks = generateSeasonPlan(cfg, [{ date: raceDate, name: 'Autumn Classic', priority: 'A' }]);
  const ev = q.get('SELECT id FROM events WHERE date = ? AND name = ?', raceDate, 'Autumn Classic');
  q.run("INSERT INTO season_plans(name, config, weeks, event_id) VALUES('Road to the Autumn Classic', ?, ?, ?)", JSON.stringify(cfg), JSON.stringify(weeks), ev?.id ?? null);
  q.run("INSERT INTO settings(key, value) VALUES('demo', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'");
  return count;
}

function demoThresholds(date: string, ftp: number, runThr: number): Thresholds {
  return {
    ...DEFAULT_THRESHOLDS,
    date,
    ftp,
    wPrime: 19500,
    lthr: LTHR,
    runLthr: RUN_LTHR,
    maxHr: MAX_HR,
    restHr: REST_HR,
    runThresholdSpeed: Math.round(runThr * 100) / 100,
    swimCss: 1.15,
    weight: WEIGHT,
  };
}

export function clearDemo() {
  transaction(() => {
    q.run("DELETE FROM activities WHERE source = 'demo'");
    q.run("DELETE FROM planned_workouts WHERE source = 'demo'");
    q.run("DELETE FROM events WHERE description = 'demo'");
    q.run("DELETE FROM season_plans WHERE name = 'Road to the Autumn Classic'");
    q.run('DELETE FROM threshold_estimates');
    if (q.get("SELECT value FROM settings WHERE key = 'demo'")) {
      q.run('DELETE FROM thresholds');
      q.run("DELETE FROM settings WHERE key = 'demo'");
    }
  });
  deleteThresholds('0000-00-00'); // resets the thresholds cache
  resetEstimateCache();
}

export function isDemo(): boolean {
  return !!q.get("SELECT value FROM settings WHERE key = 'demo'");
}
