/**
 * Eight Sleep: each night's sleep and recovery — sleep score, time asleep and its stages,
 * heart-rate variability, heart rate and breathing asleep — from the account the Pod reports
 * to. There's no official API: this is the private one the Eight Sleep app calls, as the
 * open-source clients use it (lukas-clarke/eight_sleep, pyEight). It can change without notice
 * and limits sign-ins, so the token is kept until it expires and nights come a month at a time.
 *
 * The first sync reads back through the history (resuming where it stopped if interrupted);
 * every sync re-reads the last few nights, which Eight Sleep finishes processing after you get
 * up, through today.
 */
import { addDays, format, parseISO, subDays } from 'date-fns';
import type { SleepNight } from '../../shared/types';
import { config, eightSleepConfigured } from '../config';
import { athleteTimezone, getSetting, log, q, saveNight, setSetting } from '../db';

const AUTH_URL = 'https://auth-api.8slp.net/v1/tokens';
const API = 'https://client-api.8slp.net/v1';
const HEADERS = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'traininganalytics (self-hosted)' };
/** nights per request */
const CHUNK_DAYS = 30;
/** reading back through the history stops after this many empty months in a row: before the Pod (a year, so a long spell away from it isn't taken for the start) */
const EMPTY_MONTHS = 12;
/** Eight Sleep began in 2014: nothing to find before */
const EARLIEST = '2014-01-01';
/** each sync re-reads this many nights before the newest one stored */
const REREAD_DAYS = 3;

const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A day of the trends response: the fields read (see lukas-clarke/eight_sleep, pyEight/user.py). */
export interface TrendDay {
  day?: string;
  score?: number;
  sleepDuration?: number;
  presenceDuration?: number;
  lightDuration?: number;
  deepDuration?: number;
  remDuration?: number;
  presenceStart?: string;
  presenceEnd?: string;
  tnt?: number;
  processing?: boolean;
  sleepQualityScore?: {
    total?: number;
    hrv?: { current?: number };
    heartRate?: { average?: number; current?: number };
    respiratoryRate?: { average?: number; current?: number };
    tempBedC?: { average?: number };
    tempRoomC?: { average?: number };
  };
  sleepRoutineScore?: { total?: number };
  sessions?: unknown[];
}

const value = (v: unknown, digits = 0) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 10 ** digits) / 10 ** digits : null);

/**
 * A night from a day of trends, dated by the day you woke up — the end of your time in bed, in
 * the athlete's time zone (the server runs in it) — else the day Eight Sleep files it under.
 * The night's own HRV is `hrv.current`, its heart rate and breathing the `average`s (as the
 * Home Assistant integration reads them). Null when nothing was recorded.
 */
export function nightFromTrend(d: TrendDay): SleepNight | null {
  const date = d.presenceEnd ? iso(new Date(d.presenceEnd)) : d.day;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const asleep = value(d.sleepDuration);
  const inBed = value(d.presenceDuration);
  if (!asleep && !inBed) return null;
  const s = d.sleepQualityScore ?? {};
  return {
    date,
    source: 'eightsleep',
    bedStart: d.presenceStart ?? null,
    bedEnd: d.presenceEnd ?? null,
    asleep,
    inBed,
    light: value(d.lightDuration),
    deep: value(d.deepDuration),
    rem: value(d.remDuration),
    score: value(d.score),
    quality: value(s.total),
    routine: value(d.sleepRoutineScore?.total),
    hrv: value(s.hrv?.current, 1),
    hr: value(s.heartRate?.average, 1) ?? value(s.heartRate?.current, 1),
    rr: value(s.respiratoryRate?.average, 1) ?? value(s.respiratoryRate?.current, 1),
    bedTemp: value(s.tempBedC?.average, 1),
    roomTemp: value(s.tempRoomC?.average, 1),
    tnt: value(d.tnt),
    processing: !!d.processing,
  };
}

