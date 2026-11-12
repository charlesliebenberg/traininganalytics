/**
 * TrainerRoad: the plan TrainerRoad builds and adapts, in this app's calendar, so the fitness
 * projection, the week's plan and compliance follow it.
 *
 * Two ways in. With the account's login it reads the plan as TrainerRoad's own web app does:
 * each scheduled workout with its intervals, and the races the plan is built around, with their
 * priority. TrainerRoad has no public API, so this is the private one, as the unofficial
 * trainerroad-cli and tp2intervals use it; it can change without notice. Without a login, the
 * calendar export's private URL (TrainerRoad → Settings → Calendar Sync) gives the workouts with
 * their length, TSS, IF and description, but not their intervals.
 *
 * Every sync reads the plan from four weeks back (to match rides to) to a year ahead, and the
 * calendar follows it: TrainerRoad's Adaptive Training changes workouts often.
 */
import { addDays, format, subDays } from 'date-fns';
import type { EventPriority, Sport, WorkoutStructure } from '../../shared/types';
import { structureFromProfile, type ProfilePoint } from '../../shared/analytics/trainerroad';
import { config, trainerRoadMode } from '../config';
import { log, q } from '../db';
import { today } from '../aggregate';
import { applyExternalPlan, type ExternalPlan, type ExternalRace, type ExternalWorkout, type PlanChanges } from '../external-plan';

const BASE = 'https://www.trainerroad.com';
const AUTH_COOKIE = 'SharedTrainerRoadAuth';
const HEADERS = { 'user-agent': 'traininganalytics (self-hosted; personal data)', accept: 'application/json, text/plain, */*', 'trainerroad-jsonformat': 'camel-case' };
const BACK_DAYS = 28;
const AHEAD_DAYS = 365;
/** a library workout's details are read again after this many days */
const WORKOUT_DAYS = 30;
/** TrainerRoad's race priorities */
const PRIORITY: Record<number, EventPriority> = { 3: 'A', 2: 'B', 1: 'C' };

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && x.trim() && Number.isFinite(Number(x)) ? Number(x) : null);
/** what TrainerRoad's private API answers: read field by field, defensively */
type Json = any;

/** Text from TrainerRoad's HTML descriptions. */
export const plainText = (html: unknown): string =>
  typeof html !== 'string'
    ? ''
    : html
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li)>\s*/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&rsquo;/g, '’')
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

/** A workout's or race's sport, from its name: TrainerRoad's are mostly rides. */
export function sportOf(name: string, otherwise: Sport = 'ride'): Sport {
  if (/\b(run|running|jog)\b/i.test(name)) return 'run';
  if (/\b(swim|swimming|endless pool)\b/i.test(name)) return 'swim';
  if (/\b(ride|cycling|bike|spin)\b/i.test(name)) return 'ride';
  return otherwise;
}

/** TrainerRoad's activity types */
const ACTIVITY_SPORT: Record<number, Sport> = { 1: 'ride', 2: 'run', 3: 'swim' };
/** TrainerRoad's planned rides that aren't its sessions (its openType) */
const OPEN_TITLE: Record<number, string> = { 1: 'Group ride', 2: 'Solo ride', 3: 'Zwift race' };
/** the name for something planned without one */
const SPORT_TITLE: Partial<Record<Sport, string>> = { ride: 'Ride', run: 'Run', swim: 'Swim', strength: 'Strength', other: 'Other activity' };

/** A TrainerRoad date: { year, month, day }, or an ISO date or date-time. */
export function trDate(d: unknown): string | null {
  if (d && typeof d === 'object') {
    const { year, month, day } = d as { year: unknown; month: unknown; day: unknown };
    const [y, m, dd] = [num(year), num(month), num(day)];
    return y && m && dd ? `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}` : null;
  }
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null;
}

// ---------- the account ----------

/** The session's cookies, kept with the connection so a restart doesn't sign in again (snapshots strip them). */
const jar = new Map<string, string>();

function loadJar() {
  jar.clear();
  const c = q.get("SELECT access_token, scope FROM connections WHERE provider = 'trainerroad'");
  // only for the account they're from
  if (!c?.access_token || c.scope !== config.trainerRoad.username) return;
  try {
    for (const [k, v] of Object.entries(JSON.parse(c.access_token) as Record<string, string>)) jar.set(k, v);
  } catch {
    // unreadable: sign in again
  }
}

function saveJar() {
  q.run(
    `INSERT INTO connections(provider, access_token, scope) VALUES('trainerroad', ?, ?)
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope`,
    JSON.stringify(Object.fromEntries(jar)),
    config.trainerRoad.username,
  );
}

