import type { Sport, WorkoutBlock, WorkoutIntent, WorkoutStep, WorkoutStructure } from '../types';

export interface Segment {
  start: number;
  duration: number;
  low: number;
  high: number;
  ramp: boolean;
  intent: WorkoutIntent;
  label?: string;
  cadence?: number | null;
  repeat?: { index: number; of: number; blockId: string };
}

let idCounter = 0;
export function uid(): string {
  idCounter = (idCounter + 1) % 1e6;
  return Math.random().toString(36).slice(2, 8) + idCounter.toString(36);
}

export function step(intent: WorkoutIntent, minutes: number, low: number, high = low, opts: Partial<WorkoutStep> = {}): WorkoutStep {
  return { kind: 'step', id: uid(), intent, duration: Math.round(minutes * 60), low, high, ...opts };
}

export function repeat(count: number, steps: WorkoutStep[]): WorkoutBlock {
  return { kind: 'repeat', id: uid(), count, steps };
}

export function flatten(structure: WorkoutStructure | WorkoutBlock[]): Segment[] {
  const blocks = Array.isArray(structure) ? structure : structure.blocks;
  const out: Segment[] = [];
  let t = 0;
  const push = (s: WorkoutStep, rep?: Segment['repeat']) => {
    out.push({
      start: t,
      duration: s.duration,
      low: s.low,
      high: s.high,
      ramp: !!s.ramp,
      intent: s.intent,
      label: s.label,
      cadence: s.cadence,
      repeat: rep,
    });
    t += s.duration;
  };
  for (const b of blocks) {
    if (b.kind === 'step') push(b);
    else for (let i = 0; i < b.count; i++) for (const s of b.steps) push(s, { index: i + 1, of: b.count, blockId: b.id });
  }
  return out;
}

/** 1 Hz intensity (fraction of threshold) for a structure. Ranges use their midpoint. */
export function intensitySeries(structure: WorkoutStructure): number[] {
  const out: number[] = [];
  for (const s of flatten(structure)) {
    for (let i = 0; i < s.duration; i++) {
      out.push(s.ramp ? s.low + ((s.high - s.low) * i) / Math.max(1, s.duration - 1) : (s.low + s.high) / 2);
    }
  }
  return out;
}

export interface WorkoutMetrics {
  duration: number;
  if: number;
  tss: number;
  avg: number;
  /** kJ at the given FTP (bike only) */
  work: number | null;
  timeAboveThreshold: number;
  zoneSeconds: number[];
}

