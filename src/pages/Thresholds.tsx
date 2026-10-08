import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { parseISO } from 'date-fns';
import { RefreshCw, Info, ChevronLeft, ChevronRight, Play, Pause } from 'lucide-react';
import type { Preferences, Thresholds as Th } from '../../shared/types';
import { ESTIMATE_CONFIG, MAX_WEEKLY_DECLINE, WINDOW_DAYS, type ThresholdEstimate, type ThresholdSport } from '../../shared/analytics/thresholds';
import { http, qs, useAction, useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtDuration, fmtPace, iso } from '../lib/format';
import { Badge, Button, Card, Empty, PageHeader, Segmented, Spinner, Stat, Toggle } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { breakNames, makeTimeline, monthsText, type Gap, type Timeline } from '../lib/timeline';

interface SeriesResponse {
  sport: ThresholdSport;
  auto: boolean;
  series: ThresholdEstimate[];
  manual: { date: string; value: number }[];
  gaps: Gap[];
  firstActivity: string | null;
  state: { running: boolean; lastRun: string | null };
  current: Th;
}
interface CurvesResponse {
  durations: number[];
  weeks: { date: string; values: (number | null)[] }[];
}

const DAY = 86400_000;

const LABEL: Record<ThresholdSport, { name: string; model: string; cp: string; wp: string }> = {
  ride: { name: 'Bike FTP', model: 'critical power', cp: 'Critical power', wp: 'W′' },
  run: { name: 'Run threshold pace', model: 'critical speed', cp: 'Critical speed', wp: 'D′' },
  swim: { name: 'Swim CSS', model: 'critical swim speed', cp: 'Critical speed', wp: 'D′' },
};
const BAND = ['Short', 'Medium', 'Long'];
/** Which rule set the automatic FTP that week. */
const BASIS: Record<string, string> = { cp: `${Math.round(ESTIMATE_CONFIG.ride.factor * 100)}% of CP`, '20min': '95% of 20 min', '60min': 'best hour' };

/** Formatting helpers per sport: power in W, run pace /km, swim pace /100m. */
function fmt(sport: ThresholdSport) {
  if (sport === 'ride') return { value: (v: number) => `${Math.round(v)} W`, axis: (v: number) => `${Math.round(v)}`, unit: 'W' };
  const s = sport === 'run' ? 'run' : 'swim';
  return { value: (v: number) => fmtPace(v, s), axis: (v: number) => fmtPace(v, s, false), unit: sport === 'run' ? 'pace' : 'pace /100m' };
}
const wpText = (sport: ThresholdSport, w: number) => (sport === 'ride' ? `${(w / 1000).toFixed(1)} kJ` : `${Math.round(w)} m`);

