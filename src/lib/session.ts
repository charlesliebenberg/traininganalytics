import { setLabel, type Execution, type SessionAnalysis, type SessionType, type SetSummary, type Surges, type WorkSet } from '../../shared/analytics/session';
import type { Progression } from '../../shared/analytics/session';
import { alpha, type Tokens } from './theme';
import { fmtDate, fmtDuration, fmtPace } from './format';

export type SetProgress = Progression & { current: SetSummary };

/** Kinds of session, folded for charts: six colours, shared with the comeback's build. */
export type SessionGroup = 'recovery' | 'endurance' | 'tempo' | 'threshold' | 'vo2' | 'race';
export const SESSION_GROUPS: SessionGroup[] = ['recovery', 'endurance', 'tempo', 'threshold', 'vo2', 'race'];
export const GROUP_OF: Record<SessionType, SessionGroup> = {
  recovery: 'recovery',
  endurance: 'endurance',
  tempo: 'tempo',
  sweetspot: 'tempo',
  mixed: 'tempo',
  threshold: 'threshold',
  vo2: 'vo2',
  anaerobic: 'vo2',
  sprint: 'vo2',
  race: 'race',
};
export const GROUP_LABEL: Record<SessionGroup, string> = {
  recovery: 'Recovery',
  endurance: 'Endurance',
  tempo: 'Tempo & sweet spot',
  threshold: 'Threshold',
  vo2: 'VO2max & anaerobic',
  race: 'Race & group ride',
};
export function groupColor(t: Tokens, g: SessionGroup): string {
  // validated for colour-vision deficiency, light and dark (blue, amber, green, purple, red)
  return { recovery: alpha(t.muted, 0.55), endurance: t.series[0], tempo: t.series[3], threshold: t.series[2], vo2: t.series[6], race: t.series[7] }[g];
}
export const typeColor = (t: Tokens, s: SessionType) => groupColor(t, GROUP_OF[s]);

/** Short name of a kind of session. */
export const TYPE_LABEL: Record<SessionType, string> = {
  recovery: 'Recovery',
  endurance: 'Endurance',
  tempo: 'Tempo',
  sweetspot: 'Sweet spot',
  threshold: 'Threshold',
  vo2: 'VO2max',
  anaerobic: 'Anaerobic',
  sprint: 'Sprints',
  race: 'Race / group',
  mixed: 'Mixed',
};

/** The same, in a few letters (narrow day columns). */
export const TYPE_SHORT: Record<SessionType, string> = {
  recovery: 'Rec',
  endurance: 'End',
  tempo: 'Tmp',
  sweetspot: 'SST',
  threshold: 'Thr',
  vo2: 'VO2',
  anaerobic: 'Ana',
  sprint: 'Spr',
  race: 'Race',
  mixed: 'Mix',
};

/** What the session was, as a title: "Threshold intervals", "Long endurance ride", "Easy run". */
export function sessionTitle(s: Pick<SessionAnalysis, 'type' | 'long' | 'sport'> & { main?: Pick<WorkSet, 'kind'> | null }): string {
  const run = s.sport === 'run';
  const kind = s.main?.kind;
  const shape = kind === 'reps' ? 'intervals' : kind === 'ladder' ? 'efforts' : 'effort';
  const what: Record<SessionType, string> = {
    recovery: run ? 'Recovery run' : 'Recovery ride',
    endurance: run ? (s.long ? 'Long run' : 'Easy run') : s.long ? 'Long endurance ride' : 'Endurance ride',
    tempo: kind ? `Tempo ${shape}` : run ? 'Tempo run' : 'Tempo ride',
    sweetspot: `Sweet spot ${kind ? shape : 'ride'}`,
    threshold: kind ? `Threshold ${shape}` : run ? 'Threshold run' : 'Hard steady ride',
    vo2: 'VO2max intervals',
    anaerobic: run ? 'Speed intervals' : 'Anaerobic intervals',
    sprint: 'Sprints',
    race: s.long ? 'Long group ride or race' : 'Group ride or race',
    mixed: 'Mixed-intensity ride',
  };
  const title = what[s.type];
  // a long ride built around a set: say both
  if (s.long && kind && !run && ['tempo', 'sweetspot', 'threshold', 'vo2'].includes(s.type)) return `Long ride with ${title.charAt(0).toLowerCase()}${title.slice(1)}`;
  return title;
}

