/**
 * A review of a week (or a block of weeks) of training: how the load compared with the
 * athlete's own normal, what kind of sessions it held, how the key sessions went against the
 * last time, what the fitness signals said, and how recovered the athlete came out of it.
 *
 * The rules here pick and rank the observations; the client turns them into sentences.
 */
import type { EffortFinding } from './insights';
import type { SessionType, SetSummary } from './session';

/** Sessions that count as hard: intervals, sustained threshold work, races and hard group rides. */
export const HARD_TYPES: SessionType[] = ['threshold', 'vo2', 'anaerobic', 'sprint', 'race'];

export interface ReviewActivity {
  id: number;
  date: string;
  sport: string;
  name: string;
  /** moving seconds */
  moving: number;
  tss: number;
  type: SessionType | null;
  long: boolean;
  /** its main set and how that compared with the last comparable one */
  set: (SetSummary & { change: number | null; hrChange: number | null; rank: number; of: number; lastDate: string | null; lastOut: number | null }) | null;
  /** efforts in context (rides and runs) */
  findings: EffortFinding[];
  /** aerobic surprise against fitness (negative = better than fitness predicted) */
  zFitness: number | null;
  /** against everything expected that day */
  z: number | null;
  /** seconds in the 3 intensity zones (below LT1, between, above LT2) */
  seiler: number[] | null;
}

export interface ReviewWeekStats {
  tss: number;
  hours: number;
  sessions: number;
  hard: number;
  long: number;
  /** share of zoned time above LT1 */
  intensity: number | null;
  restDays: number;
}

export interface ReviewInput {
  from: string;
  to: string;
  weeks: number;
  /** days of the period already lived (less than weeks × 7 while it's under way) */
  days: number;
  acts: ReviewActivity[];
  /** the athlete's normal: per-week averages over the weeks before */
  baseline: (ReviewWeekStats & { weeks: number }) | null;
  /** CTL the day before the period and at its end; ATL and TSB at its end */
  ctl: [number, number];
  atl: number;
  tsb: number;
  /** aerobic fitness change over the period, % with ±1 sd */
  aerobic: { sport: 'ride' | 'run'; pct: number; sdPct: number } | null;
  /** FTP in use at the start and end */
  ftp: [number, number] | null;
  /** weeks in a row before the period that held a long ride */
  longStreak: number;
}

export type NoteTone = 'up' | 'flat' | 'down' | 'warn';

export type ReviewNote =
  | { kind: 'load'; tone: NoteTone; tss: number; base: number | null; hours: number; baseHours: number | null; sessions: number }
  | { kind: 'ctl'; tone: NoteTone; from: number; to: number; perWeek: number }
  | { kind: 'form'; tone: NoteTone; tsb: number }
  | { kind: 'aerobic'; tone: NoteTone; sport: 'ride' | 'run'; pct: number; sdPct: number }
  | { kind: 'ftp'; tone: NoteTone; from: number; to: number }
  | { kind: 'set'; tone: NoteTone; act: ReviewActivity }
  | { kind: 'effort'; tone: NoteTone; act: ReviewActivity; finding: EffortFinding }
  | { kind: 'aerobicDay'; tone: NoteTone; act: ReviewActivity }
  | { kind: 'hrHigh'; tone: NoteTone; acts: ReviewActivity[] }
  | { kind: 'mix'; tone: NoteTone; hard: ReviewActivity[]; perWeek: number; base: number | null }
  | { kind: 'long'; tone: NoteTone; acts: ReviewActivity[] }
  | { kind: 'noLong'; tone: NoteTone; streak: number }
  | { kind: 'intensity'; tone: NoteTone; share: number; base: number }
  | { kind: 'rest'; tone: NoteTone; restDays: number; days: number; backToBack: [string, string][] };

export type ReviewTitle = 'none' | 'rest' | 'recovery' | 'light' | 'steady' | 'build' | 'big' | 'spike';

export interface Review {
  title: ReviewTitle;
  tone: NoteTone | 'none';
  /** the period is still under way */
  partial: boolean;
  stats: ReviewWeekStats & { perWeek: { tss: number; hours: number } };
  /** fitness signals, strongest first: the "so what" of the period */
  signals: ReviewNote[];
  /** everything else worth saying, most important first */
  notes: ReviewNote[];
}

