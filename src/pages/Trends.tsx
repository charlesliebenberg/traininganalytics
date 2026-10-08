import { useMemo, useState } from 'react';
import { parseISO, getDayOfYear } from 'date-fns';
import { qs, useApi } from '../lib/api';
import { resolvePreset, type DateRange } from '../lib/range';
import { alpha, useTokens } from '../lib/theme';
import { distValue, distUnit, elevUnit, elevValue, fmtDate, fmtNum, iso, SPORT_LABEL } from '../lib/format';
import { Card, PageHeader, Segmented, Select, Spinner } from '../components/ui';
import { RangePicker } from '../components/RangePicker';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { foldEmptyBuckets, isGap, monthsText, type Gap } from '../lib/timeline';
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
type Item = Bucket | { gap: Gap };
interface TrendsData {
  buckets: Bucket[];
}

/** Category labels, with a folded break shown as "5.8 yr off". */
const itemLabel = (it: Item, bucket: 'week' | 'month') => (isGap(it) ? `${monthsText(it.gap.days)} off` : fmtDate(it.start, bucket === 'week' ? 'd MMM' : 'MMM yy'));
const itemTitle = (it: Item, bucket: 'week' | 'month') =>
  isGap(it) ? `No training · ${fmtDate(it.gap.from, 'MMM yyyy')} – ${fmtDate(it.gap.to, 'MMM yyyy')}` : `${bucket === 'week' ? 'Week of ' : ''}${fmtDate(it.start, bucket === 'week' ? 'd MMM yyyy' : 'MMMM yyyy')}`;
/** Shade folded breaks on a category axis. */
function gapAreas(items: Item[], t: ReturnType<typeof useTokens>) {
  const idx = items.map((it, i) => (isGap(it) ? i : -1)).filter((i) => i >= 0);
  return idx.length ? { markArea: { silent: true, itemStyle: { color: alpha(t.muted, 0.1) }, data: idx.map((i) => [{ xAxis: i }, { xAxis: i }]) } } : {};
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

function VolumeChart({ items, metric, bucket }: { items: Item[]; metric: Metric; bucket: 'week' | 'month' }) {
  const t = useTokens();
  const option = useMemo(() => {
    const buckets = items.filter((b): b is Bucket => !isGap(b));
    const sports = SPORT_ORDER.filter((s) => buckets.some((b) => b.sports[s]));
    return {
      animation: false,
      grid: { left: 48, right: 10, top: 34, bottom: 28 },
      legend: { ...legendStyle(t), data: sports.map((s) => SPORT_LABEL[s as keyof typeof SPORT_LABEL]) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => p.value);
          const it = items[ps[0].dataIndex];
          const total = arr.reduce((a: number, p: any) => a + p.value, 0);
          return `<b>${itemTitle(it, bucket)}</b>${arr.map((p: any) => tipRow(p.color, p.seriesName, `${fmtNum(p.value, metric === 'time' ? 1 : 0)} ${metricUnit(metric)}`)).join('')}${arr.length > 1 ? tipRow('transparent', 'Total', `${fmtNum(total, metric === 'time' ? 1 : 0)} ${metricUnit(metric)}`) : ''}`;
        },
      },
      xAxis: { type: 'category', data: items.map((it) => itemLabel(it, bucket)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { splitNumber: 4, name: metricUnit(metric), nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: sports.map((s, i) => ({
        type: 'bar',
        name: SPORT_LABEL[s as keyof typeof SPORT_LABEL],
        stack: 'v',
        barMaxWidth: 24,
        itemStyle: { color: t.sport[s], borderColor: t.surface, borderWidth: 1, borderRadius: i === sports.length - 1 ? [3, 3, 0, 0] : 0 },
        data: items.map((b) => (!isGap(b) && b.sports[s] ? Math.round(metricValue(metric, b.sports[s]) * 10) / 10 : 0)),
        ...(i === 0 ? gapAreas(items, t) : {}),
      })),
    };
  }, [items, metric, bucket, t]);
  return <Chart option={option} height={300} />;
}

function ZoneDistribution({ items, kind, bucket }: { items: Item[]; kind: 'power' | 'hr' | 'seiler'; bucket: 'week' | 'month' }) {
  const t = useTokens();
  const option = useMemo(() => {
    const defs = kind === 'power' ? POWER_ZONES : kind === 'hr' ? HR_ZONES : SEILER_ZONES;
    const base = kind === 'hr' ? t.hr : kind === 'power' ? t.power : t.accent;
    const rows = items.map((b) => {
      if (isGap(b)) return defs.map(() => 0);
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
          const b = items[ps[0].dataIndex];
          if (isGap(b)) return `<b>${itemTitle(b, bucket)}</b>`;
          const z = b[kind];
          return `<b>${itemTitle(b, bucket)}</b>${ps
            .map((p: any, i: number) => tipRow(p.color, `${defs[i].id} ${defs[i].name}`, `${Math.round(p.value)}% · ${fmtNum((z[i] ?? 0) / 3600, 1)}h`))
            .join('')}`;
        },
      },
      xAxis: { type: 'category', data: items.map((it) => itemLabel(it, bucket)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { max: 100, axisLabel: { color: t.muted, fontSize: 10, formatter: '{value}%' } }),
      series: defs.map((d, i) => ({
        type: 'bar',
        name: d.id,
        stack: 'z',
        barMaxWidth: 24,
        itemStyle: { color: alpha(base, 0.46 + (0.54 * i) / Math.max(1, defs.length - 1)), borderColor: t.surface, borderWidth: 1 },
        data: rows.map((r) => Math.round(r[i] * 10) / 10),
        ...(i === 0 ? gapAreas(items, t) : {}),
      })),
    };
  }, [items, kind, bucket, t]);
  return <Chart option={option} height={280} />;
}

function LineTrend({ items, lines, bucket, height = 220, threshold, inverse }: { items: Item[]; lines: { name: string; color: string; get: (b: Bucket) => number | null; fmt: (v: number) => string }[]; bucket: 'week' | 'month'; height?: number; threshold?: { value: number; label: string }; inverse?: boolean }) {
  const t = useTokens();
  const option = useMemo(() => {
    return {
      animation: false,
      grid: { left: 44, right: 12, top: lines.length > 1 ? 34 : 16, bottom: 28 },
      legend: lines.length > 1 ? { ...legendStyle(t), data: lines.map((l) => l.name) } : undefined,
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => `<b>${itemTitle(items[ps[0].dataIndex], bucket)}</b>${ps.filter((p: any) => p.value != null).map((p: any) => tipRow(p.color, p.seriesName, lines[p.seriesIndex].fmt(p.value))).join('')}`,
      },
      xAxis: { type: 'category', data: items.map((it) => itemLabel(it, bucket)), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { inverse, min: (v: { min: number }) => Math.floor(v.min * 10) / 10, max: (v: { max: number }) => Math.ceil(v.max * 10) / 10, axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => lines[0]?.fmt(v) ?? String(v) } }),
      series: lines.map((l, i) => ({
        type: 'line',
        name: l.name,
        // don't draw across a break
        connectNulls: false,
        symbolSize: 8,
        showSymbol: true,
        smooth: 0.25,
        lineStyle: { color: l.color, width: 2 },
        itemStyle: { color: l.color, borderColor: t.surface, borderWidth: 1 },
        data: items.map((b) => {
          if (isGap(b)) return null;
          const v = l.get(b);
          return v == null ? null : Math.round(v * 100) / 100;
        }),
        markLine: i === 0 && threshold ? { symbol: 'none', silent: true, data: [{ yAxis: threshold.value }], lineStyle: { color: t.muted, type: 'solid', width: 1 }, label: { formatter: threshold.label, color: t.muted, fontSize: 10, position: 'insideEndTop' } } : undefined,
        ...(i === 0 ? gapAreas(items, t) : {}),
      })),
    };
  }, [items, lines, bucket, t, threshold, inverse]);
  return <Chart option={option} height={height} />;
}

