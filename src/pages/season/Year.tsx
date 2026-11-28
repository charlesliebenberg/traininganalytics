import { useMemo, useState, type ReactNode } from 'react';
import { qs, useApi } from '../../lib/api';
import { resolvePreset, type DateRange } from '../../lib/range';
import { useTokens } from '../../lib/theme';
import { fmtNum, iso } from '../../lib/format';
import { foldEmptyBuckets, isGap } from '../../lib/timeline';
import { acwr, monotonyStrain } from '../../../shared/analytics/pmc';
import type { PmcPoint } from '../../../shared/types';
import { RangePicker } from '../../components/RangePicker';
import { RecoveryCard } from '../../components/sleep';
import { ReviewCard } from '../../components/review';
import { Card, PageHeader, Segmented, Select, Skeleton, Stat } from '../../components/ui';
import { LineTrend, METRICS, SessionMix, VolumeChart, YearOverYear, ZoneDistribution, type Item, type Metric, type TrendsData } from '../../components/trends';
import { LoadCalendar, MonotonyChart, RampChart } from '../../components/load';

/**
 * The season zoomed out: a year of load day by day, what it was made of, whether it was built
 * safely, how you slept on it, and how it stacks up against other years.
 */
export function SeasonYear({ lens }: { lens: ReactNode }) {
  const t = useTokens();
  const [range, setRange] = useState<DateRange>(() => resolvePreset('365d'));
  const [bucket, setBucket] = useState<'week' | 'month'>('week');
  const [metric, setMetric] = useState<Metric>('time');
  const [zoneKind, setZoneKind] = useState<'sessions' | 'power' | 'hr' | 'seiler'>('sessions');
  const [yoy, setYoy] = useState<'distance' | 'time' | 'tss'>('distance');
  const { data, isLoading } = useApi<TrendsData>(`/trends${qs({ from: range.from, to: range.to, bucket })}`);
  const today = iso(new Date());
  const pmc = useApi<PmcPoint[]>(`/pmc${qs({ from: range.from, to: today })}`);
  const items: Item[] = useMemo(() => {
    const list = data?.buckets ?? [];
    const first = list.findIndex((b) => Object.keys(b.sports).length > 0);
    return foldEmptyBuckets(first > 0 ? list.slice(first) : list, (b) => Object.keys(b.sports).length === 0, bucket === 'week' ? 13 : 3);
  }, [data, bucket]);
  const folded = items.some(isGap);
  const points = pmc.data?.filter((p) => !p.projected) ?? [];
  const now = points[points.length - 1];
  const ms = useMemo(() => (points.length ? monotonyStrain(points.map((p) => p.tss)).pop() : null), [points]);

  return (
    <>
      <PageHeader
        eyebrow="Season"
        title="The year"
        subtitle="Your training zoomed out: the load day by day, what it was made of, whether it was built safely, and how it compares with other years"
        actions={
          <>
            {lens}
            <Segmented value={bucket} onChange={setBucket} options={[{ value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
            <RangePicker value={range} onChange={setRange} presets={['90d', '180d', '365d', '730d', 'ytd', 'lastyear', 'all']} />
          </>
        }
      />

      {/* a block reviewed: the last week, or four, or eight, against your normal */}
      <div className="mb-4">
        <ReviewCard />
      </div>

      {/* how the load is being carried, today */}
      <div className="card mb-4 grid grid-cols-2 gap-5 p-5 sm:grid-cols-4">
        <Stat label="Ramp rate" accent={t.ctl} value={now ? `${now.ramp >= 0 ? '+' : ''}${fmtNum(now.ramp, 1)}` : '–'} unit="a week" sub="fitness gained: keep most weeks under 5–8" />
        <Stat label="Acute : chronic" value={now ? fmtNum(acwr(now.atl, now.ctl), 2) : '–'} sub="0.8–1.3 is the sweet spot" title="This week's load against your usual: above 1.5 is a spike" />
        <Stat label="Monotony" value={fmtNum(ms?.monotony, 2)} sub="over 2 for long is a warning" title="Foster: low day-to-day variation plus high load predicts illness and overreaching" />
        <Stat label="Strain" value={fmtNum(ms?.strain)} sub="this week’s load × monotony" />
      </div>

      <Card className="mb-4" title="Every day of the last year" subtitle="Daily load: darker is harder">
        <LoadCalendar />
      </Card>

      {isLoading || !data ? (
        <Skeleton className="h-80 !rounded-2xl" />
      ) : (
        <>
          <Card
            className="mb-4"
            title="Volume"
            subtitle={`${METRICS.find((m) => m.value === metric)?.label} per ${bucket}, by sport${folded ? ' · breaks of 3+ months fold into one column' : ''}`}
            actions={
              <Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} aria-label="Measure">
                {METRICS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </Select>
            }
          >
            <VolumeChart items={items} metric={metric} bucket={bucket} />
          </Card>
          <div className="mb-4 grid gap-4 xl:grid-cols-2">
            <Card
              title={zoneKind === 'sessions' ? 'What it was made of' : 'Intensity'}
              subtitle={zoneKind === 'sessions' ? `Rides and runs per ${bucket} by what they were` : zoneKind === 'seiler' ? 'Three zones: below the first threshold, between, above the second' : 'Share of time in each zone'}
              actions={<Segmented size="sm" value={zoneKind} onChange={setZoneKind} options={[{ value: 'sessions', label: 'Sessions' }, { value: 'seiler', label: '3-zone' }, { value: 'power', label: 'Power' }, { value: 'hr', label: 'HR' }]} />}
            >
              {zoneKind === 'sessions' ? <SessionMix items={items} bucket={bucket} /> : <ZoneDistribution items={items} kind={zoneKind} bucket={bucket} />}
            </Card>
            <Card title="Polarization" subtitle={`Treff’s index, ${bucket === 'week' ? 'over the 4 weeks to each week' : 'by month'}: above 2 is polarized; below, pyramidal or threshold-heavy`}>
              <LineTrend items={items} bucket={bucket} height={280} threshold={{ value: 2, label: 'polarized' }} lines={[{ name: 'Polarization index', color: t.series[6], get: (b) => b.polarization, fmt: (v) => v.toFixed(2) }]} />
            </Card>
          </div>
        </>
      )}

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card title="Ramp rate, week by week" subtitle="Fitness gained each week: most under 5–8">
          {points.length ? <RampChart points={points.slice(-7 * 52)} /> : <Skeleton className="h-[230px]" />}
        </Card>
        <Card title="Monotony and strain" subtitle="Low day-to-day variation with high load is the pattern that precedes illness">
          {pmc.data ? <MonotonyChart points={pmc.data} /> : <Skeleton className="h-[230px]" />}
        </Card>
      </div>

      <RecoveryCard from={range.from} to={range.to < today ? range.to : today} />

      <Card className="mt-4" title="Year over year" subtitle="Running totals by day of the year, every year you trained: this year and your biggest highlighted" actions={<Segmented size="sm" value={yoy} onChange={setYoy} options={[{ value: 'distance', label: 'Distance' }, { value: 'time', label: 'Time' }, { value: 'tss', label: 'TSS' }]} />}>
        <YearOverYear metric={yoy} />
      </Card>
    </>
  );
}