const DAY = 86400000;
const dayIndex = (d: string) => Math.floor(Date.parse(d) / DAY);

/** Week statistics for a list of activities spanning `days` days. */
export function weekStats(acts: Pick<ReviewActivity, 'date' | 'moving' | 'tss' | 'type' | 'long' | 'seiler'>[], days: number): ReviewWeekStats {
  const seiler = [0, 0, 0];
  for (const a of acts) a.seiler?.forEach((s, i) => (seiler[i] += s));
  const zoned = seiler[0] + seiler[1] + seiler[2];
  return {
    tss: acts.reduce((s, a) => s + a.tss, 0),
    hours: acts.reduce((s, a) => s + a.moving, 0) / 3600,
    sessions: acts.length,
    hard: acts.filter((a) => a.type && HARD_TYPES.includes(a.type)).length,
    long: acts.filter((a) => a.long).length,
    intensity: zoned > 0 ? (seiler[1] + seiler[2]) / zoned : null,
    restDays: days - new Set(acts.map((a) => a.date)).size,
  };
}

/** Hard days in a row (the dates of each pair). */
function backToBack(acts: ReviewActivity[]): [string, string][] {
  const hardDays = [...new Set(acts.filter((a) => a.type && HARD_TYPES.includes(a.type)).map((a) => a.date))].sort();
  const out: [string, string][] = [];
  for (let i = 1; i < hardDays.length; i++) if (dayIndex(hardDays[i]) - dayIndex(hardDays[i - 1]) === 1) out.push([hardDays[i - 1], hardDays[i]]);
  return out;
}

/** Effort findings worth a line in a review: bests, beating the model, durability. */
const REVIEW_EFFORTS: EffortFinding['kind'][] = ['pb', 'model', 'best90', 'durability'];
/** by kind, then by how big the gain was (times: lower is better) */
const effortRank = (f: EffortFinding) => ({ pb: 0, model: 1, best90: 2, durability: 3, near: 4 })[f.kind] * 100 - 100 * (f.meters != null ? f.ref / f.value - 1 : f.value / f.ref - 1);

