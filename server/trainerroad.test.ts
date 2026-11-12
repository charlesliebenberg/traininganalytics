import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, format } from 'date-fns';
import type { WorkoutRepeat } from '../shared/types';
import { flatten } from '../shared/analytics/workout';

// a throwaway database, a TrainerRoad login, and the athlete's time zone, before the server modules load
const dir = mkdtempSync(join(tmpdir(), 'ta-trainerroad-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.TZ = 'Australia/Sydney';
Object.assign(process.env, { TRAINERROAD_USERNAME: 'rider@example.com', TRAINERROAD_PASSWORD: 'pw' });
const iso = (d: Date) => format(d, 'yyyy-MM-dd');
const today = new Date();
const day = (n: number) => iso(addDays(today, n));
const ymd = (s: string) => ({ year: +s.slice(0, 4), month: +s.slice(5, 7), day: +s.slice(8, 10) });

/** A workout's profile a second at a time, in milliseconds, as TrainerRoad's chart data gives it. */
function profile(pieces: [number, number, number?][]) {
  const out: { seconds: number; ftpPercent: number }[] = [];
  let t = 0;
  for (const [d, a, b = a] of pieces) for (let i = 0; i < d; i++, t++) out.push({ seconds: t * 1000, ftpPercent: a + ((b - a) * i) / d });
  return out;
}
const library: Record<number, { name: string; minutes: number; tss: number; if: number; pieces: [number, number, number?][] }> = {
  101: { name: 'Pettit', minutes: 60, tss: 40, if: 0.62, pieces: [[600, 40, 65], [2400, 65], [600, 50]] },
  102: { name: 'Mary Austin', minutes: 63, tss: 80, if: 0.87, pieces: [[600, 45, 70], ...Array.from({ length: 4 }, () => [[480, 110], [240, 50]] as [number, number][]).flat(), [300, 55, 40]] },
  103: { name: 'Gibbs', minutes: 120, tss: 95, if: 0.69, pieces: [[300, 50, 65], [6600, 65], [300, 50]] },
  104: { name: 'Antelope', minutes: 60, tss: 75, if: 0.85, pieces: [[600, 45, 70], [1200, 92], [300, 50], [1200, 92], [300, 50, 40]] },
};

/**
 * TrainerRoad's private API as its web app (and the unofficial trainerroad-cli) uses it: a
 * sign-in that sets the session cookie, the member, the calendar's timeline, scheduled
 * workouts in full by id, library workouts by id, and each workout's profile.
 */
const tr = {
  password: 'pw',
  token: 0,
  signIns: 0,
  planned: [] as { id: number; date: string; workoutId: number | null; name?: string; activityType?: number; tss?: number }[],
  events: [] as Record<string, unknown>[],
  calls: [] as string[],
  ics: '',
};
const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const headers = new Headers(init?.headers);
  if (url.pathname === '/cal/plan.ics') return new Response(tr.ics, { headers: { 'content-type': 'text/calendar' } });
  tr.calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
  if (url.pathname === '/app/api/login/login') {
    tr.signIns++;
    const b = JSON.parse(String(init?.body));
    if (b.username !== 'rider@example.com' || b.password !== tr.password) return Response.json({ success: false });
    const h = new Headers({ 'content-type': 'application/json' });
    h.append('set-cookie', `SharedTrainerRoadAuth=tok-${++tr.token}; path=/; secure; httponly`);
    h.append('set-cookie', 'TrainerRoadAntiForgery=af; path=/');
    return new Response(JSON.stringify({ success: true, redirectUrl: '/app/career' }), { headers: h });
  }
  if (!headers.get('cookie')?.includes(`SharedTrainerRoadAuth=tok-${tr.token}`) || tr.token === 0) return new Response('', { status: 401 });
  const w = (id: number) => library[id];
  if (url.pathname === '/app/api/member-info') return Response.json({ memberId: 4242, username: 'rider', ftp: 300 });
  if (url.pathname === '/app/api/react-calendar/4242/timeline')
    return Response.json({
      plannedActivities: tr.planned.map((p) => ({ id: p.id, date: ymd(p.date), workoutId: p.workoutId, name: p.name ?? null, canMove: true, ...(p.activityType ? { type: p.activityType } : {}), ...(p.tss ? { tss: p.tss } : {}) })),
      events: tr.events,
      annotations: [],
      // FTP records as TrainerRoad gives them: in no order, and marked applied only when AI FTP's and
      // taken. Two set years ago and left; one set by hand at sign-up and AI FTP's taken the same
      // morning (neither in the history); a ramp test; a prediction for a day gone by, never taken;
      // one found two days ago and waiting; one predicted three weeks out
      fitnessThresholds: [
        { id: 'd0', date: `${day(-40)}T08:36:09.47`, value: 295, isApplied: true, source: 22 },
        { id: 'h1', date: `${day(-1000)}T08:09:00`, value: 250, isApplied: false, source: 0 },
        { id: 'm0', date: `${day(-40)}T08:02:05.37`, value: 292, isApplied: false, source: 6 },
        { id: 'h2', date: `${day(-900)}T04:44:32`, value: 260, isApplied: false, source: 0 },
        { id: 'd1', date: `${day(-20)}T00:00:00`, value: 300, isApplied: false, source: 3 },
        { id: 'x1', date: `${day(-30)}T13:00:00`, value: 299, isApplied: false, source: 22 },
        { id: 'd2', date: `${day(-2)}T00:00:00`, value: 306, isApplied: false, source: 24 },
        { id: 'p1', date: `${day(21)}T13:00:00`, value: 315, isApplied: false, source: 22 },
      ],
      pendingAiFtpChange: { id: 'd2', value: 306, source: 24, date: `${day(-2)}T00:00:00`, isApplied: false, isLowConfidence: false },
      // the ride three days ago and yesterday's run, as TrainerRoad recorded them (their starts without a zone)
      activities: [
        { id: 'g-5001', started: `${day(-3)}T08:02:00` },
        { id: 'g-5002', started: `${day(-1)}T01:00:00` },
      ],
    });
  if (url.pathname === '/app/api/tss/rider') return Response.json({ ftpRecordsDate: [{ date: `${day(-60)}T00:00:00`, value: 290 }, { date: `${day(-20)}T00:00:00`, value: 300 }], tssByDay: [] });
  if (url.pathname === '/app/api/ai-ftp-detection/can-use-ai-ftp/4242')
    return Response.json({ can: false, reason: 3, modelVersion: 0, additionalData: { lastChanged: `${day(-1)}T04:38:05.19`, nextAiFtpAvailability: `${day(21)}T00:00:00`, lastViewed: null, detection: { ftp: 306, currentProgressionLevels: [{ progressionId: 83, previousDisplayLevel: 4.2 }], projectedProgressionLevels: [{ progressionId: 83, displayFinalLevel: 3.6 }] } } });
  if (url.pathname === '/app/api/calendar/aiftp/4242/ai-failure-status') return Response.json({ status: 0 });
  if (url.pathname === '/app/api/career/4242/levels')
    // as TrainerRoad gives them: 0 for no prediction, and a reset that left a level where it was
    return Response.json({ timestamp: `${day(0)}T01:00:00`, levels: { 79: { recent: 2.1, predicted: 0, changeEvent: { date: `${day(-1)}T04:38:05Z`, reason: 7, level: { from: 2.1, to: 2.1 } } }, 83: { recent: 4.2, predicted: 6.1, changeEvent: { date: `${day(-3)}T10:00:00`, reason: 1, level: { from: 3.9, to: 4.2 }, delta: 0.3 } }, 33: { recent: 5.5, predicted: 0 } } });
  // no current plan of its own; phases by TrainerRoad's codes (type 0 Base, 2 Build; volume 1 Mid), one long over
  if (url.pathname === '/app/api/plan-builder/4242/plan-phases')
    return Response.json([
      { type: 2, volume: 1, planName: 'Sustained Power Build', start: `${day(33)}T00:00:00`, end: `${day(60)}T23:59:59.999` },
      { type: 0, volume: 1, planName: 'Sweet Spot Base I', start: `${day(-10)}T00:00:00`, end: `${day(32)}T23:59:59.999` },
      { type: 3, volume: 0, planName: 'An old plan', start: `${day(-200)}T00:00:00`, end: `${day(-150)}T23:59:59.999` },
    ]);
  if (url.pathname === '/app/api/react-calendar/4242/activities') {
    const ride = { id: 'g-5001', activityId: 900001, activityType: 1, started: `${day(-3)}T08:02:00`, name: 'Pettit', workout: { id: 101, name: 'Pettit' }, durationInSeconds: 3600, tss: 41, intensityFactor: 0.63, kj: 650, surveyResponse: { rpeSurveyElementId: 103, struggleReasonSurveyElementIds: [201], rpe: 3.25, text: null } };
    const run = { $type: 'ReactCalendarRunningActivityModel', id: 'g-5002', activityId: 900002, activityType: 2, started: `${day(-1)}T01:00:00`, name: 'Lunch Run', durationInSeconds: 1700, tss: 17, surveyResponse: null };
    const ids = (headers.get('ids') ?? '').split(',');
    return Response.json([ride, run].filter((a) => ids.includes(a.id)));
  }
  // the survey's words go by the ride's number
  if (url.pathname === '/app/api/survey/900001')
    return Response.json([
      { id: 1, parentId: null, elementId: 101, kind: 1, type: 1, text: 'Easy' },
      { id: 3, parentId: null, elementId: 103, kind: 3, type: 1, text: 'Hard' },
      { id: 9, parentId: 3, elementId: 201, kind: 7, type: 1, text: 'My legs were heavy' },
    ]);
  if (url.pathname === '/app/api/react-calendar/4242/planned-activities') {
    const ids = (headers.get('ids') ?? '').split(',').map(Number);
    // TrainerRoad refuses the lot when it's asked for something it doesn't keep this way
    if (tr.planned.some((p) => ids.includes(p.id) && !p.workoutId)) return Response.json({ type: 'general/100', status: 400 }, { status: 400 });
    return Response.json(
      tr.planned
        .filter((p) => ids.includes(p.id))
        .map((p) => ({ id: p.id, date: ymd(p.date), tss: p.workoutId ? w(p.workoutId).tss : 30, durationInSeconds: 1800, workout: p.workoutId ? { id: p.workoutId, name: w(p.workoutId).name, duration: w(p.workoutId).minutes, tss: w(p.workoutId).tss, isOutside: false } : null })),
    );
  }
  if (url.pathname === '/app/api/workouts/by-id') {
    const ids = JSON.parse(String(init?.body)) as number[];
    return Response.json(ids.map((id) => ({ id, workoutName: w(id).name, duration: w(id).minutes, tss: w(id).tss, intensityFactor: w(id).if * 100, kj: 600, workoutDescription: `<p>${w(id).name} is a workout&nbsp;for you.</p>`, goalDescription: '<p>Get faster.</p>' })));
  }
  const chart = url.pathname.match(/^\/app\/api\/workouts\/(\d+)\/chart-data$/);
  // Pettit's in PascalCase; Gibbs's profile only in its workout details, as intervals
  if (chart && chart[1] === '101') return Response.json({ CourseData: profile(w(101).pieces).map((p) => ({ Seconds: p.seconds, FtpPercent: p.ftpPercent })) });
  if (chart && chart[1] === '103') return Response.json({ courseData: [] });
  if (chart) return Response.json({ courseData: profile(w(+chart[1]).pieces) });
  if (url.pathname === '/app/api/workoutdetails/103')
    return Response.json({
      Workout: {
        Details: { Id: 103, WorkoutName: 'Gibbs' },
        IntervalData: [
          { Name: 'Workout', Start: 0, End: 7200, StartTargetPowerPercent: 65 },
          { Name: 'Fake', Start: 0, End: 300, StartTargetPowerPercent: 55 },
          { Name: 'Fake', Start: 300, End: 6900, StartTargetPowerPercent: 65 },
          { Name: 'Fake', Start: 6900, End: 7200, StartTargetPowerPercent: 50 },
        ],
      },
    });
  return new Response('not found', { status: 404 });
};

describe('TrainerRoad', () => {
  let trp: typeof import('./providers/trainerroad');
  let db: typeof import('./db');
  let config: typeof import('./config').config;
  // run a sync, letting the pauses between requests pass at once
  const run = async () => {
    let done = false;
    const p = trp.syncTrainerRoad().finally(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(250);
    return p;
  };
  const planned = () => db.q.all("SELECT * FROM planned_workouts WHERE source = 'trainerroad' ORDER BY date, sort_order");
  const charts = () => tr.calls.filter((c) => c.endsWith('/chart-data')).length;
  let rideId = 0;
  let runId = 0;

  beforeAll(async () => {
    vi.stubGlobal('fetch', fakeFetch);
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    db = await import('./db');
    trp = await import('./providers/trainerroad');
    config = (await import('./config')).config;
    tr.planned = [
      { id: 9001, date: day(-35), workoutId: 101 },
      { id: 9002, date: day(-3), workoutId: 101 },
      { id: 9003, date: day(0), workoutId: 102 },
      { id: 9004, date: day(2), workoutId: 103 },
      { id: 9005, date: day(40), workoutId: 101 },
    ];
    tr.events = [{ id: 7001, name: 'Grafton to Inverell', date: ymd(day(60)), racePriority: 3, tss: 250, duration: 4 * 3600, isTriathlonType: false, notes: '<p>The big one</p>' }];
    // the ride already done three days ago
    rideId = Number(db.q.run("INSERT INTO activities(source, external_id, name, sport, start_time, local_date, detailed) VALUES('file', 'r1', 'Morning Ride', 'ride', ?, ?, 1)", `${day(-3)}T08:00:00.000Z`, day(-3)).lastInsertRowid);
    runId = Number(db.q.run("INSERT INTO activities(source, external_id, name, sport, start_time, local_date, detailed) VALUES('file', 'r2', 'Lunch Run', 'run', ?, ?, 1)", `${day(-1)}T01:00:30.000Z`, day(-1)).lastInsertRowid);
    // this app's own FTP: 295 W, then 305 W for the last eleven days
    for (let n = -90; n <= 0; n++) db.q.run("INSERT INTO threshold_estimates(sport, date, data) VALUES('ride', ?, ?)", day(n), JSON.stringify({ sport: 'ride', date: day(n), threshold: n < -10 ? 295 : 305, raw: 0, cp: 0 }));
  });
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads the plan from the account: workouts with their intervals, the race, matched to rides done', async () => {
    const changes = await run();
    expect(changes).toEqual({ added: 6, changed: 0, removed: 0 });
    expect(tr.signIns).toBe(1);
    const rows = planned();
    // four weeks back to a year ahead: not the workout five weeks ago
    expect(rows.map((r) => [r.date, r.title])).toEqual([
      [day(-3), 'Pettit'],
      [day(0), 'Mary Austin'],
      [day(2), 'Gibbs'],
      [day(40), 'Pettit'],
      [day(60), 'Grafton to Inverell'],
    ]);
    const mary = rows[1];
    expect(mary).toMatchObject({ external_id: '9003', sport: 'ride', planned_duration: 63 * 60, planned_tss: 80, planned_if: 0.87, activity_id: null });
    expect(mary.description).toBe('Mary Austin is a workout for you.\n\nGet faster.');
    const s = JSON.parse(mary.structure);
    expect(s.blocks[1]).toMatchObject({ kind: 'repeat', count: 4 });
    expect((s.blocks[1] as WorkoutRepeat).steps.map((x) => [x.duration, x.low])).toEqual([[480, 1.1], [240, 0.5]]);
    // the race: an event with its priority, and its load on the day
    expect(rows[4]).toMatchObject({ planned_tss: 250, planned_duration: 4 * 3600, structure: null });
    expect(db.q.all("SELECT name, priority, description, source FROM events WHERE source = 'trainerroad'")).toEqual([{ name: 'Grafton to Inverell', priority: 'A', description: 'The big one', source: 'trainerroad' }]);
    // the ride three days ago matched to the workout planned for it
    expect(rows[0].activity_id).toBe(rideId);
    expect(db.q.get('SELECT planned_id FROM activities WHERE id = ?', rideId)!.planned_id).toBe(rows[0].id);
    // intervals from TrainerRoad's PascalCase answer (Pettit), and from a workout's details when its chart has none (Gibbs)
    expect(flatten(JSON.parse(rows[0].structure)).map((x) => [x.duration, x.ramp])).toEqual([[600, true], [2400, false], [600, false]]);
    expect(flatten(JSON.parse(rows[2].structure)).map((x) => [x.duration, x.low])).toEqual([[300, 0.55], [6600, 0.65], [300, 0.5]]);
    // each library workout's intervals read once, though Pettit is planned twice
    expect(charts()).toBe(3);
    expect(trp.trainerRoadStatus()).toMatchObject({ mode: 'account', readBy: 'account', account: 'rider', lastError: null, upcoming: 4, races: 1, next: { date: day(0), title: 'Mary Austin' } });
    // the session's cookies are kept with the connection
    expect(JSON.parse(db.q.get("SELECT access_token FROM connections WHERE provider = 'trainerroad'")!.access_token)).toMatchObject({ SharedTrainerRoadAuth: 'tok-1' });
  });

  it('reads what else TrainerRoad keeps, and sets its FTP beside this app’s', async () => {
    const { trainerRoadInsights } = await import('./trainerroad-insights');
    const r = trainerRoadInsights();
    // its FTP now, and this app's
    expect(r.ftp).toMatchObject({ trainerRoad: 300, app: 305 });
    expect(r.ftp!.events.map((e) => [e.date, e.kind, e.value, e.app, e.diff, e.source])).toEqual([
      // set years ago, before TrainerRoad kept sources: in use, though not marked so
      [day(-1000), 'applied', 250, null, null, 0],
      [day(-900), 'applied', 260, null, null, 0],
      [day(-60), 'applied', 290, 295, -5, null],
      // set by hand, then AI FTP's taken the same morning: only TrainerRoad's own records have them
      [day(-40), 'applied', 292, 295, -3, 6],
      [day(-40), 'applied', 295, 295, 0, 22],
      // AI FTP's prediction for a day now gone, never taken
      [day(-30), 'detected', 299, 295, 4, 22],
      // the history's change, told by TrainerRoad's record of it: a ramp test
      [day(-20), 'applied', 300, 295, 5, 3],
      // found by AI FTP Detection, waiting to be accepted
      [day(-2), 'pending', 306, 305, 1, 24],
      // predicted for three weeks out: no estimate of this app's for a day to come
      [day(21), 'predicted', 315, null, null, 22],
    ]);
    // day by day over its current stretch, from the first change after 840 days without one:
    // 20 days 5 W under, 20 level (the later of the two changes on day −40 held), 10 over, 11 under
    expect(r.ftp!.since).toBe(day(-60));
    expect(r.ftp!.agreement!.days).toBe(61);
    expect(r.ftp!.agreement!.mean).toBeCloseTo((20 * -5 + 20 * 0 + 10 * 5 + 11 * -5) / 61, 6);
    expect(r.ftp!.agreement!.meanAbs).toBeCloseTo((20 * 5 + 10 * 5 + 11 * 5) / 61, 6);
    // the prediction, beside this app's forecast for the day (no capacity model from one ride)
    expect(r.ftp!.forecasts).toEqual([{ date: day(21), trainerRoad: 315, app: null, range: null, days: 21 }]);
    expect(r.ai).toMatchObject({ can: false, reason: 'the FTP changed too recently', status: 'CanPredict', modelVersion: null, detected: 306, next: day(21), changed: day(-1) });
    // progression levels by zone, in TrainerRoad's order, with what accepting the detection would do
    expect(r.levels.map((l) => [l.zone, l.level, l.predicted])).toEqual([
      ['Endurance', 5.5, null],
      ['Threshold', 4.2, 6.1],
      ['Anaerobic', 2.1, null],
    ]);
    expect(r.levels[1]).toMatchObject({ changed: { date: day(-3), from: 3.9, to: 4.2, reason: 1 }, ai: { from: 4.2, to: 3.6 } });
    expect(r.levels[2].changed).toBeNull();
    // the plan by its phases: the one under way, and the next; the old plan's left out
    expect(r.plan).toMatchObject({ name: 'Sweet Spot Base I', volume: 'Mid', current: { name: 'Base', start: day(-10), end: day(32) } });
    expect(r.plan!.phases.map((p: { name: string }) => p.name)).toEqual(['Base', 'Build']);
    // the ride and the run as TrainerRoad recorded them, how the ride was rated, and the same ones here
    expect(r.rides).toEqual([
      { id: 'g-5002', started: `${day(-1)}T01:00:00`, name: 'Lunch Run', sport: 'run', duration: 1700, tss: 17, if: null, kj: null, survey: null, activity: { id: runId, name: 'Lunch Run', tss: null } },
      {
        id: 'g-5001',
        started: `${day(-3)}T08:02:00`,
        name: 'Pettit',
        sport: 'ride',
        duration: 3600,
        tss: 41,
        if: 0.63,
        kj: 650,
        survey: { rating: 'Hard', level: 3, reasons: ['My legs were heavy'], rpe: 3.25, text: null },
        activity: { id: rideId, name: 'Morning Ride', tss: null },
      },
    ]);
    // and on the activity
    const { api } = await import('./api');
    const detail = await (await api.request(`/activities/${rideId}`)).json();
    expect(detail.trainerRoad).toMatchObject({ name: 'Pettit', survey: { rating: 'Hard', rpe: 3.25 } });
    // all kept as TrainerRoad gave it
    expect(db.q.all('SELECT key FROM trainerroad_data ORDER BY key').map((x) => x.key)).toEqual(['ai-ftp', 'ai-ftp-status', 'fitness-thresholds', 'ftp-history', 'levels', 'member', 'plan', 'plan-phases', 'power-records', 'timeline', 'weight']);
  });

  it('follows TrainerRoad as it adapts the plan: moved, swapped and dropped workouts, a ride’s workout kept', async () => {
    const before = new Map(planned().map((r) => [r.external_id, r]));
    tr.planned = [
      { id: 9003, date: day(0), workoutId: 104 }, // swapped by Adaptive Training
      { id: 9004, date: day(3), workoutId: 103 }, // moved a day
      { id: 9006, date: day(7), workoutId: 103 }, // added
      { id: 9008, date: day(6), workoutId: null, activityType: 2, tss: 18 }, // a run, not a workout
      // 9002 (ridden) and 9005 gone
    ];
    const asked = () => tr.calls.filter((c) => c.endsWith('/planned-activities')).length;
    const before2 = asked();
    const changes = await run();
    expect(changes).toEqual({ added: 2, changed: 2, removed: 1 });
    // TrainerRoad refused the lot for the run, so the workouts were asked for on their own
    expect(asked() - before2).toBe(2);
    const rows = planned();
    expect(rows.map((r) => [r.date, r.title, r.external_id])).toEqual([
      [day(-3), 'Pettit', '9002'],
      [day(0), 'Antelope', '9003'],
      [day(3), 'Gibbs', '9004'],
      [day(6), 'Run', '9008'],
      [day(7), 'Gibbs', '9006'],
      [day(60), 'Grafton to Inverell', 'event-7001'],
    ]);
    expect(rows[3]).toMatchObject({ sport: 'run', planned_tss: 18, planned_duration: null, structure: null });
    // the same rows, changed in place
    expect(rows[1].id).toBe(before.get('9003')!.id);
    expect(rows[2].id).toBe(before.get('9004')!.id);
    expect(JSON.parse(rows[1].structure).blocks.length).toBeGreaterThan(2);
    expect(rows[1].planned_tss).toBe(75);
    // only the new workout's intervals read
    expect(charts()).toBe(4);
    expect(tr.signIns).toBe(1);
  });

  it('sets out the plan ahead for every page: the race, the weeks, how it was followed, and the two FTP outlooks apart', async () => {
    const { planOutlook } = await import('./plan-outlook');
    const o = planOutlook();
    expect(o.source).toBe('trainerroad');
    expect(o.race).toMatchObject({ name: 'Grafton to Inverell', priority: 'A', date: day(60) });
    expect(o.raceDay?.days).toBe(60);
    // the weeks carry the planned load, the riding in it, and what was done
    const planned = o.weeks.reduce((s, w) => s + w.planned.n, 0);
    expect(planned).toBeGreaterThan(0);
    expect(o.weeks.every((w) => w.planned.rideTss <= w.planned.tss)).toBe(true);
    // TrainerRoad's FTP and prediction as its own; this app's outlook as its own (none without a capacity model)
    expect(o.ftp.trainerRoad).toMatchObject({ now: 300, predicted: [{ date: day(21), value: 315 }] });
    expect(o.ftp.trainerRoad!.history[0].date).toBe(day(-60));
    expect(o.ftp.app?.path ?? []).toEqual([]);
    // days before the race with nothing planned are called out
    expect(o.unplanned.every((g) => g.days >= 4 && g.to < day(60))).toBe(true);
  });

  it('reads a chart that counts in ticks, as TrainerRoad’s live one does', () => {
    // 10 min at 50%, 5 min at 110%, 5 min at 50%: one tick a second, over its 20 minutes
    const courseData = Array.from({ length: 1200 }, (_, t) => ({ tick: t, memberFtpPercent: 162.5, ftpPercent: t >= 600 && t < 900 ? 110 : 50 }));
    const s = trp.workoutStructure({ courseData }, null, 20)!;
    expect(flatten(s).map((x) => [x.duration, x.low])).toEqual([[600, 0.5], [300, 1.1], [300, 0.5]]);
  });

  it('signs in again when the session has run out', async () => {
    // the session held here is one TrainerRoad no longer knows
    db.q.run("UPDATE connections SET access_token = '{\"SharedTrainerRoadAuth\":\"stale\"}' WHERE provider = 'trainerroad'");
    expect(await run()).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(tr.signIns).toBe(2);
    expect(trp.trainerRoadStatus().lastError).toBeNull();
  });

  it('keeps TrainerRoad’s workouts and races to TrainerRoad: no moving or deleting them here', async () => {
    const { api } = await import('./api');
    const row = planned()[1];
    const send = (path: string, method: string, body?: unknown) => api.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    expect((await send(`/planned/${row.id}`, 'PATCH', { date: day(5) })).status).toBe(409);
    expect((await send(`/planned/${row.id}`, 'DELETE')).status).toBe(409);
    const race = db.q.get("SELECT id FROM events WHERE source = 'trainerroad'")!;
    expect((await send(`/events/${race.id}`, 'PATCH', { priority: 'C' })).status).toBe(409);
    // a race's target CTL is this app's own
    expect((await send(`/events/${race.id}`, 'PATCH', { targetCtl: 95 })).status).toBe(200);
    expect((await send(`/events/${race.id}`, 'DELETE')).status).toBe(409);
    expect(planned()[1].date).toBe(row.date);
  });

  it('reads the calendar export instead, without a login: the same workouts, not doubled', async () => {
    Object.assign(config.trainerRoad, { username: '', password: '', calendarUrl: 'https://www.trainerroad.com/cal/plan.ics' });
    const d = (s: string) => s.replace(/-/g, '');
    const before = planned();
    tr.calls = [];
    tr.ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TrainerRoad//Calendar//EN',
      'BEGIN:VEVENT',
      'UID:cal-1@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(0))}`,
      'SUMMARY:1:00 - Antelope',
      // a long line folded onto the next, with escaped commas and a line break
      'DESCRIPTION:TSS 75\\, IF 0.85\\, kJ(Cal) 640. Description: Antelope is 2x20 mi',
      ' nutes at sweet spot.\\nGoals: hold it steady.',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cal-2@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(3))}`,
      'SUMMARY:2:00 - Gibbs',
      'DESCRIPTION:TSS 95\\, IF 0.69. Description: Endurance.',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cal-3@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(7))}`,
      'SUMMARY:2:00 - Gibbs',
      'DESCRIPTION:TSS 95\\, IF 0.69',
      'END:VEVENT',
      // a ride at a time of day, without a length in its name
      'BEGIN:VEVENT',
      'UID:cal-4@trainerroad.com',
      `DTSTART;TZID=Australia/Sydney:${d(day(8))}T060000`,
      `DTEND;TZID=Australia/Sydney:${d(day(8))}T071500`,
      'SUMMARY:Coffee ride',
      'END:VEVENT',
      // the race, and its leg
      'BEGIN:VEVENT',
      'UID:cal-5@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(60))}`,
      'SUMMARY:Grafton to Inverell',
      'DESCRIPTION:Your A race.',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cal-6@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(60))}`,
      'SUMMARY:4:00 - Grafton to Inverell',
      'DESCRIPTION:TSS 250',
      'END:VEVENT',
      // a phase marker and a note: not workouts or races
      'BEGIN:VEVENT',
      'UID:cal-7@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(1))}`,
      'SUMMARY:Build',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:cal-8@trainerroad.com',
      `DTSTART;VALUE=DATE:${d(day(5))}`,
      'SUMMARY:Away for work',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const changes = await run();
    // the run isn't in the export: gone
    expect(changes).toMatchObject({ added: 1, removed: 1 });
    expect(tr.calls).toEqual([]);
    const rows = planned();
    expect(rows.map((r) => [r.date, r.title, r.planned_duration])).toEqual([
      [day(-3), 'Pettit', 3600],
      [day(0), 'Antelope', 3600],
      [day(3), 'Gibbs', 7200],
      [day(7), 'Gibbs', 7200],
      [day(8), 'Coffee ride', 75 * 60],
      [day(60), 'Grafton to Inverell', 4 * 3600],
    ]);
    // found again by day and name: the same rows, their intervals kept
    const antelope = rows[1];
    expect(antelope.id).toBe(before[1].id);
    expect(antelope).toMatchObject({ external_id: 'cal-1@trainerroad.com', planned_tss: 75, planned_if: 0.85 });
    expect(antelope.description).toBe('Antelope is 2x20 minutes at sweet spot.\nGoals: hold it steady.');
    expect(JSON.parse(antelope.structure).blocks.length).toBeGreaterThan(2);
    expect(db.q.all("SELECT name, priority, target_ctl FROM events WHERE source = 'trainerroad'")).toEqual([{ name: 'Grafton to Inverell', priority: 'A', target_ctl: 95 }]);
    expect(trp.trainerRoadStatus()).toMatchObject({ mode: 'calendar', readBy: 'calendar', account: null, lastError: null });
  });

  it('says what to check when the sign-in is refused, and leaves the plan as it was', async () => {
    Object.assign(config.trainerRoad, { username: 'rider@example.com', password: 'wrong', calendarUrl: '' });
    db.q.run("UPDATE connections SET access_token = NULL WHERE provider = 'trainerroad'");
    const before = planned();
    expect(await run()).toBeNull();
    expect(trp.trainerRoadStatus().lastError).toBe('sign-in refused — check TRAINERROAD_USERNAME and TRAINERROAD_PASSWORD');
    expect(planned()).toEqual(before);
  });
});

