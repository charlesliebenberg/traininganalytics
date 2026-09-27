import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import clsx from 'clsx';
import type { Activity, Sport } from '../../shared/types';
import { qs, useApi } from '../lib/api';
import { useRange } from '../lib/range';
import { Button, Card, Input, PageHeader, Select, SportIcon, Spinner, Empty, Badge } from '../components/ui';
import { RangePicker } from '../components/RangePicker';
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNum, fmtPace, fmtSpeed, SPORT_LABEL } from '../lib/format';

interface ListResponse {
  items: Activity[];
  total: number;
  totals: { n: number; time: number; distance: number; tss: number; elevation: number };
}

const COLS: { key: string; label: string; sort?: string; align?: 'right'; render: (a: Activity) => React.ReactNode; title?: string }[] = [
  { key: 'date', label: 'Date', sort: 'date', render: (a) => <span className="text-ink-2">{fmtDate(a.startTime, 'EEE d MMM yy')}</span> },
  {
    key: 'name',
    label: 'Activity',
    sort: 'name',
    render: (a) => (
      <span className="flex min-w-0 items-center gap-2">
        <SportIcon sport={a.sport} />
        <span className="truncate font-medium text-ink">{a.name}</span>
        {a.trainer && <Badge>Indoor</Badge>}
        {!a.detailed && <Badge>Summary</Badge>}
      </span>
    ),
  },
  { key: 'time', label: 'Time', sort: 'duration', align: 'right', render: (a) => fmtDuration(a.movingTime) },
  { key: 'dist', label: 'Distance', sort: 'distance', align: 'right', render: (a) => (a.distance ? fmtDistance(a.distance, 1, a.sport) : '–') },
  { key: 'elev', label: 'Elev', sort: 'elevation', align: 'right', render: (a) => (a.elevationGain ? fmtElevation(a.elevationGain) : '–') },
  { key: 'tss', label: 'TSS', sort: 'tss', align: 'right', render: (a) => <span className="font-medium text-ink">{fmtNum(a.tss)}</span> },
  { key: 'if', label: 'IF', sort: 'if', align: 'right', render: (a) => fmtNum(a.intensity, 2) },
  { key: 'np', label: 'NP', sort: 'np', align: 'right', render: (a) => (a.np ? `${a.np} W` : '–'), title: 'Normalized Power' },
  { key: 'hr', label: 'Avg HR', sort: 'hr', align: 'right', render: (a) => fmtNum(a.avgHr) },
  { key: 'speed', label: 'Speed / pace', sort: 'speed', align: 'right', render: (a) => (a.sport === 'run' || a.sport === 'swim' || a.sport === 'walk' || a.sport === 'hike' ? fmtPace(a.avgSpeed, a.sport) : fmtSpeed(a.avgSpeed)) },
  { key: 'ef', label: 'EF', sort: 'ef', align: 'right', render: (a) => fmtNum(a.ef, 2), title: 'Efficiency factor (NP or NGP ÷ HR)' },
  { key: 'dec', label: 'Decoupling', sort: 'decoupling', align: 'right', render: (a) => (a.decoupling != null ? `${a.decoupling.toFixed(1)}%` : '–'), title: 'Aerobic decoupling (Pw:HR / Pa:HR)' },
  { key: 'work', label: 'Work', sort: 'work', align: 'right', render: (a) => (a.work ? `${fmtNum(a.work)} kJ` : '–') },
];

export function Activities() {
  const { range } = useRange();
  const [sport, setSport] = useState<Sport | ''>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('date');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [limit, setLimit] = useState(100);
  const { data, isLoading, isFetching } = useApi<ListResponse>(`/activities${qs({ from: range.from, to: range.to, sport, search, sort, dir, limit })}`, { placeholderData: (p) => p });

  return (
    <div>
      <PageHeader
        title="Activities"
        subtitle={data ? `${data.total} activities · ${fmtDuration(data.totals.time ?? 0, { short: true })} · ${fmtDistance(data.totals.distance ?? 0, 0)} · ${fmtNum(data.totals.tss ?? 0)} TSS` : undefined}
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-2.5 left-2.5 h-4 w-4 text-muted" />
              <Input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="w-48 pl-8" />
            </div>
            <Select value={sport} onChange={(e) => setSport(e.target.value as Sport | '')}>
              <option value="">All sports</option>
              {Object.entries(SPORT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
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
          <Empty title="No activities in this range">Try a wider date range or a different sport filter.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  {COLS.map((c) => (
                    <th
                      key={c.key}
                      title={c.title}
                      className={clsx('px-3 py-2.5 font-medium whitespace-nowrap first:pl-5 last:pr-5', c.align === 'right' && 'text-right', c.sort && 'cursor-pointer hover:text-ink')}
                      onClick={() => {
                        if (!c.sort) return;
                        if (sort === c.sort) setDir(dir === 'asc' ? 'desc' : 'asc');
                        else {
                          setSort(c.sort);
                          setDir(c.sort === 'name' ? 'asc' : 'desc');
                        }
                      }}
                    >
                      <span className={clsx('inline-flex items-center gap-1', c.align === 'right' && 'flex-row-reverse')}>
                        {c.label}
                        {sort === c.sort && (dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={clsx('tnum', isFetching && 'opacity-70')}>
                {data.items.map((a) => (
                  <tr key={a.id} className="border-b border-line/60 last:border-0 hover:bg-surface-2">
                    {COLS.map((c) => (
                      <td key={c.key} className={clsx('px-3 py-2 whitespace-nowrap text-ink-2 first:pl-5 last:pr-5', c.align === 'right' && 'text-right', c.key === 'name' && 'max-w-[320px]')}>
                        <Link to={`/activities/${a.id}`} className="block min-w-0">
                          {c.render(a)}
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {data.items.length < data.total && (
              <div className="flex justify-center p-4">
                <Button onClick={() => setLimit(limit + 100)} loading={isFetching}>
                  Load more ({data.total - data.items.length} remaining)
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
