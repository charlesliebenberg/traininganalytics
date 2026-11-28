import { Link, NavLink, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import clsx from 'clsx';
import { RefreshCw, Sun, Moon, Monitor, LogOut, Search, AlertTriangle, Settings as SettingsIcon } from 'lucide-react';
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { http, useApi, useAction } from '../lib/api';
import { useTheme } from '../lib/theme';
import { APP_NAME, isTyping } from '../lib/hooks';
import { SPACES, SETTINGS, pageTitle } from '../lib/nav';
import { useInspect } from '../lib/inspect';
import { Button, Empty, Menu, MenuItem, Spinner } from './ui';
import { CommandPalette, usePaletteShortcut } from './CommandPalette';
import { TimezoneNotice } from './TimezoneNotice';
import { StatusCapsule } from './StatusCapsule';
import { Inspector } from './inspector/Inspector';
import type { Preferences, SyncStatus } from '../../shared/types';

export type Status = SyncStatus & { job: { kind: string; message: string | null; progress: number } | null; demo: boolean; publicUrl: string; apiUrl: string };

export function useStatus() {
  return useApi<Status>('/status', {
    refetchInterval: (q) => {
      const d = q.state.data as Status | undefined;
      return d?.running || d?.job || d?.queue ? 2000 : 20000;
    },
  });
}

const PROVIDER: Record<string, string> = { strava: 'Strava', eightsleep: 'Eight Sleep', trainerroad: 'TrainerRoad' };

/** What the sync is doing, in a few words, and whether something needs attention. */
function useSyncState() {
  const { data } = useStatus();
  if (!data) return null;
  const connected = data.connections.filter((c) => c.connected);
  const busy = data.running || !!data.job || data.queue > 0;
  const last = connected
    .map((c) => c.lastSyncAt)
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  const error = connected.find((c) => c.lastError);
  const label = data.job
    ? (data.job.message ?? `${data.job.kind}…`)
    : busy
      ? `Syncing · ${data.queue} queued`
      : connected.length
        ? last
          ? `Synced ${formatDistanceToNowStrict(parseISO(last), { addSuffix: true })}`
          : `Connected · ${connected.map((c) => PROVIDER[c.provider] ?? c.provider).join(', ')}`
        : data.demo
          ? 'Demo data'
          : 'No sources connected';
  return { connected: connected.length, busy, error: error ? `${PROVIDER[error.provider] ?? error.provider}: ${error.lastError}` : null, label };
}

/** The mark: a fitness line climbing to today. */
function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={clsx('h-8 w-8 shrink-0', className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--inverse)" />
      <path d="M6.5 22c4 0 5-8 9-8s4.5 4.5 10-5" fill="none" stroke="var(--inverse-ink)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="25.5" cy="9" r="2.6" fill="var(--accent)" />
    </svg>
  );
}