describe('TrainerRoad’s calendar export, read', () => {
  it('reads dates, times of day, folded lines and escapes', async () => {
    const { parseIcs, entryText } = await import('./providers/trainerroad');
    const [allDay, utc, local] = parseIcs(
      [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:a',
        'DTSTART;VALUE=DATE:20261110',
        'SUMMARY:0:45 - Baird\\, the short one',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'UID:b',
        // 7:30 pm UTC is 6:30 am the next day in Sydney
        'DTSTART:20261110T193000Z',
        'DTEND:20261110T203000Z',
        'SUMMARY:Early ride',
        'END:VEVENT',
        'BEGIN:VEVENT',
        'DTSTART;TZID="Australia/Sydney":20261112T173000',
        'DTEND;TZID="Australia/Sydney":20261112T183000',
        'SUMMARY:Club',
        'DESCRIPTION;ALTREP="cid:x":Line one\\nline two',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\n'),
    );
    expect(allDay).toMatchObject({ uid: 'a', date: '2026-11-10', allDay: true, minutes: null, summary: '0:45 - Baird, the short one' });
    expect(utc).toMatchObject({ date: '2026-11-11', allDay: false, minutes: 60 });
    expect(local).toMatchObject({ uid: '2026-11-12|Club', date: '2026-11-12', minutes: 60, description: 'Line one\nline two' });
    expect(entryText('TSS 61, IF 71, kJ(Cal) 593')).toEqual({ tss: 61, if: 0.71, words: null });
    expect(entryText('Intensity Factor: 0.8\nA steady ride.')).toMatchObject({ tss: null, if: 0.8, words: 'Intensity Factor: 0.8\nA steady ride.' });
  });
});

describe('TrainerRoad’s post-ride survey, read', () => {
  it('reads an answer by its words and reasons, its wording alone, or just an RPE', async () => {
    const { surveyAnswer } = await import('./providers/trainerroad');
    const options = [
      { id: 3, parentId: null, elementId: 103, kind: 3, type: 1, text: 'Hard' },
      { id: 9, parentId: 3, elementId: 201, kind: 7, type: 1, text: 'My legs were heavy' },
    ];
    expect(surveyAnswer(options, null)).toBeNull();
    expect(surveyAnswer(options, { rpeSurveyElementId: 999 })).toBeNull();
    expect(surveyAnswer(options, { rpeSurveyElementId: 103, struggleReasonSurveyElementId: 201, text: '  ' })).toEqual({ rating: 'Hard', level: 3, reasons: ['My legs were heavy'], rpe: null, text: null });
    expect(surveyAnswer(options, { rpeSurveyElementId: 999, translatedDisplayName: 'Very Hard' })).toMatchObject({ rating: 'Very Hard', level: null });
    expect(surveyAnswer([], { rpe: 2.5, text: 'Windy' })).toEqual({ rating: null, level: null, reasons: [], rpe: 2.5, text: 'Windy' });
  });
});