/** The stored sign-in while it lasts (for the same account), else a new one: Eight Sleep limits how often you can sign in. */
async function signIn(fresh = false): Promise<{ token: string; userId: string }> {
  const e = config.eightSleep;
  const c = q.get("SELECT access_token, expires_at, athlete_id, athlete_name FROM connections WHERE provider = 'eightsleep'");
  if (!fresh && c?.access_token && c.athlete_id && c.athlete_name === e.email && (c.expires_at ?? 0) - 300 > Date.now() / 1000) return { token: c.access_token, userId: c.athlete_id };
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ client_id: e.clientId, client_secret: e.clientSecret, grant_type: 'password', username: e.email, password: e.password }),
  });
  if (!res.ok) {
    const why = (await res.text()).slice(0, 200);
    const creds = res.status === 400 || res.status === 401 || res.status === 403 ? ' — check EIGHT_SLEEP_EMAIL, EIGHT_SLEEP_PASSWORD and the client ID and secret' : '';
    throw new Error(`sign-in failed (${res.status})${creds}${why ? `: ${why}` : ''}`);
  }
  const t = (await res.json()) as { access_token?: string; expires_in?: number; userId?: string };
  if (!t.access_token || !t.userId) throw new Error('sign-in gave no token');
  q.run(
    `INSERT INTO connections(provider, access_token, expires_at, athlete_id, athlete_name) VALUES('eightsleep', ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, expires_at = excluded.expires_at, athlete_id = excluded.athlete_id, athlete_name = excluded.athlete_name`,
    t.access_token,
    Math.floor(Date.now() / 1000 + (Number(t.expires_in) || 3600)),
    t.userId,
    e.email,
  );
  return { token: t.access_token, userId: t.userId };
}