function takeCookies(res: Response) {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair, ...attrs] = c.split(';');
    const at = pair.indexOf('=');
    if (at <= 0) continue;
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age\s*=\s*0\s*$/i.test(a) || (/^\s*expires\s*=/i.test(a) && Date.parse(a.slice(a.indexOf('=') + 1)) < Date.now()));
    if (!value || expired) jar.delete(name);
    else jar.set(name, value);
  }
}

async function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string; redirect?: RequestRedirect } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...HEADERS, ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}), ...init.headers },
    body: init.body,
    redirect: init.redirect ?? 'manual',
  });
  takeCookies(res);
  return res;
}

/**
 * TrainerRoad's keys as camelCase: it answers in PascalCase unless the camel-case header is
 * honoured, and some answers nest PascalCase inside camelCase even then. An object whose keys
 * all start with a capital has them lower-cased, at every depth (as trainerroad-cli does).
 */
export function camelize(value: unknown): Json {
  if (Array.isArray(value)) return value.map(camelize);
  if (value === null || typeof value !== 'object') return value;
  const keys = Object.keys(value);
  const pascal = keys.length > 0 && keys.every((k) => /^[A-Z]/.test(k));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [pascal ? k[0].toLowerCase() + k.slice(1) : k, camelize(v)]));
}

async function signIn() {
  jar.clear();
  const { username, password } = config.trainerRoad;
  const res = await request('/app/api/login/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE, referer: `${BASE}/app/login` },
    body: JSON.stringify({ username, password, returnUrl: '/app/career' }),
  });
  const text = await res.text();
  let body: Json = null;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  if (res.ok && body?.success !== false && jar.has(AUTH_COOKIE)) return saveJar();
  if (res.status === 429) throw new Error('TrainerRoad is limiting sign-ins — trying again at the next sync');
  if (body?.success === false || [400, 401, 403].includes(res.status)) throw new Error('sign-in refused — check TRAINERROAD_USERNAME and TRAINERROAD_PASSWORD');
  throw new Error(`sign-in failed (${res.status})${text ? `: ${text.slice(0, 160)}` : ''}`);
}