export function workoutMetrics(structure: WorkoutStructure, ftp?: number): WorkoutMetrics {
  const s = intensitySeries(structure);
  const n = s.length;
  if (!n) return { duration: 0, if: 0, tss: 0, avg: 0, work: 0, timeAboveThreshold: 0, zoneSeconds: [] };
  // NP-style normalisation (30 s rolling, 4th power)
  let sum = 0;
  let sum4 = 0;
  let c = 0;
  let roll = 0;
  let above = 0;
  const bounds = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
  const zones = new Array(bounds.length + 1).fill(0);
  for (let i = 0; i < n; i++) {
    sum += s[i];
    roll += s[i];
    if (i >= 30) roll -= s[i - 30];
    const r = roll / Math.min(i + 1, 30);
    sum4 += r ** 4;
    c++;
    if (s[i] >= 1) above++;
    let z = 0;
    while (z < bounds.length && s[i] >= bounds[z]) z++;
    zones[z]++;
  }
  const intensity = structure.target === 'hr' ? sum / n : (sum4 / c) ** 0.25;
  const tss = (n / 3600) * intensity * intensity * 100;
  return {
    duration: n,
    if: intensity,
    tss,
    avg: sum / n,
    work: ftp ? (sum / n) * ftp * n / 1000 : null,
    timeAboveThreshold: above,
    zoneSeconds: zones,
  };
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

/** Zwift .zwo export */
export function toZwo(name: string, description: string, structure: WorkoutStructure, sport: Sport = 'ride'): string {
  const lines: string[] = [];
  const f = (x: number) => x.toFixed(3);
  const stepXml = (s: WorkoutStep) => {
    const cad = s.cadence ? ` Cadence="${s.cadence}"` : '';
    if (s.ramp || s.low !== s.high) {
      const tag = s.intent === 'warmup' ? 'Warmup' : s.intent === 'cooldown' ? 'Cooldown' : 'Ramp';
      if (s.ramp) return `    <${tag} Duration="${s.duration}" PowerLow="${f(s.low)}" PowerHigh="${f(s.high)}"${cad}/>`;
    }
    return `    <SteadyState Duration="${s.duration}" Power="${f((s.low + s.high) / 2)}"${cad}/>`;
  };
  for (const b of structure.blocks) {
    if (b.kind === 'step') lines.push(stepXml(b));
    else if (b.steps.length === 2) {
      const [on, off] = b.steps;
      lines.push(
        `    <IntervalsT Repeat="${b.count}" OnDuration="${on.duration}" OffDuration="${off.duration}" OnPower="${f((on.low + on.high) / 2)}" OffPower="${f((off.low + off.high) / 2)}"${on.cadence ? ` Cadence="${on.cadence}"` : ''}/>`,
      );
    } else for (let i = 0; i < b.count; i++) for (const s of b.steps) lines.push(stepXml(s));
  }
  return `<workout_file>
  <author>Training Analytics</author>
  <name>${esc(name)}</name>
  <description>${esc(description)}</description>
  <sportType>${sport === 'run' ? 'run' : 'bike'}</sportType>
  <tags/>
  <workout>
${lines.join('\n')}
  </workout>
</workout_file>
`;
}

function courseData(structure: WorkoutStructure, scale: (x: number) => number): string {
  const rows: string[] = [];
  for (const s of flatten(structure)) {
    const a = s.start / 60;
    const b = (s.start + s.duration) / 60;
    const lo = scale(s.ramp ? s.low : (s.low + s.high) / 2);
    const hi = scale(s.ramp ? s.high : (s.low + s.high) / 2);
    rows.push(`${a.toFixed(2)}\t${lo}`, `${b.toFixed(2)}\t${hi}`);
  }
  return rows.join('\n');
}

/** .erg (absolute watts) export for trainers / TrainerRoad-style apps */
export function toErg(name: string, structure: WorkoutStructure, ftp: number): string {
  return `[COURSE HEADER]
VERSION = 2
UNITS = ENGLISH
DESCRIPTION = ${name}
FILE NAME = ${name}
FTP = ${Math.round(ftp)}
MINUTES WATTS
[END COURSE HEADER]
[COURSE DATA]
${courseData(structure, (x) => Math.round(x * ftp))}
[END COURSE DATA]
`;
}

/** .mrc (percent of FTP) export */
export function toMrc(name: string, structure: WorkoutStructure): string {
  return `[COURSE HEADER]
VERSION = 2
UNITS = ENGLISH
DESCRIPTION = ${name}
FILE NAME = ${name}
MINUTES PERCENT
[END COURSE HEADER]
[COURSE DATA]
${courseData(structure, (x) => Math.round(x * 100))}
[END COURSE DATA]
`;
}

/** Plain-text description, e.g. "10m 50-75% · 3x (12m 95% / 4m 55%) · 10m 50%". */
export function describe(structure: WorkoutStructure): string {
  const unit = structure.target === 'power' ? '% FTP' : structure.target === 'pace' ? '% pace' : '% LTHR';
  const dur = (s: number) => (s % 60 === 0 ? `${s / 60}m` : s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`);
  const pct = (s: WorkoutStep) =>
    s.low === s.high ? `${Math.round(s.low * 100)}` : `${Math.round(s.low * 100)}–${Math.round(s.high * 100)}`;
  return structure.blocks
    .map((b) =>
      b.kind === 'step'
        ? `${dur(b.duration)} @ ${pct(b)}`
        : `${b.count}× (${b.steps.map((s) => `${dur(s.duration)} @ ${pct(s)}`).join(' / ')})`,
    )
    .join(' · ')
    .concat(` ${unit}`);
}

/** Scale the non-warmup/cooldown work so total TSS approximately matches a target. */
export function scaleToTss(structure: WorkoutStructure, targetTss: number): WorkoutStructure {
  const copy: WorkoutStructure = JSON.parse(JSON.stringify(structure));
  // adjust the longest steady/endurance step's duration
  const steps = copy.blocks.filter((b): b is WorkoutStep => b.kind === 'step' && b.intent === 'active');
  if (!steps.length) return copy;
  const main = steps.reduce((a, b) => (b.duration > a.duration ? b : a));
  for (let i = 0; i < 20; i++) {
    const m = workoutMetrics(copy);
    const diff = targetTss - m.tss;
    if (Math.abs(diff) < 2) break;
    const i2 = ((main.low + main.high) / 2) ** 2;
    const dt = (diff / 100) * 3600 / Math.max(0.2, i2);
    main.duration = Math.max(300, Math.round((main.duration + dt) / 300) * 300);
    if (main.duration === 300 && diff < 0) break;
  }
  return copy;
}
