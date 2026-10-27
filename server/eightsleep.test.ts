import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, format, subDays } from 'date-fns';

// a throwaway database, credentials, and the athlete's time zone, before the server modules load
const dir = mkdtempSync(join(tmpdir(), 'ta-eightsleep-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.TZ = 'Australia/Sydney';
Object.assign(process.env, { EIGHT_SLEEP_EMAIL: 'rider@example.com', EIGHT_SLEEP_PASSWORD: 'pw', EIGHT_SLEEP_CLIENT_ID: 'cid', EIGHT_SLEEP_CLIENT_SECRET: 'cs' });
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

/**
 * Eight Sleep's API as the open-source clients see it: a password sign-in that gives a token
 * and the user's id, and nightly trends by date. Each night is filed under the evening it
 * began (as `day`); you wake up the next morning.
 */
const api = {
  nights: new Map<string, Record<string, unknown>>(),
  signIns: 0,
  calls: [] as { from: string; to: string; tz: string | null }[],
  reject: null as number | null,
  expireFirstToken: false,
};
function night(evening: string, over: Record<string, unknown> = {}) {
  const next = iso(addDays(new Date(`${evening}T12:00:00`), 1));
  api.nights.set(evening, {
    day: evening,
    score: 82,
    sleepDuration: 7.25 * 3600,
    presenceDuration: 7.75 * 3600,
    lightDuration: 4 * 3600,
    deepDuration: 1.5 * 3600,
    remDuration: 1.75 * 3600,
    presenceStart: new Date(`${evening}T22:40:00`).toISOString(),
    presenceEnd: new Date(`${next}T06:25:00`).toISOString(),
    tnt: 21,
    processing: false,
    sleepQualityScore: { total: 78, hrv: { current: 61.4, average: 55 }, heartRate: { average: 47.2 }, respiratoryRate: { average: 14.1, current: 15 }, tempBedC: { average: 28.4 }, tempRoomC: { average: 19.6 } },
    sleepRoutineScore: { total: 88 },
    sessions: [{ timeseries: { heartRate: [['2026-01-01T00:00:00.000Z', 50]] } }],
    ...over,
  });
}
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.host === 'auth-api.8slp.net') {
    api.signIns++;
    const body = JSON.parse(String(init?.body));
    if (body.password !== 'pw' || body.client_id !== 'cid' || body.client_secret !== 'cs' || body.grant_type !== 'password') return new Response('{"error":"invalid_grant"}', { status: 401 });
    return Response.json({ access_token: `token-${api.signIns}`, expires_in: 72000, userId: 'u-1' });
  }
  if (url.host === 'client-api.8slp.net' && url.pathname === '/v1/users/u-1/trends') {
    const auth = new Headers(init?.headers).get('authorization');
    if (api.expireFirstToken && auth === 'Bearer token-1') return new Response('expired', { status: 401 });
    if (api.reject) return new Response('slow down', { status: api.reject });
    const from = url.searchParams.get('from')!;
    const to = url.searchParams.get('to')!;
    api.calls.push({ from, to, tz: url.searchParams.get('tz') });
    return Response.json({ days: [...api.nights.values()].filter((d) => (d.day as string) >= from && (d.day as string) <= to).sort((a, b) => String(a.day).localeCompare(String(b.day))) });
  }
  return new Response('not found', { status: 404 });
};