function ProfileMenu() {
  const { mode, setMode } = useTheme();
  const sync = useSyncState();
  const prefs = useApi<Preferences>('/preferences');
  const session = useApi<{ required: boolean }>('/session', { staleTime: Infinity });
  const doSync = useAction(() => http('/sync', { method: 'POST' }), { success: 'Sync started' });
  const out = useAction(() => http('/session/logout', { method: 'POST' }));
  const name = prefs.data?.athleteName?.trim() || 'Athlete';
  const initials = name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  const themes = [
    { v: 'light' as const, icon: Sun, label: 'Light' },
    { v: 'system' as const, icon: Monitor, label: 'Auto' },
    { v: 'dark' as const, icon: Moon, label: 'Dark' },
  ];
  return (
    <Menu
      label="You"
      button={({ open, toggle }) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label={`${name}: settings, theme and sync`} className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-3 text-[12px] font-semibold text-ink ring-offset-2 ring-offset-surface transition hover:ring-2 hover:ring-line-strong">
          {initials}
          {sync && (sync.busy || sync.error) && <span className={clsx('absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface', sync.error && !sync.busy ? 'bg-warning' : 'animate-pulse bg-accent')} />}
        </button>
      )}
      className="w-72"
    >
      <div className="px-2.5 pt-1.5 pb-2.5">
        <div className="truncate text-[14px] font-semibold text-ink">{name}</div>
        {sync && (
          <div className={clsx('mt-0.5 flex items-center gap-1.5 text-[12px]', sync.error && !sync.busy ? 'text-ink-2' : 'text-muted')} title={sync.error ?? undefined}>
            {sync.error && !sync.busy && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />}
            <span className="truncate">{sync.error && !sync.busy ? sync.error : sync.label}</span>
          </div>
        )}
      </div>
      <div className="border-t border-line pt-1.5">
        {sync && sync.connected > 0 && (
          <MenuItem icon={<RefreshCw className={clsx(sync.busy && 'animate-spin text-accent')} />} onClick={() => doSync.mutate(undefined)}>
            Sync now
          </MenuItem>
        )}
        <Link to={SETTINGS.to} role="menuitem" className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink">
          <SettingsIcon className="h-4 w-4 text-muted" />
          Settings
        </Link>
      </div>
      <div className="mt-1.5 border-t border-line px-1 pt-2.5 pb-1">
        <div className="mb-1.5 px-1.5 text-[11px] text-muted">Appearance</div>
        <div className="grid grid-cols-3 gap-1 rounded-[10px] bg-surface-2 p-0.5" role="group" aria-label="Theme">
          {themes.map(({ v, icon: Icon, label }) => (
            <button key={v} type="button" data-keep-open onClick={() => setMode(v)} aria-pressed={mode === v} className={clsx('flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] font-medium', mode === v ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}>
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>
      </div>
      {session.data?.required && (
        <div className="mt-1.5 border-t border-line pt-1.5">
          <MenuItem icon={<LogOut />} onClick={() => out.mutate(undefined)}>
            Sign out
          </MenuItem>
        </div>
      )}
    </Menu>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function TopBar({ onSearch }: { onSearch: () => void }) {
  const loc = useLocation();
  const here = [...SPACES, SETTINGS].find((s) => s.match(loc.pathname));
  return (
    <header className="z-[900] shrink-0 border-b border-line bg-surface">
      <div className="mx-auto flex h-14 max-w-[1680px] items-center gap-1.5 px-3 sm:px-5">
        <Link to="/" className="flex shrink-0 items-center gap-2.5 rounded-xl pr-2" aria-label={`${APP_NAME}: Today`}>
          <Logo />
          <span className="hidden text-[14.5px] font-semibold tracking-[-0.01em] xl:block">{APP_NAME}</span>
        </Link>
        <span className="truncate pl-1 text-[15px] font-semibold md:hidden">{here?.label ?? APP_NAME}</span>
        <nav className="ml-3 hidden items-center gap-0.5 md:flex" aria-label="Main">
          {SPACES.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.to === '/'} title={s.blurb} className={({ isActive }) => clsx('flex items-center gap-2 rounded-[10px] px-3 py-1.5 text-[13.5px] font-medium transition-colors', isActive ? 'bg-surface-2 text-ink' : 'text-ink-2 hover:bg-surface-2/70 hover:text-ink')}>
              {({ isActive }) => (
                <>
                  <s.icon className={clsx('h-4 w-4', isActive ? 'text-ink' : 'text-muted')} />
                  {s.label}
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <StatusCapsule />
          <button type="button" onClick={onSearch} className="hidden h-9 items-center gap-2 rounded-[10px] border border-line bg-surface-2/60 pr-1.5 pl-2.5 text-[13px] text-muted transition-colors hover:border-line-strong hover:text-ink lg:flex">
            <Search className="h-4 w-4" />
            <span className="w-24 text-left">Search</span>
            <kbd className="rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[10.5px] font-medium">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <button type="button" onClick={onSearch} className="flex h-9 w-9 items-center justify-center rounded-[10px] text-ink-2 hover:bg-surface-2 hover:text-ink lg:hidden" aria-label="Search">
            <Search className="h-[18px] w-[18px]" />
          </button>
          <ProfileMenu />
        </div>
      </div>
    </header>
  );
}

/** On a phone, the four places sit under your thumb. */
function TabBar() {
  return (
    <nav className="glass pb-safe fixed inset-x-0 bottom-0 z-[900] border-t border-line md:hidden" aria-label="Main">
      <div className="grid grid-cols-4">
        {SPACES.map((s) => (
          <NavLink key={s.to} to={s.to} end={s.to === '/'} className={({ isActive }) => clsx('flex flex-col items-center gap-1 pt-2 pb-1.5 text-[10.5px] font-medium transition-colors', isActive ? 'text-ink' : 'text-muted')}>
            {({ isActive }) => (
              <>
                <span className={clsx('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-surface-3')}>
                  <s.icon className="h-[19px] w-[19px]" strokeWidth={isActive ? 2.25 : 1.9} />
                </span>
                {s.label}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/**
 * A page that throws shows what went wrong in place of the page, with the navigation still there
 * to go elsewhere — rather than a blank screen. After a deploy, a page's code may no longer be
 * on the server; that one asks for a reload.
 */
class PageErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const stale = /dynamically imported module|Importing a module script failed|error loading dynamically|Failed to fetch/i.test(error.message);
    return (
      <div className="card" role="alert">
        <Empty icon={<AlertTriangle className="text-warning" />} title={stale ? 'A newer version of the app is available' : 'This page ran into a problem'}>
          <p>{stale ? 'The app was updated since this tab opened. Reload to get the latest version.' : error.message}</p>
          <div className="mt-4 flex justify-center gap-2">
            {stale ? (
              <Button variant="primary" onClick={() => location.reload()}>
                Reload
              </Button>
            ) : (
              <>
                <Button onClick={() => this.setState({ error: null })}>Try again</Button>
                <Button variant="ghost" onClick={() => location.reload()}>
                  Reload the app
                </Button>
              </>
            )}
          </div>
        </Empty>
      </div>
    );
  }
}

/**
 * The page scrolls inside <main>, not the window, so the browser's own scroll restoration
 * doesn't apply: a new page opens at the top, and back/forward return to where you were.
 */
function useScrollRestoration(ref: RefObject<HTMLElement | null>) {
  const loc = useLocation();
  const type = useNavigationType();
  const positions = useRef(new Map<string, number>());
  const current = useRef(loc.key);
  const path = useRef(loc.pathname);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onScroll = () => positions.current.set(current.current, el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || current.current === loc.key) return;
    current.current = loc.key;
    const samePage = path.current === loc.pathname;
    path.current = loc.pathname;
    if (type === 'POP') {
      // opening or closing the inspector doesn't move the page under it
      if (samePage) return;
      const y = positions.current.get(loc.key);
      if (y == null) return;
      // the page may still be loading its data: keep trying until it is tall enough
      let tries = 0;
      const restore = () => {
        el.scrollTop = y;
        if (Math.abs(el.scrollTop - y) > 2 && tries++ < 30) timer = window.setTimeout(restore, 60);
      };
      let timer = window.setTimeout(restore, 0);
      return () => clearTimeout(timer);
    }
    // a filter, tab or the inspector changing the URL on the same page keeps your place
    if (!samePage) el.scrollTo({ top: 0 });
  }, [loc.key, loc.pathname, type, ref]);
}

/** g then t / s / p / a: go to Today, Season, Performance or Activities from the keyboard. */
function useGoKeys() {
  const nav = useNavigate();
  useEffect(() => {
    let armed = 0;
    const h = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'g') {
        armed = Date.now();
        return;
      }
      if (Date.now() - armed > 1200) return;
      armed = 0;
      const to = { t: '/', s: '/season', p: '/performance', a: '/activities' }[k];
      if (to) {
        e.preventDefault();
        nav(to);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav]);
}

export function Layout() {
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  const { current } = useInspect();
  useScrollRestoration(main);
  usePaletteShortcut(setPalette);
  useGoKeys();
  const closePalette = useCallback(() => setPalette(false), []);
  // the tab title follows the page; an activity sets its own
  useEffect(() => {
    const t = pageTitle(loc.pathname);
    if (t) document.title = `${t} · ${APP_NAME}`;
    else if (!loc.pathname.startsWith('/activities/')) document.title = APP_NAME;
  }, [loc.pathname]);
  return (
    <div className="flex h-full flex-col">
      <TopBar onSearch={() => setPalette(true)} />
      <main ref={main} className={clsx('min-h-0 flex-1 overflow-y-auto transition-[padding] duration-200', current && '2xl:pr-[540px]')}>
        <div className="mx-auto max-w-[1440px] px-4 pt-6 pb-28 sm:px-6 md:pb-14 lg:px-8 lg:pt-8">
          <TimezoneNotice />
          <PageErrorBoundary resetKey={loc.pathname}>
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </PageErrorBoundary>
        </div>
      </main>
      <TabBar />
      <Inspector />
      <CommandPalette open={palette} onClose={closePalette} />
    </div>
  );
}
