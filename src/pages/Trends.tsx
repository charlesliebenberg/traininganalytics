import { useMemo, useState } from 'react';
import { parseISO, getDayOfYear, subYears, startOfYear } from 'date-fns';
import { qs, useApi } from '../lib/api';
import { resolvePreset, type DateRange } from '../lib/range';
import { alpha, useTokens } from '../lib/theme';
import { distValue, distUnit, elevUnit, elevValue, fmtDate, fmtNum, iso, SPORT_LABEL } from '../lib/format';
import { Card, PageHeader, Segmented, Select, Spinner } from '../components/ui';
import { RangePicker } from '../components/RangePicker';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { HR_ZONES, POWER_ZONES, SEILER_ZONES } from '../../shared/analytics/zones';
import type { DailyLoad } from '../../shared/types';

interface Bucket {
  start: string;
  sports: Record<string, { time: number; distance: number; elevation: number; tss: number; count: number; work: number }>;
  power: number[];
  hr: number[];
  seiler: number[];
  polarization: number | null;
  efRide: number | null;
  efRun: number | null;
  decoupling: number | null;
}

type Metric = 'time' | 'distance' | 'tss' | 'elevation' | 'count' | 'work';
const METRICS: { value: Metric; label: string }[] = [
  { value: 'time', label: 'Hours' },
  { value: 'distance', label: 'Distance' },
  { value: 'tss', label: 'TSS' },
  { value: 'elevation', label: 'Elevation' },
  { value: 'work', label: 'Work (kJ)' },
  { value: 'count', label: 'Activities' },
];
const SPORT_ORDER = ['ride', 'run', 'swim', 'strength', 'walk', 'hike', 'ski', 'row', 'other'];

function metricValue(m: Metric, v: { time: number; distance: number; elevation: number; tss: number; count: number; work: number }) {
  switch (m) {
    case 'time':
      return v.time / 3600;
    case 'distance':
      return distValue(v.distance);
    case 'elevation':
      return elevValue(v.elevation);
    default:
      return v[m];
  }
}
const metricUnit = (m: Metric) => (m === 'time' ? 'h' : m === 'distance' ? distUnit() : m === 'elevation' ? elevUnit() : m === 'work' ? 'kJ' : '');

