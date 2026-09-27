import { NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import {
  LayoutDashboard,
  ListOrdered,
  TrendingUp,
  Zap,
  BarChart3,
  Trophy,
  Map as MapIcon,
  CalendarDays,
  Dumbbell,
  Flag,
  Settings,
  RefreshCw,
  Sun,
  Moon,
  Monitor,
  Activity,
  Menu,
} from 'lucide-react';
import { Suspense, useEffect, useState } from 'react';
import { http, useApi, useAction } from '../lib/api';
import { useTheme } from '../lib/theme';
import { Spinner } from './ui';
import type { SyncStatus } from '../../shared/types';

export type Status = SyncStatus & { job: { kind: string; message: string | null; progress: number } | null; demo: boolean; publicUrl: string };

export function useStatus() {
  return useApi<Status>('/status', {
    refetchInterval: (q) => {
      const d = q.state.data as Status | undefined;
      return d?.running || d?.job || d?.queue ? 2000 : 20000;
    },
  });
}

const NAV = [
  { group: null, items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard }] },
  {
    group: 'Analyze',
    items: [
      { to: '/activities', label: 'Activities', icon: ListOrdered },
      { to: '/fitness', label: 'Fitness & Form', icon: TrendingUp },
      { to: '/performance', label: 'Power & Performance', icon: Zap },
      { to: '/trends', label: 'Trends', icon: BarChart3 },
      { to: '/records', label: 'Records', icon: Trophy },
      { to: '/map', label: 'Heatmap', icon: MapIcon },
    ],
  },
  {
    group: 'Plan',
    items: [
      { to: '/calendar', label: 'Calendar', icon: CalendarDays },
      { to: '/workouts', label: 'Workout Builder', icon: Dumbbell },
      { to: '/season', label: 'Season Planner', icon: Flag },
    ],
  },
];

function SyncPill() {
  const { data } = useStatus();
  const sync = useAction(() => http('/sync', { method: 'POST' }));
  if (!data) return null;
  const connected = data.connections.filter((c) => c.connected);
  const busy = data.running || !!data.job || data.queue > 0;
  const label = data.job
    ? data.job.message ?? `${data.job.kind}…`
    : busy
      ? `Syncing · ${data.queue} queued`
      : connected.length
        ? `Synced · ${connected.map((c) => (c.provider === 'strava' ? 'Strava' : 'TrainingPeaks')).join(' + ')}`
        : data.demo
          ? 'Demo data'
          : 'No sources connected';
  return (
    <button
      onClick={() => connected.length && sync.mutate(undefined)}
      title={connected.length ? 'Sync now' : undefined}
      className="flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-2 text-left text-xs text-ink-2 hover:text-ink"
    >
      <RefreshCw className={clsx('h-3.5 w-3.5 shrink-0', busy && 'animate-spin text-accent')} />
      <span className="truncate">{label}</span>
    </button>
  );
}

function ThemeSwitch() {
  const { mode, setMode } = useTheme();
  const opts = [
    { v: 'light' as const, icon: Sun },
    { v: 'system' as const, icon: Monitor },
    { v: 'dark' as const, icon: Moon },
  ];
  return (
    <div className="flex rounded-lg border border-line bg-surface-2 p-0.5">
      {opts.map(({ v, icon: Icon }) => (
        <button key={v} onClick={() => setMode(v)} title={`${v} theme`} className={clsx('flex-1 rounded-md py-1', mode === v ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink')}>
          <Icon className="mx-auto h-3.5 w-3.5" />
        </button>
      ))}
    </div>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="flex h-full">
      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-[900] flex w-60 shrink-0 flex-col border-r border-line bg-surface transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2.5 px-5 pt-5 pb-4">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-white">
            <Activity className="h-4.5 w-4.5" strokeWidth={2.5} />
          </div>
          <div>
            <div className="text-[14px] leading-tight font-semibold">Training Analytics</div>
            <div className="text-[11px] text-muted">Analyze · Plan · Perform</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-3">
          {NAV.map((g) => (
            <div key={g.group ?? 'root'} className="mt-3">
              {g.group && <div className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-muted uppercase">{g.group}</div>}
              {g.items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/'}
                  className={({ isActive }) =>
                    clsx('mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition-colors', isActive ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')
                  }
                >
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
          <NavLink
            to="/settings"
            className={({ isActive }) => clsx('flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium', isActive ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}
          >
            <Settings className="h-4 w-4 text-muted" />
            Settings & Sync
          </NavLink>
          <SyncPill />
          <ThemeSwitch />
        </div>
      </aside>
      {open && <div className="fixed inset-0 z-[800] bg-black/40 lg:hidden" onClick={() => setOpen(false)} />}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="sticky top-0 z-[700] flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-2.5 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-md p-1.5 hover:bg-surface-2" aria-label="Menu">
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold">Training Analytics</span>
        </div>
        <div className="mx-auto max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
          <Suspense fallback={<Spinner />}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
