import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { addDays, parseISO, subDays } from 'date-fns';
import { config, stravaConfigured, tpConfigured } from './config';
import {
  ACTIVITY_LIST_COLUMNS,
  deleteThresholds,
  getActivity,
  getCurves,
  getPreferences,
  listThresholds,
  loadStreams,
  q,
  rowToActivity,
  rowToEvent,
  rowToPlan,
  rowToPlanned,
  rowToTemplate,
  setPreferences,
  thresholdsFor,
  transaction,
  upsertThresholds,
  DEFAULT_THRESHOLDS,
} from './db';
import { aggregateCurve, dailyLoads, iso, modelHistory, pmc, powerModel, records, today, trends, type CurveType } from './aggregate';
import { linkPlanned, recalculate } from './ingest';
import { importFile } from './importers/files';
import { clearDemo, isDemo, loadDemo } from './demo';
import { syncNow, syncStatus } from './sync';
import { stravaAuthUrl, stravaDisconnect, stravaExchangeCode, stravaHandleWebhook, stravaWebhookSubscribe } from './providers/strava';
import { tpAuthUrl, tpDisconnect, tpExchangeCode } from './providers/trainingpeaks';
import { BUILTIN_WORKOUTS } from '../shared/library';
import { workoutMetrics } from '../shared/analytics/workout';
import { generateSeasonPlan, generateWeekWorkouts } from '../shared/analytics/plan';
import { formZone } from '../shared/analytics/pmc';
import type { SeasonPlanConfig, Thresholds, WorkoutStructure } from '../shared/types';

export const api = new Hono();

// ---------- background jobs (recalculate, demo) ----------
const job = { kind: null as string | null, message: null as string | null, progress: 0 };
async function runJob(kind: string, fn: (progress: (p: number, msg?: string) => void) => Promise<unknown> | unknown) {
  if (job.kind) throw new Error(`${job.kind} already running`);
  job.kind = kind;
  job.progress = 0;
  job.message = null;
  try {
    await fn((p, msg) => {
      job.progress = p;
      if (msg) job.message = msg;
    });
  } finally {
    job.kind = null;
    job.message = null;
  }
}

api.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

api.get('/status', (c) => c.json({ ...syncStatus(), job: job.kind ? { ...job } : null, demo: isDemo(), publicUrl: config.publicUrl }));

// ---------- preferences & thresholds ----------
api.get('/preferences', (c) => c.json(getPreferences()));
api.put('/preferences', async (c) => c.json(setPreferences(await c.req.json())));

api.get('/thresholds', (c) => c.json({ history: listThresholds(), current: thresholdsFor(today()), defaults: DEFAULT_THRESHOLDS }));
api.put('/thresholds', async (c) => {
  const t = (await c.req.json()) as Thresholds;
  if (!t.date) t.date = today();
  upsertThresholds({ ...DEFAULT_THRESHOLDS, ...t });
  return c.json({ ok: true, history: listThresholds() });
});
api.delete('/thresholds/:date', (c) => {
  deleteThresholds(c.req.param('date'));
  return c.json({ ok: true });
});
api.post('/recalculate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  runJob('recalculate', (progress) => recalculate({ from: body.from }, (d, t) => progress(d / t, `Recalculating ${d}/${t}`))).catch(() => {});
  return c.json({ started: true });
});

// ---------- activities ----------
const SORTS: Record<string, string> = {
  date: 'start_time',
  name: 'name',
  duration: 'moving_time',
  distance: 'distance',
  tss: 'COALESCE(tss_override, tss)',
  np: 'np',
  if: 'intensity',
  hr: 'avg_hr',
  elevation: 'elevation_gain',
  speed: 'avg_speed',
  work: 'work',
  ef: 'ef',
  decoupling: 'decoupling',
};

api.get('/activities', (c) => {
  const { from, to, sport, search, sort = 'date', dir = 'desc', limit = '50', offset = '0' } = c.req.query();
  const where: string[] = [];
  const params: unknown[] = [];
  if (from) where.push('local_date >= ?') && params.push(from);
  if (to) where.push('local_date <= ?') && params.push(to);
  if (sport) where.push('sport = ?') && params.push(sport);
  if (search) where.push('(name LIKE ? OR description LIKE ?)') && params.push(`%${search}%`, `%${search}%`);
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = `${SORTS[sort] ?? 'start_time'} ${dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, start_time DESC`;
  const rows = q.all(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, Number(limit), Number(offset));
  const total = q.get(`SELECT COUNT(*) AS n, SUM(moving_time) AS time, SUM(distance) AS distance, SUM(COALESCE(tss_override, tss)) AS tss, SUM(elevation_gain) AS elevation FROM activities ${w}`, ...params);
  return c.json({ items: rows.map(rowToActivity), total: total?.n ?? 0, totals: total });
});

