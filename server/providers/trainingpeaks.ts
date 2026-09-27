/**
 * TrainingPeaks Partner API client.
 *
 * TrainingPeaks' API is only available to approved partners
 * (https://github.com/TrainingPeaks/PartnersAPI/wiki). Once you have client credentials,
 * set TRAININGPEAKS_CLIENT_ID / TRAININGPEAKS_CLIENT_SECRET and connect from Settings.
 * Without API access, export your history from TrainingPeaks ("Export Workout Files")
 * and drop the ZIP on the Import screen — it goes through the same analytics pipeline.
 */
import { addDays, format, subDays } from 'date-fns';
import { config } from '../config';
import { log, q } from '../db';
import { saveActivity } from '../ingest';
import { parseFit } from '../importers/files';
import { gunzipSync } from 'fflate';
import type { Sport } from '../../shared/types';
import { RateLimitError, enqueue } from '../queue';

const hosts = () =>
  config.trainingPeaks.sandbox
    ? { oauth: 'https://oauth.sandbox.trainingpeaks.com', api: 'https://api.sandbox.trainingpeaks.com' }
    : { oauth: 'https://oauth.trainingpeaks.com', api: 'https://api.trainingpeaks.com' };

const SCOPES = 'athlete:profile workouts:read workouts:details workouts:plan';
const redirectUri = () => `${config.publicUrl}/api/auth/trainingpeaks/callback`;

export function tpAuthUrl(state: string): string {
  const u = new URL(`${hosts().oauth}/OAuth/Authorize`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.trainingPeaks.clientId);
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  return u.toString();
}

