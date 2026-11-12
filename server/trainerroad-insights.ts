/**
 * TrainerRoad's view of the athlete beside this app's: its FTP — applied, found by AI FTP
 * Detection, and predicted — against this app's daily estimate and this app's own forecast;
 * its progression levels; its plan; and how the rides it recorded were rated. Read from what
 * providers/trainerroad.ts keeps, as TrainerRoad gave it.
 */
import { differenceInCalendarDays, format, parseISO, subDays } from 'date-fns';
import { AI_FTP_REASONS, AI_FTP_SOURCES, compareFtp, progressionLevels, valueOn, type FtpPoint, type TrFtpRecord } from '../shared/analytics/trainerroad';
import type { Sport } from '../shared/types';
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

/**
 * TrainerRoad's FTP records: each change of the FTP it trained by, and when, in the order made;
 * and its records of where each came from, AI FTP's findings and predictions among them.
 */
export function trainerRoadFtp(): { applied: FtpPoint[]; others: TrFtpRecord[]; current: number | null } {
  const t = today();
  const hist = stored('ftp-history');
  // `at`, TrainerRoad's time of the change, orders two on a day
  const changes: (FtpPoint & { at: string })[] = (Array.isArray(hist?.ftpRecordsDate ?? hist?.FtpRecordsDate) ? (hist.ftpRecordsDate ?? hist.FtpRecordsDate) : [])
    .map((x: Json) => ({ at: String(x?.date ?? x?.Date ?? ''), date: dateOf(x?.date ?? x?.Date), value: num(x?.value ?? x?.Value) }))
    .filter((p: { date: string | null; value: number | null }) => !!p.date && p.value != null && p.value > 0);
  const th = stored('fitness-thresholds');
  // a detection waiting for the athlete to accept it
  const p = th?.pendingAiFtpChange;
  const pv = num(p?.value);
  const pending = p && pv != null && !p.isApplied ? { id: p.id ?? null, date: dateOf(p.date) ?? t, value: pv } : null;
  let pendingListed = false;
  const others: TrFtpRecord[] = [];
  const records = (Array.isArray(th?.fitnessThresholds) ? [...th.fitnessThresholds] : []).sort((a: Json, b: Json) => String(a?.date ?? a?.Date ?? '').localeCompare(String(b?.date ?? b?.Date ?? '')));
  for (const x of records) {
    const date = dateOf(x?.date ?? x?.Date);
    const value = num(x?.value ?? x?.Value);
    if (!date || value == null || value <= 0) continue;
    const source = x?.source ?? x?.Source ?? null;
    const lowConfidence = x?.isLowConfidence ?? null;
    if (pending && ((pending.id != null && x?.id === pending.id) || (date === pending.date && Math.abs(value - pending.value) < 1))) {
      pendingListed = true;
      others.push({ date, value, kind: 'pending', source, lowConfidence });
      continue;
    }
    // TrainerRoad marks applied only the AI FTP findings taken; any other FTP was in use from
    // the day it was set (with no source to go by, its mark is all there is)
    const ai = source == null || AI_FTP_SOURCES.has(Number(source));
    const applied = Boolean(x?.isApplied ?? x?.IsApplied) || (!ai && date <= t);
    others.push({ date, value, kind: applied ? 'applied' : date > t ? 'predicted' : 'detected', source, lowConfidence });
    // a change of FTP, whether or not the history has it
    if (applied && !changes.some((c) => c.date === date && Math.abs(c.value - value) < 1)) changes.push({ at: String(x?.date ?? x?.Date), date, value });
  }
  if (pending && !pendingListed) others.push({ date: pending.date, value: pending.value, kind: 'pending', source: p.source ?? null, lowConfidence: p.isLowConfidence ?? null });
  changes.sort((a, b) => a.at.localeCompare(b.at));
  const applied = changes.map(({ date, value }) => ({ date, value }));
  const member = stored('member');
  return { applied, others, current: num(member?.ftp) ?? applied[applied.length - 1]?.value ?? null };
}

function aiFtp() {
  const e = stored('ai-ftp');
  const s = stored('ai-ftp-status');
  if (!e && !s) return null;
  const det = e?.additionalData?.detection;
  const reason = num(e?.reason);
  return {
    /** whether AI FTP Detection can run now, and if not, TrainerRoad's reason */
    can: typeof e?.can === 'boolean' ? e.can : null,
    reason: reason != null ? (AI_FTP_REASONS[reason] ?? `reason ${reason}`) : null,
    status: typeof s?.status === 'number' ? (AI_STATUS[s.status] ?? String(s.status)) : null,
    modelVersion: e?.modelVersion || det?.modelVersion || null,
    /** the FTP it detects now */
    detected: num(det?.ftp),
    /** when it can run next, and when the FTP last changed */
    next: dateOf(e?.additionalData?.nextAiFtpAvailability),
    changed: dateOf(e?.additionalData?.lastChanged),
    lastViewed: dateOf(e?.additionalData?.lastViewed),
  };
}