const restText = (sec: number) => (sec < 90 ? `${Math.round(sec / 5) * 5}-second` : sec < 600 ? `${Math.round(sec / 30) / 2}-minute` : `${Math.round(sec / 60)}-minute`);
export const outText = (sport: string, v: number) => (sport === 'run' ? `${fmtPace(v, 'run')}` : `${Math.round(v)} W`);
const relText = (sport: string, rel: number, thr: number) => (sport === 'run' ? `threshold ${fmtPace(thr, 'run')}` : `${Math.round(rel * 100)}% of FTP`);

/** "3 × 10 min at 307 W (103% of FTP), 5-minute recoveries". */
export function setText(s: WorkSet, sport: string, thr: number): string {
  const at = `${outText(sport, s.out)}${sport === 'run' ? ' grade-adjusted' : ''} (${relText(sport, s.rel, thr)})`;
  if (s.kind === 'single') return `${setLabel(s)} at ${at}`;
  if (s.kind === 'ladder') return `${s.reps.length} efforts of ${s.reps.map((r) => Math.round((r.end - r.start) / 60)).join(', ')} min at ${at}`;
  return `${setLabel(s)} at ${at}${s.rest != null ? `, ${restText(s.rest)} recoveries` : ''}`;
}

const pct = (v: number, digits = 0) => `${Math.abs(v * 100).toFixed(digits)}%`;

/** How evenly the set went, and how heart rate answered it. */
export function executionText(e: Execution, s: WorkSet, sport: string): string {
  const parts: string[] = [];
  const outs = s.reps.map((r) => r.out);
  const list = outs.length <= 6 ? ` (${outs.map((v) => (sport === 'run' ? fmtPace(v, 'run', false) : Math.round(v))).join(', ')}${sport === 'run' ? '' : ' W'})` : '';
  if (e.fade != null) {
    if (Math.abs(e.fade) <= 0.02 && e.cv <= 0.02) parts.push(`Even: every rep within ${Math.max(1, Math.round(e.cv * 200))}% of the others${list}.`);
    else if (e.fade <= -0.04) parts.push(`Faded: the last rep was ${pct(e.fade)} below the first${list}.`);
    else if (e.fade >= 0.03) parts.push(`Built: the last rep was ${pct(e.fade)} above the first${list}.`);
    else parts.push(`Steady reps${list}.`);
  } else if (s.kind === 'ladder') parts.push(`Efforts${list}.`);
  if (e.opening != null && e.opening >= 1.06) parts.push(`Reps opened hard — their first quarter ${pct(e.opening - 1)} above their average.`);
  else if (e.opening != null && e.opening <= 0.94) parts.push(`Reps started easy and built through.`);
  const ends = s.reps.map((r) => r.hrEnd).filter((x): x is number => x != null);
  if (e.hrRise != null && ends.length >= 2) {
    const range = `${Math.round(ends[0])} → ${Math.round(ends[ends.length - 1])} bpm at the end of each rep`;
    parts.push(
      e.hrRise <= 3
        ? `Heart rate held across the set (${range})`
        : e.hrRise <= 10
          ? `Heart rate rose ${Math.round(e.hrRise)} bpm across the set (${range})`
          : `Heart rate rose ${Math.round(e.hrRise)} bpm across the set (${range}) — close to the set's limit`,
    );
  }
  if (e.hrDrop) {
    const [a, b] = e.hrDrop.map(Math.round);
    const drop = a === b ? `${a} bpm` : `${Math.min(a, b)}–${Math.max(a, b)} bpm`;
    if (parts.length && parts[parts.length - 1].startsWith('Heart rate')) parts[parts.length - 1] += `, and fell ${drop} in the minute after.`;
    else parts.push(`Heart rate fell ${drop} in the minute after each rep.`);
  } else if (parts.length && parts[parts.length - 1].startsWith('Heart rate')) parts[parts.length - 1] += '.';
  return parts.join(' ');
}

