/**
 * Download a read-only snapshot of the deployed database to data/real.db.
 *   TA_READ_TOKEN=... npx tsx server/scripts/pull-snapshot.ts [--no-streams]
 * Then run against it with DB_PATH=data/real.db.
 */
import { createWriteStream, mkdirSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const base = (process.env.TA_API_URL ?? 'https://traininganalytics-api.onrender.com').replace(/\/$/, '');
const token = process.env.TA_READ_TOKEN;
if (!token) throw new Error('Set TA_READ_TOKEN (the READ_TOKEN configured on the server).');
const streams = !process.argv.includes('--no-streams');
const res = await fetch(`${base}/api/admin/snapshot${streams ? '' : '?streams=0'}`, { headers: { authorization: `Bearer ${token}` } });
if (!res.ok || !res.body) throw new Error(`Snapshot failed: ${res.status} ${await res.text()}`);
mkdirSync('data', { recursive: true });
await pipeline(Readable.fromWeb(res.body as never), createGunzip(), createWriteStream('data/real.db.part'));
renameSync('data/real.db.part', 'data/real.db');
console.log('Saved data/real.db');