/** A JSON call, signed in; signs in again once if the session has run out. `orNull`: a 404 means there's none. */
async function api(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; orNull?: boolean } = {}): Promise<Json> {
  for (let attempt = 0; ; attempt++) {
    if (!jar.has(AUTH_COOKIE)) await signIn();
    // redirects followed, as TrainerRoad's own app does: some of its addresses have moved
    const res = await request(path, {
      method: init.method,
      headers: { ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: 'follow',
    });
    // signed out: a 401, or sent on to the sign-in page
    const signedOut = res.status === 401 || (res.redirected && /\/login/i.test(res.url));
    if (signedOut && attempt === 0) {
      jar.delete(AUTH_COOKIE);
      continue;
    }
    if (res.status === 429) throw new Error('TrainerRoad is limiting requests — trying again at the next sync');
    if (res.status === 404 && init.orNull) return null;
    if (!res.ok || signedOut) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
    const text = await res.text();
    if (/^\s*</.test(text)) throw new Error(`${path}: a page, not data`);
    return text ? camelize(JSON.parse(text)) : null;
  }
}

interface LibraryWorkout {
  /** how it was read: kept workouts read an older way are read again */
  v?: number;
  name: string | null;
  minutes: number | null;
  tss: number | null;
  if: number | null;
  description: string | null;
  structure: WorkoutStructure | null;
  /** what TrainerRoad answered, when no intervals could be read from it */
  unread?: { chart: string; details: string | null };
}

const WORKOUT_READ = 3;

/** A workout's intervals: TrainerRoad's own points, or each interval's start, end and target. */
export function workoutStructure(chart: Json, details: Json, minutes: number | null = null): WorkoutStructure | null {
  const points = (xs: unknown) => {
    const raw = Array.isArray(xs) ? xs : [];
    // its chart counts in ticks, not seconds: set against the workout's length when known
    const last = Math.max(0, ...raw.map((p: Json) => num(p?.tick) ?? 0));
    const perTick = minutes && last > 0 ? (minutes * 60) / (last + 1) : 1;
    return raw
      .map((p: Json) => ({ seconds: num(p?.seconds) ?? (num(p?.tick) != null ? Math.round(num(p.tick)! * perTick) : null), ftpPercent: num(p?.ftpPercent ?? p?.memberFtpPercent) }))
      .filter((p): p is ProfilePoint => p.seconds != null && p.ftpPercent != null);
  };
  const fromChart = structureFromProfile(points(chart?.courseData));
  if (fromChart) return fromChart;
  const w = details?.workout ?? details;
  const fromData = structureFromProfile(points(w?.workoutData));
  if (fromData) return fromData;
  // intervals as TrainerRoad lists them, "Workout" being the whole: each held at its target
  const steps = (Array.isArray(w?.intervalData) ? w.intervalData : [])
    .filter((x: Json) => x?.name !== 'Workout' && num(x?.start) != null && num(x?.end) != null && num(x?.startTargetPowerPercent) != null)
    .sort((a: Json, b: Json) => a.start - b.start)
    .flatMap((x: Json) => [{ seconds: x.start, ftpPercent: x.startTargetPowerPercent }, { seconds: x.end, ftpPercent: x.startTargetPowerPercent }]);
  return structureFromProfile(steps);
}

/** TrainerRoad library workouts, with their intervals: kept, and read again after a month (a day, without intervals). */
async function libraryWorkouts(ids: string[]): Promise<Map<string, LibraryWorkout>> {
  const out = new Map<string, LibraryWorkout>();
  const fresh = iso(subDays(new Date(), WORKOUT_DAYS));
  const today = iso(new Date());
  for (const id of ids) {
    const row = q.get('SELECT data, fetched_at FROM trainerroad_workouts WHERE id = ?', id);
    const w: LibraryWorkout | null = row ? JSON.parse(row.data) : null;
    if (w && w.v === WORKOUT_READ && row!.fetched_at >= (w.structure ? fresh : today)) out.set(id, w);
  }
  const missing = ids.filter((id) => !out.has(id));
  const referer = { referer: `${BASE}/app/workouts/list` };
  const summaries = new Map<string, Json>();
  try {
    for (let i = 0; i < missing.length; i += 100) {
      const got = await api('/app/api/workouts/by-id', { method: 'POST', body: missing.slice(i, i + 100).map(Number), headers: referer });
      for (const w of Array.isArray(got) ? got : []) summaries.set(String(w.id), w);
    }
  } catch (e) {
    log('trainerroad', 'warn', `Workout details: ${(e as Error).message}`);
  }
  // once the intervals can't be read, not for the rest either this time: one warning, not one a workout
  let charts = true;
  for (const id of missing) {
    const s = summaries.get(id);
    let structure: WorkoutStructure | null = null;
    let unread: LibraryWorkout['unread'];
    let read = charts;
    if (charts) {
      try {
        const chart = await api(`/app/api/workouts/${encodeURIComponent(id)}/chart-data`, { headers: referer, orNull: true });
        structure = workoutStructure(chart, null, num(s?.duration));
        if (!structure) {
          const details = await api(`/app/api/workoutdetails/${encodeURIComponent(id)}`, { headers: referer, orNull: true });
          structure = workoutStructure(chart, details, num(s?.duration));
          if (!structure) unread = { chart: JSON.stringify(chart ?? null).slice(0, 4000), details: details ? JSON.stringify(details).slice(0, 4000) : null };
        }
      } catch (e) {
        read = charts = false;
        log('trainerroad', 'warn', `Intervals: ${(e as Error).message}`);
      }
    }
    const intensity = num(s?.intensityFactor);
    const w: LibraryWorkout = {
      v: WORKOUT_READ,
      name: s?.workoutName ?? s?.name ?? null,
      minutes: num(s?.duration),
      tss: num(s?.tss),
      if: intensity == null ? null : intensity > 2 ? intensity / 100 : intensity,
      description: [plainText(s?.workoutDescription), plainText(s?.goalDescription)].filter(Boolean).join('\n\n') || null,
      structure,
      ...(unread ? { unread } : {}),
    };
    // only what was read in full is kept; the rest is asked for again next time
    if (read && s) q.run("INSERT INTO trainerroad_workouts(id, data, fetched_at) VALUES(?, ?, datetime('now')) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at", id, JSON.stringify(w));
    out.set(id, w);
    // gently: one workout at a time
    if (charts) await pause(250);
  }
  return out;
}

/** The plan between two dates, from the account. */
async function readAccount(from: string, to: string): Promise<ExternalPlan> {
  loadJar();
  const m = await api('/app/api/member-info');
  const memberId = m?.memberId ?? m?.MemberId;
  const username = m?.username ?? m?.Username;
  if (memberId == null || !username) throw new Error('TrainerRoad gave no member id');
  q.run("UPDATE connections SET athlete_id = ?, athlete_name = ? WHERE provider = 'trainerroad'", String(memberId), String(username));
  const referer = { referer: `${BASE}/app/calendar/${encodeURIComponent(username)}` };
  const timeline = await api(`/app/api/react-calendar/${memberId}/timeline`, { headers: { 'tr-cache-control': 'no-cache', ...referer } });
  // a calendar it can't read is an error, not an empty plan: the plan here would be cleared
  if (!Array.isArray(timeline?.plannedActivities)) throw new Error('TrainerRoad’s calendar came back in a form this doesn’t read');
  const planned: Json[] = timeline.plannedActivities.filter((p: Json) => {
    const d = trDate(p?.date);
    return p?.id != null && d && d >= from && d <= to;
  });
  // each item in full: its workout, TSS and length. TrainerRoad refuses a whole batch for one
  // item it can't give this way, so a refused batch is halved until that item is found and left out
  const details = new Map<string, Json>();
  const headers = (items: Json[]) => ({ ids: items.map((p) => p.id).join(','), 'tr-cache-control': 'use-cache', referer: `${BASE}/app/calendar/${encodeURIComponent(username)}` });
  const refused: string[] = [];
  let calls = 0;
  const read = async (items: Json[]): Promise<void> => {
    if (!items.length || calls > 40) return;
    calls++;
    try {
      const got = await api(`/app/api/react-calendar/${memberId}/planned-activities`, { headers: headers(items) });
      for (const d of Array.isArray(got) ? got : []) details.set(String(d.id), d);
    } catch (e) {
      if (!/: 400\b/.test((e as Error).message)) throw e;
      if (items.length === 1) refused.push(`${items[0].title || 'untitled'} ${trDate(items[0].date)}`);
      else {
        const half = Math.ceil(items.length / 2);
        await read(items.slice(0, half));
        await read(items.slice(half));
      }
    }
  };
  try {
    for (let i = 0; i < planned.length; i += 100) await read(planned.slice(i, i + 100));
    if (refused.length) log('trainerroad', 'info', `Not given in full by TrainerRoad (read from its calendar instead): ${refused.slice(0, 8).join(', ')}${refused.length > 8 ? ` and ${refused.length - 8} more` : ''}`);
  } catch (e) {
    log('trainerroad', 'warn', `Scheduled workouts: ${(e as Error).message}`);
  }
  // a solo ride, group ride or Zwift race in the plan: no TrainerRoad session, though TrainerRoad
  // keeps the workout it would suggest on it
  const openOf = (p: Json) => num(details.get(String(p.id))?.openType ?? p.openType) ?? 0;
  const workoutOf = (p: Json) => (openOf(p) > 0 ? null : (details.get(String(p.id))?.workout?.id ?? p.workout?.id ?? p.workoutId ?? null));
  const library = await libraryWorkouts([...new Set(planned.map(workoutOf).filter((id) => id != null).map(String))]);
  const workouts: ExternalWorkout[] = planned.map((p) => {
    const d = details.get(String(p.id)) ?? p;
    const wid = workoutOf(p);
    const lib = wid != null ? library.get(String(wid)) : undefined;
    const name = openOf(p) > 0 ? null : (d.workout?.name ?? p.workout?.name ?? lib?.name ?? d.name ?? p.name ?? null);
    // not a workout: its own kind (TrainerRoad's activity types: 1 ride, 2 run, 3 swim), else its name's
    // (the timeline calls it `type`)
    const sport: Sport = openOf(p) > 0 ? 'ride' : wid != null ? sportOf(name ?? '') : (ACTIVITY_SPORT[num(d.activityType ?? p.activityType ?? p.type) ?? -1] ?? (name ? sportOf(name, 'other') : 'other'));
    const open = OPEN_TITLE[openOf(p)];
    const title = String(open ?? name ?? SPORT_TITLE[sport]);
    // a ride that isn't a session has its own length, not its suggested workout's
    const minutes = openOf(p) > 0 ? null : (num(d.workout?.duration) ?? lib?.minutes ?? null);
    const seconds = minutes != null ? minutes * 60 : num(d.durationInSeconds ?? p.durationInSeconds);
    return {
      id: String(p.id),
      date: trDate(d.date) ?? trDate(p.date)!,
      sport,
      title,
      description: lib?.description ?? (plainText(d.notes) || null),
      duration: seconds ? Math.round(seconds) : null,
      tss: num(d.tss) ?? (openOf(p) > 0 ? null : (num(d.workout?.tss) ?? lib?.tss ?? null)),
      if: lib?.if ?? null,
      structure: lib?.structure ?? null,
    };
  });
  const races: ExternalRace[] = [];
  for (const e of Array.isArray(timeline.events) ? timeline.events : []) {
    const date = trDate(e?.date);
    if (e?.id == null || !e.name || !date || date < from || date > to) continue;
    const sport: Sport = e.isTriathlonType ? 'other' : sportOf(e.name);
    races.push({ id: `event-${e.id}`, date, name: String(e.name), sport, priority: PRIORITY[num(e.racePriority) ?? 0] ?? 'B', description: plainText(e.notes) || null });
    // the race's own load on the day, unless it's a scheduled workout already
    const tss = num(e.tss) ?? num(e.activityTss);
    if (tss && !workouts.some((w) => w.date === date && w.title === e.name))
      workouts.push({ id: `event-${e.id}`, date, sport, title: String(e.name), description: null, duration: num(e.durationInSeconds) ?? num(e.duration), tss, if: null, structure: null });
  }
  await readDetails(String(memberId), String(username), m, timeline);
  saveJar();
  return { from, to, workouts, races };
}

const keep = (key: string, data: unknown) =>
  q.run("INSERT INTO trainerroad_data(key, data, fetched_at) VALUES(?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at", key, JSON.stringify(data ?? null));

/**
 * Everything else TrainerRoad keeps about the athlete, kept as it gives it (read by
 * trainerroad-insights.ts): its FTP history, AI FTP Detection (what it detected, its predictions,
 * and what accepting it would do to the progression levels), the progression levels, the plan
 * and its phases, power records, weight, and the rides it recorded, with the post-ride survey.
 * What can't be read is said once, and left as it was.
 */
/**
 * TrainerRoad's FTP records, with a prediction it blanks for a while (0 W, while AI FTP works it
 * out again) kept at its last value, marked held, until it gives one again.
 */
function holdPredictions(records: unknown): Json {
  if (!Array.isArray(records)) return null;
  const before = q.get("SELECT data FROM trainerroad_data WHERE key = 'fitness-thresholds'");
  const last = new Map<string, Json>((before ? (JSON.parse(before.data)?.fitnessThresholds ?? []) : []).filter((x: Json) => x?.id != null).map((x: Json) => [String(x.id), x]));
  return records.map((x: Json) => {
    const prev = x?.id != null ? last.get(String(x.id)) : null;
    if (num(x?.value) === 0 && !x?.isApplied && prev && (num(prev.value) ?? 0) > 0) return { ...x, value: prev.value, held: prev.held ?? new Date().toISOString() };
    return x;
  });
}

async function readDetails(memberId: string, username: string, member: Json, timeline: Json) {
  keep('member', member);
  keep('fitness-thresholds', { fitnessThresholds: holdPredictions(timeline.fitnessThresholds), pendingAiFtpChange: timeline.pendingAiFtpChange ?? null });
  // the calendar as it came (its rides are kept one by one, below)
  keep('timeline', { ...timeline, activities: undefined });
  const career = { referer: `${BASE}/app/career/${encodeURIComponent(username)}` };
  const get = (path: string, headers: Record<string, string> = {}) => () => api(path, { headers: { ...career, ...headers }, orNull: true });
  const records = (path: string) => api(path, { method: 'POST', headers: career, body: [{ Slot: 1, StartDate: '2013-05-10', EndDate: iso(new Date()) }], orNull: true });
  const reads: [string, () => Promise<Json>][] = [
    ['ftp-history', get(`/app/api/tss/${encodeURIComponent(username)}`)],
    ['ai-ftp', get(`/app/api/ai-ftp-detection/can-use-ai-ftp/${memberId}`)],
    ['ai-ftp-status', get(`/app/api/calendar/aiftp/${memberId}/ai-failure-status`, { 'tr-cache-control': 'no-cache' })],
    ['levels', get(`/app/api/career/${memberId}/levels`)],
    ['plan', get(`/app/api/plan-builder/current-custom-plan/${memberId}`)],
    ['plan-phases', get(`/app/api/plan-builder/${memberId}/plan-phases`)],
    ['power-records', async () => (await records(`/app/api/personal-records/${memberId}?rowType=101&indoorOnly=false`)) ?? records(`/app/api/personal-records/for-date-range/${memberId}?rowType=101&indoorOnly=false`)],
    ['weight', get(`/app/api/weight-history/${memberId}/all`)],
  ];
  const missed: string[] = [];
  for (const [key, read] of reads) {
    try {
      keep(key, await read());
    } catch (e) {
      missed.push(`${key} (${(e as Error).message.slice(0, 100)})`);
    }
    await pause(200);
  }
  try {
    await readRides(memberId, username, timeline);
  } catch (e) {
    missed.push(`rides (${(e as Error).message.slice(0, 100)})`);
  }
  if (missed.length) log('trainerroad', 'warn', `Not read this time: ${missed.join('; ')}`);
}

export interface SurveyAnswer {
  /** the answer as TrainerRoad words it: Easy, Moderate, Hard, Very Hard, All Out */
  rating: string | null;
  /** 1 (easy) to 5 (all out) */
  level: number | null;
  /** why: what made it hard, or what went well */
  reasons: string[];
  /** RPE, 1 to 5 in quarter steps, when given */
  rpe: number | null;
  text: string | null;
}

/** The athlete's answer to TrainerRoad's post-ride survey, in words; null when not answered. */
export function surveyAnswer(options: unknown, response: unknown): SurveyAnswer | null {
  const r = response as Json;
  if (!r || typeof r !== 'object') return null;
  const byElement = new Map<unknown, Json>((Array.isArray(options) ? options : []).map((o: Json) => [o?.elementId, o]));
  const root = byElement.get(r.rpeSurveyElementId);
  const ids: unknown[] = Array.isArray(r.struggleReasonSurveyElementIds) && r.struggleReasonSurveyElementIds.length ? r.struggleReasonSurveyElementIds : r.struggleReasonSurveyElementId != null ? [r.struggleReasonSurveyElementId] : [];
  const rating = root?.text ?? r.translatedDisplayName ?? null;
  const level = num(root?.kind);
  const rpe = num(r.rpe);
  if (!rating && level == null && rpe == null) return null;
  return {
    rating: rating ? String(rating) : null,
    level: level != null && level >= 1 && level <= 5 ? level : null,
    reasons: ids.map((id) => byElement.get(id)?.text).filter((t): t is string => typeof t === 'string' && t.trim() !== ''),
    rpe,
    text: typeof r.text === 'string' && r.text.trim() ? r.text.trim() : null,
  };
}

/** The rides TrainerRoad recorded in the last four weeks, in full, and the post-ride survey's answer. */
async function readRides(memberId: string, username: string, timeline: Json) {
  const from = iso(subDays(new Date(), BACK_DAYS));
  const recent: Json[] = (Array.isArray(timeline?.activities) ? timeline.activities : []).filter((a: Json) => a?.id != null && typeof a.started === 'string' && a.started.slice(0, 10) >= from);
  const kept = new Map(q.all('SELECT id, survey FROM trainerroad_rides').map((r) => [r.id as string, r.survey as string | null]));
  const referer = { referer: `${BASE}/app/career/${encodeURIComponent(username)}` };
  const added = new Set<string>();
  // new rides, and the last week's still without a survey answer: it's part of TrainerRoad's
  // record of a ride, and often given later
  const week = iso(subDays(new Date(), 7));
  const toRead = recent.filter((a) => !kept.has(String(a.id)) || (!kept.get(String(a.id)) && a.started.slice(0, 10) >= week));
  for (let i = 0; i < toRead.length; i += 100) {
    const got = await api(`/app/api/react-calendar/${memberId}/activities`, { headers: { ids: toRead.slice(i, i + 100).map((a) => a.id).join(','), ...referer } });
    for (const d of Array.isArray(got) ? got : []) {
      if (d?.id == null) continue;
      q.run('INSERT INTO trainerroad_rides(id, started, data) VALUES(?, ?, ?) ON CONFLICT(id) DO UPDATE SET started = excluded.started, data = excluded.data', String(d.id), d.started ?? null, JSON.stringify(d));
      added.add(String(d.id));
    }
  }
  for (const id of added) {
    const d = JSON.parse(q.get('SELECT data FROM trainerroad_rides WHERE id = ?', id)!.data);
    const response = d.surveyResponse;
    if (!response || typeof response !== 'object') continue;
    let answer = surveyAnswer(null, response);
    let options: Json = null;
    // the words, when the record has only TrainerRoad's ids for them (its survey goes by the ride's number)
    const reasons = Array.isArray(response.struggleReasonSurveyElementIds) ? response.struggleReasonSurveyElementIds.length : response.struggleReasonSurveyElementId != null ? 1 : 0;
    if ((!answer?.rating || answer.reasons.length < reasons) && num(d.activityId) != null) {
      options = await api(`/app/api/survey/${num(d.activityId)}`, { headers: referer, orNull: true });
      answer = surveyAnswer(options, response);
      await pause(250);
    }
    if (answer) q.run('UPDATE trainerroad_rides SET survey = ? WHERE id = ?', JSON.stringify({ ...answer, raw: { response, options } }), id);
  }
}

// ---------- the calendar export ----------

export interface IcsEvent {
  uid: string;
  summary: string;
  description: string;
  /** the day it's on */
  date: string;
  /** a whole-day entry, rather than one at a time of day */
  allDay: boolean;
  /** how long, for one at a time of day */
  minutes: number | null;
}

type IcsProp = { params: string; value: string };

/** An iCalendar date or date-time: its day (a UTC time's day here), and the moment for a time. */
function icsWhen(p: IcsProp | undefined): { date: string; at: number | null } | null {
  const m = p?.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, z] = m;
  if (h == null) return { date: `${y}-${mo}-${d}`, at: null };
  const at = z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return { date: z ? iso(new Date(at)) : `${y}-${mo}-${d}`, at };
}

