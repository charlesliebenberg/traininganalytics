import { Link } from 'react-router-dom';
import { Bike, Footprints, Mountain, Flame, Zap, Gauge } from 'lucide-react';
import { useApi } from '../lib/api';
import { Card, PageHeader, Spinner, Empty } from '../components/ui';
import { BestEffortsCard } from '../components/efforts';
import { fmtDate, fmtDistance, fmtDurLabel, fmtDuration, fmtElevation, fmtNum, fmtPace } from '../lib/format';

interface Rec {
  id: number;
  name: string;
  local_date: string;
  value: number;
}
interface RecordsData {
  years: string[];
  powerYears: string[];
  runYears: string[];
  run: { key: string; label: string; meters: number; time: number; id: number; date: string; name: string; byYear: Record<string, number> }[];
  peaks: ({ duration: number; all: { value: number; id: number; date: string } | null } & Record<string, { value: number; id: number; date: string } | null | number>)[];
  highlights: Record<string, Rec | null>;
}

const HIGHLIGHTS: { key: string; label: string; icon: typeof Bike; fmt: (v: number) => string }[] = [
  { key: 'longestRide', label: 'Longest ride', icon: Bike, fmt: (v) => fmtDistance(v, 1) },
  { key: 'longestRun', label: 'Longest run', icon: Footprints, fmt: (v) => fmtDistance(v, 1) },
  { key: 'mostClimbing', label: 'Most climbing', icon: Mountain, fmt: fmtElevation },
  { key: 'biggestTss', label: 'Biggest day (TSS)', icon: Flame, fmt: (v) => fmtNum(v) },
  { key: 'mostWork', label: 'Most work', icon: Zap, fmt: (v) => `${fmtNum(v)} kJ` },
  { key: 'highestNp', label: 'Highest NP (>30 min)', icon: Gauge, fmt: (v) => `${fmtNum(v)} W` },
];

export function Records() {
  const { data, isLoading } = useApi<RecordsData>('/records');
  if (isLoading || !data) return <Spinner />;
  // every year with data, newest first (the tables scroll sideways on small screens)
  const years = [...data.powerYears].reverse();
  const runYears = [...data.runYears].reverse();
  return (
    <div>
      <PageHeader title="Records" subtitle="Your best efforts for any duration, all of them ranked, and personal bests by year" />
      <BestEffortsCard />
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {HIGHLIGHTS.map(({ key, label, icon: Icon, fmt }) => {
          const r = data.highlights[key];
          return (
            <Link key={key} to={r ? `/activities/${r.id}` : '#'} className="card block p-4 hover:border-line-strong">
              <div className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted uppercase">
                <Icon className="h-3.5 w-3.5" />
                {label}
              </div>
              <div className="mt-1.5 text-xl font-semibold">{r?.value ? fmt(r.value) : '–'}</div>
              {r && <div className="mt-0.5 truncate text-xs text-ink-2">{r.name}</div>}
              {r && <div className="text-[11px] text-muted">{fmtDate(r.local_date, 'd MMM yyyy')}</div>}
            </Link>
          );
        })}
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Peak power" subtitle="Best mean-maximal power by year" pad={false}>
          <div className="overflow-x-auto">
          <table className="tnum w-full min-w-[480px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="py-2 pl-5 font-medium">Duration</th>
                <th className="px-3 text-right font-medium">All time</th>
                {years.map((y) => (
                  <th key={y} className="px-3 text-right font-medium last:pr-5">
                    {y}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.peaks.map((p) => (
                <tr key={p.duration} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pl-5 font-medium">{fmtDurLabel(p.duration)}</td>
                  <td className="px-3 text-right">
                    {p.all ? (
                      <Link to={`/activities/${p.all.id}`} className="font-semibold text-accent hover:underline" title={fmtDate(p.all.date)}>
                        {p.all.value} W
                      </Link>
                    ) : (
                      '–'
                    )}
                  </td>
                  {years.map((y) => {
                    const v = p[y] as { value: number; id: number; date: string } | null;
                    return (
                      <td key={y} className="px-3 text-right text-ink-2 last:pr-5">
                        {v ? (
                          <Link to={`/activities/${v.id}`} className="hover:text-ink" title={fmtDate(v.date)}>
                            {v.value}
                          </Link>
                        ) : (
                          '–'
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
        <Card title="Running best efforts" subtitle="Fastest time over each distance within any run — GPS glitches (jumps between buildings, a watch starting before lock) are filtered out" pad={false}>
          {!data.run.length ? (
            <Empty title="No runs with distance data yet" />
          ) : (
            <div className="overflow-x-auto">
            <table className="tnum w-full min-w-[480px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  <th className="py-2 pl-5 font-medium">Distance</th>
                  <th className="px-3 text-right font-medium">Best</th>
                  <th className="px-3 text-right font-medium">Pace</th>
                  {runYears.map((y) => (
                    <th key={y} className="px-3 text-right font-medium last:pr-5">
                      {y}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.run.map((r) => (
                  <tr key={r.key} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5 pl-5 font-medium">{r.label}</td>
                    <td className="px-3 text-right">
                      <Link to={`/activities/${r.id}`} className="font-semibold text-accent hover:underline" title={`${r.name} · ${fmtDate(r.date)}`}>
                        {fmtDuration(r.time)}
                      </Link>
                    </td>
                    <td className="px-3 text-right text-ink-2">{fmtPace(r.meters / r.time, 'run')}</td>
                    {runYears.map((y) => (
                      <td key={y} className="px-3 text-right text-ink-2 last:pr-5">
                        {r.byYear[y] ? fmtDuration(r.byYear[y]) : '–'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