function HistoryChart({ sport, data, series, timeline, selected, onSelect }: { sport: ThresholdSport; data: SeriesResponse; series: ThresholdEstimate[]; timeline: Timeline; selected: string | null; onSelect: (d: string) => void }) {
  const t = useTokens();
  const f = fmt(sport);
  // the click handler is bound once; read the latest data through a ref
  const ref = useRef({ series, onSelect, timeline });
  ref.current = { series, onSelect, timeline };
  const option = useMemo(() => {
    const X = (d: string) => timeline.toX(parseISO(d).getTime());
    const s = series;
    const firstDate = s[0]?.date ?? iso(new Date());
    const lastDate = s.length ? s[s.length - 1].date : iso(new Date());
    // manual values: clip to the visible range (no lines back to dates before any training)
    const manual = data.manual.filter((m) => m.value > 0);
    const manualPts: [number, number][] = [];
    manual.forEach((m, i) => {
      const next = manual[i + 1]?.date;
      if (next && next <= firstDate) return;
      manualPts.push([X(m.date < firstDate ? firstDate : m.date), m.value]);
    });
    if (manualPts.length) manualPts.push([X(lastDate), manualPts[manualPts.length - 1][1]]);
    const sel = s.find((e) => e.date === selected);
    // split lines at breaks so they don't draw across collapsed periods
    const withBreaks = (pts: { date: string; v: number }[]) => {
      const out: (number[] | null[])[] = [];
      pts.forEach((p, i) => {
        if (i && timeline.breaks.some((g) => g.a > parseISO(pts[i - 1].date).getTime() && g.a < parseISO(p.date).getTime())) out.push([null, null] as null[]);
        out.push([X(p.date), p.v]);
      });
      return out;
    };
    return {
      animation: false,
      grid: { left: 64, right: 16, top: 34, bottom: 30 },
      legend: { ...legendStyle(t), data: ['Applied', 'Raw fit', ...(manualPts.length ? ['Manual setting'] : [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const x = ps[0].value?.[0];
          const e = s.find((z) => X(z.date) === x);
          if (!e) return '';
          return `<b>From ${fmtDate(e.date, 'd MMM yyyy')}</b><div style="opacity:.6;font-size:11px;margin-bottom:4px">window ${fmtDate(e.windowFrom, 'd MMM')} – ${fmtDate(e.windowTo, 'd MMM yyyy')}</div>${tipRow(t.accent, 'Applied', f.value(e.threshold))}${tipRow(t.muted, 'Raw fit', f.value(e.raw))}${sport === 'ride' && e.basis ? tipRow('transparent', 'Set by', BASIS[e.basis]) : ''}${tipRow('transparent', LABEL[sport].wp, wpText(sport, e.wPrime))}<div style="opacity:.6;font-size:11px;margin-top:4px">Click to inspect the fit</div>`;
        },
      },
      xAxis: {
        type: 'value',
        min: X(firstDate) - 7 * DAY,
        max: X(lastDate) + 7 * DAY,
        ...axisStyle(t, { grid: false }),
        splitNumber: 8,
        axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => (timeline.inBreak(v) ? '' : fmtDate(new Date(timeline.fromX(v)), 'MMM yy')) },
      },
      yAxis: valueAxis(t, {
        inverse: sport !== 'ride',
        scale: true,
        axisLabel: { color: t.muted, fontSize: 11, formatter: f.axis },
      }),
      series: [
        {
          type: 'line',
          name: 'Applied',
          step: 'end',
          showSymbol: false,
          connectNulls: false,
          data: withBreaks(s.map((e) => ({ date: e.date, v: e.threshold }))),
          lineStyle: { color: t.accent, width: 2.5 },
          itemStyle: { color: t.accent },
          markLine: sel ? { symbol: 'none', silent: true, data: [{ xAxis: X(sel.date) }], lineStyle: { color: t.ink2, type: 'solid', width: 1.5 }, label: { show: false } } : undefined,
          markArea: timeline.breaks.length
            ? {
                silent: true,
                itemStyle: { color: alpha(t.muted, 0.12) },
                label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, lineHeight: 13, formatter: (p: any) => p.name },
                data: timeline.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]),
              }
            : undefined,
        },
        {
          type: 'scatter',
          name: 'Raw fit',
          symbolSize: 5,
          data: s.map((e) => [X(e.date), e.raw]),
          itemStyle: { color: alpha(t.muted, 0.7) },
        },
        ...(manualPts.length ? [{ type: 'line', name: 'Manual setting', step: 'end', showSymbol: false, data: manualPts, lineStyle: { color: t.series[1], width: 1.5 }, itemStyle: { color: t.series[1] } }] : []),
      ],
    };
  }, [data, series, timeline, t, selected, sport, f]);
  return (
    <Chart
      option={option}
      height={300}
      onReady={(c) =>
        c.getZr().on('click', (ev: any) => {
          const pt = c.convertFromPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY]);
          if (!pt) return;
          const { series: ser, timeline: tl, onSelect: sel } = ref.current;
          let best: ThresholdEstimate | null = null;
          for (const e of ser) if (!best || Math.abs(tl.toX(parseISO(e.date).getTime()) - pt[0]) < Math.abs(tl.toX(parseISO(best.date).getTime()) - pt[0])) best = e;
          if (best) sel(best.date);
        })
      }
    />
  );
}

