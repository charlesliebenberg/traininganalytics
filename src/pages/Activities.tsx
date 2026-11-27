import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowDown, ArrowUp, Search, X } from 'lucide-react';
import clsx from 'clsx';
import type { Activity, Sport } from '../../shared/types';
import { qs, useApi } from '../lib/api';
import { useRange } from '../lib/range';
import { useDebounced } from '../lib/hooks';
import { Button, Card, Input, PageHeader, Select, SportIcon, Spinner, Empty, Badge } from '../components/ui';
import { RangePicker } from '../components/RangePicker';
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNum, fmtPace, fmtSpeed, SPORT_LABEL } from '../lib/format';
import { activityTitle, sessionBrief, typeColor } from '../lib/session';
import { useTokens, type Tokens } from '../lib/theme';

interface ListResponse {
  items: Activity[];
  total: number;
  totals: { n: number; time: number; distance: number; tss: number; elevation: number };
}

const paceLike = (s: Sport) => s === 'run' || s === 'swim' || s === 'walk' || s === 'hike';

/** `show`: the breakpoint from which a secondary column appears, so the table fits without scrolling sideways. */
const COLS: { key: string; label: string; sort?: string; align?: 'right'; render: (a: Activity, t: Tokens) => React.ReactNode; title?: string; show?: string }[] = [
  { key: 'date', label: 'Date', sort: 'date', render: (a) => <span className="text-ink-2">{fmtDate(a.localDate, 'EEE d MMM yy')}</span> },
  {
    key: 'name',
    label: 'Activity',
    sort: 'name',
    render: (a) => {
      const title = activityTitle(a);
      return (
        <span className="flex min-w-0 items-center gap-2" title={title !== a.name ? `${a.name} · planned as ${title}` : undefined}>
          <SportIcon sport={a.sport} />
          <span className="truncate font-medium text-ink">{title}</span>
          {a.trainer && <Badge>Indoor</Badge>}
          {!a.detailed && <Badge>Summary</Badge>}
        </span>
      );
    },
  },
  {
    key: 'session',
    label: 'Session',
    title: 'What the session was, read from its power or pace: its kind and main set',
    show: 'lg',
    render: (a, t) => {
      const brief = sessionBrief(a);
      return brief ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: typeColor(t, a.sessionType!) }} />
          <span className="truncate">{brief}</span>
        </span>
      ) : (
        <span className="text-muted">–</span>
      );
    },
  },
  { key: 'time', label: 'Time', sort: 'duration', align: 'right', render: (a) => fmtDuration(a.movingTime) },
  { key: 'dist', label: 'Distance', sort: 'distance', align: 'right', render: (a) => (a.distance ? fmtDistance(a.distance, 1, a.sport) : '–') },
  { key: 'elev', label: 'Elev', sort: 'elevation', align: 'right', render: (a) => (a.elevationGain ? fmtElevation(a.elevationGain) : '–'), show: '2xl' },
  { key: 'tss', label: 'TSS', sort: 'tss', align: 'right', render: (a) => <span className="font-medium text-ink">{fmtNum(a.tss)}</span> },
  { key: 'if', label: 'IF', sort: 'if', align: 'right', render: (a) => fmtNum(a.intensity, 2), title: 'Intensity factor', show: 'xl' },
  { key: 'np', label: 'NP', sort: 'np', align: 'right', render: (a) => (a.np ? `${a.np} W` : '–'), title: 'Normalized Power' },
  { key: 'hr', label: 'Avg HR', sort: 'hr', align: 'right', render: (a) => fmtNum(a.avgHr), show: 'xl' },
  { key: 'speed', label: 'Speed / pace', sort: 'speed', align: 'right', render: (a) => (paceLike(a.sport) ? fmtPace(a.avgSpeed, a.sport) : fmtSpeed(a.avgSpeed)), show: '2xl' },
  { key: 'ef', label: 'EF', sort: 'ef', align: 'right', render: (a) => fmtNum(a.ef, 2), title: 'Efficiency factor (NP or NGP ÷ HR)', show: '2xl' },
  { key: 'dec', label: 'Decoupling', sort: 'decoupling', align: 'right', render: (a) => (a.decoupling != null ? `${a.decoupling.toFixed(1)}%` : '–'), title: 'Aerobic decoupling (Pw:HR / Pa:HR)', show: '2xl' },
  { key: 'work', label: 'Work', sort: 'work', align: 'right', render: (a) => (a.work ? `${fmtNum(a.work)} kJ` : '–'), show: '2xl' },
];
// whole class names, so Tailwind sees them
const SHOW: Record<string, string> = { lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell', '2xl': 'hidden 2xl:table-cell' };

const SORT_OPTIONS = [
  { value: 'date', label: 'Newest first', dir: 'desc' },
  { value: 'tss', label: 'Most TSS', dir: 'desc' },
  { value: 'duration', label: 'Longest', dir: 'desc' },
  { value: 'distance', label: 'Farthest', dir: 'desc' },
  { value: 'np', label: 'Highest NP', dir: 'desc' },
  { value: 'name', label: 'Name A–Z', dir: 'asc' },
] as const;

/** One activity as a row on a phone: what it was, when, and its load. */
function MobileRow({ a }: { a: Activity }) {
  const t = useTokens();
  const detail = [fmtDuration(a.movingTime, { short: true }), a.distance ? fmtDistance(a.distance, 1, a.sport) : null, a.np ? `${a.np} W NP` : paceLike(a.sport) && a.avgSpeed ? fmtPace(a.avgSpeed, a.sport) : null].filter(Boolean).join(' · ');
  const brief = sessionBrief(a);
  return (
    <Link to={`/activities/${a.id}`} className="flex items-center gap-3 px-4 py-3 active:bg-surface-2">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2">
        <SportIcon sport={a.sport} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink">{activityTitle(a)}</span>
          {a.trainer && <Badge>Indoor</Badge>}
        </div>
        <div className="truncate text-[11px] text-muted">
          {fmtDate(a.localDate, 'EEE d MMM')} · {detail}
        </div>
        {brief && (
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] text-ink-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: typeColor(t, a.sessionType!) }} />
            {brief}
          </div>
        )}
      </div>
      <div className="tnum shrink-0 text-right">
        <div className="text-sm font-semibold text-ink">{fmtNum(a.tss)}</div>
        <div className="text-[10px] text-muted uppercase">TSS</div>
      </div>
    </Link>
  );
}