api.get('/activities/:id', (c) => {
  const id = Number(c.req.param('id'));
  const a = getActivity(id);
  if (!a) return c.json({ error: 'Not found' }, 404);
  const nav = {
    prev: q.get('SELECT id FROM activities WHERE start_time < ? ORDER BY start_time DESC LIMIT 1', a.startTime)?.id ?? null,
    next: q.get('SELECT id FROM activities WHERE start_time > ? ORDER BY start_time ASC LIMIT 1', a.startTime)?.id ?? null,
  };
  const planned = a.plannedId ? q.get('SELECT * FROM planned_workouts WHERE id = ?', a.plannedId) : null;
  return c.json({
    ...a,
    curves: getCurves(id),
    streams: loadStreams(id),
    thresholds: thresholdsFor(a.localDate),
    nav,
    planned: planned ? rowToPlanned(planned) : null,
  });
});

api.patch('/activities/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json();
  const fields: Record<string, string> = { name: 'name', description: 'description', rpe: 'rpe', feel: 'feel', tssOverride: 'tss_override', trainer: 'trainer', commute: 'commute', sport: 'sport' };
  for (const [k, col] of Object.entries(fields)) {
    if (k in b) q.run(`UPDATE activities SET ${col} = ?, updated_at = datetime('now') WHERE id = ?`, typeof b[k] === 'boolean' ? Number(b[k]) : b[k], id);
  }
  if ('sport' in b) recalculate({ ids: [id] });
  return c.json(getActivity(id));
});

api.delete('/activities/:id', (c) => {
  const id = Number(c.req.param('id'));
  q.run('UPDATE planned_workouts SET activity_id = NULL WHERE activity_id = ?', id);
  q.run('DELETE FROM activities WHERE id = ?', id);
  return c.json({ ok: true });
});

// ---------- analytics ----------
const range = (c: { req: { query: (k: string) => string | undefined } }, days = 90) => ({
  from: c.req.query('from') ?? iso(subDays(new Date(), days)),
  to: c.req.query('to') ?? today(),
});

api.get('/pmc', (c) => {
  const { from, to } = range(c, 180);
  return c.json(pmc(from, to, c.req.query('sport') || null));
});

api.get('/daily', (c) => {
  const { from, to } = range(c, 365);
  return c.json(dailyLoads(from, to, c.req.query('sport') || null));
});

api.get('/curves', (c) => {
  const { from, to } = range(c, 90);
  const type = (c.req.query('type') ?? 'power') as CurveType;
  const sport = c.req.query('sport') ?? (type === 'speed' ? 'run' : type === 'hr' || type === 'vam' ? null : 'ride');
  return c.json(aggregateCurve(type, from, to, sport || null));
});

api.get('/model', (c) => {
  const { from, to } = range(c, 90);
  const m = powerModel(from, to);
  const th = thresholdsFor(to);
  return c.json({ ...m, weight: th.weight, ftp: th.ftp });
});

api.get('/model/history', (c) => {
  const { from, to } = range(c, 365);
  return c.json(modelHistory(from, to));
});

api.get('/trends', (c) => {
  const { from, to } = range(c, 365);
  return c.json(trends(from, to, c.req.query('bucket') === 'month' ? 'month' : 'week'));
});

api.get('/records', (c) => c.json(records()));

api.get('/heatmap', (c) => {
  const { from, to } = range(c, 3650);
  const sport = c.req.query('sport');
  const rows = q.all(
    `SELECT id, sport, name, local_date, polyline FROM activities WHERE polyline IS NOT NULL AND local_date BETWEEN ? AND ? ${sport ? 'AND sport = ?' : ''}`,
    from,
    to,
    ...(sport ? [sport] : []),
  );
  return c.json(rows);
});