async function token(params: Record<string, string>) {
  const res = await fetch(`${hosts().oauth}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.trainingPeaks.clientId, client_secret: config.trainingPeaks.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`TrainingPeaks token error ${res.status}: ${await res.text()}`);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; scope?: string };
}

export async function tpExchangeCode(code: string) {
  const t = await token({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
  q.run(
    `INSERT INTO connections(provider, access_token, refresh_token, expires_at, scope, last_error) VALUES('trainingpeaks', ?, ?, ?, ?, NULL)
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
     expires_at = excluded.expires_at, scope = excluded.scope, last_error = NULL`,
    t.access_token,
    t.refresh_token,
    Math.floor(Date.now() / 1000) + t.expires_in,
    t.scope ?? SCOPES,
  );
  log('trainingpeaks', 'info', 'Connected TrainingPeaks');
  enqueue('trainingpeaks', 'profile', 'me', null, 10);
  enqueue('trainingpeaks', 'range', 'backfill', { days: 365 }, 9);
}

async function accessToken(): Promise<string> {
  const c = q.get("SELECT * FROM connections WHERE provider = 'trainingpeaks'");
  if (!c?.refresh_token) throw new Error('TrainingPeaks is not connected');
  if (c.expires_at - 300 > Date.now() / 1000) return c.access_token;
  const t = await token({ grant_type: 'refresh_token', refresh_token: c.refresh_token });
  q.run(
    "UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE provider = 'trainingpeaks'",
    t.access_token,
    t.refresh_token ?? c.refresh_token,
    Math.floor(Date.now() / 1000) + t.expires_in,
  );
  return t.access_token;
}

async function api(path: string, accept = 'application/json'): Promise<Response> {
  const res = await fetch(hosts().api + path, { headers: { Authorization: `Bearer ${await accessToken()}`, Accept: accept } });
  if (res.status === 429) {
    const retry = Number(res.headers.get('retry-after') ?? 60);
    throw new RateLimitError(Date.now() + retry * 1000);
  }
  if (!res.ok) throw new Error(`TrainingPeaks ${path} → ${res.status}`);
  return res;
}

function mapTpSport(t: string | undefined): Sport {
  const v = (t ?? '').toLowerCase();
  if (v.includes('bike') || v.includes('mtb') || v.includes('cycl')) return 'ride';
  if (v.includes('run')) return 'run';
  if (v.includes('swim')) return 'swim';
  if (v.includes('walk')) return 'walk';
  if (v.includes('strength')) return 'strength';
  if (v.includes('ski')) return 'ski';
  if (v.includes('row')) return 'row';
  return 'other';
}

interface TpWorkout {
  Id: number;
  WorkoutDay: string;
  StartTime?: string;
  Title?: string;
  WorkoutType?: string;
  Description?: string;
  Completed?: boolean;
  TotalTime?: number; // hours
  TotalTimePlanned?: number;
  Distance?: number;
  DistancePlanned?: number;
  TssActual?: number;
  TssPlanned?: number;
  IFPlanned?: number;
  IF?: number;
  PowerAverage?: number;
  NormalizedPower?: number;
  HeartRateAverage?: number;
  VelocityAverage?: number;
  ElevationGain?: number;
  Energy?: number;
  Calories?: number;
}

export async function tpSyncProfile() {
  const p = (await (await api('/v1/athlete/profile')).json()) as { FirstName?: string; LastName?: string; Id?: number };
  q.run(
    "UPDATE connections SET athlete_name = ?, athlete_id = ? WHERE provider = 'trainingpeaks'",
    `${p.FirstName ?? ''} ${p.LastName ?? ''}`.trim() || null,
    p.Id != null ? String(p.Id) : null,
  );
}

/** Sync completed + planned workouts in a date window (default: last 14 days to +42 days). */
export async function tpSyncRange(payload: { days?: number; ahead?: number } | null) {
  const back = payload?.days ?? 14;
  const ahead = payload?.ahead ?? 42;
  const today = new Date();
  // the API limits ranges to ~90 days; walk in chunks
  let from = subDays(today, back);
  const end = addDays(today, ahead);
  let count = 0;
  while (from < end) {
    const to = new Date(Math.min(addDays(from, 89).getTime(), end.getTime()));
    const res = await api(`/v2/workouts/${format(from, 'yyyy-MM-dd')}/${format(to, 'yyyy-MM-dd')}`).catch(async (e) => {
      if (String(e.message).includes('404')) return api(`/v1/workouts/${format(from, 'yyyy-MM-dd')}/${format(to, 'yyyy-MM-dd')}`);
      throw e;
    });
    const list = (await res.json()) as TpWorkout[];
    for (const w of list) {
      count++;
      const done = w.Completed ?? (w.TotalTime != null && w.TotalTime > 0);
      if (done) {
        const exists = q.get("SELECT detailed FROM activities WHERE source = 'trainingpeaks' AND external_id = ?", String(w.Id));
        if (!exists) saveTpSummary(w);
        if (!exists?.detailed) enqueue('trainingpeaks', 'file', String(w.Id), { day: w.WorkoutDay, title: w.Title, type: w.WorkoutType, start: w.StartTime }, 2, Date.parse(w.WorkoutDay));
      } else savePlanned(w);
    }
    from = addDays(to, 1);
  }
  q.run("UPDATE connections SET last_sync_at = ?, last_error = NULL WHERE provider = 'trainingpeaks'", new Date().toISOString());
  log('trainingpeaks', 'info', `Synced ${count} workouts`);
}

function saveTpSummary(w: TpWorkout) {
  const sport = mapTpSport(w.WorkoutType);
  const secs = Math.round((w.TotalTime ?? 0) * 3600);
  const start = w.StartTime ? new Date(w.StartTime) : new Date(w.WorkoutDay);
  saveActivity({
    source: 'trainingpeaks',
    externalId: String(w.Id),
    name: w.Title || `${w.WorkoutType ?? 'Workout'}`,
    sport,
    startTime: start.toISOString(),
    localDate: w.WorkoutDay.slice(0, 10),
    description: w.Description ?? null,
    summary: {
      sport,
      elapsedTime: secs,
      movingTime: secs,
      distance: w.Distance ?? null,
      avgPower: w.PowerAverage ?? null,
      weightedPower: w.NormalizedPower ?? null,
      avgHr: w.HeartRateAverage ?? null,
      avgSpeed: w.VelocityAverage ?? null,
      elevationGain: w.ElevationGain ?? null,
      work: w.Energy ?? null,
      calories: w.Calories ?? null,
      tss: w.TssActual ?? null,
      intensity: w.IF ?? null,
    },
  });
}

function savePlanned(w: TpWorkout) {
  q.run(
    `INSERT INTO planned_workouts(date, sport, title, description, planned_duration, planned_distance, planned_tss, planned_if, source, external_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'trainingpeaks', ?)
     ON CONFLICT(source, external_id) DO UPDATE SET date = excluded.date, sport = excluded.sport, title = excluded.title,
       description = excluded.description, planned_duration = excluded.planned_duration, planned_distance = excluded.planned_distance,
       planned_tss = excluded.planned_tss, planned_if = excluded.planned_if`,
    w.WorkoutDay.slice(0, 10),
    mapTpSport(w.WorkoutType),
    w.Title || 'Planned workout',
    w.Description ?? null,
    w.TotalTimePlanned ? Math.round(w.TotalTimePlanned * 3600) : null,
    w.DistancePlanned ?? null,
    w.TssPlanned ?? null,
    w.IFPlanned ?? null,
    String(w.Id),
  );
}

/** Download the device file for a completed workout and run it through the full pipeline. */
export async function tpSyncFile(id: string, meta: { day: string; title?: string; type?: string } | null) {
  const athlete = q.get("SELECT athlete_id FROM connections WHERE provider = 'trainingpeaks'")?.athlete_id;
  const paths = [`/v1/workouts/${id}/fitfile`, athlete ? `/v1/workouts/${athlete}/id/${id}/fitfile` : null].filter(Boolean) as string[];
  let bytes: Uint8Array | null = null;
  for (const p of paths) {
    try {
      const res = await api(p, 'application/octet-stream');
      bytes = new Uint8Array(await res.arrayBuffer());
      break;
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
    }
  }
  if (!bytes?.length) return; // summary-only workout (manual entry)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = gunzipSync(bytes);
  const input = await parseFit(bytes);
  saveActivity({
    ...input,
    source: 'trainingpeaks',
    externalId: id,
    name: meta?.title || input.name,
    sport: meta?.type ? mapTpSport(meta.type) : input.sport,
    localDate: meta?.day?.slice(0, 10) ?? input.localDate,
  });
}

export function tpDisconnect() {
  q.run("DELETE FROM connections WHERE provider = 'trainingpeaks'");
  q.run("DELETE FROM sync_queue WHERE provider = 'trainingpeaks'");
}
