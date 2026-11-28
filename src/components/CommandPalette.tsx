import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { CornerDownLeft, Flag, Monitor, Moon, Plus, RefreshCw, Search, Sun, Upload } from 'lucide-react';
import type { Activity, RaceEvent } from '../../shared/types';
import { http, qs, useAction, useApi } from '../lib/api';
import { useDebounced, isTyping } from '../lib/hooks';
import { DESTINATIONS } from '../lib/nav';
import { useInspect } from '../lib/inspect';
import { useTheme } from '../lib/theme';
import { fmtDate, fmtDistance, fmtDuration } from '../lib/format';
import { SportIcon } from './ui';
import { activityTitle, sessionBrief } from '../lib/session';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  run: () => void;
}

/** Fuzzy enough: every word typed appears somewhere in the label or its keywords. */
const matches = (q: string, ...text: (string | undefined)[]) => {
  const hay = text.filter(Boolean).join(' ').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
};

/**
 * ⌘K / Ctrl+K (or "/"): jump to any page, find an activity by name, or run a common action,
 * without leaving the keyboard.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const { setMode } = useTheme();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const dq = useDebounced(q.trim(), 150);
  const acts = useApi<{ items: Activity[] }>(open ? `/activities${qs({ search: dq.length >= 2 ? dq : undefined, limit: dq.length >= 2 ? 8 : 5, from: '2000-01-01' })}` : null, { placeholderData: (p) => p });
  const events = useApi<RaceEvent[]>(open ? '/events' : null);
  const inspect = useInspect();
  const sync = useAction(() => http('/sync', { method: 'POST' }), { success: 'Sync started' });

  useEffect(() => {
    if (!open) return;
    setQ('');
    setActive(0);
    // focus after the dialog is painted
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const go = (to: string) => () => {
      nav(to);
      onClose();
    };
    const lq = q.toLowerCase();
    const rank = (label: string) => (label.toLowerCase().startsWith(lq) ? 0 : label.toLowerCase().includes(lq) ? 1 : 2);
    const pages: Item[] = DESTINATIONS.filter((p) => (q ? matches(q, p.label, p.hint, p.keywords) : p.to.split('/').length <= 2 && !p.to.includes('?')))
      .sort((a, b) => (q ? rank(a.label) - rank(b.label) : 0))
      .map((p) => ({
      id: `page:${p.to}`,
      group: 'Go to',
      label: p.label,
      hint: p.hint !== p.label ? p.hint : undefined,
      icon: <p.icon className="h-4 w-4" />,
      run: go(p.to),
    }));
    const today = new Date().toISOString().slice(0, 10);
    const races: Item[] = (events.data ?? [])
      .filter((e) => e.date >= today && (!q || matches(q, e.name, 'race event', e.priority)))
      .slice(0, 4)
      .map((e) => ({
        id: `race:${e.id}`,
        group: 'Races',
        label: e.name,
        hint: `${e.priority} · ${fmtDate(e.date, 'EEE d MMM yyyy')}`,
        icon: <Flag className="h-4 w-4" />,
        run: () => {
          inspect.open('e', e.id);
          onClose();
        },
      }));
    const actions: Item[] = [
      { id: 'act:workout', group: 'Actions', label: 'New workout', hint: 'Workout builder', icon: <Plus className="h-4 w-4" />, run: go('/season/workouts'), k: 'create build structured' },
      { id: 'act:import', group: 'Actions', label: 'Import activity files', hint: 'FIT, TCX, GPX, ZIP', icon: <Upload className="h-4 w-4" />, run: go('/settings?tab=import'), k: 'upload trainingpeaks' },
      {
        id: 'act:sync',
        group: 'Actions',
        label: 'Sync now',
        hint: 'Strava, Eight Sleep, TrainerRoad',
        icon: <RefreshCw className="h-4 w-4" />,
        run: () => {
          sync.mutate(undefined);
          onClose();
        },
        k: 'refresh strava',
      },
      { id: 'act:light', group: 'Actions', label: 'Light theme', icon: <Sun className="h-4 w-4" />, run: () => (setMode('light'), onClose()), k: 'appearance' },
      { id: 'act:dark', group: 'Actions', label: 'Dark theme', icon: <Moon className="h-4 w-4" />, run: () => (setMode('dark'), onClose()), k: 'appearance' },
      { id: 'act:system', group: 'Actions', label: 'System theme', icon: <Monitor className="h-4 w-4" />, run: () => (setMode('system'), onClose()), k: 'appearance auto' },
    ]
      .filter((a) => !q || matches(q, a.label, a.hint, a.k))
      .map(({ k: _k, ...a }) => a);
    const activities: Item[] = (acts.data?.items ?? []).map((a) => ({
      id: `activity:${a.id}`,
      group: dq.length >= 2 ? 'Activities' : 'Recent activities',
      label: activityTitle(a),
      hint: `${fmtDate(a.localDate, 'EEE d MMM yyyy')} · ${sessionBrief(a) ?? `${fmtDuration(a.movingTime, { short: true })}${a.distance ? ` · ${fmtDistance(a.distance, 1, a.sport)}` : ''}`}`,
      icon: <SportIcon sport={a.sport} />,
      // opens beside the page you're on
      run: () => {
        inspect.open('a', a.id);
        onClose();
      },
    }));
    // with a query, what it names comes first; without one, places lead
    return q ? [...pages, ...races, ...activities, ...actions] : [...pages, ...races, ...actions, ...activities];
  }, [q, dq, acts.data, events.data, inspect, nav, onClose, setMode, sync]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(items.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[active]?.run();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };
  let lastGroup = '';
  return (
    <div className="animate-fade fixed inset-0 z-[1100] flex items-start justify-center bg-black/40 p-4 pt-[12vh] backdrop-blur-[3px]" onMouseDown={onClose}>
      <div className="animate-rise w-full max-w-[600px] overflow-hidden rounded-2xl border border-line bg-surface shadow-lg" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label="Search and jump to">
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Go anywhere, find a ride or a race…"
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder:text-muted focus:outline-none focus-visible:outline-none"
            role="combobox"
            aria-expanded
            aria-controls="palette-list"
            aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          />
          <kbd className="hidden rounded border border-line px-1.5 py-0.5 text-[10px] text-muted sm:block">Esc</kbd>
        </div>
        <div ref={list} id="palette-list" role="listbox" className="max-h-[min(60vh,440px)] overflow-y-auto p-1.5">
          {items.length === 0 && <p className="px-3 py-8 text-center text-xs text-muted">{acts.isFetching ? 'Searching…' : `Nothing matches “${q}”.`}</p>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {header && <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">{it.group}</div>}
                <button
                  id={`palette-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={it.run}
                  className={clsx('flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left', i === active ? 'bg-surface-2 text-ink' : 'text-ink-2')}
                >
                  <span className={clsx('flex h-4 w-4 shrink-0 items-center justify-center', i === active ? 'text-ink' : 'text-muted')}>{it.icon}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{it.label}</span>
                  {it.hint && <span className="hidden max-w-[50%] truncate text-[11px] text-muted sm:block">{it.hint}</span>}
                  {i === active && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-muted" />}
                </button>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>
            <kbd className="font-sans">↑↓</kbd> to move
          </span>
          <span>
            <kbd className="font-sans">↵</kbd> to open
          </span>
          <span className="ml-auto">
            <kbd className="font-sans">⌘K</kbd> anywhere
          </span>
        </div>
      </div>
    </div>
  );
}

/** Opens the palette on ⌘K / Ctrl+K anywhere, or "/" when not typing. */
export function usePaletteShortcut(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === '/' && !isTyping(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setOpen(() => true);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [setOpen]);
}
