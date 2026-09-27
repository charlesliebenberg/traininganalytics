import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env loader (no dependency): KEY=VALUE lines, existing env wins.
for (const file of ['.env.local', '.env']) {
  const p = resolve(process.cwd(), file);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const port = Number(env.PORT ?? 8787);
const production = env.NODE_ENV === 'production';

export const config = {
  port,
  production,
  publicUrl: (env.PUBLIC_URL ?? (production ? `http://localhost:${port}` : 'http://localhost:5173')).replace(/\/$/, ''),
  dataDir: resolve(env.DATA_DIR ?? './data'),
  syncIntervalMinutes: Number(env.SYNC_INTERVAL_MINUTES ?? 15),
  strava: {
    clientId: env.STRAVA_CLIENT_ID ?? '',
    clientSecret: env.STRAVA_CLIENT_SECRET ?? '',
    verifyToken: env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? 'training-analytics',
  },
  trainingPeaks: {
    clientId: env.TRAININGPEAKS_CLIENT_ID ?? '',
    clientSecret: env.TRAININGPEAKS_CLIENT_SECRET ?? '',
    sandbox: env.TRAININGPEAKS_SANDBOX === 'true',
  },
};

export const stravaConfigured = () => !!(config.strava.clientId && config.strava.clientSecret);
export const tpConfigured = () => !!(config.trainingPeaks.clientId && config.trainingPeaks.clientSecret);