/** Step, drag or play through every week's fit. */
function Scrubber({ series, index, onIndex, timeline }: { series: ThresholdEstimate[]; index: number; onIndex: (i: number) => void; timeline: Timeline }) {
  const [playing, setPlaying] = useState(false);
  const idx = useRef(index);
  idx.current = index;
  useEffect(() => {
    if (!playing) return;
    const h = setInterval(() => {
      if (idx.current >= series.length - 1) setPlaying(false);
      else onIndex(idx.current + 1);
    }, 280);
    return () => clearInterval(h);
  }, [playing, series.length, onIndex]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' && (e.target as HTMLInputElement).type !== 'range') return;
      if (e.key === 'ArrowLeft') onIndex(Math.max(0, idx.current - 1));
      else if (e.key === 'ArrowRight') onIndex(Math.min(series.length - 1, idx.current + 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [series.length, onIndex]);
  const e = series[index];
  const breakBefore = index > 0 && timeline.breaks.find((g) => g.a > parseISO(series[index - 1].date).getTime() && g.a < parseISO(e.date).getTime());
  return (
    <div className="card sticky top-2 z-[600] mt-4 flex flex-wrap items-center gap-3 px-4 py-3 lg:top-3">
      <div className="flex items-center gap-1">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => onIndex(Math.max(0, index - 1))} disabled={index === 0} title="Previous week (←)" />
        <Button
          size="sm"
          variant="primary"
          icon={playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          onClick={() => {
            if (!playing && index >= series.length - 1) onIndex(0);
            setPlaying(!playing);
          }}
          title="Play through time"
        />
        <Button size="sm" variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => onIndex(Math.min(series.length - 1, index + 1))} disabled={index === series.length - 1} title="Next week (→)" />
      </div>
      <div className="w-44 text-[13px]">
        <div className="font-semibold">Week of {fmtDate(e.date, 'd MMM yyyy')}</div>
        <div className="text-[11px] text-muted">
          {index + 1} / {series.length}
          {breakBefore ? ` · after ${monthsText(breakBefore.days)} off` : ''}
        </div>
      </div>
      <input type="range" min={0} max={series.length - 1} value={index} onChange={(ev) => onIndex(Number(ev.target.value))} className="min-w-[200px] flex-1 accent-[var(--accent)]" aria-label="Week" />
    </div>
  );
}

function CurveFitChart({ sport, e, durations, values, yRange }: { sport: ThresholdSport; e: ThresholdEstimate; durations: number[]; values: (number | null)[]; yRange: [number, number] }) {
  const t = useTokens();
  const f = fmt(sport);
  const cfg = ESTIMATE_CONFIG[sport];
  const option = useMemo(() => {
    const [lo, hi] = curveSpan(sport);
    const curve = durations.map((d, i) => [d, values[i]] as [number, number | null]).filter(([d, v]) => v != null && d >= lo && d <= hi);
    const model: [number, number][] = [];
    for (let d = cfg.tMin * 0.6; d <= hi; d *= 1.08) model.push([d, e.cp + e.wPrime / d]);
    const ticks = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200].filter((x) => x >= lo && x <= hi);
    return {
      animation: false,
      grid: { left: 64, right: 16, top: 34, bottom: 30 },
      legend: { ...legendStyle(t), data: ['Best efforts (6 months)', `${LABEL[sport].model} model`, 'Chosen efforts'] },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(t),
        formatter: (p: any) => {
          const [d, v] = p.value;
          const pick = e.points.find((q) => q.t === d);
          if (pick && p.seriesIndex === 2) return `<b>${BAND[pick.band]} effort · ${fmtDurLabel(d)}</b>${tipRow(t.series[1], 'Best', f.value(v))}${tipRow('transparent', 'vs envelope', `${(pick.score * 100).toFixed(1)}%`)}${pick.date ? `<div style="opacity:.6;font-size:11px">${fmtDate(pick.date)}</div>` : ''}`;
          return `<b>${fmtDurLabel(Math.round(d))}</b>${tipRow(p.color, p.seriesName, f.value(v))}`;
        },
      },
      xAxis: { type: 'log', min: lo, max: hi, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, customValues: ticks, formatter: (v: number) => fmtDurLabel(Math.round(v)) }, axisTick: { show: true, customValues: ticks } },
      // fixed range across weeks, so scrubbing through time shows real change, not axis jumps
      yAxis: valueAxis(t, { inverse: sport !== 'ride', min: yRange[0], max: yRange[1], axisLabel: { color: t.muted, fontSize: 11, formatter: f.axis } }),
      series: [
        {
          type: 'line',
          name: 'Best efforts (6 months)',
          showSymbol: false,
          data: curve,
          lineStyle: { color: t.series[0], width: 2 },
          itemStyle: { color: t.series[0] },
          areaStyle: { color: alpha(t.series[0], 0.08), origin: sport === 'ride' ? 'start' : 'end' },
          markArea: { silent: true, itemStyle: { color: alpha(t.ink2, 0.06) }, label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, formatter: 'model range' }, data: [[{ xAxis: cfg.tMin }, { xAxis: cfg.tMax }]] },
        },
        { type: 'line', name: `${LABEL[sport].model} model`, showSymbol: false, data: model, lineStyle: { color: t.ink2, width: 1.5, type: 'dashed' }, itemStyle: { color: t.ink2 } },
        {
          type: 'scatter',
          name: 'Chosen efforts',
          symbolSize: 13,
          z: 10,
          itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2 },
          data: e.points.map((p, i) => ({ value: [p.t, p.value], label: { position: i % 2 ? 'bottom' : 'top' } })),
          label: { show: true, color: t.ink, fontSize: 11, fontWeight: 600, distance: 8, formatter: (p: any) => `${fmtDurLabel(p.value[0])} · ${f.axis(p.value[1])}` },
        },
      ],
    };
  }, [e, durations, values, yRange, t, sport, f, cfg]);
  return <Chart option={option} height={340} />;
}