/** The events of an iCalendar file. */
export function parseIcs(text: string): IcsEvent[] {
  const out: IcsEvent[] = [];
  let cur: Record<string, IcsProp> | null = null;
  // long lines continue on the next, indented
  for (const line of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (/^BEGIN:VEVENT$/i.test(line)) cur = {};
    else if (/^END:VEVENT$/i.test(line)) {
      const start = icsWhen(cur?.DTSTART);
      const summary = icsText(cur?.SUMMARY?.value ?? '').trim();
      if (cur && start && summary) {
        const end = icsWhen(cur.DTEND);
        const allDay = start.at == null || /VALUE=DATE(?!-)/i.test(cur.DTSTART.params);
        out.push({
          uid: cur.UID?.value.trim() || `${start.date}|${summary}`,
          summary,
          description: icsText(cur.DESCRIPTION?.value ?? '').trim(),
          date: start.date,
          allDay,
          minutes: !allDay && end?.at != null && start.at != null ? Math.round((end.at - start.at) / 60000) : null,
        });
      }
      cur = null;
    } else if (cur) {
      // NAME;PARAMS:value — the first colon outside quotes
      let colon = -1;
      for (let i = 0, quoted = false; i < line.length; i++) {
        if (line[i] === '"') quoted = !quoted;
        else if (line[i] === ':' && !quoted) {
          colon = i;
          break;
        }
      }
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const semi = head.indexOf(';');
      const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
      cur[name] ??= { params: semi < 0 ? '' : head.slice(semi + 1), value: line.slice(colon + 1) };
    }
  }
  return out;
}

