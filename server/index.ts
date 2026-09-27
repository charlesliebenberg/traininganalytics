import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config';
import { api } from './api';
import { startScheduler } from './sync';

const app = new Hono();
app.use('/api/*', compress());
app.route('/api', api);

const dist = resolve(process.cwd(), 'dist');
if (existsSync(dist)) {
  app.use('/*', serveStatic({ root: './dist' }));
  const index = readFileSync(resolve(dist, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index));
}

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Training Analytics API listening on http://localhost:${info.port}`);
  console.log(`Open ${config.publicUrl}`);
  startScheduler();
});