export function Activities() {
  const t = useTokens();
  const { range } = useRange();
  // filters live in the URL: coming back from an activity finds the list as you left it
  const [params, setParams] = useSearchParams();
  const sport = (params.get('sport') ?? '') as Sport | '';
  const sort = params.get('sort') ?? 'date';
  const dir = params.get('dir') === 'asc' ? 'asc' : 'desc';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 300);
  const [limit, setLimit] = useState(100);
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(patch)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: true },
    );
  useEffect(() => {
    if (q !== (params.get('q') ?? '')) set({ q: q || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);
  // a new filter starts from the first page again
  useEffect(() => setLimit(100), [range.from, range.to, sport, q, sort, dir]);
  const { data, isLoading, isFetching } = useApi<ListResponse>(`/activities${qs({ from: range.from, to: range.to, sport, search: q, sort, dir, limit })}`, { placeholderData: (p) => p });
  const sortBy = (key: string) => {
    if (sort === key) set({ dir: dir === 'asc' ? 'desc' : 'asc' });
    else set({ sort: key === 'date' ? null : key, dir: key === 'name' ? 'asc' : null });
  };
  const filtered = !!(sport || q);

  return (
    <div>
      <PageHeader
        title="Activities"
        subtitle={data ? `${data.total.toLocaleString()} ${data.total === 1 ? 'activity' : 'activities'} · ${fmtDuration(data.totals.time ?? 0, { short: true })} · ${fmtDistance(data.totals.distance ?? 0, 0)} · ${fmtNum(data.totals.tss ?? 0)} TSS` : undefined}
        actions={
          <>
            <div className="relative w-full sm:w-auto">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted" />
              <Input placeholder="Search activities" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setSearch('')} className="w-full pr-8 pl-8 sm:w-56" aria-label="Search activities" />
              {search && (
                <button onClick={() => setSearch('')} className="absolute top-2 right-2 rounded p-0.5 text-muted hover:text-ink" aria-label="Clear search">
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <Select value={sport} onChange={(e) => set({ sport: e.target.value || null })} aria-label="Sport">
              <option value="">All sports</option>
              {Object.entries(SPORT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select className="md:hidden" value={sort} onChange={(e) => set({ sort: e.target.value === 'date' ? null : e.target.value, dir: SORT_OPTIONS.find((o) => o.value === e.target.value)?.dir === 'asc' ? 'asc' : null })} aria-label="Sort">
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <RangePicker />
          </>
        }
      />
      <Card pad={false}>
        {isLoading ? (
          <Spinner />
        ) : !data?.items.length ? (
          <Empty title={filtered ? 'Nothing matches' : 'No activities in this range'}>
            {filtered ? (
              <>
                No {sport ? SPORT_LABEL[sport].toLowerCase() : 'activity'}
                {q ? ` matching “${q}”` : ''} in {range.label.toLowerCase()}.{' '}
                <button
                  className="text-accent hover:underline"
                  onClick={() => {
                    setSearch('');
                    set({ sport: null, q: null });
                  }}
                >
                  Clear filters
                </button>
              </>
            ) : (
              'Try a wider date range, or import files from Settings.'
            )}
          </Empty>
        ) : (
          <>
            <div className={clsx('divide-y divide-line/70 md:hidden', isFetching && 'opacity-70')}>
              {data.items.map((a) => (
                <MobileRow key={a.id} a={a} />
              ))}
            </div>
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                    {COLS.map((c) => (
                      <th
                        key={c.key}
                        title={c.title}
                        scope="col"
                        aria-sort={sort === c.sort ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        className={clsx('px-3 py-2.5 font-medium whitespace-nowrap first:pl-5 last:pr-5', c.align === 'right' && 'text-right', c.show && SHOW[c.show])}
                      >
                        {c.sort ? (
                          <button onClick={() => sortBy(c.sort!)} className={clsx('inline-flex items-center gap-1 uppercase hover:text-ink', c.align === 'right' && 'flex-row-reverse', sort === c.sort && 'text-ink')}>
                            {c.label}
                            {sort === c.sort && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                          </button>
                        ) : (
                          c.label
                        )}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className={clsx('tnum', isFetching && 'opacity-70')}>
                  {data.items.map((a) => (
                    <tr key={a.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2">
                      {COLS.map((c) => (
                        <td key={c.key} className={clsx('px-3 py-2 whitespace-nowrap text-ink-2 first:pl-5 last:pr-5', c.align === 'right' && 'text-right', c.key === 'name' && 'max-w-[280px]', c.key === 'session' && 'max-w-[240px]', c.show && SHOW[c.show])}>
                          <Link to={`/activities/${a.id}`} className="block min-w-0" tabIndex={c.key === 'name' ? 0 : -1}>
                            {c.render(a, t)}
                          </Link>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.items.length < data.total && (
              <div className="flex justify-center border-t border-line p-4">
                <Button onClick={() => setLimit(limit + 100)} loading={isFetching}>
                  Load more ({(data.total - data.items.length).toLocaleString()} remaining)
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