/** An iCalendar text value: \n, \, \; and \\ escaped */
const icsText = (s: string) => s.replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));

/** "1:30 - Pettit": the planned length, then the workout */
const LENGTH = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(.+)$/;
/** the plan's phases, marked on its first day */
const PHASES = new Set(['base', 'build', 'specialty', 'recovery week']);

/** TSS, IF and the words from a calendar entry: "TSS 72, IF 0.75, kJ(Cal) 701. Description: …". */
export function entryText(text: string): { tss: number | null; if: number | null; words: string | null } {
  const tss = text.match(/\bTSS[:\s]+(\d+(?:\.\d+)?)/i);
  const intensity = text.match(/\b(?:IF|Intensity Factor)[:\s]+(\d+(?:\.\d+)?)/i);
  const f = intensity ? Number(intensity[1]) : null;
  const parts = text.split(/\bDescription:\s*/i);
  const words = (parts.length > 1 ? parts.slice(1).join(' ') : text.replace(/^\s*TSS\b[^\n]*\n?/i, '')).trim();
  return { tss: tss ? Number(tss[1]) : null, if: f == null ? null : f > 2 ? f / 100 : f, words: words || null };
}

/**
 * Workouts and races from the calendar export: a workout's entry is named with its length
 * ("1:30 - Pettit") or set at a time of day; a race is a day's entry with legs of the same name.
 * Notes, illness, time off and the plan's phase markers are left out.
 */