/** Duration span shown on the curve chart. */
function curveSpan(sport: ThresholdSport): [number, number] {
  const cfg = ESTIMATE_CONFIG[sport];
  return [Math.max(10, cfg.tMin / 4), Math.min(4 * 3600, cfg.tMax * 2.5)];
}

function LinearFitChart({ sport, e, yMax }: { sport: ThresholdSport; e: ThresholdEstimate; yMax: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const isBike = sport === 'ride';
    const yv = (p: { t: number; value: number }) => (isBike ? (p.value * p.t) / 1000 : p.value * p.t);
    const maxT = ESTIMATE_CONFIG[sport].tMax * 1.05;
    const line: [number, number][] = [
      [0, isBike ? e.wPrime / 1000 : e.wPrime],
      [maxT / 60, isBike ? (e.cp * maxT + e.wPrime) / 1000 : e.cp * maxT + e.wPrime],
    ];
    const yName = isBike ? 'Work (kJ)' : 'Distance (m)';
    return {
      animation: false,
      grid: { left: 60, right: 16, top: 30, bottom: 40 },
      tooltip: { trigger: 'item', ...tooltipStyle(t), formatter: (p: any) => `${fmtDuration(p.value[0] * 60)} → ${Math.round(p.value[1]).toLocaleString()} ${isBike ? 'kJ' : 'm'}` },
      xAxis: { type: 'value', min: 0, max: Math.ceil(maxT / 60), name: 'Duration (min)', nameLocation: 'middle', nameGap: 26, ...axisStyle(t) },
      yAxis: valueAxis(t, { min: 0, max: yMax, name: yName, nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: [
        { type: 'line', showSymbol: false, data: line, lineStyle: { color: t.ink2, width: 1.5, type: 'dashed' }, silent: true },
        {
          type: 'scatter',
          symbolSize: 12,
          data: e.points.map((p) => [p.t / 60, yv(p)]),
          itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2 },
          label: { show: true, position: 'left', color: t.ink2, fontSize: 10, formatter: (p: any) => BAND[e.points[p.dataIndex].band] },
        },
      ],
    };
  }, [e, t, sport, yMax]);
  return <Chart option={option} height={260} />;
}

type View = ThresholdSport | 'hr';

export function Thresholds() {
  const [view, setView] = useState<View>('ride');
  const tabs = <Segmented value={view} onChange={setView} options={[{ value: 'ride', label: 'Bike FTP' }, { value: 'run', label: 'Run pace' }, { value: 'swim', label: 'Swim CSS' }, { value: 'hr', label: 'Heart rate' }]} />;
  return view === 'hr' ? <HeartRateThresholds tabs={tabs} /> : <SportThresholds key={view} sport={view} tabs={tabs} />;
}

function RecomputeButton({ running }: { running: boolean }) {
  const refresh = useAction(() => http('/estimates/refresh', { method: 'POST' }));
  return (
    <Button icon={<RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined)} title="Recompute all estimates and recalculate activities">
      Recompute
    </Button>
  );
}

