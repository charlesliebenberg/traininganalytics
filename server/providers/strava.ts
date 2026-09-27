import { config, stravaConfigured } from '../config';
import { log, q, upsertThresholds, listThresholds, DEFAULT_THRESHOLDS } from '../db';
import { saveActivity, type LapInput } from '../ingest';
import { normalizeStreams } from '../../shared/analytics/metrics';
import type { Sport } from '../../shared/types';
import { RateLimitError, enqueue } from '../queue';

const API = 'https://www.strava.com/api/v3';
const SCOPES = 'read,activity:read_all,profile:read_all';

export function stravaAuthUrl(state: string): string {
  const u = new URL('https://www.strava.com/oauth/authorize');
  u.searchParams.set('client_id', config.strava.clientId);
  u.searchParams.set('redirect_uri', `${config.publicUrl}/api/auth/strava/callback`);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('approval_prompt', 'auto');
  u.searchParams.set('scope', SCOPES);
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: config.strava.clientId, client_secret: config.strava.clientSecret, ...params }),
  });
  if (!res.ok) throw new Error(`Strava token error ${res.status}: ${await res.text()}`);
  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
    scope?: string;
    athlete?: { id: number; firstname: string; lastname: string };
  };
}

export async function stravaExchangeCode(code: string, scope: string | null) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code' });
  q.run(
    `INSERT INTO connections(provider, access_token, refresh_token, expires_at, athlete_id, athlete_name, scope, last_error)
     VALUES('strava', ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, athlete_id = excluded.athlete_id, athlete_name = excluded.athlete_name, scope = excluded.scope, last_error = NULL`,
    t.access_token,
    t.refresh_token,
    t.expires_at,
    String(t.athlete?.id ?? ''),
    t.athlete ? `${t.athlete.firstname} ${t.athlete.lastname}`.trim() : null,
    scope,
  );
  log('strava', 'info', `Connected Strava athlete ${t.athlete?.firstname ?? ''}`);
  enqueue('strava', 'athlete', 'me', null, 10);
  enqueue('strava', 'list', 'backfill', { page: 1 }, 9);
}

async function accessToken(): Promise<string> {
  const c = q.get("SELECT * FROM connections WHERE provider = 'strava'");
  if (!c?.refresh_token) throw new Error('Strava is not connected');
  if (c.expires_at && c.expires_at - 300 > Date.now() / 1000) return c.access_token;
  const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refresh_token });
  q.run("UPDATE connections SET access_token = ?, refresh_token = ?, expires_at = ? WHERE provider = 'strava'", t.access_token, t.refresh_token, t.expires_at);
  return t.access_token;
}

/** Strava rate-limit state parsed from response headers. */
const rate = { usage15: 0, limit15: 100, usageDay: 0, limitDay: 1000 };

function nextQuarterHour(): number {
  const now = Date.now();
  return Math.ceil(now / 900_000) * 900_000 + 5_000;
}

async function api<T>(path: string): Promise<T> {
  const token = await accessToken();
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
  const usage = res.headers.get('x-readratelimit-usage') ?? res.headers.get('x-ratelimit-usage');
  const limit = res.headers.get('x-readratelimit-limit') ?? res.headers.get('x-ratelimit-limit');
  if (usage && limit) {
    [rate.usage15, rate.usageDay] = usage.split(',').map(Number);
    [rate.limit15, rate.limitDay] = limit.split(',').map(Number);
  }
  if (res.status === 429) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 30, 0);
    throw new RateLimitError(rate.usageDay >= rate.limitDay ? tomorrow.getTime() : nextQuarterHour());
  }
  if (res.status === 401) {
    q.run("UPDATE connections SET last_error = ? WHERE provider = 'strava'", 'Authorization expired — please reconnect');
    throw new Error('Strava authorization failed (401)');
  }
  if (!res.ok) throw new Error(`Strava ${path} → ${res.status}`);
  return (await res.json()) as T;
}

/** Pause proactively when close to the 15-minute read limit. */
export function stravaThrottleUntil(): number | null {
  if (rate.usage15 >= rate.limit15 - 3) return nextQuarterHour();
  return null;
}

export function mapStravaSport(t: string): Sport {
  if (/Ride|Velomobile|Handcycle|Wheelchair/.test(t)) return 'ride';
  if (/Run/.test(t)) return 'run';
  if (/Swim/.test(t)) return 'swim';
  if (t === 'Walk') return 'walk';
  if (/Hike|Snowshoe/.test(t)) return 'hike';
  if (/WeightTraining|Crossfit|Workout|HighIntensityIntervalTraining|Pilates|Yoga|StairStepper|Elliptical/.test(t)) return 'strength';
  if (/Ski|Snowboard/.test(t)) return 'ski';
  if (/Row|Canoe|Kayak|StandUpPaddling/.test(t)) return 'row';
  return 'other';
}

