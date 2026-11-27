import { NavLink, Outlet, useLocation, useNavigationType } from 'react-router-dom';
import clsx from 'clsx';
import { RefreshCw, Sun, Moon, Monitor, Activity, Menu, LogOut, Search, AlertTriangle } from 'lucide-react';
import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type ErrorInfo, type ReactNode, type RefObject } from 'react';
import { formatDistanceToNowStrict, parseISO } from 'date-fns';
import { http, useApi, useAction } from '../lib/api';
import { useTheme } from '../lib/theme';
import { APP_NAME } from '../lib/hooks';
import { NAV, SETTINGS_ITEM, pageTitle } from '../lib/nav';
import { Button, Empty, Spinner } from './ui';
import { CommandPalette, usePaletteShortcut } from './CommandPalette';
import type { SyncStatus } from '../../shared/types';

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

function SyncPill() {
  const { data } = useStatus();
  const sync = useAction(() => http('/sync', { method: 'POST' }), { success: 'Sync started' });
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
  return (
    <button
      onClick={() => connected.length && sync.mutate(undefined)}
      disabled={!connected.length}
      title={error ? `${PROVIDER[error.provider] ?? error.provider}: ${error.lastError}` : connected.length ? 'Sync now' : undefined}
      aria-label={connected.length ? `${label}. Sync now` : label}
      className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-left text-xs text-ink-2 enabled:hover:text-ink disabled:cursor-default"
    >
      {error && !busy ? <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" /> : <RefreshCw className={clsx('h-3.5 w-3.5 shrink-0', busy && 'animate-spin text-accent')} />}
      <span className="truncate">{label}</span>
    </button>
  );
}

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const opts = [
    { v: 'light' as const, icon: Sun, label: 'Light theme' },
    { v: 'system' as const, icon: Monitor, label: 'Match system theme' },
    { v: 'dark' as const, icon: Moon, label: 'Dark theme' },
  ];
  return (
    <div className="flex rounded-lg border border-line bg-surface-2 p-0.5" role="group" aria-label="Theme">
      {opts.map(({ v, icon: Icon, label }) => (
        <button key={v} onClick={() => setMode(v)} title={label} aria-label={label} aria-pressed={mode === v} className={clsx('flex-1 rounded-md py-1', mode === v ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          <Icon className="mx-auto h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

function SignOut() {
  const { data } = useApi<{ required: boolean }>('/session', { staleTime: Infinity });
  const out = useAction(() => http('/session/logout', { method: 'POST' }));
  if (!data?.required) return null;
  return (
    <button onClick={() => out.mutate(undefined)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-ink">
      <LogOut className="h-3.5 w-3.5" />
      Sign out
    </button>
  );
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] text-muted hover:text-ink">
      <Search className="h-3.5 w-3.5" />
      <span className="flex-1 text-left">Search</span>
      <kbd className="rounded border border-line bg-surface px-1.5 text-[10px] font-medium">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
  );
}

/**
 * A page that throws shows what went wrong in place of the page, with the sidebar still there
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
        <Empty icon={<AlertTriangle className="h-6 w-6 text-warning" />} title={stale ? 'A newer version of the app is available' : 'This page ran into a problem'}>
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
    // a filter or tab changing the URL on the same page keeps your place
    if (!samePage) el.scrollTo({ top: 0 });
  }, [loc.key, loc.pathname, type, ref]);
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const loc = useLocation();
  const main = useRef<HTMLElement>(null);
  useEffect(() => setOpen(false), [loc.pathname]);
  useScrollRestoration(main);
  usePaletteShortcut(setPalette);
  const closePalette = useCallback(() => setPalette(false), []);
  // the tab title follows the page; an activity sets its own
  useEffect(() => {
    const t = pageTitle(loc.pathname);
    if (t) document.title = `${t} · ${APP_NAME}`;
    else if (!loc.pathname.startsWith('/activities/')) document.title = APP_NAME;
  }, [loc.pathname]);
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
  const linkClass = ({ isActive }: { isActive: boolean }) => clsx('mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors', isActive ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink');
  return (
    <div className="flex h-full">
      <aside
        id="sidebar"
        className={clsx(
          'fixed inset-y-0 left-0 z-[900] flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            <Activity className="h-4.5 w-4.5" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[14px] leading-tight font-semibold">{APP_NAME}</div>
            <div className="text-[11px] text-muted">Analyze · Plan · Perform</div>
          </div>
        </div>
        <div className="px-3 pb-1">
          <SearchButton onOpen={() => setPalette(true)} />
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-3" aria-label="Main">
          {NAV.map((g) => (
            <div key={g.group ?? 'root'} className="mt-3">
              {g.group && <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{g.group}</div>}
              {g.items.map(({ to, label, icon: Icon }) => (
                <NavLink key={to} to={to} end={to === '/'} className={linkClass}>
                  {({ isActive }) => (
                    <>
                      <Icon className={clsx('h-4 w-4', isActive ? 'text-accent' : 'text-muted')} />
                      {label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="space-y-2 border-t border-line p-3">
          <NavLink to={SETTINGS_ITEM.to} className={(s) => clsx(linkClass(s), 'mb-0')}>
            {({ isActive }) => (
              <>
                <SETTINGS_ITEM.icon className={clsx('h-4 w-4', isActive ? 'text-accent' : 'text-muted')} />
                {SETTINGS_ITEM.label}
              </>
            )}
          </NavLink>
          <SyncPill />
          <ThemeSwitch />
          <SignOut />
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-[800] bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <main ref={main} className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-[700] flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-surface-2" aria-label="Open menu" aria-expanded={open} aria-controls="sidebar">
            <Menu className="h-5 w-5" />
          </button>
          <span className="flex-1 font-semibold">{pageTitle(loc.pathname) ?? APP_NAME}</span>
          <button onClick={() => setPalette(true)} className="rounded-md p-1.5 text-ink-2 hover:bg-surface-2" aria-label="Search">
            <Search className="h-5 w-5" />
          </button>
        </div>
        <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
          <PageErrorBoundary resetKey={loc.pathname}>
            <Suspense fallback={<Spinner />}>
              <Outlet />
            </Suspense>
          </PageErrorBoundary>
        </div>
      </main>
      <CommandPalette open={palette} onClose={closePalette} />
    </div>
  );
}
