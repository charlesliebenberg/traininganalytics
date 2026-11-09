import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

const dir = mkdtempSync(join(tmpdir(), 'ta-import-snapshot-'));
process.env.DB_PATH = join(dir, 'test.db');
let api: typeof import('./api')['api'];
let db: typeof import('./db');
let activityId: number;
beforeAll(async () => {
  db = await import('./db');
  ({ api } = await import('./api'));
});
afterAll(() => { db.db.close(); rmSync(dir, { recursive: true, force: true }); });

describe('import and read-only snapshots', () => {
  it('imports a GPX through multipart HTTP and serves its activity and streams', async () => {
    const start = Date.parse('2026-10-12T06:00:00Z');
    const points = Array.from({ length: 121 }, (_, i) => `<trkpt lat="${-33.86 + i * 0.00003}" lon="151.2"><ele>25</ele><time>${new Date(start + i * 1000).toISOString()}</time></trkpt>`).join('');
    const gpx = `<gpx version="1.1"><trk><name>Review run</name><type>running</type><trkseg>${points}</trkseg></trk></gpx>`;
    const form = new FormData();
    form.append('files', new File([gpx], 'review.gpx', { type: 'application/gpx+xml' }));
    const res = await api.request('/import', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const [result] = await res.json();
    expect(result.status).toBe('imported');
    activityId = result.id;
    const detail = await (await api.request(`/activities/${activityId}`)).json();
    expect(detail).toMatchObject({ name: 'Review run', hasGps: true, detailed: true });
    expect(detail.streams.time.length).toBeGreaterThan(100);
    expect(detail.distance).toBeGreaterThan(300);
  });

  it('reports a malformed import without creating an activity', async () => {
    const form = new FormData();
    form.append('files', new File(['<gpx/>'], 'broken.gpx'));
    const [result] = await (await api.request('/import', { method: 'POST', body: form })).json();
    expect(result).toMatchObject({ status: 'error', file: 'broken.gpx' });
    expect(db.q.get('SELECT COUNT(*) AS n FROM activities')!.n).toBe(1);
  });

  it('reports a broken ZIP per file and continues the rest of the batch', async () => {
    const form = new FormData();
    form.append('files', new File(['not a zip'], 'broken.zip'));
    form.append('files', new File(['unsupported'], 'notes.txt'));
    const res = await api.request('/import', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject([
      { file: 'broken.zip', status: 'error' },
      { file: 'notes.txt', status: 'skipped' },
    ]);
  });

  it.each([true, false])('exports a consistent sanitized snapshot (streams=%s)', async (streams) => {
    db.q.run("INSERT OR REPLACE INTO connections(provider, access_token, refresh_token, expires_at) VALUES('strava', 'fixture-access', 'fixture-refresh', 1234)");
    db.q.run("INSERT OR IGNORE INTO sync_queue(provider, kind, external_id) VALUES('strava', 'detail', 'fixture')");
    const res = await api.request(`/admin/snapshot${streams ? '' : '?streams=0'}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gzip');
    const bytes = gunzipSync(Buffer.from(await res.arrayBuffer()));
    expect(bytes.subarray(0, 16).toString()).toBe('SQLite format 3\0');
    const file = join(dir, `snapshot-${streams}.db`);
    writeFileSync(file, bytes);
    const copy = new DatabaseSync(file, { readOnly: true });
    try {
      expect(copy.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
      expect(copy.prepare('SELECT access_token, refresh_token, expires_at FROM connections').get()).toEqual({ access_token: null, refresh_token: null, expires_at: null });
      expect(copy.prepare('SELECT COUNT(*) AS n FROM sync_queue').get()?.n).toBe(0);
      expect(copy.prepare('SELECT COUNT(*) AS n FROM streams').get()?.n).toBe(streams ? 1 : 0);
      expect(copy.prepare('SELECT id FROM activities').get()?.id).toBe(activityId);
      expect(bytes.includes(Buffer.from('fixture-access'))).toBe(false);
      expect(bytes.includes(Buffer.from('fixture-refresh'))).toBe(false);
    } finally { copy.close(); }
    // Sanitizing the copy must not disconnect the source database.
    expect(db.q.get("SELECT access_token FROM connections WHERE provider = 'strava'")?.access_token).toBe('fixture-access');
    expect(db.loadStreams(activityId)).not.toBeNull();
  });
});
