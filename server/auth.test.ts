import { beforeAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';

// Local fixtures only; these are unrelated to deployment credentials.
process.env.APP_PASSWORD = 'local-test-password';
process.env.READ_TOKEN = 'local-read-token-for-tests-only';
let app: Hono;
beforeAll(async () => {
  const { requireAuth, session } = await import('./auth');
  app = new Hono();
  app.use('/api/*', requireAuth);
  app.route('/api/session', session);
  app.all('/api/*', c => c.json({ ok: true }));
});

describe('password and read-only authentication', () => {
  it('requires a session to manage webhook subscriptions', async () => {
    expect((await app.request('/api/webhooks/strava/subscribe', { method: 'POST' })).status).toBe(401);
  });
  it('allows public health checks and incoming Strava webhooks', async () => {
    expect((await app.request('/api/health')).status).toBe(200);
    expect((await app.request('/api/webhooks/strava')).status).toBe(200);
    expect((await app.request('/api/webhooks/strava', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/api/activities')).status).toBe(401);
  });
  it('permits snapshots with a read token, but refuses mutations', async () => {
    const headers = { authorization: `Bearer ${process.env.READ_TOKEN}` };
    expect((await app.request('/api/admin/snapshot', { headers })).status).toBe(200);
    expect((await app.request('/api/activities/1', { method: 'DELETE', headers })).status).toBe(401);
  });
  it('does not let a read token start or complete an account connection', async () => {
    const headers = { authorization: `Bearer ${process.env.READ_TOKEN}` };
    expect((await app.request('/api/auth/strava/start', { headers })).status).toBe(401);
    expect((await app.request('/api/auth/strava/callback', { headers })).status).toBe(401);
  });
  it('logs in with a session cookie and can log out', async () => {
    const login = await app.request('/api/session/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: process.env.APP_PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect((await app.request('/api/webhooks/strava/subscribe', { method: 'POST', headers: { cookie } })).status).toBe(200);
    const logout = await app.request('/api/session/logout', { method: 'POST', headers: { cookie } });
    expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});