describe('Eight Sleep sync', () => {
  let es: typeof import('./providers/eightsleep');
  let db: typeof import('./db');
  const today = new Date();
  // run a sync, letting the pauses between requests pass at once
  const run = async (opts?: { full?: boolean }) => {
    let done = false;
    const p = es.syncSleep(opts).finally(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(1000);
    return p;
  };

  beforeAll(async () => {
    vi.stubGlobal('fetch', fakeFetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    db = await import('./db');
    es = await import('./providers/eightsleep');
    // a year and a bit of nights, with a 7-week gap (a trip) in the middle
    for (let i = 400; i >= 1; i--) if (i < 150 || i > 200) night(iso(subDays(today, i)));
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads back through the history on the first sync, signing in once', async () => {
    const saved = await run();
    expect(saved).toBe(api.nights.size);
    expect(db.listNights()).toHaveLength(api.nights.size);
    expect(api.signIns).toBe(1);
    // past the 7-week gap, and on until a year of empty months before the first night
    const earliest = api.calls.map((c) => c.from).sort()[0];
    expect(earliest < iso(subDays(today, 400 + 330))).toBe(true);
    expect(earliest > iso(subDays(today, 400 + 420))).toBe(true);
    expect(api.calls.every((c) => c.tz === 'Australia/Sydney')).toBe(true);
    const s = es.sleepStatus();
    expect(s).toMatchObject({ configured: true, connected: true, account: 'rider@example.com', lastError: null, historyDone: true, nights: api.nights.size });
  });

  it('dates each night by the morning you woke up, with the night’s own values', () => {
    const evening = iso(subDays(today, 10));
    const n = db.listNights().find((x) => x.date === iso(addDays(new Date(`${evening}T12:00:00`), 1)))!;
    expect(n).toMatchObject({ source: 'eightsleep', asleep: 26100, inBed: 27900, deep: 5400, score: 82, quality: 78, routine: 88, hrv: 61.4, hr: 47.2, rr: 14.1, bedTemp: 28.4, roomTemp: 19.6, tnt: 21, processing: false });
    // the tracker's record is kept, without the heavy per-minute series
    const raw = JSON.parse(db.q.get<{ data: string }>('SELECT data FROM sleep WHERE date = ?', n.date)!.data);
    expect(raw.day).toBe(evening);
    expect(raw.sessions).toBe(1);
  });

  it('then re-reads only the last few nights, catching nights finished processing since', async () => {
    api.calls = [];
    const lastEvening = iso(subDays(today, 1));
    night(lastEvening, { processing: false, score: 64, sleepQualityScore: { hrv: { current: 41 }, heartRate: { average: 52 } } });
    night(iso(today), { processing: true, score: 70 });
    await run();
    // from three nights before the newest stored (this morning's) through tomorrow
    expect(api.calls).toEqual([{ from: iso(subDays(today, 3)), to: iso(addDays(today, 1)), tz: 'Australia/Sydney' }]);
    const byDate = new Map(db.listNights().map((n) => [n.date, n]));
    expect(byDate.get(iso(today))).toMatchObject({ score: 64, hrv: 41, hr: 52 });
    expect(byDate.get(iso(addDays(today, 1)))?.processing).toBe(true);
    expect(api.signIns).toBe(1);
  });

  it('moves a night first read before midnight, while you were still in bed, to the morning you woke up', async () => {
    // away the night before, so nothing else is filed under today
    api.nights.delete(iso(subDays(today, 1)));
    db.q.run('DELETE FROM sleep WHERE date = ?', iso(today));
    const evening = iso(today);
    night(evening, { processing: true, sleepDuration: 3600, presenceDuration: 4200, presenceEnd: new Date(`${evening}T23:50:00`).toISOString() });
    await run();
    let byDate = new Map(db.listNights().map((n) => [n.date, n]));
    expect(byDate.get(evening)).toMatchObject({ asleep: 3600, processing: true });
    expect(byDate.has(iso(addDays(today, 1)))).toBe(false);
    // read again once you're up: one night, under the morning
    night(evening);
    await run();
    byDate = new Map(db.listNights().map((n) => [n.date, n]));
    expect(byDate.has(evening)).toBe(false);
    expect(byDate.get(iso(addDays(today, 1)))).toMatchObject({ asleep: 26100, processing: false });
  });

  it('signs in again when a token stops working early, and records what goes wrong', async () => {
    api.expireFirstToken = true;
    await run();
    expect(api.signIns).toBe(2);
    expect(es.sleepStatus().lastError).toBeNull();
    api.reject = 429;
    await run();
    expect(es.sleepStatus().lastError).toMatch(/limiting requests/);
    api.reject = null;
    await run();
    expect(es.sleepStatus().lastError).toBeNull();
  });

  it('signs in afresh for a different account, rather than reading the old one', async () => {
    const { config } = await import('./config');
    const before = api.signIns;
    config.eightSleep.email = 'partner@example.com';
    await run();
    expect(api.signIns).toBe(before + 1);
    expect(es.sleepStatus().account).toBe('partner@example.com');
    config.eightSleep.email = 'rider@example.com';
  });

  it('says which settings to check when the sign-in is refused', async () => {
    process.env.EIGHT_SLEEP_PASSWORD = 'wrong';
    const { config } = await import('./config');
    config.eightSleep.password = 'wrong';
    db.q.run("UPDATE connections SET expires_at = 0 WHERE provider = 'eightsleep'");
    await run();
    expect(es.sleepStatus().lastError).toMatch(/sign-in failed \(401\) — check EIGHT_SLEEP_EMAIL, EIGHT_SLEEP_PASSWORD/);
    config.eightSleep.password = 'pw';
  });
});