api.get('/dashboard', (c) => {
  const t = today();
  const goal = q.get("SELECT date FROM events WHERE date >= ? ORDER BY CASE priority WHEN 'A' THEN 0 ELSE 1 END, date LIMIT 1", t);
  const horizon = [iso(addDays(new Date(), 21)), goal ? iso(addDays(parseISO(goal.date), 3)) : ''].sort().pop()!;
  const points = pmc(iso(subDays(new Date(), 120)), horizon);
  const todayPt = points.find((p) => p.date === t) ?? points[points.length - 1];
  const weekStart = getPreferences().weekStart;
  const now = new Date();
  const dow = (now.getDay() - weekStart + 7) % 7;
  const ws = iso(subDays(now, dow));
  const we = iso(addDays(parseISO(ws), 6));
  const week = q.get(
    'SELECT COUNT(*) AS n, SUM(moving_time) AS time, SUM(distance) AS distance, SUM(COALESCE(tss_override, tss)) AS tss FROM activities WHERE local_date BETWEEN ? AND ?',
    ws,
    we,
  );
  const weekPlanned = q.get('SELECT SUM(planned_tss) AS tss, SUM(planned_duration) AS time, COUNT(*) AS n FROM planned_workouts WHERE date BETWEEN ? AND ?', ws, we);
  const recent = q.all(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities ORDER BY start_time DESC LIMIT 6`).map(rowToActivity);
  const upcoming = q.all('SELECT * FROM planned_workouts WHERE date >= ? AND activity_id IS NULL ORDER BY date, sort_order LIMIT 6', t).map(rowToPlanned);
  const nextEvent = q.get('SELECT * FROM events WHERE date >= ? ORDER BY CASE priority WHEN \'A\' THEN 0 ELSE 1 END, date LIMIT 1', t);
  const nextAny = q.all('SELECT * FROM events WHERE date >= ? ORDER BY date LIMIT 3', t).map(rowToEvent);
  const eventPoint = nextEvent ? points.find((p) => p.date === nextEvent.date) ?? null : null;
  const model = powerModel(iso(subDays(new Date(), 90)), t).model;
  return c.json({
    today: todayPt,
    form: todayPt ? formZone(todayPt.tsb, todayPt.ctl) : null,
    pmc: points,
    week: { ...week, planned: weekPlanned, start: ws, end: we },
    recent,
    upcoming,
    events: nextAny,
    nextEvent: nextEvent ? { ...rowToEvent(nextEvent), projected: eventPoint } : null,
    model,
    thresholds: thresholdsFor(t),
    weekly: trends(iso(subDays(new Date(), 7 * 16)), t, 'week').map((b) => ({ start: b.start, sports: b.sports })),
  });
});

// ---------- calendar & planning ----------
api.get('/calendar', (c) => {
  const { from, to } = range(c, 35);
  const acts = q.all(`SELECT ${ACTIVITY_LIST_COLUMNS} FROM activities WHERE local_date BETWEEN ? AND ? ORDER BY start_time`, from, to).map(rowToActivity);
  const planned = q.all('SELECT * FROM planned_workouts WHERE date BETWEEN ? AND ? ORDER BY date, sort_order', from, to).map(rowToPlanned);
  const events = q.all('SELECT * FROM events WHERE date BETWEEN ? AND ? ORDER BY date', from, to).map(rowToEvent);
  const plan = q.get('SELECT * FROM season_plans ORDER BY id DESC LIMIT 1');
  const weeks = plan ? rowToPlan(plan).weeks.filter((w) => w.weekStart >= iso(subDays(parseISO(from), 6)) && w.weekStart <= to) : [];
  return c.json({ activities: acts.map(({ laps, ...a }) => a), planned, events, planWeeks: weeks, pmc: pmc(from, to) });
});

function plannedMetrics(structure: WorkoutStructure | null, fallback: { duration?: number | null; tss?: number | null; if?: number | null }) {
  if (!structure) return { duration: fallback.duration ?? null, tss: fallback.tss ?? null, if: fallback.if ?? null };
  const m = workoutMetrics(structure);
  return { duration: m.duration, tss: Math.round(m.tss), if: Math.round(m.if * 1000) / 1000 };
}

api.get('/planned', (c) => {
  const { from, to } = range(c, 30);
  return c.json(q.all('SELECT * FROM planned_workouts WHERE date BETWEEN ? AND ? ORDER BY date, sort_order', from, to).map(rowToPlanned));
});

api.post('/planned', async (c) => {
  const b = await c.req.json();
  const m = plannedMetrics(b.structure ?? null, { duration: b.plannedDuration, tss: b.plannedTss, if: b.plannedIf });
  const res = q.run(
    `INSERT INTO planned_workouts(date, sport, title, description, structure, planned_duration, planned_distance, planned_tss, planned_if, sort_order)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM planned_workouts WHERE date = ?))`,
    b.date,
    b.sport ?? 'ride',
    b.title ?? 'Workout',
    b.description ?? null,
    b.structure ? JSON.stringify(b.structure) : null,
    m.duration,
    b.plannedDistance ?? null,
    m.tss,
    m.if,
    b.date,
  );
  const id = Number(res.lastInsertRowid);
  // link to an existing same-day activity
  const act = q.get('SELECT id FROM activities WHERE local_date = ? AND sport = ? AND planned_id IS NULL LIMIT 1', b.date, b.sport ?? 'ride');
  if (act) linkPlanned(act.id);
  return c.json(rowToPlanned(q.get('SELECT * FROM planned_workouts WHERE id = ?', id)!));
});

api.patch('/planned/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json();
  const cur = q.get('SELECT * FROM planned_workouts WHERE id = ?', id);
  if (!cur) return c.json({ error: 'Not found' }, 404);
  const next = { ...rowToPlanned(cur), ...b };
  const m = 'structure' in b || 'plannedTss' in b || 'plannedDuration' in b ? plannedMetrics(next.structure, { duration: next.plannedDuration, tss: next.plannedTss, if: next.plannedIf }) : { duration: next.plannedDuration, tss: next.plannedTss, if: next.plannedIf };
  if ('date' in b && b.date !== cur.date && cur.activity_id) {
    q.run('UPDATE activities SET planned_id = NULL WHERE id = ?', cur.activity_id);
    next.activityId = null;
  }
  q.run(
    `UPDATE planned_workouts SET date = ?, sport = ?, title = ?, description = ?, structure = ?, planned_duration = ?, planned_distance = ?,
     planned_tss = ?, planned_if = ?, sort_order = ?, activity_id = ? WHERE id = ?`,
    next.date,
    next.sport,
    next.title,
    next.description,
    next.structure ? JSON.stringify(next.structure) : null,
    m.duration,
    next.plannedDistance,
    m.tss,
    m.if,
    next.sortOrder,
    next.activityId,
    id,
  );
  if ('date' in b) {
    const act = q.get('SELECT id FROM activities WHERE local_date = ? AND sport = ? AND planned_id IS NULL LIMIT 1', next.date, next.sport);
    if (act) linkPlanned(act.id);
  }
  return c.json(rowToPlanned(q.get('SELECT * FROM planned_workouts WHERE id = ?', id)!));
});

api.delete('/planned/:id', (c) => {
  const id = Number(c.req.param('id'));
  q.run('UPDATE activities SET planned_id = NULL WHERE planned_id = ?', id);
  q.run('DELETE FROM planned_workouts WHERE id = ?', id);
  return c.json({ ok: true });
});

// ---------- workout library ----------
function ensureBuiltins() {
  for (const w of BUILTIN_WORKOUTS) {
    q.run(
      `INSERT INTO workout_templates(name, sport, category, description, structure, builtin_key) VALUES(?, ?, ?, ?, ?, ?)
       ON CONFLICT(builtin_key) DO UPDATE SET name = excluded.name, description = excluded.description, structure = excluded.structure, category = excluded.category`,
      w.name,
      w.sport,
      w.category,
      w.description,
      JSON.stringify(w.structure),
      w.key,
    );
  }
}
ensureBuiltins();

api.get('/templates', (c) => c.json(q.all('SELECT * FROM workout_templates ORDER BY builtin_key IS NOT NULL, sport, category, name').map(rowToTemplate)));
api.post('/templates', async (c) => {
  const b = await c.req.json();
  const res = q.run(
    'INSERT INTO workout_templates(name, sport, category, description, structure) VALUES(?, ?, ?, ?, ?)',
    b.name,
    b.sport ?? 'ride',
    b.category ?? 'Custom',
    b.description ?? '',
    JSON.stringify(b.structure),
  );
  return c.json(rowToTemplate(q.get('SELECT * FROM workout_templates WHERE id = ?', Number(res.lastInsertRowid))!));
});
api.put('/templates/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json();
  q.run('UPDATE workout_templates SET name = ?, sport = ?, category = ?, description = ?, structure = ? WHERE id = ? AND builtin_key IS NULL', b.name, b.sport, b.category, b.description, JSON.stringify(b.structure), id);
  return c.json(rowToTemplate(q.get('SELECT * FROM workout_templates WHERE id = ?', id)!));
});
api.delete('/templates/:id', (c) => {
  q.run('DELETE FROM workout_templates WHERE id = ? AND builtin_key IS NULL', Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---------- events ----------
api.get('/events', (c) => c.json(q.all('SELECT * FROM events ORDER BY date').map(rowToEvent)));
api.post('/events', async (c) => {
  const b = await c.req.json();
  const res = q.run('INSERT INTO events(date, name, sport, priority, description, target_ctl) VALUES(?, ?, ?, ?, ?, ?)', b.date, b.name, b.sport ?? 'ride', b.priority ?? 'B', b.description ?? null, b.targetCtl ?? null);
  return c.json(rowToEvent(q.get('SELECT * FROM events WHERE id = ?', Number(res.lastInsertRowid))!));
});
api.patch('/events/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const cur = q.get('SELECT * FROM events WHERE id = ?', id);
  if (!cur) return c.json({ error: 'Not found' }, 404);
  const n = { ...rowToEvent(cur), ...(await c.req.json()) };
  q.run('UPDATE events SET date = ?, name = ?, sport = ?, priority = ?, description = ?, target_ctl = ? WHERE id = ?', n.date, n.name, n.sport, n.priority, n.description, n.targetCtl, id);
  return c.json(n);
});
api.delete('/events/:id', (c) => {
  q.run('DELETE FROM events WHERE id = ?', Number(c.req.param('id')));
  return c.json({ ok: true });
});

// ---------- season plans ----------
api.get('/plans', (c) => c.json(q.all('SELECT * FROM season_plans ORDER BY id DESC').map(rowToPlan)));

api.get('/plans/defaults', (c) => {
  const t = today();
  const pt = pmc(iso(subDays(new Date(), 1)), t).pop();
  const aRace = q.get("SELECT * FROM events WHERE date > ? AND priority = 'A' ORDER BY date LIMIT 1", t);
  return c.json({
    startDate: t,
    raceDate: aRace?.date ?? iso(addDays(new Date(), 16 * 7)),
    startCtl: Math.round(pt?.ctl ?? 40),
    startAtl: Math.round(pt?.atl ?? 40),
    targetCtl: Math.round((pt?.ctl ?? 40) + 20),
    maxRamp: 5,
    pattern: '3:1',
    taperWeeks: 2,
    maxWeeklyHours: 12,
    sport: 'ride',
    eventId: aRace?.id ?? null,
  });
});

api.post('/plans/preview', async (c) => {
  const cfg = (await c.req.json()) as SeasonPlanConfig;
  const events = q.all('SELECT * FROM events WHERE date BETWEEN ? AND ?', cfg.startDate, cfg.raceDate).map(rowToEvent);
  const prefs = getPreferences();
  return c.json(generateSeasonPlan(cfg, events, prefs.ctlDays, prefs.atlDays));
});

api.post('/plans', async (c) => {
  const b = (await c.req.json()) as { name: string; config: SeasonPlanConfig; eventId?: number | null };
  const events = q.all('SELECT * FROM events WHERE date BETWEEN ? AND ?', b.config.startDate, b.config.raceDate).map(rowToEvent);
  const prefs = getPreferences();
  const weeks = generateSeasonPlan(b.config, events, prefs.ctlDays, prefs.atlDays);
  const res = q.run('INSERT INTO season_plans(name, config, weeks, event_id) VALUES(?, ?, ?, ?)', b.name || 'Season plan', JSON.stringify(b.config), JSON.stringify(weeks), b.eventId ?? null);
  return c.json(rowToPlan(q.get('SELECT * FROM season_plans WHERE id = ?', Number(res.lastInsertRowid))!));
});

api.delete('/plans/:id', (c) => {
  const id = Number(c.req.param('id'));
  q.run('DELETE FROM planned_workouts WHERE plan_id = ? AND activity_id IS NULL', id);
  q.run('DELETE FROM season_plans WHERE id = ?', id);
  return c.json({ ok: true });
});

/** Fill the calendar with generated workouts for the plan's weeks (from a given week onward). */
api.post('/plans/:id/apply', async (c) => {
  const id = Number(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  const row = q.get('SELECT * FROM season_plans WHERE id = ?', id);
  if (!row) return c.json({ error: 'Not found' }, 404);
  const plan = rowToPlan(row);
  const from = b.from ?? today();
  const weeks = plan.weeks.filter((w) => iso(addDays(parseISO(w.weekStart), 6)) >= from).slice(0, b.weeks ?? 4);
  let created = 0;
  transaction(() => {
    q.run('DELETE FROM planned_workouts WHERE plan_id = ? AND date >= ? AND activity_id IS NULL', id, from);
    for (const w of weeks) {
      for (const g of generateWeekWorkouts(w)) {
        if (g.date < from) continue;
        q.run(
          `INSERT INTO planned_workouts(date, sport, title, description, structure, planned_duration, planned_tss, planned_if, plan_id, sort_order)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 10)`,
          g.date,
          g.sport,
          g.title,
          g.description,
          JSON.stringify(g.structure),
          g.duration,
          g.tss,
          g.if,
          id,
        );
        created++;
      }
    }
  });
  return c.json({ created });
});

// ---------- import ----------
api.post('/import', async (c) => {
  const form = await c.req.formData();
  const results = [];
  for (const [, v] of form.entries()) {
    if (typeof v === 'string') continue;
    const f = v as File;
    results.push(...(await importFile(f.name, new Uint8Array(await f.arrayBuffer()))));
  }
  return c.json(results);
});

// ---------- demo ----------
api.post('/demo', async (c) => {
  runJob('demo', (progress) => loadDemo((m) => progress(0, m))).catch((e) => console.error(e));
  return c.json({ started: true });
});
api.delete('/demo', (c) => {
  clearDemo();
  return c.json({ ok: true });
});

// ---------- sync & auth ----------
api.post('/sync', (c) => {
  syncNow();
  return c.json({ ok: true });
});
api.get('/sync/log', (c) => c.json(q.all('SELECT * FROM sync_log ORDER BY id DESC LIMIT 100')));

const oauthStates = new Map<string, number>();
const newState = () => {
  const s = randomBytes(12).toString('hex');
  oauthStates.set(s, Date.now());
  return s;
};
const checkState = (s: string | undefined) => {
  const ok = !!s && oauthStates.has(s) && Date.now() - oauthStates.get(s)! < 15 * 60_000;
  if (s) oauthStates.delete(s);
  return ok;
};

api.get('/auth/strava/start', (c) => {
  if (!stravaConfigured()) return c.redirect('/settings?error=strava-not-configured');
  return c.redirect(stravaAuthUrl(newState()));
});
api.get('/auth/strava/callback', async (c) => {
  const { code, scope, state, error } = c.req.query();
  if (error || !code || !checkState(state)) return c.redirect(`/settings?error=${encodeURIComponent(error ?? 'strava-auth-failed')}`);
  if (!scope?.includes('activity:read')) return c.redirect('/settings?error=strava-scope');
  await stravaExchangeCode(code, scope);
  return c.redirect('/settings?connected=strava');
});
api.post('/auth/strava/disconnect', (c) => {
  stravaDisconnect();
  return c.json({ ok: true });
});
api.post('/webhooks/strava/subscribe', async (c) => c.json({ id: await stravaWebhookSubscribe() }));
api.get('/webhooks/strava', (c) => {
  const mode = c.req.query('hub.mode');
  const token = c.req.query('hub.verify_token');
  const challenge = c.req.query('hub.challenge');
  if (mode === 'subscribe' && token === config.strava.verifyToken) return c.json({ 'hub.challenge': challenge });
  return c.json({ error: 'forbidden' }, 403);
});
api.post('/webhooks/strava', async (c) => {
  const ev = await c.req.json();
  const conn = q.get("SELECT athlete_id FROM connections WHERE provider = 'strava'");
  if (conn && String(ev.owner_id) === conn.athlete_id) stravaHandleWebhook(ev);
  return c.json({ ok: true });
});

api.get('/auth/trainingpeaks/start', (c) => {
  if (!tpConfigured()) return c.redirect('/settings?error=trainingpeaks-not-configured');
  return c.redirect(tpAuthUrl(newState()));
});
api.get('/auth/trainingpeaks/callback', async (c) => {
  const { code, state, error } = c.req.query();
  if (error || !code || !checkState(state)) return c.redirect(`/settings?error=${encodeURIComponent(error ?? 'trainingpeaks-auth-failed')}`);
  await tpExchangeCode(code);
  return c.redirect('/settings?connected=trainingpeaks');
});
api.post('/auth/trainingpeaks/disconnect', (c) => {
  tpDisconnect();
  return c.json({ ok: true });
});

