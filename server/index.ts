import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config';
import { api } from './api';
import { authEnabled, requireAuth, session } from './auth';
import { startScheduler } from './sync';
import { ingestEvents } from './ingest';
import { scheduleEstimateRefresh, upgradeMetrics } from './estimates';
import { warmAerobic } from './aerobic';
import { warmEffortSeries } from './efforts';
import { log } from './db';

const app = new Hono();

// Allow a frontend hosted on another domain (e.g. Vercel/Netlify without a proxy) to call the API.
const origins = new Set([config.publicUrl, ...config.corsOrigins]);
app.use('/api/*', cors({ origin: (o) => (origins.has(o) ? o : null), credentials: true }));
app.use('/api/*', compress());
app.use('/api/*', requireAuth);
app.route('/api/session', session);
app.route('/api', api);
// an unknown API path is an error, not the app's HTML shell (which a client would take for success)
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

// When the frontend has been built (single-service deploys, `npm start` locally), serve it too.
const dist = resolve(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: './dist' }));
  const index = readFileSync(resolve(dist, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Training Analytics API listening on http://localhost:${info.port}`);
  console.log(`Open ${config.publicUrl}`);
  if (config.production && !authEnabled()) console.warn('WARNING: APP_PASSWORD is not set — anyone who can reach this server can read and change your data.');
  startScheduler();
  ingestEvents.onSaved.push(() => {
    scheduleEstimateRefresh();
    scheduleWarm();
  });
  // after a metrics change, rebuild stored activities once (in the background); otherwise
  // just refresh the threshold estimates
  setTimeout(() => {
    upgradeMetrics()
      .then((did) => {
        if (!did) scheduleEstimateRefresh(0);
        scheduleWarm();
      })
      .catch((e) => log(null, 'error', `Metrics upgrade failed: ${(e as Error).message}`));
  }, 3000);
});

/** Steady stretches for new activities and the aerobic models, computed off the request path. */
let warmTimer: NodeJS.Timeout | null = null;
function scheduleWarm() {
  if (warmTimer) clearTimeout(warmTimer);
  warmTimer = setTimeout(() => {
    warmTimer = null;
    warmAerobic()
      .catch((e) => log(null, 'error', `Aerobic model failed: ${(e as Error).message}`))
      .then(() => warmEffortSeries())
      .catch((e) => log(null, 'error', `Best-effort series failed: ${(e as Error).message}`));
  }, 8000);
}