function VolumeChart({ buckets, metric, bucket }: { buckets: Bucket[]; metric: Metric; bucket: 'week' | 'month' }) {
  const t = useTokens();
  const option = useMemo(() => {
    const sports = SPORT_ORDER.filter((s) => buckets.some((b) => b.sports[s]));
    const labelFmt = bucket === 'week' ? 'd MMM' : 'MMM yy';
    return {
      animation: false,
      grid: { left: 48, right: 10, top: 34, bottom: 28 },
      legend: { ...legendStyle(t), data: sports.map((s) => SPORT_LABEL[s as keyof typeof SPORT_LABEL]) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => p.value);
          const b = buckets[ps[0].dataIndex];
          const total = arr.reduce((a: number, p: any) => a + p.value, 0);
          return `<b>${bucket === 'week' ? 'Week of ' : ''}${fmtDate(b.start, bucket === 'week' ? 'd MMM yyyy' : 'MMMM yyyy')}</b>${arr.map((p: any) => tipRow(p.color, p.seriesName, `${fmtNum(p.value, metric === 'time' ? 1 : 0)} ${metricUnit(metric)}`)).join('')}${arr.length > 1 ? tipRow('transparent', 'Total', `${fmtNum(total, metric === 'time' ? 1 : 0)} ${metricUnit(metric)}`) : ''}`;
        },
      },
      xAxis: { type: 'category', data: buckets.map((b) => fmtDate(b.start, labelFmt)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { splitNumber: 4, name: metricUnit(metric), nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: sports.map((s, i) => ({
        type: 'bar',
        name: SPORT_LABEL[s as keyof typeof SPORT_LABEL],
        stack: 'v',
        barMaxWidth: 28,
        itemStyle: { color: t.sport[s], borderColor: t.surface, borderWidth: 1, borderRadius: i === sports.length - 1 ? [3, 3, 0, 0] : 0 },
        data: buckets.map((b) => (b.sports[s] ? Math.round(metricValue(metric, b.sports[s]) * 10) / 10 : 0)),
      })),
    };
  }, [buckets, metric, bucket, t]);
  return <Chart option={option} height={300} />;
}

function ZoneDistribution({ buckets, kind, bucket }: { buckets: Bucket[]; kind: 'power' | 'hr' | 'seiler'; bucket: 'week' | 'month' }) {
  const t = useTokens();
  const option = useMemo(() => {
    const defs = kind === 'power' ? POWER_ZONES : kind === 'hr' ? HR_ZONES : SEILER_ZONES;
    const base = kind === 'hr' ? t.hr : kind === 'power' ? t.power : t.accent;
    const labelFmt = bucket === 'week' ? 'd MMM' : 'MMM yy';
    const rows = buckets.map((b) => {
      const z = b[kind];
      const total = z.reduce((a, x) => a + x, 0);
      return defs.map((_, i) => (total ? ((z[i] ?? 0) / total) * 100 : 0));
    });
    return {
      animation: false,
      grid: { left: 40, right: 10, top: 34, bottom: 28 },
      legend: { ...legendStyle(t), data: defs.map((d) => d.id) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const b = buckets[ps[0].dataIndex];
          const z = b[kind];
          return `<b>${fmtDate(b.start, bucket === 'week' ? 'd MMM yyyy' : 'MMMM yyyy')}</b>${ps
            .map((p: any, i: number) => tipRow(p.color, `${defs[i].id} ${defs[i].name}`, `${Math.round(p.value)}% · ${fmtNum((z[i] ?? 0) / 3600, 1)}h`))
            .join('')}`;
        },
      },
      xAxis: { type: 'category', data: buckets.map((b) => fmtDate(b.start, labelFmt)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { max: 100, axisLabel: { color: t.muted, fontSize: 10, formatter: '{value}%' } }),
      series: defs.map((d, i) => ({
        type: 'bar',
        name: d.id,
        stack: 'z',
        barMaxWidth: 28,
        itemStyle: { color: alpha(base, 0.4 + (0.6 * i) / Math.max(1, defs.length - 1)), borderColor: t.surface, borderWidth: 1 },
        data: rows.map((r) => Math.round(r[i] * 10) / 10),
      })),
    };
  }, [buckets, kind, bucket, t]);
  return <Chart option={option} height={280} />;
}

function LineTrend({ buckets, lines, bucket, height = 220, threshold }: { buckets: Bucket[]; lines: { name: string; color: string; get: (b: Bucket) => number | null; fmt: (v: number) => string }[]; bucket: 'week' | 'month'; height?: number; threshold?: { value: number; label: string } }) {
  const t = useTokens();
  const option = useMemo(() => {
    const labelFmt = bucket === 'week' ? 'd MMM' : 'MMM yy';
    return {
      animation: false,
      grid: { left: 44, right: 12, top: lines.length > 1 ? 34 : 16, bottom: 28 },
      legend: lines.length > 1 ? { ...legendStyle(t), data: lines.map((l) => l.name) } : undefined,
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => `<b>${fmtDate(buckets[ps[0].dataIndex].start, bucket === 'week' ? 'd MMM yyyy' : 'MMMM yyyy')}</b>${ps.filter((p: any) => p.value != null).map((p: any) => tipRow(p.color, p.seriesName, lines[p.seriesIndex].fmt(p.value))).join('')}`,
      },
      xAxis: { type: 'category', data: buckets.map((b) => fmtDate(b.start, labelFmt)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { min: (v: { min: number }) => Math.floor(v.min * 10) / 10, max: (v: { max: number }) => Math.ceil(v.max * 10) / 10 }),
      series: lines.map((l, i) => ({
        type: 'line',
        name: l.name,
        connectNulls: true,
        symbolSize: 5,
        showSymbol: true,
        smooth: 0.25,
        lineStyle: { color: l.color, width: 2 },
        itemStyle: { color: l.color },
        data: buckets.map((b) => {
          const v = l.get(b);
          return v == null ? null : Math.round(v * 100) / 100;
        }),
        markLine: i === 0 && threshold ? { symbol: 'none', silent: true, data: [{ yAxis: threshold.value }], lineStyle: { color: t.muted, type: 'solid', width: 1 }, label: { formatter: threshold.label, color: t.muted, fontSize: 10, position: 'insideEndTop' } } : undefined,
      })),
    };
  }, [buckets, lines, bucket, t, threshold]);
  return <Chart option={option} height={height} />;
}

function YearOverYear({ metric }: { metric: 'distance' | 'time' | 'tss' }) {
  const t = useTokens();
  const from = iso(startOfYear(subYears(new Date(), 3)));
  const { data } = useApi<DailyLoad[]>(`/daily${qs({ from, to: iso(new Date()) })}`);
  const option = useMemo(() => {
    if (!data) return null;
    const years = [...new Set(data.map((d) => d.date.slice(0, 4)))];
    const byYear = years.map((y) => {
      let cum = 0;
      const pts: [number, number][] = [];
      for (const d of data.filter((d) => d.date.startsWith(y))) {
        cum += metric === 'distance' ? distValue(d.distance) : metric === 'time' ? d.duration / 3600 : d.tss;
        pts.push([getDayOfYear(parseISO(d.date)), Math.round(cum * 10) / 10]);
      }
      return { y, pts };
    }).filter((y) => y.pts.some((p) => p[1] > 0));
    const unit = metric === 'distance' ? distUnit() : metric === 'time' ? 'h' : 'TSS';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return {
      animation: false,
      grid: { left: 52, right: 60, top: 34, bottom: 28 },
      legend: { ...legendStyle(t), data: byYear.map((y) => y.y) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => `<b>Day ${ps[0].value[0]}</b>${ps.map((p: any) => tipRow(p.color, p.seriesName, `${fmtNum(p.value[1])} ${unit}`)).join('')}`,
      },
      xAxis: { type: 'value', min: 1, max: 366, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, customValues: [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335], formatter: (v: number) => months[Math.min(11, Math.floor((v - 1) / 30.5))] } },
      yAxis: valueAxis(t, { name: unit, nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: byYear.map((y, i) => {
        const current = i === byYear.length - 1;
        const color = current ? t.series[0] : alpha(t.ink2, 0.35 + (0.4 * i) / Math.max(1, byYear.length - 1));
        const last = y.pts[y.pts.length - 1];
        return {
          type: 'line',
          name: y.y,
          showSymbol: false,
          data: y.pts,
          lineStyle: { color, width: current ? 2.5 : 1.5 },
          itemStyle: { color },
          endLabel: { show: true, formatter: `${y.y}\n${fmtNum(last[1])}`, color: t.ink2, fontSize: 10 },
        };
      }),
    };
  }, [data, metric, t]);
  if (!option) return <Spinner />;
  return <Chart option={option} height={320} />;
}

export function Trends() {
  const t = useTokens();
  const [range, setRange] = useState<DateRange>(() => resolvePreset('365d'));
  const [bucket, setBucket] = useState<'week' | 'month'>('week');
  const [metric, setMetric] = useState<Metric>('time');
  const [zoneKind, setZoneKind] = useState<'power' | 'hr' | 'seiler'>('seiler');
  const [yoy, setYoy] = useState<'distance' | 'time' | 'tss'>('distance');
  const { data, isLoading } = useApi<Bucket[]>(`/trends${qs({ from: range.from === '2000-01-01' ? undefined : range.from, to: range.to, bucket })}`);
  const buckets = data ?? [];
  const efLines = [
    { name: 'Ride EF (NP/HR)', color: t.series[0], get: (b: Bucket) => b.efRide, fmt: (v: number) => v.toFixed(2) },
  ];
  const efRun = [{ name: 'Run EF (NGP m/min per beat)', color: t.series[1], get: (b: Bucket) => b.efRun, fmt: (v: number) => v.toFixed(2) }];

  return (
    <div>
      <PageHeader
        title="Trends"
        subtitle="Volume, intensity distribution and aerobic efficiency over time"
        actions={
          <>
            <Segmented value={bucket} onChange={setBucket} options={[{ value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
            <RangePicker value={range} onChange={setRange} presets={['90d', '180d', '365d', 'ytd', 'lastyear', 'all']} />
          </>
        }
      />
      {isLoading ? (
        <Spinner />
      ) : (
        <>
          <Card title="Training volume" subtitle={`${METRICS.find((m) => m.value === metric)?.label} per ${bucket}, stacked by sport`} actions={<Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>{METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}>
            <VolumeChart buckets={buckets} metric={metric} bucket={bucket} />
          </Card>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card
              title="Intensity distribution"
              subtitle={zoneKind === 'seiler' ? '3-zone model (below LT1 / between thresholds / above LT2) — power for rides, HR otherwise' : 'Share of time in each zone'}
              actions={<Segmented size="sm" value={zoneKind} onChange={setZoneKind} options={[{ value: 'seiler', label: '3-zone' }, { value: 'power', label: 'Power' }, { value: 'hr', label: 'HR' }]} />}
            >
              <ZoneDistribution buckets={buckets} kind={zoneKind} bucket={bucket} />
            </Card>
            <Card title="Polarization index" subtitle="Treff et al. — above 2.0 indicates a polarized distribution; below suggests pyramidal/threshold-heavy">
              <LineTrend buckets={buckets} bucket={bucket} height={280} threshold={{ value: 2, label: 'polarized' }} lines={[{ name: 'Polarization index', color: t.series[6], get: (b) => b.polarization, fmt: (v) => v.toFixed(2) }]} />
            </Card>
          </div>
          <div className="mt-4 grid gap-4 xl:grid-cols-3">
            <Card title="Aerobic efficiency · ride" subtitle="Average EF of steady rides (IF < 0.82, > 45 min). Rising = fitter aerobic engine">
              <LineTrend buckets={buckets} bucket={bucket} lines={efLines} />
            </Card>
            <Card title="Aerobic efficiency · run" subtitle="Average EF of steady runs (grade-adjusted speed per heartbeat)">
              <LineTrend buckets={buckets} bucket={bucket} lines={efRun} />
            </Card>
            <Card title="Aerobic decoupling" subtitle="Average Pw:HR / Pa:HR drift on long steady sessions. Under 5% = aerobically durable">
              <LineTrend buckets={buckets} bucket={bucket} threshold={{ value: 5, label: '5%' }} lines={[{ name: 'Decoupling', color: t.series[2], get: (b) => b.decoupling, fmt: (v) => `${v.toFixed(1)}%` }]} />
            </Card>
          </div>
          <Card className="mt-4" title="Year over year" subtitle="Cumulative totals by day of year" actions={<Segmented size="sm" value={yoy} onChange={setYoy} options={[{ value: 'distance', label: 'Distance' }, { value: 'time', label: 'Time' }, { value: 'tss', label: 'TSS' }]} />}>
            <YearOverYear metric={yoy} />
          </Card>
        </>
      )}
    </div>
  );
}
