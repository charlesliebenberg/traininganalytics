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

const app = new Hono();

// Allow a frontend hosted on another domain (e.g. Vercel/Netlify without a proxy) to call the API.
const origins = new Set([config.publicUrl, ...config.corsOrigins]);
app.use('/api/*', cors({ origin: (o) => (origins.has(o) ? o : null), credentials: true }));
app.use('/api/*', compress());
app.use('/api/*', requireAuth);
app.route('/api/session', session);
app.route('/api', api);

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
});