export function reviewPeriod(x: ReviewInput): Review {
  const scale = 7 / Math.max(1, x.days);
  const stats = weekStats(x.acts, x.days);
  const perWeek = { tss: stats.tss * scale, hours: stats.hours * scale };
  const b = x.baseline;
  const partial = x.days < x.weeks * 7;
  const signals: ReviewNote[] = [];
  const notes: ReviewNote[] = [];

  // ---------- fitness signals ----------
  for (const a of x.acts) {
    const s = a.set;
    if (!s || s.change == null) continue;
    const better = s.change >= 0.02 && (s.hrChange == null || s.hrChange <= 2);
    const easier = Math.abs(s.change) < 0.02 && s.hrChange != null && s.hrChange <= -3;
    const best = s.rank === 1 && s.of >= 3 && s.change > 0;
    if (better || easier || best) signals.push({ kind: 'set', tone: 'up', act: a });
    else notes.push({ kind: 'set', tone: s.change <= -0.04 ? 'down' : 'flat', act: a });
  }
  const efforts = x.acts
    .flatMap((a) => a.findings.filter((f) => REVIEW_EFFORTS.includes(f.kind) && (f.duration == null || f.duration >= 60)).map((f) => ({ a, f })))
    .sort((p, q) => effortRank(p.f) - effortRank(q.f));
  // one line per activity, its strongest finding
  const seen = new Set<number>();
  for (const { a, f } of efforts) {
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    signals.push({ kind: 'effort', tone: 'up', act: a, finding: f });
  }
  if (x.aerobic && Math.abs(x.aerobic.pct) >= Math.max(1, 1.5 * x.aerobic.sdPct)) signals.push({ kind: 'aerobic', tone: x.aerobic.pct > 0 ? 'up' : 'down', ...x.aerobic });
  for (const a of x.acts) if (a.zFitness != null && a.zFitness <= -1.5 && !seen.has(a.id)) signals.push({ kind: 'aerobicDay', tone: 'up', act: a });
  if (x.ftp && Math.abs(x.ftp[1] - x.ftp[0]) >= 3) signals.push({ kind: 'ftp', tone: x.ftp[1] > x.ftp[0] ? 'up' : 'flat', from: x.ftp[0], to: x.ftp[1] });

  // ---------- load ----------
  const ratio = b && b.tss > 0 ? perWeek.tss / b.tss : null;
  const ctlWeek = ((x.ctl[1] - x.ctl[0]) / Math.max(1, x.days)) * 7;
  notes.unshift({ kind: 'load', tone: ratio == null ? 'flat' : ratio >= 1.35 ? 'warn' : ratio >= 1.1 ? 'up' : ratio <= 0.7 ? 'flat' : 'flat', tss: stats.tss, base: b ? b.tss : null, hours: stats.hours, baseHours: b ? b.hours : null, sessions: stats.sessions });
  notes.push({ kind: 'ctl', tone: ctlWeek >= 8 ? 'warn' : ctlWeek > 0.5 ? 'up' : ctlWeek < -2 ? 'down' : 'flat', from: x.ctl[0], to: x.ctl[1], perWeek: ctlWeek });

  // ---------- what the training was ----------
  const hard = x.acts.filter((a) => a.type && HARD_TYPES.includes(a.type));
  if (hard.length || (b && b.hard >= 1)) notes.push({ kind: 'mix', tone: 'flat', hard, perWeek: hard.length * scale, base: b ? b.hard : null });
  const long = x.acts.filter((a) => a.long);
  if (long.length) notes.push({ kind: 'long', tone: 'flat', acts: long });
  else if (!partial && x.weeks === 1 && x.longStreak >= 3) notes.push({ kind: 'noLong', tone: 'flat', streak: x.longStreak });
  if (stats.intensity != null && b?.intensity != null && Math.abs(stats.intensity - b.intensity) >= 0.06) notes.push({ kind: 'intensity', tone: 'flat', share: stats.intensity, base: b.intensity });

  // ---------- recovery ----------
  const highs = x.acts.filter((a) => a.z != null && a.z >= 1.5);
  if (highs.length >= 2 || (highs.length === 1 && x.tsb <= -20)) notes.push({ kind: 'hrHigh', tone: 'warn', acts: highs });
  const b2b = backToBack(x.acts);
  if (x.weeks === 1 && (stats.restDays === 0 || b2b.length)) notes.push({ kind: 'rest', tone: stats.restDays === 0 && b2b.length ? 'warn' : 'flat', restDays: stats.restDays, days: x.days, backToBack: b2b });
  notes.push({ kind: 'form', tone: x.tsb <= -30 ? 'warn' : x.tsb <= -10 ? 'flat' : x.tsb >= 10 ? 'up' : 'flat', tsb: x.tsb });

  // ---------- verdict ----------
  let title: ReviewTitle;
  if (!x.acts.length) title = 'rest';
  else if (ratio == null) title = ctlWeek > 0.5 ? 'build' : 'steady';
  else if (ctlWeek >= 8 || ratio >= 1.5) title = 'spike';
  else if (ratio >= 1.25) title = 'big';
  else if (ratio <= 0.6) title = hard.length * scale >= 2 ? 'light' : 'recovery';
  else if (ratio <= 0.8) title = 'light';
  else if (ctlWeek > 0.5) title = 'build';
  else title = 'steady';
  const tone: Review['tone'] = title === 'rest' ? 'none' : title === 'spike' ? 'warn' : title === 'build' || title === 'big' ? 'up' : 'flat';

  // the strongest signals first: set progress, bests, the aerobic trend, single good days, FTP
  const order: Record<string, number> = { set: 0, effort: 1, aerobic: 2, aerobicDay: 3, ftp: 4 };
  signals.sort((p, q) => order[p.kind] - order[q.kind] || (p.tone === 'up' ? 0 : 1) - (q.tone === 'up' ? 0 : 1));
  return { title, tone, partial, stats: { ...stats, perWeek }, signals, notes };
}