/** The nights Eight Sleep has between two dates (inclusive). */
async function trends(from: string, to: string): Promise<TrendDay[]> {
  for (let attempt = 0; ; attempt++) {
    const { token, userId } = await signIn(attempt > 0);
    const u = new URL(`${API}/users/${encodeURIComponent(userId)}/trends`);
    const tz = athleteTimezone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    for (const [k, v] of Object.entries({ tz, from, to, 'include-main': 'false', 'include-all-sessions': 'true', 'model-version': 'v2' })) u.searchParams.set(k, v);
    const res = await fetch(u, { headers: { ...HEADERS, authorization: `Bearer ${token}` } });
    // a token that stopped working early: sign in again, once
    if (res.status === 401 && attempt === 0) continue;
    if (res.status === 429) throw new Error('Eight Sleep is limiting requests — trying again at the next sync');
    if (!res.ok) throw new Error(`nights ${from} to ${to}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { days?: TrendDay[] };
    return Array.isArray(body.days) ? body.days : [];
  }
}

/**
 * Store a request's nights; returns how many. Two days filed for one wake-up date (a nap, a
 * split night) keep the longer sleep; the same day read again replaces itself (a night still
 * being processed gets its final values), wherever it was filed before: a night read while
 * you were still in bed before midnight went under that evening.
 */
function store(days: TrendDay[]): number {
  let n = 0;
  for (const d of days) {
    const night = nightFromTrend(d);
    if (!night) continue;
    if (d.day && /^\d{4}-\d{2}-\d{2}$/.test(d.day)) {
      const day = parseISO(d.day);
      q.run("DELETE FROM sleep WHERE date BETWEEN ? AND ? AND date != ? AND json_extract(data, '$.day') = ?", iso(subDays(day, 2)), iso(addDays(day, 2)), night.date, d.day);
    }
    const had = q.get("SELECT asleep, json_extract(data, '$.day') AS day FROM sleep WHERE date = ?", night.date);
    if (had && had.day && d.day && had.day !== d.day && (had.asleep ?? 0) >= (night.asleep ?? 0)) continue;
    const { sessions, ...summary } = d;
    saveNight(night, { ...summary, sessions: Array.isArray(sessions) ? sessions.length : 0 });
    n++;
  }
  return n;
}

/** Nights from `from` to `to`, a month per request, oldest first. */
async function readRange(from: string, to: string): Promise<number> {
  let n = 0;
  for (let a = from; a <= to; a = iso(addDays(parseISO(a), CHUNK_DAYS))) {
    const b = iso(addDays(parseISO(a), CHUNK_DAYS - 1));
    n += store(await trends(a, b < to ? b : to));
  }
  return n;
}

interface Backfill {
  /** the last day of the next month to read */
  next: string;
  /** empty months in a row so far */
  empty: number;
  done: boolean;
}

const sync = { running: false };

/**
 * Bring the nights up to date: the last few nights (or the last month, the first time)
 * through tomorrow, then — until it's done — back through the history a month at a time,
 * saving where it got to so an interrupted read picks up there. `full` reads the history again.
 */
export async function syncSleep(opts: { full?: boolean } = {}): Promise<number> {
  if (!eightSleepConfigured() || sync.running) return 0;
  sync.running = true;
  let saved = 0;
  try {
    if (opts.full) setSetting('eightsleep_backfill', null);
    const newest = q.get('SELECT MAX(date) AS d FROM sleep')?.d as string | null;
    const from = newest && !opts.full ? iso(subDays(parseISO(newest), REREAD_DAYS)) : iso(subDays(new Date(), CHUNK_DAYS - 1));
    saved += await readRange(from, iso(addDays(new Date(), 1)));
    const back = getSetting<Backfill>('eightsleep_backfill') ?? { next: iso(subDays(parseISO(from), 1)), empty: 0, done: false };
    if (!back.done) {
      let history = 0;
      while (back.next >= EARLIEST && back.empty < EMPTY_MONTHS) {
        const a = iso(subDays(parseISO(back.next), CHUNK_DAYS - 1));
        const n = store(await trends(a, back.next));
        history += n;
        back.empty = n ? 0 : back.empty + 1;
        back.next = iso(subDays(parseISO(a), 1));
        setSetting('eightsleep_backfill', back);
        // gently: the API is rate-limited
        await pause(1000);
      }
      back.done = true;
      setSetting('eightsleep_backfill', back);
      saved += history;
      log('eightsleep', 'info', `Read your sleep history: ${q.get('SELECT COUNT(*) AS n FROM sleep')?.n ?? 0} nights`);
    }
    q.run("UPDATE connections SET last_sync_at = ?, last_error = NULL WHERE provider = 'eightsleep'", new Date().toISOString());
  } catch (e) {
    const msg = (e as Error).message;
    q.run("INSERT INTO connections(provider, last_error) VALUES('eightsleep', ?) ON CONFLICT(provider) DO UPDATE SET last_error = excluded.last_error", msg);
    log('eightsleep', 'error', `Sync failed: ${msg}`);
  } finally {
    sync.running = false;
  }
  return saved;
}

/** Sync shortly after start, then every few hours (EIGHT_SLEEP_SYNC_HOURS) — when configured. */
export function startSleepSync() {
  if (!eightSleepConfigured()) return;
  setTimeout(() => void syncSleep(), 20_000).unref();
  setInterval(() => void syncSleep(), config.eightSleep.syncHours * 3600_000).unref();
}

export function sleepStatus() {
  const c = q.get("SELECT last_sync_at, last_error, athlete_id, athlete_name FROM connections WHERE provider = 'eightsleep'");
  const s = q.get('SELECT COUNT(*) AS n, MIN(date) AS first, MAX(date) AS last FROM sleep');
  return {
    configured: eightSleepConfigured(),
    /** signed in at least once */
    connected: !!c?.athlete_id,
    /** the account last signed in to */
    account: (c?.athlete_name as string | null) ?? null,
    syncing: sync.running,
    lastSyncAt: (c?.last_sync_at as string | null) ?? null,
    lastError: (c?.last_error as string | null) ?? null,
    nights: Number(s?.n ?? 0),
    first: (s?.first as string | null) ?? null,
    last: (s?.last as string | null) ?? null,
    historyDone: !!getSetting<Backfill>('eightsleep_backfill')?.done,
    everyHours: config.eightSleep.syncHours,
  };
}