interface StravaSummary {
  id: number;
  name: string;
  sport_type?: string;
  type: string;
  start_date: string;
  start_date_local: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  total_elevation_gain: number;
  average_watts?: number;
  weighted_average_watts?: number;
  max_watts?: number;
  kilojoules?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  average_speed?: number;
  max_speed?: number;
  average_temp?: number;
  trainer?: boolean;
  commute?: boolean;
  device_watts?: boolean;
  map?: { summary_polyline?: string; polyline?: string };
  description?: string;
  device_name?: string;
  calories?: number;
  laps?: { name: string; elapsed_time: number; start_index: number; start_date: string }[];
  perceived_exertion?: number;
}

function summaryInput(a: StravaSummary) {
  const sport = mapStravaSport(a.sport_type ?? a.type);
  return {
    source: 'strava' as const,
    externalId: String(a.id),
    name: a.name,
    sport,
    startTime: new Date(a.start_date).toISOString(),
    localDate: a.start_date_local.slice(0, 10),
    trainer: !!a.trainer || /Virtual/.test(a.sport_type ?? a.type),
    commute: !!a.commute,
    description: a.description ?? null,
    device: a.device_name ?? null,
    rpe: a.perceived_exertion ?? null,
    summary: {
      sport,
      elapsedTime: a.elapsed_time,
      movingTime: a.moving_time,
      distance: a.distance || null,
      avgPower: a.device_watts || a.average_watts ? a.average_watts ?? null : null,
      weightedPower: a.weighted_average_watts ?? null,
      maxPower: a.max_watts ?? null,
      avgHr: a.average_heartrate ?? null,
      maxHr: a.max_heartrate ?? null,
      avgCadence: a.average_cadence ?? null,
      avgSpeed: a.average_speed ?? null,
      maxSpeed: a.max_speed ?? null,
      elevationGain: a.total_elevation_gain ?? null,
      work: a.kilojoules ?? null,
      calories: a.calories ?? null,
      polyline: a.map?.summary_polyline || null,
      avgTemp: a.average_temp ?? null,
    },
  };
}

/** Page through the athlete's activity list, storing summaries and queueing detail fetches. */
export async function stravaSyncList(payload: { page?: number; after?: number } | null): Promise<void> {
  const page = payload?.page ?? 1;
  const conn = q.get("SELECT cursor FROM connections WHERE provider = 'strava'");
  const after = payload?.after ?? (conn?.cursor ? Number(conn.cursor) : undefined);
  const params = new URLSearchParams({ page: String(page), per_page: '100' });
  if (after) params.set('after', String(after));
  const list = await api<StravaSummary[]>(`/athlete/activities?${params}`);
  let newest = after ?? 0;
  for (const a of list) {
    const existing = q.get("SELECT id, detailed FROM activities WHERE source = 'strava' AND external_id = ?", String(a.id));
    if (!existing) saveActivity(summaryInput(a));
    if (!existing?.detailed) enqueue('strava', 'detail', String(a.id), null, after ? 5 : 1, Date.parse(a.start_date));
    newest = Math.max(newest, Math.floor(Date.parse(a.start_date) / 1000));
  }
  if (list.length === 100) enqueue('strava', 'list', `${after ? 'after' : 'backfill'}-${page + 1}`, { page: page + 1, after }, 8);
  // advance cursor to newest seen (a day of overlap guards against late uploads)
  if (newest) {
    const cur = conn?.cursor ? Number(conn.cursor) : 0;
    const next = Math.max(cur, newest - 86400);
    q.run("UPDATE connections SET cursor = ?, last_sync_at = ?, last_error = NULL WHERE provider = 'strava'", String(next), new Date().toISOString());
  } else q.run("UPDATE connections SET last_sync_at = ?, last_error = NULL WHERE provider = 'strava'", new Date().toISOString());
  if (list.length) log('strava', 'info', `Listed ${list.length} activities (page ${page})`);
}

type StreamSet = Record<string, { data: unknown[] } | undefined>;

/** Fetch full detail + streams for an activity and compute analytics. */
export async function stravaSyncDetail(id: string): Promise<void> {
  const detail = await api<StravaSummary>(`/activities/${id}?include_all_efforts=false`);
  let streams: StreamSet = {};
  try {
    streams = await api<StreamSet>(
      `/activities/${id}/streams?keys=time,latlng,distance,altitude,velocity_smooth,heartrate,cadence,watts,temp,moving,grade_smooth&key_by_type=true`,
    );
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    // manual activities have no streams
  }
  const input = summaryInput(detail);
  const time = streams.time?.data as number[] | undefined;
  let normalized = null;
  if (time && time.length > 1) {
    const latlng = streams.latlng?.data as [number, number][] | undefined;
    normalized = normalizeStreams({
      time,
      watts: streams.watts?.data as number[] | undefined,
      heartrate: streams.heartrate?.data as number[] | undefined,
      cadence: streams.cadence?.data as number[] | undefined,
      speed: streams.velocity_smooth?.data as number[] | undefined,
      distance: streams.distance?.data as number[] | undefined,
      altitude: streams.altitude?.data as number[] | undefined,
      lat: latlng?.map((p) => p[0]),
      lng: latlng?.map((p) => p[1]),
      temp: streams.temp?.data as number[] | undefined,
      grade: streams.grade_smooth?.data as number[] | undefined,
      moving: streams.moving?.data as boolean[] | undefined,
    });
  }
  let laps: LapInput[] | null = null;
  if (detail.laps && time) {
    const t0 = Date.parse(detail.start_date);
    laps = detail.laps.map((l) => ({ name: l.name, start: Math.max(0, Math.round((Date.parse(l.start_date) - t0) / 1000)), duration: l.elapsed_time }));
  }
  saveActivity({ ...input, streams: normalized, laps, raw: undefined });
}