/** The set against the last comparable one: the headline, and its context. */
export function progressionText(p: SetProgress, sport: string): { main: string; sub: string | null } {
  const last = p.last!;
  const label = setLabel(p.current);
  const ch = p.change ?? 0;
  const out = sport === 'run' ? 'pace' : 'power';
  const hr = p.hrChange != null && Math.abs(p.hrChange) >= 1 ? `, heart rate ${Math.round(Math.abs(p.hrChange))} bpm ${p.hrChange < 0 ? 'lower' : 'higher'}` : p.hrChange != null ? ', at the same heart rate' : '';
  const vs = `your last ${label} (${fmtDate(last.date, 'd MMM')}, ${outText(sport, last.out)})`;
  const main =
    Math.abs(ch) < 0.01 ? `Same ${out} as ${vs}${hr}.` : `${ch > 0 ? '+' : '−'}${pct(ch, 1)} on ${vs}${hr}.`;
  const subs: string[] = [];
  if (p.of >= 3) subs.push(p.rank === 1 ? `Your best of ${p.of} such sets in the last year.` : `${ordinal(p.rank)} of ${p.of} in the last year — best ${outText(sport, p.best!.out)} on ${fmtDate(p.best!.date, 'd MMM')}.`);
  const cur = p.current;
  const ctx: string[] = [];
  if (cur.kjBefore != null && last.kjBefore != null && Math.abs(cur.kjBefore - last.kjBefore) >= 500) ctx.push(`${fmtNumK(cur.kjBefore)} kJ into the ride (${fmtNumK(last.kjBefore)} last time)`);
  if (cur.temp != null && last.temp != null && Math.abs(cur.temp - last.temp) >= 6) ctx.push(`${Math.round(cur.temp)} °C (${Math.round(last.temp)} °C last time)`);
  if (ctx.length) subs.push(`This set came ${ctx.join(', at ')}.`);
  return { main, sub: subs.length ? subs.join(' ') : null };
}
const fmtNumK = (v: number) => v.toLocaleString('en-US');
function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

/** A hard, surging ride in a sentence. */
export function surgeText(s: Surges, ftp: number): string {
  const parts: string[] = [];
  if (s.count) parts.push(`${s.count} surge${s.count === 1 ? '' : 's'} over ${Math.round(1.2 * ftp)} W (120% of FTP)${s.long ? `, ${s.long} lasting a minute or more` : ''}`);
  if (s.aboveFtp >= 60) parts.push(`${fmtDuration(s.aboveFtp, { short: true })} above FTP in all`);
  const peak = s.peak ? ` Hardest 5 minutes: ${s.peak.out} W, from ${fmtDuration(s.peak.start)}.` : '';
  return `${parts.length ? parts.join('; ') + '.' : 'No surges above 120% of FTP.'}${peak}`;
}

/** Continuous runs: the halves' grade-adjusted pace. */
export function halvesText(h: [number, number]): string {
  const d = h[1] / h[0] - 1;
  const paces = `${fmtPace(h[0], 'run', false)} → ${fmtPace(h[1], 'run')}`;
  if (Math.abs(d) < 0.02) return `Even pacing: the halves within 2% of each other (${paces}, grade-adjusted).`;
  return d > 0 ? `Negative split: the second half ${pct(d)} faster (${paces}, grade-adjusted).` : `The second half ${pct(d)} slower than the first (${paces}, grade-adjusted).`;
}

export { setLabel };