const MONTH_STARTS = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Cumulative totals by day of year for every year with training. This year and the biggest
 * year are drawn in colour and labelled; the rest stay as grey context.
 */
function YearOverYear({ metric }: { metric: 'distance' | 'time' | 'tss' }) {
  const t = useTokens();
  const { data } = useApi<DailyLoad[]>(`/daily${qs({ from: '2000-01-01', to: iso(new Date()) })}`);
  const option = useMemo(() => {
    if (!data) return null;
    const years = [...new Set(data.map((d) => d.date.slice(0, 4)))].sort();
    const byYear = years
      .map((y) => {
        let cum = 0;
        const pts: [number, number][] = [];
        for (const d of data.filter((d) => d.date.startsWith(y))) {
          cum += metric === 'distance' ? distValue(d.distance) : metric === 'time' ? d.duration / 3600 : d.tss;
          pts.push([getDayOfYear(parseISO(d.date)), Math.round(cum * 10) / 10]);
        }
        return { y, pts, total: cum };
      })
      .filter((y) => y.total > 0);
    const thisYear = String(new Date().getFullYear());
    const best = [...byYear].sort((a, b) => b.total - a.total)[0]?.y;
    const unit = metric === 'distance' ? distUnit() : metric === 'time' ? 'h' : 'TSS';
    return {
      animation: false,
      grid: { left: 52, right: 70, top: 34, bottom: 28 },
      legend: { ...legendStyle(t), data: byYear.map((y) => y.y) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const doy = ps[0].value[0];
          const m = MONTH_STARTS.filter((d) => d <= doy).length - 1;
          return `<b>${MONTHS[m]} ${doy - MONTH_STARTS[m] + 1}</b>${[...ps]
            .sort((a: any, b: any) => b.value[1] - a.value[1])
            .map((p: any) => tipRow(p.color, p.seriesName, `${fmtNum(p.value[1])} ${unit}`))
            .join('')}`;
        },
      },
      xAxis: { type: 'value', min: 1, max: 366, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, customValues: MONTH_STARTS, formatter: (v: number) => MONTHS[MONTH_STARTS.indexOf(v)] ?? '' } },
      yAxis: valueAxis(t, { name: unit, nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: byYear.map((y) => {
        const strong = y.y === thisYear || y.y === best;
        const color = y.y === thisYear ? t.series[0] : y.y === best ? t.series[1] : alpha(t.muted, 0.55);
        const last = y.pts[y.pts.length - 1];
        return {
          type: 'line',
          name: y.y,
          showSymbol: false,
          z: strong ? 3 : 2,
          data: y.pts,
          lineStyle: { color, width: strong ? 2 : 1 },
          itemStyle: { color },
          endLabel: { show: strong, formatter: `${y.y}${y.y === best && y.y !== thisYear ? ' (best)' : ''}\n${fmtNum(last[1])}`, color: t.ink2, fontSize: 10 },
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
  const { data, isLoading } = useApi<TrendsData>(`/trends${qs({ from: range.from, to: range.to, bucket })}`);
  // long stretches without training fold into one marked column (13+ weeks / 3+ months)
  const items: Item[] = useMemo(() => {
    const list = data?.buckets ?? [];
    // drop empty buckets before the first activity in the range
    const first = list.findIndex((b) => Object.keys(b.sports).length > 0);
    return foldEmptyBuckets(first > 0 ? list.slice(first) : list, (b) => Object.keys(b.sports).length === 0, bucket === 'week' ? 13 : 3);
  }, [data, bucket]);
  const folded = items.some(isGap);
  return (
    <div>
      <PageHeader
        title="Trends"
        subtitle="Volume, intensity distribution and durability over time"
        actions={
          <>
            <Segmented value={bucket} onChange={setBucket} options={[{ value: 'week', label: 'Weekly' }, { value: 'month', label: 'Monthly' }]} />
            <RangePicker value={range} onChange={setRange} presets={['90d', '180d', '365d', '730d', 'ytd', 'lastyear', 'all']} />
          </>
        }
      />
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <>
          <Card
            title="Training volume"
            subtitle={`${METRICS.find((m) => m.value === metric)?.label} per ${bucket}, stacked by sport${folded ? ' · breaks of 3+ months are folded into one column' : ''}`}
            actions={<Select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>{METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}</Select>}
          >
            <VolumeChart items={items} metric={metric} bucket={bucket} />
          </Card>
          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            <Card
              title="Intensity distribution"
              subtitle={zoneKind === 'seiler' ? '3-zone model (below LT1 / between thresholds / above LT2) — power for rides, heart rate otherwise' : 'Share of time in each zone'}
              actions={<Segmented size="sm" value={zoneKind} onChange={setZoneKind} options={[{ value: 'seiler', label: '3-zone' }, { value: 'power', label: 'Power' }, { value: 'hr', label: 'HR' }]} />}
            >
              <ZoneDistribution items={items} kind={zoneKind} bucket={bucket} />
            </Card>
            <Card title="Polarization index" subtitle={`Treff et al., ${bucket === 'week' ? 'over the 4 weeks ending each week' : 'per month'}. Above 2.0 is polarized; below is pyramidal or threshold-heavy.`}>
              <LineTrend items={items} bucket={bucket} height={280} threshold={{ value: 2, label: 'polarized' }} lines={[{ name: 'Polarization index', color: t.series[6], get: (b) => b.polarization, fmt: (v) => v.toFixed(2) }]} />
            </Card>
          </div>
          <Card
            className="mt-4"
            title="Aerobic decoupling"
            subtitle={`Pw:HR / Pa:HR drift on steady sessions of an hour or more, ridden evenly${bucket === 'week' ? ', averaged over 4 weeks' : ''}. Under 5 % = aerobically durable. Aerobic fitness itself is on Fitness & Form.`}
          >
            <LineTrend items={items} bucket={bucket} height={240} threshold={{ value: 5, label: '5%' }} lines={[{ name: 'Decoupling', color: t.series[2], get: (b) => b.decoupling, fmt: (v) => `${v.toFixed(1)}%` }]} />
          </Card>
          <Card className="mt-4" title="Year over year" subtitle="Cumulative totals by day of year, every year you trained — this year and your biggest year highlighted" actions={<Segmented size="sm" value={yoy} onChange={setYoy} options={[{ value: 'distance', label: 'Distance' }, { value: 'time', label: 'Time' }, { value: 'tss', label: 'TSS' }]} />}>
            <YearOverYear metric={yoy} />
          </Card>
        </>
      )}
    </div>
  );
}
