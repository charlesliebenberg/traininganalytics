import { createReadStream, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { db } from './db';

/**
 * A gzipped, consistent copy of the database for testing against real data, with the
 * Strava OAuth tokens removed. `streams: false` drops the per-second streams (much smaller).
 */
export function snapshot(opts: { streams: boolean }): ReadableStream {
  const file = join(tmpdir(), `ta-snapshot-${process.pid}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(file);
  try {
    copy.exec(`UPDATE connections SET access_token = NULL, refresh_token = NULL, expires_at = NULL`);
    copy.exec(`DELETE FROM sync_queue`);
    if (!opts.streams) copy.exec(`DELETE FROM streams`);
    copy.exec('VACUUM');
  } finally {
    copy.close();
  }
  const out = createReadStream(file).pipe(createGzip({ level: 6 }));
  const cleanup = () => rmSync(file, { force: true });
  out.on('close', cleanup);
  out.on('error', cleanup);
  return Readable.toWeb(out) as ReadableStream;
}
