/**
 * TrainerRoad's view of the athlete beside this app's: its FTP — applied, found by AI FTP
 * Detection, and predicted — against this app's daily estimate and this app's own forecast;
 * its progression levels; its plan; and how the rides it recorded were rated. Read from what
 * providers/trainerroad.ts keeps, as TrainerRoad gave it.
 */
import { differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { compareFtp, progressionLevels, valueOn, type FtpPoint, type TrFtpRecord } from '../shared/analytics/trainerroad';
import { q } from './db';
import { storedSeries } from './estimates';
import { dailyLoads, today } from './aggregate';
import { capacityChange } from './comeback';
import { trDate, trainerRoadStatus, type SurveyAnswer } from './providers/trainerroad';

/** what TrainerRoad's private API gave: read field by field, defensively */
type Json = any;

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
const dateOf = (x: unknown) => trDate(x);
/** TrainerRoad's AI FTP Detection status codes */
const AI_STATUS = ['CanPredict', 'NoData', 'NoRecentData', 'NoActivities'];

function stored(key: string): Json {
  const r = q.get('SELECT data FROM trainerroad_data WHERE key = ?', key);
  return r ? JSON.parse(r.data) : null;
}

/** TrainerRoad's FTP records: the FTP it applied, when, and AI FTP Detection's own records. */
export function trainerRoadFtp(): { applied: FtpPoint[]; others: TrFtpRecord[]; current: number | null } {
  const t = today();
  const hist = stored('ftp-history');
  const applied: FtpPoint[] = (Array.isArray(hist?.ftpRecordsDate ?? hist?.FtpRecordsDate) ? (hist.ftpRecordsDate ?? hist.FtpRecordsDate) : [])
    .map((x: Json) => ({ date: dateOf(x?.date ?? x?.Date), value: num(x?.value ?? x?.Value) }))
    .filter((p: { date: string | null; value: number | null }): p is FtpPoint => !!p.date && p.value != null && p.value > 0)
    .sort((a: FtpPoint, b: FtpPoint) => a.date.localeCompare(b.date));
  const th = stored('fitness-thresholds');
  const others: TrFtpRecord[] = [];
  for (const x of Array.isArray(th?.fitnessThresholds) ? th.fitnessThresholds : []) {
    const date = dateOf(x?.date ?? x?.Date);
    const value = num(x?.value ?? x?.Value);
    if (!date || value == null || value <= 0) continue;
    const isApplied = Boolean(x?.isApplied ?? x?.IsApplied);
    others.push({ date, value, kind: isApplied ? 'applied' : date > t ? 'predicted' : 'detected', source: x?.source ?? x?.Source ?? null, lowConfidence: x?.isLowConfidence ?? null });
  }
  // a detection waiting for the athlete to accept it
  const p = th?.pendingAiFtpChange;
  const pv = num(p?.value);
  if (p && pv != null && !p.isApplied) {
    const date = dateOf(p.date) ?? t;
    const same = others.find((o) => o.date === date && Math.abs(o.value - pv) < 1);
    if (same) same.kind = 'pending';
    else others.push({ date, value: pv, kind: 'pending', source: p.source ?? null, lowConfidence: p.isLowConfidence ?? null });
  }
  const member = stored('member');
  return { applied, others, current: num(member?.ftp) ?? applied[applied.length - 1]?.value ?? null };
}

function aiFtp() {
  const e = stored('ai-ftp');
  const s = stored('ai-ftp-status');
  if (!e && !s) return null;
  const det = e?.additionalData?.detection;
  return {
    /** whether AI FTP Detection can run now, and if not, TrainerRoad's reason */
    can: typeof e?.can === 'boolean' ? e.can : null,
    reason: e?.reason ?? null,
    status: typeof s?.status === 'number' ? (AI_STATUS[s.status] ?? String(s.status)) : null,
    modelVersion: e?.modelVersion ?? det?.modelVersion ?? null,
    /** the FTP it detects now */
    detected: num(det?.ftp),
    /** when it can run next */
    next: dateOf(e?.additionalData?.nextAiFtpAvailability),
    lastViewed: dateOf(e?.additionalData?.lastViewed),
  };
}

function plan() {
  const p = stored('plan');
  const raw = Array.isArray(p?.phases) && p.phases.length ? p.phases : stored('plan-phases');
  const phases = (Array.isArray(raw) ? raw : [])
    .map((x: Json) => ({ name: typeof x?.type === 'string' ? x.type : (x?.planName ?? null), plan: x?.planName ?? null, volume: x?.volume ?? null, start: dateOf(x?.start), end: dateOf(x?.end) }))
    .filter((x: { start: string | null }) => x.start)
    .sort((a: { start: string | null }, b: { start: string | null }) => a.start!.localeCompare(b.start!));
  if (!p && !phases.length) return null;
  return {
    name: p?.name ?? null,
    volume: p?.volume ?? null,
    start: dateOf(p?.start),
    end: dateOf(p?.end),
    current: p?.currentPhaseName ? { name: String(p.currentPhaseName), start: dateOf(p.currentPhaseStart), end: dateOf(p.currentPhaseEnd) } : null,
    phases,
  };
}

export interface TrainerRoadRide {
  id: string;
  started: string | null;
  name: string | null;
  /** seconds */
  duration: number | null;
  /** TrainerRoad's TSS and IF, from its FTP */
  tss: number | null;
  if: number | null;
  kj: number | null;
  survey: SurveyAnswer | null;
  /** the same ride here */
  activity: { id: number; name: string; tss: number | null } | null;
}

/** A start with no zone, read both ways: as UTC (as TrainerRoad's own tools read it) and as local time. */
function startTimes(started: string): number[] {
  const out = /([zZ]|[+-]\d{2}:?\d{2})$/.test(started) ? [Date.parse(started)] : [Date.parse(`${started}Z`), new Date(started).getTime()];
  return out.filter(Number.isFinite);
}

/** The ride here that started within 20 minutes of TrainerRoad's. */
function sameRide(started: string | null): { id: number; name: string; tss: number | null } | null {
  const times = started ? startTimes(started) : [];
  if (!times.length) return null;
  const lo = new Date(Math.min(...times) - 86400000).toISOString();
  const hi = new Date(Math.max(...times) + 86400000).toISOString();
  let best: { id: number; name: string; tss: number | null } | null = null;
  let gap = 20 * 60000;
  for (const a of q.all("SELECT id, name, start_time, COALESCE(tss_override, tss) AS tss FROM activities WHERE sport = 'ride' AND start_time BETWEEN ? AND ?", lo, hi)) {
    for (const t of times) {
      const d = Math.abs(Date.parse(a.start_time) - t);
      if (d <= gap) {
        gap = d;
        best = { id: a.id, name: a.name, tss: a.tss };
      }
    }
  }
  return best;
}

function readRide(r: Json): TrainerRoadRide {
  const d = JSON.parse(r.data);
  const survey = r.survey ? JSON.parse(r.survey) : null;
  const intensity = num(d.intensityFactor ?? d.if ?? d.ifactor);
  return {
    id: String(r.id),
    started: r.started ?? null,
    name: d.name ?? d.workoutName ?? d.workout?.name ?? null,
    duration: num(d.durationInSeconds ?? d.duration),
    tss: num(d.tss ?? d.Tss),
    if: intensity == null ? null : intensity > 2 ? intensity / 100 : intensity,
    kj: num(d.kj ?? d.kilojoules ?? d.work),
    survey: survey ? { rating: survey.rating ?? null, level: survey.level ?? null, reasons: survey.reasons ?? [], rpe: survey.rpe ?? null, text: survey.text ?? null } : null,
    activity: sameRide(r.started ?? null),
  };
}

/** TrainerRoad's record of an activity here, matched by its start. */
export function trainerRoadRide(a: { startTime: string; sport: string }): TrainerRoadRide | null {
  if (a.sport !== 'ride') return null;
  const t = Date.parse(a.startTime);
  if (!Number.isFinite(t)) return null;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  for (const r of q.all('SELECT * FROM trainerroad_rides WHERE substr(started, 1, 10) BETWEEN ? AND ?', day(t - 86400000), day(t + 86400000))) {
    if (startTimes(r.started).some((s) => Math.abs(s - t) <= 20 * 60000)) return readRide(r);
  }
  return null;
}

/** Everything TrainerRoad says, beside this app's own reading. */
export function trainerRoadInsights() {
  const t = today();
  const status = trainerRoadStatus();
  const read = q.get('SELECT MAX(fetched_at) AS at FROM trainerroad_data')?.at ?? null;
  if (!read) return { status, read: null, ftp: null, ai: null, levels: [], plan: null, rides: [] };
  const { applied, others, current } = trainerRoadFtp();
  const app: FtpPoint[] = storedSeries('ride').map((e) => ({ date: e.date, value: Math.round(e.threshold) }));
  const appNow = valueOn(app, t);
  const { events, agreement } = compareFtp(applied, others, app, t);
  // TrainerRoad's predictions, and this app's own expectation for the same day: the capacity
  // model's change from today, riding the load planned in the calendar until then
  const predicted = events.filter((e) => e.kind === 'predicted');
  const last = predicted.reduce((m, e) => (e.date > m ? e.date : m), t);
  const planned = new Map(last > t ? dailyLoads(t, last, 'ride').map((l) => [l.date, l.planned]) : []);
  const forecasts = predicted.map((e) => {
    const c = appNow != null ? capacityChange(e.date, (d) => planned.get(d) ?? 0) : null;
    return { date: e.date, trainerRoad: e.value, app: c ? Math.round(appNow! * c.ratio) : null, range: c ? ([Math.round(appNow! * c.range[0]), Math.round(appNow! * c.range[1])] as [number, number]) : null, days: differenceInCalendarDays(parseISO(e.date), parseISO(t)) };
  });
  const plannedThrough = q.get("SELECT MAX(date) AS d FROM planned_workouts WHERE sport = 'ride' AND date > ? AND activity_id IS NULL", t)?.d ?? null;
  // the chart: from a month before TrainerRoad's first record, or the last four months
  const from = [events[0] ? iso(subDays(parseISO(events[0].date), 30)) : null, iso(subDays(new Date(), 120))].filter((x): x is string => !!x).sort()[0];
  const rides = q
    .all('SELECT * FROM trainerroad_rides WHERE substr(started, 1, 10) >= ? ORDER BY started DESC', iso(subDays(new Date(), 28)))
    .map(readRide);
  const levelsRaw = stored('levels');
  return {
    status,
    read,
    ftp: {
      trainerRoad: current,
      app: appNow,
      events,
      agreement,
      forecasts,
      plannedThrough,
      /** this app's FTP for the chart: the one in effect at its start, then each day it changed */
      appSeries: [
        ...(valueOn(app, from) != null ? [{ date: from, value: valueOn(app, from)! }] : []),
        ...app.filter((p, i) => p.date > from && p.date <= t && (i === 0 || app[i - 1].value !== p.value)),
      ],
      from,
    },
    ai: aiFtp(),
    levels: progressionLevels(levelsRaw, stored('ai-ftp')?.additionalData?.detection),
    levelsAt: dateOf(levelsRaw?.timestamp),
    plan: plan(),
    rides,
  };
}
