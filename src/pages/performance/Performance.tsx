import { lazy, Suspense, useMemo, useState } from 'react';
import { NavLink, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { qs, useApi } from '../../lib/api';
import { resolvePreset, type DateRange } from '../../lib/range';
import { useTokens } from '../../lib/theme';
import { foldEmptyBuckets } from '../../lib/timeline';
import { RangePicker } from '../../components/RangePicker';
import { Card, EmbedContext, PageHeader, Skeleton, Spinner } from '../../components/ui';
import { Overview } from './Overview';

const Power = lazy(() => import('./Power').then((m) => ({ default: m.Power })));
const Thresholds = lazy(() => import('../Thresholds').then((m) => ({ default: m.Thresholds })));
const Records = lazy(() => import('../Records').then((m) => ({ default: m.Records })));
const Comeback = lazy(() => import('../Comeback').then((m) => ({ default: m.Comeback })));
const TrainerRoad = lazy(() => import('../TrainerRoad').then((m) => ({ default: m.TrainerRoad })));
const AerobicFitnessCard = lazy(() => import('../../components/load').then((m) => ({ default: m.AerobicFitnessCard })));
const IntervalSets = lazy(() => import('../../components/trends').then((m) => ({ default: m.IntervalSets })));
const LineTrend = lazy(() => import('../../components/trends').then((m) => ({ default: m.LineTrend })));

interface Lens {
  id: string;
  label: string;
  /** the lens's heading, where it replaces the page it used to be */
  title?: string;
  subtitle?: string;
}

/**
 * The lenses of Performance: one overview, then the detail behind each part of it. They used to
 * be pages of their own; here they're views of the one athlete.
 */
export const LENSES: Lens[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'power', label: 'Power', title: 'Power', subtitle: 'Your best power for every duration, the model drawn through it, your profile and how well you hold power when tired' },
  { id: 'thresholds', label: 'Thresholds', title: 'Thresholds', subtitle: 'FTP, run threshold pace and swim pace, estimated every day from your best efforts' },
  { id: 'endurance', label: 'Endurance' },
  { id: 'sessions', label: 'Key sessions' },
  { id: 'records', label: 'Records', title: 'Records', subtitle: 'Your best efforts for every duration, ranked, and personal bests by year — each with your form going into it' },
  { id: 'peaks', label: 'Peaks', title: 'Peaks and comebacks', subtitle: 'How your best seasons were built, where you stand now, and what it takes to get back' },
  { id: 'trainerroad', label: 'TrainerRoad', title: 'TrainerRoad', subtitle: 'TrainerRoad’s view of you beside this app’s: its FTP, AI FTP Detection, progression levels, and how your rides felt' },
];

export function Performance() {
  const { lens } = useParams();
  const active = LENSES.find((l) => l.id === lens) ?? LENSES[0];
  return (
    <>
      <PageHeader eyebrow="Performance" title={active.id === 'overview' ? 'What you can do' : active.label} subtitle={active.id === 'overview' ? 'Your engine in one place: what it is now, how it’s changing, and how it compares with your best' : undefined} />
      <nav className="sticky top-0 z-20 -mx-4 mb-6 border-b border-line bg-page/90 px-4 backdrop-blur sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8" aria-label="Performance">
        <div className="flex gap-1 overflow-x-auto py-2 scrollbar-none">
          {LENSES.map((l) => (
            <NavLink key={l.id} to={l.id === 'overview' ? '/performance' : `/performance/${l.id}`} end className={({ isActive }) => clsx('shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-medium whitespace-nowrap transition-colors', isActive ? 'bg-inverse text-inverse-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink')}>
              {l.label}
            </NavLink>
          ))}
        </div>
      </nav>
      <EmbedContext.Provider value={{ embedded: true, title: active.title, subtitle: active.subtitle }}>
        <Suspense fallback={<Spinner />}>
          {active.id === 'overview' && <Overview />}
          {active.id === 'power' && <Power />}
          {active.id === 'thresholds' && <Thresholds />}
          {active.id === 'endurance' && <Endurance />}
          {active.id === 'sessions' && <Sessions />}
          {active.id === 'records' && <Records />}
          {active.id === 'peaks' && <Comeback />}
          {active.id === 'trainerroad' && <TrainerRoad />}
        </Suspense>
      </EmbedContext.Provider>
    </>
  );
}

interface TrendsData {
  buckets: { start: string; sports: Record<string, unknown>; decoupling: number | null }[];
}

/** The aerobic engine: what your heart rate says about fitness, and how well you hold steady efforts. */
function Endurance() {
  const t = useTokens();
  const [range, setRange] = useState<DateRange>(() => resolvePreset('365d'));
  const { data } = useApi<TrendsData>(`/trends${qs({ from: range.from, to: range.to, bucket: 'week' })}`);
  const items = useMemo(() => {
    const list = data?.buckets ?? [];
    const first = list.findIndex((b) => Object.keys(b.sports).length > 0);
    return foldEmptyBuckets(first > 0 ? list.slice(first) : list, (b) => Object.keys(b.sports).length === 0, 13);
  }, [data]);
  return (
    <>
      <AerobicFitnessCard />
      <Card
        className="mt-4"
        title="Aerobic decoupling"
        subtitle="How far heart rate drifts from power (or pace) over steady sessions of an hour or more, averaged over 4 weeks. Under 5% is aerobically durable."
        actions={<RangePicker value={range} onChange={setRange} presets={['90d', '180d', '365d', '730d', 'all']} />}
      >
        {data ? <LineTrend items={items as never} bucket="week" height={260} threshold={{ value: 5, label: '5%' }} lines={[{ name: 'Decoupling', color: t.series[2], get: (b: { decoupling: number | null }) => b.decoupling, fmt: (v: number) => `${v.toFixed(1)}%` }] as never} /> : <Skeleton className="h-[260px]" />}
      </Card>
    </>
  );
}

/** Your key sessions over time: the same workout getting stronger is the clearest sign of fitness. */
function Sessions() {
  const [range, setRange] = useState<DateRange>(() => resolvePreset('365d'));
  return (
    <Card
      title="Interval sets"
      subtitle="Each threshold, sweet spot, VO2 or sustained set by its average power, grouped by workout: a rising line is the same session getting stronger. Click a point to open the ride."
      actions={<RangePicker value={range} onChange={setRange} presets={['90d', '180d', '365d', '730d', 'all']} />}
    >
      <IntervalSets range={range} />
    </Card>
  );
}
