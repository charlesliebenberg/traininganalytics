import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { Hono } from 'hono';
import { config } from './config';

/**
 * Optional single-user password protection (APP_PASSWORD). A successful login sets an
 * httpOnly cookie holding an HMAC derived from the password, so changing the password
 * signs everyone out. Webhooks and health checks stay public.
 */
const COOKIE = 'ta_session';
const PUBLIC_PATHS = [/^\/api\/health$/, /^\/api\/session(\/|$)/, /^\/api\/webhooks\//];

const token = () => createHmac('sha256', config.appPassword).update('training-analytics-session-v1').digest('hex');

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(a).digest();
  const hb = createHmac('sha256', 'cmp').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const authEnabled = () => !!config.appPassword;
const isAuthed = (c: Context) => !authEnabled() || safeEqual(getCookie(c, COOKIE) ?? '', token());

/** READ_TOKEN (at least 24 chars) as a Bearer token grants read-only access: GET requests only. */
const hasReadToken = (c: Context) => {
  if (c.req.method !== 'GET' || config.readToken.length < 24) return false;
  const h = c.req.header('authorization') ?? '';
  return h.startsWith('Bearer ') && safeEqual(h.slice(7).trim(), config.readToken);
};

/** Frontend and API on different sites (no proxy) need a cross-site cookie. */
function cookieOptions() {
  const secure = config.apiUrl.startsWith('https://');
  let crossSite = false;
  try {
    crossSite = new URL(config.publicUrl).host !== new URL(config.apiUrl).host;
  } catch {}
  return { httpOnly: true, secure, sameSite: crossSite && secure ? ('None' as const) : ('Lax' as const), path: '/', maxAge: 60 * 60 * 24 * 90 };
}

export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS' || PUBLIC_PATHS.some((r) => r.test(c.req.path)) || isAuthed(c) || hasReadToken(c)) return next();
  return c.json({ error: 'Unauthorized' }, 401);
};

export const session = new Hono();
session.get('/', (c) => c.json({ required: authEnabled(), authenticated: isAuthed(c) }));
session.post('/login', async (c) => {
  const { password } = await c.req.json().catch(() => ({ password: '' }));
  if (!authEnabled()) return c.json({ ok: true });
  if (!safeEqual(String(password ?? ''), config.appPassword)) {
    await new Promise((r) => setTimeout(r, 800)); // slow down guessing
    return c.json({ error: 'Wrong password' }, 401);
  }
  setCookie(c, COOKIE, token(), cookieOptions());
  return c.json({ ok: true });
});
session.post('/logout', (c) => {
  deleteCookie(c, COOKIE, cookieOptions());
  return c.json({ ok: true });
});