export async function stravaSyncAthlete(): Promise<void> {
  const a = await api<{ firstname: string; lastname: string; ftp?: number; weight?: number }>('/athlete');
  q.run("UPDATE connections SET athlete_name = ? WHERE provider = 'strava'", `${a.firstname} ${a.lastname}`.trim());
  // seed thresholds from the Strava profile if the user hasn't configured any
  if (!listThresholds().length && (a.ftp || a.weight)) {
    upsertThresholds({ ...DEFAULT_THRESHOLDS, ftp: a.ftp || DEFAULT_THRESHOLDS.ftp, weight: a.weight || DEFAULT_THRESHOLDS.weight });
    log('strava', 'info', 'Imported FTP / weight from Strava profile');
  }
}

export function stravaDisconnect() {
  const c = q.get("SELECT access_token FROM connections WHERE provider = 'strava'");
  if (c?.access_token)
    fetch('https://www.strava.com/oauth/deauthorize', { method: 'POST', headers: { Authorization: `Bearer ${c.access_token}` } }).catch(() => {});
  q.run("DELETE FROM connections WHERE provider = 'strava'");
  q.run("DELETE FROM sync_queue WHERE provider = 'strava'");
}

// ---------- webhooks ----------
export async function stravaWebhookSubscribe(): Promise<string> {
  if (!stravaConfigured()) throw new Error('Strava client is not configured');
  const existing = await fetch(
    `${API}/push_subscriptions?client_id=${config.strava.clientId}&client_secret=${config.strava.clientSecret}`,
  ).then((r) => r.json() as Promise<{ id: number; callback_url: string }[]>);
  const callback = `${config.publicUrl}/api/webhooks/strava`;
  for (const s of existing ?? []) {
    if (s.callback_url === callback) {
      q.run("UPDATE connections SET webhook_id = ? WHERE provider = 'strava'", String(s.id));
      return String(s.id);
    }
    await fetch(`${API}/push_subscriptions/${s.id}?client_id=${config.strava.clientId}&client_secret=${config.strava.clientSecret}`, { method: 'DELETE' });
  }
  const body = new URLSearchParams({
    client_id: config.strava.clientId,
    client_secret: config.strava.clientSecret,
    callback_url: callback,
    verify_token: config.strava.verifyToken,
  });
  const res = await fetch(`${API}/push_subscriptions`, { method: 'POST', body });
  const json = (await res.json()) as { id?: number; errors?: unknown };
  if (!res.ok || !json.id) throw new Error(`Webhook subscription failed: ${JSON.stringify(json)}`);
  q.run("UPDATE connections SET webhook_id = ? WHERE provider = 'strava'", String(json.id));
  log('strava', 'info', `Webhook subscription ${json.id} registered`);
  return String(json.id);
}

export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete';
  object_id: number;
  aspect_type: 'create' | 'update' | 'delete';
  owner_id: number;
  updates?: Record<string, string>;
}

export function stravaHandleWebhook(ev: StravaWebhookEvent) {
  if (ev.object_type === 'athlete' && ev.updates?.authorized === 'false') {
    q.run("DELETE FROM connections WHERE provider = 'strava'");
    log('strava', 'warn', 'Athlete revoked access');
    return;
  }
  if (ev.object_type !== 'activity') return;
  const id = String(ev.object_id);
  if (ev.aspect_type === 'delete') {
    q.run("DELETE FROM activities WHERE source = 'strava' AND external_id = ?", id);
    log('strava', 'info', `Activity ${id} deleted via webhook`);
  } else if (ev.aspect_type === 'update' && ev.updates && !('type' in ev.updates) && !('sport_type' in ev.updates)) {
    if (ev.updates.title) q.run("UPDATE activities SET name = ? WHERE source = 'strava' AND external_id = ?", ev.updates.title, id);
  } else {
    enqueue('strava', 'detail', id, null, 20);
    log('strava', 'info', `Webhook: activity ${id} ${ev.aspect_type}d — queued`);
  }
}
