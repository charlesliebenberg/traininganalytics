import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ta-calendar-'));
process.env.DB_PATH = join(dir, 'test.db');
let api: typeof import('./api')['api'];
let db: typeof import('./db');
let ingest: typeof import('./ingest');

beforeAll(async () => {
  db = await import('./db');
  ingest = await import('./ingest');
  ({ api } = await import('./api'));
  db.setPreferences({ autoThresholds: { ride: false, run: false, swim: false, hr: false } });
});
beforeEach(() => {
  for (const table of ['activities', 'planned_workouts', 'season_plans', 'events']) db.q.run(`DELETE FROM ${table}`);
});
afterAll(() => { db.db.close(); rmSync(dir, { recursive: true, force: true }); });

async function request(path: string, method: string, body?: unknown) {
  const res = await api.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect(res.status).toBe(200);
  return res.json();
}
const ride = () => ingest.saveActivity({
  source: 'strava', externalId: '1', name: 'Morning ride', sport: 'ride',
  startTime: '2027-01-05T08:00:00.000Z', localDate: '2027-01-05',
  summary: { sport: 'ride', elapsedTime: 600, movingTime: 600, avgPower: 200 },
})!;

describe('calendar links', () => {
  it('relinks an activity when its sport changes', async () => {
    const p = await request('/planned', 'POST', { date: '2027-01-05', sport: 'ride', title: 'Ride' });
    const run = await request('/planned', 'POST', { date: '2027-01-05', sport: 'run', title: 'Run' });
    const id = ride();
    expect(db.getActivity(id)?.plannedId).toBe(p.id);
    await request(`/activities/${id}`, 'PATCH', { sport: 'run' });
    expect(db.q.get('SELECT activity_id FROM planned_workouts WHERE id = ?', p.id)?.activity_id).toBeNull();
    expect(db.getActivity(id)?.plannedId).toBe(run.id);
  });

  it('unlinks a completed workout when its sport changes in the builder', async () => {
    const p = await request('/planned', 'POST', { date: '2027-01-05', sport: 'ride', title: 'Ride' });
    const id = ride();
    const edited = await request(`/planned/${p.id}`, 'PATCH', { sport: 'run' });
    expect(edited.activityId).toBeNull();
    expect(db.getActivity(id)?.plannedId).toBeNull();
  });

  it('upgrades a summary to imported streams without losing the activity ID, edits or plan link', async () => {
    const p = await request('/planned', 'POST', { date: '2027-01-05', sport: 'ride', title: 'Ride' });
    const id = ride();
    await request(`/activities/${id}`, 'PATCH', { rpe: 7, tssOverride: 55, description: 'Felt strong' });
    const imported = ingest.saveActivity({
      source: 'file', externalId: 'fit-1', name: 'Imported ride', sport: 'ride',
      startTime: '2027-01-05T08:00:00.000Z', localDate: '2027-01-05',
      streams: { time: Array.from({ length: 600 }, (_, i) => i), watts: Array(600).fill(200) },
    });
    expect(imported).toBe(id);
    expect(db.getActivity(id)).toMatchObject({ plannedId: p.id, rpe: 7, tss: 55, tssMethod: 'manual', description: 'Felt strong', detailed: true });
    expect(db.q.get('SELECT activity_id FROM planned_workouts WHERE id = ?', p.id)?.activity_id).toBe(id);
    expect(db.loadStreams(id)?.watts).toHaveLength(600);
  });

  it('notifies analytics after sport edits and deletions', async () => {
    const id = ride();
    const changed = vi.fn();
    ingest.ingestEvents.onSaved.push(changed);
    try {
      await request(`/activities/${id}`, 'PATCH', { sport: 'run' });
      expect(changed).toHaveBeenCalledTimes(1);
      await request(`/activities/${id}`, 'DELETE');
      expect(changed).toHaveBeenCalledTimes(2);
    } finally { ingest.ingestEvents.onSaved.splice(ingest.ingestEvents.onSaved.indexOf(changed), 1); }
  });

  it('clears a completion when Strava deletes the activity', async () => {
    const p = await request('/planned', 'POST', { date: '2027-01-05', sport: 'ride', title: 'Ride' });
    const id = ride();
    const { stravaHandleWebhook } = await import('./providers/strava');
    stravaHandleWebhook({ object_type: 'activity', object_id: 1, aspect_type: 'delete', owner_id: 1 });
    expect(db.getActivity(id)).toBeNull();
    expect(db.q.get('SELECT activity_id FROM planned_workouts WHERE id = ?', p.id)?.activity_id).toBeNull();
  });

  it('unlinks an external workout when its sport changes', async () => {
    const { applyExternalPlan } = await import('./external-plan');
    const workout = { id: 'tr-1', date: '2027-01-05', sport: 'ride' as const, title: 'Session', description: null, duration: 600, tss: 20, if: null, structure: null };
    const plan = { from: '2027-01-04', to: '2027-01-10', workouts: [workout], races: [] };
    applyExternalPlan('trainerroad', plan);
    const id = ride();
    const plannedId = db.getActivity(id)!.plannedId;
    expect(plannedId).not.toBeNull();
    applyExternalPlan('trainerroad', { ...plan, workouts: [{ ...workout, sport: 'run' }] });
    expect(db.getActivity(id)?.plannedId).toBeNull();
    expect(db.q.get('SELECT activity_id FROM planned_workouts WHERE id = ?', plannedId)?.activity_id).toBeNull();
  });
});

describe('filling a season plan', () => {
  const createPlan = () => request('/plans', 'POST', { name: 'Review plan', config: {
    startDate: '2027-01-04', raceDate: '2027-03-28', startCtl: 40, startAtl: 40,
    targetCtl: 55, maxRamp: 5, pattern: '3:1', taperWeeks: 2, maxWeeklyHours: 12, sport: 'ride',
  } });
  it('preserves later weeks when only the first week is refilled', async () => {
    const plan = await createPlan();
    await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 4 });
    const later = db.q.all('SELECT * FROM planned_workouts WHERE date >= ?', '2027-01-11');
    expect(later.length).toBeGreaterThan(0);
    await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 1 });
    expect(db.q.all('SELECT * FROM planned_workouts WHERE date >= ?', '2027-01-11')).toEqual(later);
  });
  it('does not generate another copy of a completed workout', async () => {
    const plan = await createPlan();
    await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 1 });
    const p = db.q.get('SELECT * FROM planned_workouts WHERE sport = ? ORDER BY date LIMIT 1', 'ride')!;
    ingest.saveActivity({ source: 'file', externalId: 'done', name: p.title, sport: 'ride', startTime: `${p.date}T08:00:00.000Z`, localDate: p.date,
      summary: { sport: 'ride', elapsedTime: 3600, movingTime: 3600, avgPower: 200 } });
    const before = db.q.get('SELECT COUNT(*) AS n FROM planned_workouts')!.n;
    await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 1 });
    expect(db.q.get('SELECT COUNT(*) AS n FROM planned_workouts')!.n).toBe(before);
    expect(db.q.get('SELECT activity_id FROM planned_workouts WHERE id = ?', p.id)?.activity_id).not.toBeNull();
  });
  it('leaves the calendar intact when zero weeks are selected', async () => {
    const plan = await createPlan();
    await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 4 });
    const before = db.q.all('SELECT * FROM planned_workouts');
    const result = await request(`/plans/${plan.id}/apply`, 'POST', { from: '2027-01-04', weeks: 0 });
    expect(result.created).toBe(0);
    expect(db.q.all('SELECT * FROM planned_workouts')).toEqual(before);
  });
});