export function planFromCalendar(events: IcsEvent[], from: string, to: string): ExternalPlan {
  const workouts: ExternalWorkout[] = [];
  const legs = new Set<string>();
  for (const e of events) {
    if (e.date < from || e.date > to) continue;
    const m = e.summary.match(LENGTH);
    const minutes = m ? Number(m[1]) * 60 + Number(m[2]) : !e.allDay && e.minutes != null && e.minutes > 0 && e.minutes < 720 ? e.minutes : null;
    if (minutes == null) continue;
    const title = (m ? m[3] : e.summary).trim();
    const t = entryText(e.description);
    workouts.push({ id: e.uid, date: e.date, sport: sportOf(title), title, description: t.words, duration: minutes * 60, tss: t.tss, if: t.if, structure: null });
    legs.add(`${e.date}|${title}`);
  }
  const races: ExternalRace[] = [];
  for (const e of events) {
    if (e.date < from || e.date > to || !e.allDay || LENGTH.test(e.summary) || PHASES.has(e.summary.toLowerCase())) continue;
    if (!legs.has(`${e.date}|${e.summary}`)) continue;
    // the export doesn't say A, B or C unless the race's own notes do
    const p = e.description.match(/\b([ABC])[ -](?:race|event|priority)\b/i) ?? e.description.match(/\bpriority[:\s]+([ABC])\b/i);
    races.push({ id: e.uid, date: e.date, name: e.summary, sport: sportOf(e.summary), priority: (p?.[1].toUpperCase() as EventPriority) ?? 'B', description: entryText(e.description).words });
  }
  return { from, to, workouts, races };
}

