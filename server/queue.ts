import { log, q } from './db';

/** Thrown by provider clients when an API rate limit is hit; `until` is epoch ms. */
export class RateLimitError extends Error {
  constructor(public until: number) {
    super(`Rate limited until ${new Date(until).toISOString()}`);
  }
}

type Handler = (externalId: string, payload: any) => Promise<void>;
const handlers = new Map<string, Handler>();
const throttles = new Map<string, () => number | null>();
const pausedUntil = new Map<string, number>();

export const worker = {
  running: false,
  message: null as string | null,
  processed: 0,
};

export function registerHandler(provider: string, kind: string, fn: Handler) {
  handlers.set(`${provider}:${kind}`, fn);
}

/** A provider can declare a proactive throttle (e.g. near its rate limit). */
export function registerThrottle(provider: string, fn: () => number | null) {
  throttles.set(provider, fn);
}

export function enqueue(provider: string, kind: string, externalId: string, payload: unknown = null, priority = 0, sortKey = 0) {
  q.run(
    `INSERT INTO sync_queue(provider, kind, external_id, payload, priority, sort_key) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider, kind, external_id) DO UPDATE SET priority = MAX(priority, excluded.priority), payload = excluded.payload, attempts = 0, not_before = 0`,
    provider,
    kind,
    externalId,
    payload == null ? null : JSON.stringify(payload),
    priority,
    sortKey,
  );
  kick();
}

export function queueSize(provider?: string): number {
  const r = provider
    ? q.get('SELECT COUNT(*) AS n FROM sync_queue WHERE provider = ?', provider)
    : q.get('SELECT COUNT(*) AS n FROM sync_queue');
  return Number(r?.n ?? 0);
}

export function pauseInfo(provider: string): number | null {
  const until = pausedUntil.get(provider);
  return until && until > Date.now() ? until : null;
}

let timer: NodeJS.Timeout | null = null;

export function kick(delay = 50) {
  if (worker.running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, delay);
}

async function run() {
  timer = null;
  if (worker.running) return;
  worker.running = true;
  try {
    for (;;) {
      const now = Date.now();
      const paused = [...pausedUntil.entries()].filter(([, t]) => t > now).map(([p]) => p);
      const job = q.get(
        `SELECT * FROM sync_queue WHERE not_before <= ? ${paused.length ? `AND provider NOT IN (${paused.map(() => '?').join(',')})` : ''}
         ORDER BY priority DESC, sort_key DESC, id LIMIT 1`,
        now,
        ...paused,
      );
      if (!job) break;
      const throttle = throttles.get(job.provider)?.();
      if (throttle) {
        pausedUntil.set(job.provider, throttle);
        worker.message = `${job.provider}: pausing for rate limit until ${new Date(throttle).toLocaleTimeString()}`;
        continue;
      }
      const handler = handlers.get(`${job.provider}:${job.kind}`);
      if (!handler) {
        q.run('DELETE FROM sync_queue WHERE id = ?', job.id);
        continue;
      }
      worker.message = `${job.provider}: ${job.kind} ${job.external_id}`;
      try {
        await handler(job.external_id, job.payload ? JSON.parse(job.payload) : null);
        q.run('DELETE FROM sync_queue WHERE id = ?', job.id);
        worker.processed++;
      } catch (e) {
        if (e instanceof RateLimitError) {
          pausedUntil.set(job.provider, e.until);
          log(job.provider, 'warn', e.message);
          continue;
        }
        const attempts = job.attempts + 1;
        const msg = (e as Error).message;
        if (attempts >= 5) {
          q.run('DELETE FROM sync_queue WHERE id = ?', job.id);
          log(job.provider, 'error', `Giving up on ${job.kind} ${job.external_id}: ${msg}`);
        } else {
          q.run('UPDATE sync_queue SET attempts = ?, not_before = ? WHERE id = ?', attempts, now + 2 ** attempts * 30_000, job.id);
          log(job.provider, 'warn', `${job.kind} ${job.external_id} failed (attempt ${attempts}): ${msg}`);
        }
        q.run('UPDATE connections SET last_error = ? WHERE provider = ?', msg, job.provider);
      }
    }
  } finally {
    worker.running = false;
    worker.message = null;
  }
  // wake up when the earliest deferred job becomes due
  const next = q.get('SELECT MIN(not_before) AS t FROM sync_queue');
  const pauses = [...pausedUntil.values()].filter((t) => t > Date.now());
  const due = Math.min(...[next?.t, ...pauses].filter((t): t is number => typeof t === 'number' && t > 0));
  if (Number.isFinite(due)) kick(Math.max(1000, Math.min(due - Date.now() + 100, 2 ** 31 - 1)));
}