function SportThresholds({ sport, tabs }: { sport: ThresholdSport; tabs: ReactNode }) {
  const t = useTokens();
  const { data, isLoading } = useApi<SeriesResponse>(`/estimates${qs({ sport })}`, { refetchInterval: (q) => ((q.state.data as SeriesResponse | undefined)?.state.running ? 3000 : false) });
  const [selected, setSelected] = useState<string | null>(null);
  const curves = useApi<CurvesResponse>(data?.series.length ? `/estimates/curves${qs({ sport, n: data.series.length, last: data.series[data.series.length - 1].date })}` : null, { staleTime: 5 * 60_000 });
  const prefs = useApi<Preferences>('/preferences');
  const setAuto = useAction((v: boolean) => http('/preferences', { method: 'PUT', json: { autoThresholds: { ...prefs.data!.autoThresholds, [sport]: v } } }));
  const f = fmt(sport);
  const today = iso(new Date());
  const timeline = useMemo(() => makeTimeline(data?.gaps ?? []), [data?.gaps]);
  const series = useMemo(() => (data?.series ?? []).filter((e) => !timeline.hidden(e.date)), [data?.series, timeline]);
  const current = series.filter((e) => e.date <= today).pop() ?? series[series.length - 1];
  const sel = selected ?? current?.date ?? null;
  const index = Math.max(0, series.findIndex((e) => e.date === sel));
  const e = series[index] ?? null;
  const curveByDate = useMemo(() => new Map(curves.data?.weeks.map((w) => [w.date, w.values]) ?? []), [curves.data]);
  // fixed chart ranges across all weeks
  const yRange = useMemo<[number, number]>(() => {
    if (!curves.data) return [0, 1];
    const [lo, hi] = curveSpan(sport);
    let mn = Infinity,
      mx = -Infinity;
    for (const w of curves.data.weeks)
      w.values.forEach((v, i) => {
        const d = curves.data!.durations[i];
        if (v == null || d < lo || d > hi) return;
        mn = Math.min(mn, v);
        mx = Math.max(mx, v);
      });
    if (!Number.isFinite(mn)) return [0, 1];
    const pad = (mx - mn) * 0.06;
    return sport === 'ride' ? [Math.max(0, Math.floor((mn - pad) / 25) * 25), Math.ceil((mx + pad) / 25) * 25] : [Math.max(0.1, mn - pad), mx + pad];
  }, [curves.data, sport]);
  const linearMax = useMemo(() => {
    const tMax = ESTIMATE_CONFIG[sport].tMax * 1.05;
    const m = Math.max(1, ...series.map((x) => x.cp * tMax + x.wPrime), ...series.flatMap((x) => x.points.map((p) => p.value * p.t)));
    const v = sport === 'ride' ? m / 1000 : m;
    const step = sport === 'ride' ? 100 : 1000;
    return Math.ceil((v * 1.05) / step) * step;
  }, [series, sport]);
  const setIndex = (i: number) => series[i] && setSelected(series[i].date);
  const manualNow = data?.manual.filter((m) => m.date <= today).pop() ?? data?.manual[0];

  return (
    <div>
      <PageHeader
        title="Thresholds"
        subtitle={`FTP, run threshold pace and swim CSS estimated weekly from your last ${Math.round(WINDOW_DAYS / 30)} months of best efforts`}
        actions={
          <>
            {tabs}
            <RecomputeButton running={!!data?.state.running} />
          </>
        }
      />
      {isLoading || !data ? (
        <Spinner />
      ) : !data.series.length ? (
        <Card>
          <Empty title={`Not enough data for ${LABEL[sport].name.toLowerCase()} yet`}>
            Estimates need at least {4} {sport === 'ride' ? 'rides with power' : sport === 'run' ? 'runs' : 'swims'} in a 6-month window, including some hard efforts between {fmtDurLabel(ESTIMATE_CONFIG[sport].tMin)} and {fmtDurLabel(ESTIMATE_CONFIG[sport].tMax)}. Until then your manual value is used.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="card mb-4 grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label={`Current ${ESTIMATE_CONFIG[sport].label}`} accent={t.accent} value={current ? f.value(current.threshold) : '–'} sub={current ? (sport === 'ride' && current.basis ? `${fmtDate(current.date, 'd MMM')} · ${current.threshold > current.raw + 1e-9 ? 'decline-limited' : BASIS[current.basis]}` : `from ${fmtDate(current.date, 'd MMM')}`) : undefined} title={sport === 'ride' && current?.basis ? `Set by ${current.threshold > current.raw + 1e-9 ? 'the 1%-a-week decline limit' : current.basis === 'cp' ? 'the critical-power fit' : current.basis === '20min' ? '95% of your best 20 minutes' : 'your best hour'}` : undefined} />
            <Stat label={LABEL[sport].cp} value={current ? f.value(current.cp) : '–'} sub={sport === 'ride' ? 'used for W′ balance' : 'threshold = CS'} />
            <Stat label={LABEL[sport].wp} value={current ? wpText(sport, current.wPrime) : '–'} sub={sport === 'ride' ? 'anaerobic capacity' : 'distance above CS'} />
            <Stat label="Manual value" value={manualNow?.value ? f.value(manualNow.value) : '–'} sub="Settings → Athlete" />
            <Stat label="Weeks estimated" value={series.length} sub={data.state.running ? 'recomputing…' : data.state.lastRun ? `updated ${fmtDate(data.state.lastRun, 'd MMM HH:mm')}` : undefined} />
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Zones & TSS use</div>
              <div className="mt-2">
                <Toggle checked={data.auto} onChange={(v) => setAuto.mutate(v)} label={data.auto ? 'Automatic estimate' : 'Manual value'} />
              </div>
              <div className="mt-1 text-[11px] text-muted">switching recalculates {sport} activities</div>
            </div>
          </div>

          <Card title="History" subtitle="Applied value (used for zones and TSS on that date), the raw fit for each weekly window, and your manual setting. Breaks of 3+ months without activities are collapsed. Click anywhere, or use the timeline below, to inspect a week.">
            <HistoryChart sport={sport} data={data} series={series} timeline={timeline} selected={sel} onSelect={setSelected} />
          </Card>

          {e && <Scrubber series={series} index={index} onIndex={setIndex} timeline={timeline} />}

          {!curves.data ? (
            <Spinner />
          ) : e ? (
            <>
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card
                  title={`The fit for ${fmtDate(e.date, 'd MMM yyyy')}`}
                  subtitle={`Best efforts ${fmtDate(e.windowFrom, 'd MMM yyyy')} – ${fmtDate(e.windowTo, 'd MMM yyyy')} (${e.activities} activities). Orange = the three efforts the model is fitted to.`}
                  actions={<Badge>{e.threshold > e.raw + 1e-9 ? 'decline-limited' : 'raw fit'}</Badge>}
                >
                  <CurveFitChart sport={sport} e={e} durations={curves.data.durations} values={curveByDate.get(e.date) ?? []} yRange={yRange} />
                </Card>
                <Card title="Linear check" subtitle={sport === 'ride' ? 'Work vs time is a straight line: slope = CP, intercept = W′' : 'Distance vs time is a straight line: slope = CS, intercept = D′'}>
                  <LinearFitChart sport={sport} e={e} yMax={linearMax} />
                  <div className="mt-2 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
                    <Stat label="Slope" value={<span className="text-base">{f.value(e.cp)}</span>} />
                    <Stat label="Intercept" value={<span className="text-base">{wpText(sport, e.wPrime)}</span>} />
                    <Stat label="R²" value={<span className="text-base">{e.r2.toFixed(4)}</span>} />
                  </div>
                </Card>
              </div>
              <Card className="mt-4" title="Efforts used" pad={false}>
                <table className="tnum w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                      <th className="py-2 pl-5 font-medium">Band</th>
                      <th className="px-3 font-medium">Duration</th>
                      <th className="px-3 text-right font-medium">Best {sport === 'ride' ? 'power' : 'pace'}</th>
                      <th className="px-3 text-right font-medium">{sport === 'ride' ? 'Work' : 'Distance'}</th>
                      <th className="px-3 text-right font-medium" title="How far above or below the curve's upper envelope this effort sits">vs envelope</th>
                      <th className="px-3 pr-5 font-medium">Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.points.map((p) => (
                      <tr key={p.t} className="border-b border-line/60 last:border-0">
                        <td className="py-2 pl-5">{BAND[p.band]}</td>
                        <td className="px-3">{fmtDuration(p.t)}</td>
                        <td className="px-3 text-right font-medium">{f.value(p.value)}</td>
                        <td className="px-3 text-right text-ink-2">{sport === 'ride' ? `${Math.round((p.value * p.t) / 1000)} kJ` : `${Math.round(p.value * p.t)} m`}</td>
                        <td className="px-3 text-right text-ink-2">{(p.score * 100).toFixed(1)}%</td>
                        <td className="px-3 pr-5">
                          {p.activityId ? (
                            <Link to={`/activities/${p.activityId}`} className="text-accent hover:underline">
                              {p.date ? fmtDate(p.date) : 'Open'}
                            </Link>
                          ) : (
                            '–'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          ) : (
            <Card className="mt-4">
              <Empty title="No estimate for this week" />
            </Card>
          )}

          <Card className="mt-4" title={<span className="flex items-center gap-2"><Info className="h-4 w-4 text-muted" />How the estimate works</span>}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-2">
              <li>
                Each week, take your best {sport === 'ride' ? 'power' : 'pace'} for every duration over the previous {Math.round(WINDOW_DAYS / 30)} months, between {fmtDurLabel(ESTIMATE_CONFIG[sport].tMin)} and {fmtDurLabel(ESTIMATE_CONFIG[sport].tMax)}. That range is long enough to be aerobic-dominant and short enough that you can go all-out.
              </li>
              <li>Fit a curve to the upper edge of those efforts, so easy sessions that happen to be your "best 30 minutes" don't drag it down.</li>
              <li>
                Out of every combination of three efforts that are well spread in duration (each at least 1.6× longer than the one before, 4× overall), keep the one whose <i>weakest</i> effort sits highest relative to that edge. That gives three genuinely maximal efforts that pin down both the slope and the intercept. A value copied from a longer effort doesn't count as a separate effort.
              </li>
              <li>
                Fit the {LABEL[sport].model} model through those three points (a straight line in {sport === 'ride' ? 'work' : 'distance'} vs time).{' '}
                {sport === 'ride'
                  ? `FTP = ${Math.round(ESTIMATE_CONFIG.ride.factor * 100)}% of CP, because CP from 3–30 min efforts sits slightly above one-hour power. Two floors catch a fit that runs low: 95% of your best 20 minutes (never above CP), and your best hour — FTP can't sit below an hour you've actually ridden.`
                  : sport === 'run'
                    ? 'Threshold pace = critical speed.'
                    : 'CSS is the critical speed.'}
              </li>
              <li>
                Fitness is lost slowly, but a big effort leaves the window all at once. So the applied value can drop by at most {Math.round(MAX_WEEKLY_DECLINE * 100)}% per week. Rises apply immediately.
              </li>
              <li>Each activity uses the estimate that was current on its date. Heart-rate thresholds (LTHR, max HR) have their own tab.</li>
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------- heart rate ----------
interface HrValues {
  lthr: number | null;
  runLthr: number | null;
  maxHr: number | null;
}
interface HrWeek extends HrValues {
  date: string;
  rides: number;
  runs: number;
  /** what that week's own windows measured, before the best value is carried forward */
  raw?: HrValues;
}
interface HrResponse {
  auto: boolean;
  series: HrWeek[];
  manual: { date: string; lthr: number; runLthr: number; maxHr: number }[];
  gaps: Gap[];
  state: { running: boolean; lastRun: string | null };
}

const HR_LINES = [
  { key: 'lthr', name: 'Bike LTHR', window: '6 months of rides' },
  { key: 'runLthr', name: 'Run LTHR', window: '6 months of runs' },
  { key: 'maxHr', name: 'Max HR', window: '12 months' },
] as const;

function HrHistoryChart({ series, timeline }: { series: HrWeek[]; timeline: Timeline }) {
  const t = useTokens();
  const option = useMemo(() => {
    const X = (d: string) => timeline.toX(parseISO(d).getTime());
    const firstDate = series[0]?.date ?? iso(new Date());
    const lastDate = series.length ? series[series.length - 1].date : iso(new Date());
    // bike and run LTHR often coincide (run is never below bike): dash the run line so both show
    const style = { lthr: { color: t.accent, type: 'solid' as const }, runLthr: { color: t.series[1], type: 'dashed' as const }, maxHr: { color: t.ink2, type: 'solid' as const } };
    const line = (k: keyof HrValues) => {
      const out: (number | null)[][] = [];
      series.forEach((e, i) => {
        if (i && timeline.breakBetween(series[i - 1].date, e.date)) out.push([null, null]);
        out.push([X(e.date), e[k] == null ? null : Math.round(e[k]! * 10) / 10]);
      });
      return out;
    };
    const byX = new Map(series.map((e) => [X(e.date), e]));
    return {
      animation: false,
      grid: { left: 52, right: 16, top: 34, bottom: 30 },
      legend: { ...legendStyle(t), data: HR_LINES.map((l) => l.name) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const e = byX.get(ps[0]?.value?.[0]);
          if (!e) return '';
          const row = (l: (typeof HR_LINES)[number]) => {
            const v = e[l.key];
            const m = e.raw?.[l.key];
            return v == null ? '' : tipRow(style[l.key].color, l.name, `${Math.round(v)}${m != null && Math.round(m) !== Math.round(v) ? ` <span style="opacity:.6">(measured ${Math.round(m)})</span>` : ''}`);
          };
          return `<b>From ${fmtDate(e.date, 'd MMM yyyy')}</b>${HR_LINES.map(row).join('')}<div style="opacity:.6;font-size:11px;margin-top:4px">${e.rides} rides · ${e.runs} runs with heart rate in the 6-month window</div>`;
        },
      },
      xAxis: {
        type: 'value',
        min: X(firstDate) - 7 * DAY,
        max: X(lastDate) + 7 * DAY,
        ...axisStyle(t, { grid: false }),
        splitNumber: 8,
        axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => (timeline.inBreak(v) ? '' : fmtDate(new Date(timeline.fromX(v)), 'MMM yy')) },
      },
      yAxis: valueAxis(t, { scale: true, name: 'bpm', nameTextStyle: { color: t.muted, fontSize: 10 }, axisLabel: { color: t.muted, fontSize: 11 } }),
      series: [
        ...HR_LINES.map((l, i) => ({
          type: 'line',
          name: l.name,
          step: 'end',
          showSymbol: false,
          connectNulls: false,
          data: line(l.key),
          lineStyle: { color: style[l.key].color, width: l.key === 'lthr' ? 2.5 : 1.8, type: style[l.key].type },
          itemStyle: { color: style[l.key].color },
          markArea:
            i === 0 && timeline.breaks.length
              ? {
                  silent: true,
                  itemStyle: { color: alpha(t.muted, 0.12) },
                  label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, lineHeight: 13, formatter: (p: any) => p.name },
                  data: timeline.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]),
                }
              : undefined,
        })),
        // what each week's window measured on its own: the evidence behind the lines
        ...HR_LINES.map((l) => ({
          type: 'scatter',
          name: l.name,
          symbolSize: 4,
          silent: true,
          z: 1,
          data: series.filter((e) => e.raw?.[l.key] != null).map((e) => [X(e.date), Math.round(e.raw![l.key]!)]),
          itemStyle: { color: alpha(style[l.key].color, 0.35) },
          tooltip: { show: false },
        })),
      ],
    };
  }, [series, timeline, t]);
  return <Chart option={option} height={300} />;
}

function HeartRateThresholds({ tabs }: { tabs: ReactNode }) {
  const t = useTokens();
  const { data, isLoading } = useApi<HrResponse>('/estimates/hr', { refetchInterval: (q) => ((q.state.data as HrResponse | undefined)?.state.running ? 3000 : false) });
  const prefs = useApi<Preferences>('/preferences');
  const setAuto = useAction((v: boolean) => http('/preferences', { method: 'PUT', json: { autoThresholds: { ...prefs.data!.autoThresholds, hr: v } } }));
  const timeline = useMemo(() => makeTimeline(data?.gaps ?? []), [data?.gaps]);
  const series = useMemo(() => (data?.series ?? []).filter((e) => !timeline.hidden(e.date)), [data?.series, timeline]);
  const today = iso(new Date());
  const current = series.filter((e) => e.date <= today).pop() ?? series[series.length - 1];
  const manualNow = data?.manual.filter((m) => m.date <= today).pop() ?? data?.manual[0];
  const bpm = (v: number | null | undefined) => (v == null ? '–' : `${Math.round(v)} bpm`);
  const measured = (k: keyof HrValues, window: string) => {
    const m = current?.raw?.[k];
    return m == null ? `no hard efforts in ${window}` : `measured ${Math.round(m)} in ${window}`;
  };

  return (
    <div>
      <PageHeader
        title="Thresholds"
        subtitle="Lactate-threshold and maximum heart rate from your hardest sustained efforts, estimated weekly"
        actions={
          <>
            {tabs}
            <RecomputeButton running={!!data?.state.running} />
          </>
        }
      />
      {isLoading || !data ? (
        <Spinner />
      ) : !series.length ? (
        <Card>
          <Empty title="Not enough heart-rate data yet">Estimates need rides or runs recorded with a heart-rate strap. Until then your manual values are used.</Empty>
        </Card>
      ) : (
        <>
          <div className="card mb-4 grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label="Bike LTHR" accent={t.accent} value={bpm(current?.lthr)} sub={measured('lthr', '6 mo')} />
            <Stat label="Run LTHR" value={bpm(current?.runLthr)} sub={measured('runLthr', '6 mo')} />
            <Stat label="Max HR" value={bpm(current?.maxHr)} sub={measured('maxHr', '12 mo')} />
            <Stat label="Manual values" value={manualNow ? `${manualNow.lthr} / ${manualNow.maxHr}` : '–'} sub="LTHR / max HR" title="Set in Settings → Athlete & zones" />
            <Stat label="Weeks estimated" value={series.length} sub={data.state.running ? 'recomputing…' : data.state.lastRun ? `updated ${fmtDate(data.state.lastRun, 'd MMM HH:mm')}` : undefined} />
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Zones & TSS use</div>
              <div className="mt-2">
                <Toggle checked={data.auto} onChange={(v) => setAuto.mutate(v)} label={data.auto ? 'Automatic estimate' : 'Manual values'} />
              </div>
              <div className="mt-1 text-[11px] text-muted">switching recalculates activities with heart rate</div>
            </div>
          </div>

          <Card title="History" subtitle="Lines: the values applied on each date. Faint dots: what that week's own window measured — after a break or an easy block they sit lower, because there were no hard efforts to show the threshold, not because it fell. Breaks of 3+ months without heart-rate data are collapsed.">
            <HrHistoryChart series={series} timeline={timeline} />
          </Card>

          <Card className="mt-4" title={<span className="flex items-center gap-2"><Info className="h-4 w-4 text-muted" />How the estimate works</span>}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-2">
              <li>LTHR is the heart rate you can hold for about an hour, the way Friel's field test reads it from 30 minutes of hard solo riding or running. Each week, take every ride's best 30-minute average heart rate from the previous 6 months; the second-highest is the bike LTHR (the highest when there are only a few rides), so one strap glitch can't set it.</li>
              <li>Run LTHR comes from runs the same way, but never sits below the bike value — running usually holds a few beats higher, and a block of easy running would otherwise drag it down.</li>
              <li>Max HR is the second-highest activity maximum over 12 months (a single spike can't set it), and at least 5 beats above LTHR.</li>
              <li>Heart-rate thresholds are set mostly by age, not fitness: an easy block or a long break doesn't lower them, it just lacks the hard efforts that show them. So the best value measured carries forward, less 0.7 bpm a year (the typical age decline of max HR), and only a higher reading replaces it.</li>
              <li>Heart-rate zones, and TSS for activities without power or pace, use the values current on each activity's date.</li>
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