async function readCalendar(from: string, to: string): Promise<ExternalPlan> {
  const res = await fetch(config.trainerRoad.calendarUrl, { headers: { 'user-agent': HEADERS['user-agent'], accept: 'text/calendar, */*' } });
  if ([401, 403, 404].includes(res.status)) throw new Error(`the calendar export refused (${res.status}) — check TRAINERROAD_CALENDAR_URL`);
  if (!res.ok) throw new Error(`the calendar export: ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('TRAINERROAD_CALENDAR_URL gave something other than a calendar');
  return planFromCalendar(parseIcs(text), from, to);
}

// ---------- syncing ----------

const sync = { running: false };

/** Bring the calendar in line with TrainerRoad's plan; null when not set up, already syncing, or it failed. */
export async function syncTrainerRoad(): Promise<PlanChanges | null> {
  const mode = trainerRoadMode();
  if (!mode || sync.running) return null;
  sync.running = true;
  try {
    const from = iso(subDays(new Date(), BACK_DAYS));
    const to = iso(addDays(new Date(), AHEAD_DAYS));
    const plan = mode === 'account' ? await readAccount(from, to) : await readCalendar(from, to);
    const changes = applyExternalPlan('trainerroad', plan);
    q.run(
      `INSERT INTO connections(provider, last_sync_at, last_error, cursor) VALUES('trainerroad', ?, NULL, ?)
       ON CONFLICT(provider) DO UPDATE SET last_sync_at = excluded.last_sync_at, last_error = NULL, cursor = excluded.cursor`,
      new Date().toISOString(),
      mode,
    );
    if (changes.added || changes.changed || changes.removed) log('trainerroad', 'info', `Plan: ${changes.added} added, ${changes.changed} changed, ${changes.removed} removed`);
    return changes;
  } catch (e) {
    const msg = (e as Error).message;
    q.run("INSERT INTO connections(provider, last_error) VALUES('trainerroad', ?) ON CONFLICT(provider) DO UPDATE SET last_error = excluded.last_error", msg);
    log('trainerroad', 'error', `Sync failed: ${msg}`);
    return null;
  } finally {
    sync.running = false;
  }
}

/** Sync shortly after start, then every TRAINERROAD_SYNC_MINUTES — when set up. */
export function startTrainerRoadSync() {
  if (!trainerRoadMode()) return;
  setTimeout(() => void syncTrainerRoad(), 30_000).unref();
  setInterval(() => void syncTrainerRoad(), config.trainerRoad.syncMinutes * 60_000).unref();
}

export function trainerRoadStatus() {
  const c = q.get("SELECT last_sync_at, last_error, athlete_name, cursor FROM connections WHERE provider = 'trainerroad'");
  const t = today();
  const ahead = q.get("SELECT COUNT(*) AS n, MAX(date) AS last FROM planned_workouts WHERE source = 'trainerroad' AND date >= ?", t);
  const next = q.get("SELECT date, title FROM planned_workouts WHERE source = 'trainerroad' AND date >= ? AND activity_id IS NULL ORDER BY date, sort_order LIMIT 1", t);
  const races = q.get("SELECT COUNT(*) AS n FROM events WHERE source = 'trainerroad' AND date >= ?", t);
  const mode = trainerRoadMode();
  return {
    mode,
    /** how the last sync read it */
    readBy: (c?.cursor as 'account' | 'calendar' | null) ?? null,
    account: mode === 'account' ? ((c?.athlete_name as string | null) ?? null) : null,
    syncing: sync.running,
    lastSyncAt: (c?.last_sync_at as string | null) ?? null,
    lastError: (c?.last_error as string | null) ?? null,
    upcoming: Number(ahead?.n ?? 0),
    through: (ahead?.last as string | null) ?? null,
    next: next ? { date: next.date as string, title: next.title as string } : null,
    races: Number(races?.n ?? 0),
    everyMinutes: config.trainerRoad.syncMinutes,
  };
}
