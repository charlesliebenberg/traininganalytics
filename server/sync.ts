import { config, stravaConfigured } from './config';
import { q } from './db';
import { enqueue, kick, pauseInfo, queueSize, registerHandler, registerThrottle, worker } from './queue';
import { stravaSyncAthlete, stravaSyncDetail, stravaSyncList, stravaThrottleUntil } from './providers/strava';
import type { Connection, SyncStatus } from '../shared/types';

registerHandler('strava', 'list', (_id, payload) => stravaSyncList(payload));
registerHandler('strava', 'detail', (id) => stravaSyncDetail(id));
registerHandler('strava', 'athlete', () => stravaSyncAthlete());
registerThrottle('strava', stravaThrottleUntil);

function connected(provider: string): boolean {
  return !!q.get('SELECT 1 FROM connections WHERE provider = ? AND refresh_token IS NOT NULL', provider);
}

/** Queue an incremental sync for every connected provider. */
export function syncNow() {
  if (connected('strava')) enqueue('strava', 'list', 'poll', { page: 1 }, 15);
}

export function startScheduler() {
  // TrainingPeaks support was removed; drop any leftover connection/queue rows
  q.run("DELETE FROM connections WHERE provider = 'trainingpeaks'");
  q.run("DELETE FROM sync_queue WHERE provider = 'trainingpeaks'");
  kick(2000); // resume any queued work from a previous run
  const ms = Math.max(1, config.syncIntervalMinutes) * 60_000;
  setInterval(syncNow, ms).unref();
  setTimeout(syncNow, 5000).unref();
}

export function syncStatus(): SyncStatus {
  const conns: Connection[] = (['strava'] as const).map((provider) => {
    const c = q.get('SELECT * FROM connections WHERE provider = ?', provider);
    const paused = pauseInfo(provider);
    return {
      provider,
      configured: stravaConfigured(),
      connected: !!c?.refresh_token,
      athleteName: c?.athlete_name ?? null,
      lastSyncAt: c?.last_sync_at ?? null,
      lastError: paused ? `Rate limited — resuming at ${new Date(paused).toLocaleTimeString()}` : c?.last_error ?? null,
      pending: queueSize(provider),
      webhook: !!c?.webhook_id,
    };
  });
  return {
    running: worker.running,
    queue: queueSize(),
    message: worker.message,
    connections: conns,
    activityCount: Number(q.get('SELECT COUNT(*) AS n FROM activities')?.n ?? 0),
  };
}