/** TrainerRoad's phase types (Base I and II, Build, Specialty) and volumes */
const PHASE_TYPES = ['Base', 'Base', 'Build', 'Specialty'];
const VOLUMES = ['Low', 'Mid', 'High'];

/** TrainerRoad's plan: its name, volume, the phase under way, and its phases of the last three months and to come. */
export function trainerRoadPlan() {
  const t = today();
  const p = stored('plan');
  const raw = Array.isArray(p?.phases) && p.phases.length ? p.phases : stored('plan-phases');
  const label = (x: unknown, names: string[]) => (typeof x === 'number' ? (names[x] ?? null) : typeof x === 'string' ? x : null);
  // the phases of the last three months and to come
  const since = iso(subDays(new Date(), 90));
  const phases = (Array.isArray(raw) ? raw : [])
    .map((x: Json) => ({ name: label(x?.type, PHASE_TYPES) ?? x?.planName ?? null, plan: x?.planName ?? null, volume: label(x?.volume, VOLUMES), start: dateOf(x?.start), end: dateOf(x?.end) }))
    .filter((x: { start: string | null; end: string | null }) => x.start && (!x.end || x.end >= since))
    .sort((a: { start: string | null }, b: { start: string | null }) => a.start!.localeCompare(b.start!));
  if (!p && !phases.length) return null;
  const now = phases.find((x: { start: string | null; end: string | null }) => x.start! <= t && (!x.end || x.end >= t));
  return {
    name: p?.name ?? now?.plan ?? null,
    volume: label(p?.volume, VOLUMES) ?? now?.volume ?? null,
    start: dateOf(p?.start),
    end: dateOf(p?.end),
    current: p?.currentPhaseName ? { name: String(p.currentPhaseName), start: dateOf(p.currentPhaseStart), end: dateOf(p.currentPhaseEnd) } : now ? { name: now.name, start: now.start, end: now.end } : null,
    phases,
  };
}

export interface TrainerRoadRide {
  id: string;
  started: string | null;
  name: string | null;
  sport: Sport;
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

/** The activity here that started within 20 minutes of TrainerRoad's (a ride, or a run it recorded too). */
function sameRide(started: string | null): { id: number; name: string; tss: number | null } | null {
  const times = started ? startTimes(started) : [];
  if (!times.length) return null;
  const lo = new Date(Math.min(...times) - 86400000).toISOString();
  const hi = new Date(Math.max(...times) + 86400000).toISOString();
  let best: { id: number; name: string; tss: number | null } | null = null;
  let gap = 20 * 60000;
  for (const a of q.all('SELECT id, name, start_time, COALESCE(tss_override, tss) AS tss FROM activities WHERE start_time BETWEEN ? AND ?', lo, hi)) {
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
  const kind = num(d.activityType);
  return {
    id: String(r.id),
    started: r.started ?? null,
    name: d.workout?.name ?? d.name ?? d.workoutName ?? null,
    // TrainerRoad's activity types: 1 ride, 2 run, 3 swim
    sport: kind === 1 ? 'ride' : kind === 2 ? 'run' : kind === 3 ? 'swim' : /Running/.test(String(d.$type)) ? 'run' : /Cycling/.test(String(d.$type)) ? 'ride' : 'other',
    duration: num(d.durationInSeconds ?? d.duration),
    tss: num(d.tss ?? d.Tss),
    if: intensity == null ? null : intensity > 2 ? intensity / 100 : intensity,
    kj: num(d.kj ?? d.kilojoules ?? d.work),
    survey: survey ? { rating: survey.rating ?? null, level: survey.level ?? null, reasons: survey.reasons ?? [], rpe: survey.rpe ?? null, text: survey.text ?? null } : null,
    activity: sameRide(r.started ?? null),
  };
}

/** TrainerRoad's record of an activity here, matched by its start. */
export function trainerRoadRide(a: { startTime: string }): TrainerRoadRide | null {
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
  const { events, agreement, since } = compareFtp(applied, others, app, t);
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
  // the chart: from a month before TrainerRoad's current stretch, or the last four months
  const from = [since ? iso(subDays(parseISO(since), 30)) : null, iso(subDays(new Date(), 120))].filter((x): x is string => !!x).sort()[0];
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
      /** the start of TrainerRoad's current stretch of FTP changes, which the agreement covers */
      since,
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
    plan: trainerRoadPlan(),
    rides,
  };
}
