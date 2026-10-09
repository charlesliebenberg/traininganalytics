import { useMemo } from 'react';
import { parseISO } from 'date-fns';
import type { PmcPoint, RaceEvent, WorkoutStructure } from '../../shared/types';
import { formZone, FORM_ZONES } from '../../shared/analytics/pmc';
import { flatten } from '../../shared/analytics/workout';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis, legendStyle, type EChartsOption } from './Chart';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtDuration } from '../lib/format';
import { breakNames, gapsInDaily, makeTimeline } from '../lib/timeline';

// ---------- form-zone colours (state, so status palette) ----------
export function formColor(t: Tokens, id: string): string {
  switch (id) {
    case 'transition':
      return t.muted;
    case 'fresh':
      return t.accent;
    case 'neutral':
      return t.lineStrong;
    case 'optimal':
      return t.good;
    default:
      return t.critical;
  }
}

// ---------- Performance Management Chart ----------
export function PmcChart({ points, events = [], height = 420, compact = false, showTss = true }: { points: PmcPoint[]; events?: RaceEvent[]; height?: number; compact?: boolean; showTss?: boolean }) {
  const t = useTokens();
  const option = useMemo<EChartsOption>(() => {
    const actual = points.filter((p) => !p.projected);
    // long breaks (90+ days without load) are squeezed, so years of history read continuously
    const gaps = gapsInDaily(actual, (p) => p.tss === 0);
    const tl = gaps.length ? makeTimeline(gaps) : null;
    const ts = (d: string) => (tl ? tl.toX(parseISO(d).getTime()) : parseISO(d).getTime());
    const byX = new Map(points.map((p) => [ts(p.date), p]));
    const lastActual = actual[actual.length - 1];
    const proj = points.filter((p) => p.projected);
    const projWithJoin = lastActual && proj.length ? [lastActual, ...proj] : proj;
    const line = (color: string, dashed = false) => ({ type: 'line' as const, showSymbol: false, smooth: 0.2, lineStyle: { width: 2, color, type: dashed ? ('dashed' as const) : ('solid' as const) }, itemStyle: { color }, emphasis: { disabled: true } });
    const panels = showTss ? 3 : 2;
    const gap = 26;
    // the legend gets a row of its own above the first panel's axis name (it pages on a phone)
    const top = compact ? 44 : 50;
    const bottom = compact ? 26 : 56;
    const avail = height - top - bottom - gap * (panels - 1);
    const h1 = Math.round(avail * (showTss ? 0.5 : 0.62));
    const h2 = Math.round(avail * (showTss ? 0.27 : 0.38));
    const h3 = avail - h1 - h2;
    const grids = [
      { left: 44, right: 16, top, height: h1 },
      { left: 44, right: 16, top: top + h1 + gap, height: h2 },
      ...(showTss ? [{ left: 44, right: 16, top: top + h1 + h2 + gap * 2, height: h3 }] : []),
    ];
    const xAxes = grids.map((_, i) => ({
      type: (tl ? 'value' : 'time') as 'value',
      gridIndex: i,
      ...(tl ? { min: ts(points[0].date), max: ts(points[points.length - 1].date), splitNumber: 8 } : {}),
      ...axisStyle(t, { grid: false }),
      axisLabel: { show: i === grids.length - 1, color: t.muted, fontSize: 11, hideOverlap: true, ...(tl ? { formatter: (v: number) => (tl.inBreak(v) ? '' : fmtDate(new Date(tl.fromX(v)), "MMM ''yy")) } : {}) },
      axisLine: { show: true, lineStyle: { color: t.lineStrong } },
    }));
    const breakBands = (labels: boolean) =>
      tl
        ? {
            markArea: {
              silent: true,
              itemStyle: { color: alpha(t.muted, 0.1) },
              label: { show: labels, color: t.muted, fontSize: 10, position: 'insideTop' as const },
              data: tl.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]),
            },
          }
        : {};
    const todayTs = lastActual ? ts(lastActual.date) : Date.now();
    const evLines = events.map((e) => ({
      xAxis: ts(e.date),
      lineStyle: { color: e.priority === 'A' ? t.critical : e.priority === 'B' ? t.serious : t.muted, width: 1, type: 'solid' as const },
      label: { formatter: `${e.priority} · ${e.name}`, color: t.ink2, fontSize: 10, position: 'insideEndTop' as const },
    }));
    const tsbData = points.map((p) => ({
      value: [ts(p.date), Math.round(p.tsb * 10) / 10],
      itemStyle: { color: alpha(formColor(t, formZone(p.tsb, p.ctl).id), p.projected ? 0.45 : 0.9), borderRadius: 1 },
    }));
    const series: any[] = [
      { ...line(t.ctl), name: 'Fitness (CTL)', xAxisIndex: 0, yAxisIndex: 0, data: actual.map((p) => [ts(p.date), p.ctl]), areaStyle: { color: alpha(t.ctl, 0.08) }, markLine: evLines.length || proj.length ? { symbol: 'none', silent: true, data: [...evLines, ...(proj.length ? [{ xAxis: todayTs, lineStyle: { color: t.muted, type: 'solid' as const, width: 1 }, label: { formatter: 'Today', color: t.muted, fontSize: 10, position: 'insideEndTop' as const } }] : [])] } : undefined },
      { ...line(t.atl), name: 'Fatigue (ATL)', xAxisIndex: 0, yAxisIndex: 0, data: actual.map((p) => [ts(p.date), p.atl]), lineStyle: { width: 1.5, color: t.atl }, ...breakBands(true) },
      { type: 'bar', name: 'Form (TSB)', xAxisIndex: 1, yAxisIndex: 1, data: tsbData, barMaxWidth: 6, barCategoryGap: '10%', itemStyle: { color: t.good }, ...breakBands(false) },
    ];
    if (projWithJoin.length) {
      series.push(
        { ...line(t.ctl, true), name: 'Fitness (CTL)', xAxisIndex: 0, yAxisIndex: 0, data: projWithJoin.map((p) => [ts(p.date), p.ctl]), lineStyle: { width: 2, color: t.ctl, type: 'dashed' } },
        { ...line(t.atl, true), name: 'Fatigue (ATL)', xAxisIndex: 0, yAxisIndex: 0, data: projWithJoin.map((p) => [ts(p.date), p.atl]), lineStyle: { width: 1.5, color: t.atl, type: 'dashed' } },
      );
    }
    if (showTss) {
      series.push({
        type: 'bar',
        name: 'Daily TSS',
        itemStyle: { color: t.ink2 },
        xAxisIndex: 2,
        yAxisIndex: 2,
        barMaxWidth: 6,
        data: points.map((p) => ({ value: [ts(p.date), Math.round(p.tss)], itemStyle: { color: p.projected ? alpha(t.muted, 0.45) : alpha(t.ink2, 0.75), borderRadius: [2, 2, 0, 0] } })),
        ...breakBands(false),
      });
    }
    return {
      animation: false,
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.muted, width: 1 } },
      legend: { ...legendStyle(t), data: ['Fitness (CTL)', 'Fatigue (ATL)', 'Form (TSB)', ...(showTss ? ['Daily TSS'] : [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        axisPointer: { type: 'line' },
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const x = arr[0]?.value?.[0] ?? arr[0]?.axisValue;
          const p = byX.get(x);
          if (!p) return '';
          const z = formZone(p.tsb, p.ctl);
          return `<div style="font-weight:600;margin-bottom:4px">${fmtDate(p.date)}${p.projected ? ' · projected' : ''}</div>
            ${tipRow(t.ctl, 'Fitness', p.ctl.toFixed(1))}${tipRow(t.atl, 'Fatigue', p.atl.toFixed(1))}${tipRow(formColor(t, z.id), `Form · ${z.label}`, p.tsb.toFixed(1))}
            ${tipRow(t.ink2, p.projected ? 'Planned TSS' : 'TSS', Math.round(p.tss).toString())}${tipRow(t.muted, 'Ramp (7d)', `${p.ramp >= 0 ? '+' : ''}${p.ramp.toFixed(1)}`)}`;
        },
      },
      xAxis: xAxes,
      yAxis: grids.map((_, i) => valueAxis(t, { gridIndex: i, splitNumber: i === 0 ? 4 : 2, name: ['CTL / ATL', 'TSB', 'TSS'][i], nameLocation: 'end', nameGap: 8, nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] } })),
      dataZoom: compact ? [] : [{ type: 'inside', xAxisIndex: grids.map((_, i) => i) }, { type: 'slider', xAxisIndex: grids.map((_, i) => i), height: 18, bottom: 8, borderColor: t.line, backgroundColor: t.surface2, fillerColor: alpha(t.accent, 0.15), handleStyle: { color: t.surface, borderColor: t.lineStrong }, dataBackground: { lineStyle: { color: t.lineStrong }, areaStyle: { color: t.surface3 } }, textStyle: { color: t.muted }, moveHandleSize: 0, showDetail: false }],
      series,
    };
  }, [points, events, t, height, compact, showTss]);
  return <Chart option={option} height={height} />;
}

export function FormLegend() {
  const t = useTokens();
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-2">
      {FORM_ZONES.map((z) => (
        <span key={z.id} className="inline-flex items-center gap-1.5" title={z.hint}>
          <span className="h-2 w-2 rounded-sm" style={{ background: formColor(t, z.id) }} />
          {z.label}
          <span className="text-muted">
            {Number.isFinite(z.min) && Number.isFinite(z.max) ? `${Math.round(z.min * 100)}…${Math.round(z.max * 100)}%` : Number.isFinite(z.min) ? `> ${Math.round(z.min * 100)}%` : `< ${Math.round(z.max * 100)}%`}
          </span>
        </span>
      ))}
      <span className="text-muted">of fitness</span>
    </div>
  );
}

// ---------- mean-maximal curves ----------
function niceFloor(v: number): number {
  if (v <= 0) return 0;
  const step = v > 500 ? 100 : v > 100 ? 50 : v > 20 ? 10 : v > 5 ? 1 : 0.5;
  return Math.floor(v / step) * step;
}

export interface CurveSeries {
  name: string;
  color: string;
  durations: number[];
  values: (number | null)[];
  dashed?: boolean;
  meta?: { ids?: (number | null)[]; dates?: (string | null)[] };
  width?: number;
  area?: boolean;
}

export function CurveChart({
  series,
  height = 340,
  unit,
  format = (v) => Math.round(v).toString(),
  minDuration = 1,
  maxDuration,
  onPointClick,
  invert = false,
  yMin,
}: {
  series: CurveSeries[];
  height?: number;
  unit: string;
  format?: (v: number) => string;
  minDuration?: number;
  maxDuration?: number;
  onPointClick?: (seriesIndex: number, durationIndex: number) => void;
  invert?: boolean;
  yMin?: number | 'dataMin';
}) {
  const t = useTokens();
  const option = useMemo<EChartsOption>(() => {
    const maxD = maxDuration ?? Math.max(60, ...series.flatMap((s) => s.durations.filter((_d, i) => s.values[i] != null)));
    const ticks = [1, 5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200, 10800, 18000, 28800].filter((d) => d >= minDuration && d <= maxD * 1.05);
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 34, bottom: 30 },
      legend: series.length > 1 ? { ...legendStyle(t), data: series.map((s) => s.name) } : undefined,
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        axisPointer: { type: 'line', lineStyle: { color: t.muted } },
        formatter: (ps: any) => {
          const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => p.value?.[1] != null);
          if (!arr.length) return '';
          const d = arr[0].value[0];
          return `<div style="font-weight:600;margin-bottom:4px">${fmtDurLabel(d)}</div>${arr
            .map((p: any) => {
              const s = series[p.seriesIndex];
              const di = s.durations.indexOf(d);
              const date = s.meta?.dates?.[di];
              return tipRow(s.color, s.name, `${format(p.value[1])} ${unit}`) + (date ? `<div style="text-align:right;font-size:10px;opacity:.6">${fmtDate(date, 'd MMM yyyy')}</div>` : '');
            })
            .join('')}`;
        },
      },
      xAxis: {
        type: 'log',
        logBase: 10,
        min: minDuration,
        max: maxD,
        ...axisStyle(t),
        splitLine: { show: false },
        axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => fmtDurLabel(Math.round(v)), hideOverlap: true, customValues: ticks },
        axisTick: { show: true, customValues: ticks, lineStyle: { color: t.lineStrong } },
        minorTick: { show: false },
      },
      yAxis: valueAxis(t, { inverse: invert, min: yMin ?? ((v: { min: number }) => niceFloor(v.min * 0.92)), axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => format(v), showMinLabel: false }, splitNumber: 4 }),
      series: series.map((s) => ({
        type: 'line',
        name: s.name,
        showSymbol: false,
        symbolSize: 8,
        connectNulls: false,
        smooth: 0.15,
        lineStyle: { width: s.width ?? 2, color: s.color, type: s.dashed ? 'dashed' : 'solid' },
        itemStyle: { color: s.color },
        areaStyle: s.area ? { color: alpha(s.color, 0.1) } : undefined,
        emphasis: { focus: 'series' },
        data: s.durations.map((d, i) => [d, s.values[i]] as [number, number | null]).filter(([d, v]) => v != null && d >= minDuration && d <= maxD),
      })),
    };
  }, [series, t, unit, format, minDuration, maxDuration, invert, yMin]);
  return (
    <Chart
      option={option}
      height={height}
      onEvents={
        onPointClick
          ? {
              click: (p: any) => {
                const s = series[p.seriesIndex];
                const di = s.durations.indexOf(p.value?.[0]);
                if (di >= 0) onPointClick(p.seriesIndex, di);
              },
            }
          : undefined
      }
    />
  );
}

// ---------- workout profile ----------
export function workoutZoneColor(t: Tokens, intensity: number): string {
  const bounds = [0.55, 0.75, 0.9, 1.05, 1.2, 1.5];
  let z = 0;
  while (z < bounds.length && intensity >= bounds[z]) z++;
  return alpha(t.power, 0.3 + (0.7 * z) / bounds.length);
}

export function WorkoutProfile({ structure, height = 160, ftp, highlight }: { structure: WorkoutStructure; height?: number; ftp?: number; highlight?: string | null }) {
  const t = useTokens();
  const option = useMemo<EChartsOption>(() => {
    const segs = flatten(structure);
    const total = segs.reduce((a, s) => Math.max(a, s.start + s.duration), 0) || 1;
    const maxI = Math.max(1.2, ...segs.map((s) => Math.max(s.low, s.high)));
    const unit = structure.target === 'power' ? '% FTP' : structure.target === 'pace' ? '% threshold pace' : '% LTHR';
    return {
      animation: false,
      grid: { left: 40, right: 8, top: 10, bottom: 24 },
      tooltip: {
        ...tooltipStyle(t),
        formatter: (p: any) => {
          const s = segs[p.dataIndex];
          const pct = s.low === s.high ? `${Math.round(s.low * 100)}%` : `${Math.round(s.low * 100)}–${Math.round(s.high * 100)}%`;
          const watts = ftp && structure.target === 'power' ? ` · ${Math.round(s.low * ftp)}${s.low !== s.high ? `–${Math.round(s.high * ftp)}` : ''} W` : '';
          return `<b>${s.label ?? s.intent}</b>${s.repeat ? ` <span style="opacity:.6">(${s.repeat.index}/${s.repeat.of})</span>` : ''}<br/>${fmtDuration(s.duration)} @ ${pct}${watts}<br/><span style="opacity:.6">${unit}</span>`;
        },
      },
      xAxis: { type: 'value', min: 0, max: total, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => fmtDuration(v, { short: true }) }, splitNumber: 6 },
      yAxis: valueAxis(t, { min: 0, max: Math.ceil(maxI * 10) / 10, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => `${Math.round(v * 100)}%` }, splitNumber: 3 }),
      series: [
        {
          type: 'custom',
          data: segs.map((s, i) => [s.start, s.duration, s.low, s.high, s.ramp ? 1 : 0, i]),
          renderItem: (_params: any, api: any) => {
            const [start, dur, low, high, ramp] = [api.value(0), api.value(1), api.value(2), api.value(3), api.value(4)];
            const x0 = api.coord([start, 0]);
            const x1 = api.coord([start + dur, 0]);
            const yl = api.coord([0, ramp ? low : (low + high) / 2]);
            const yh = api.coord([0, ramp ? high : (low + high) / 2]);
            const seg = segs[api.value(5)];
            const faded = highlight && seg.repeat?.blockId !== highlight;
            const color = workoutZoneColor(t, (low + high) / 2);
            const gapPx = Math.min(1, (x1[0] - x0[0]) * 0.2);
            return {
              type: 'polygon',
              shape: { points: [[x0[0] + gapPx, x0[1]], [x0[0] + gapPx, yl[1]], [x1[0] - gapPx, yh[1]], [x1[0] - gapPx, x1[1]]] },
              style: { fill: faded ? alpha(t.muted, 0.25) : color },
            };
          },
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 1, lineStyle: { color: t.muted, type: 'solid', width: 1 }, label: { show: false } }] },
        },
      ],
    };
  }, [structure, t, ftp, highlight]);
  return <Chart option={option} height={height} />;
}

/** Lightweight SVG sparkline of a workout for lists and calendar cells. */
export function MiniProfile({ structure, height = 28, className }: { structure: WorkoutStructure; height?: number; className?: string }) {
  const t = useTokens();
  const segs = flatten(structure);
  const total = segs.reduce((a, s) => Math.max(a, s.start + s.duration), 0) || 1;
  const maxI = Math.max(1.25, ...segs.map((s) => Math.max(s.low, s.high)));
  const W = 100;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className={className} style={{ height, width: '100%' }} aria-hidden>
      {segs.map((s, i) => {
        const x0 = (s.start / total) * W;
        const x1 = ((s.start + s.duration) / total) * W;
        const lo = s.ramp ? s.low : (s.low + s.high) / 2;
        const hi = s.ramp ? s.high : (s.low + s.high) / 2;
        const y0 = height - (lo / maxI) * height;
        const y1 = height - (hi / maxI) * height;
        return <polygon key={i} points={`${x0},${height} ${x0},${y0} ${x1},${y1} ${x1},${height}`} fill={workoutZoneColor(t, (lo + hi) / 2)} stroke={t.surface} strokeWidth={0.3} />;
      })}
    </svg>
  );
}

// ---------- zones ----------
export function ZoneBars({ seconds, labels, names, ranges, color }: { seconds: number[]; labels: string[]; names?: string[]; ranges?: string[]; color: string }) {
  const total = seconds.reduce((a, b) => a + b, 0) || 1;
  const max = Math.max(...seconds, 1);
  return (
    <div className="space-y-1.5">
      {seconds.map((s, i) => (
        <div key={i} className="grid grid-cols-[34px_minmax(0,1fr)_64px_40px] items-center gap-2 text-xs">
          <span className="font-medium text-ink-2" title={names?.[i]}>
            {labels[i]}
          </span>
          <div className="relative h-5 overflow-hidden rounded-[4px] bg-surface-2" title={`${names?.[i] ?? ''} ${ranges?.[i] ?? ''}`}>
            <div className="h-full rounded-[4px]" style={{ width: `${(s / max) * 100}%`, background: alpha(color, 0.35 + (0.65 * i) / Math.max(1, seconds.length - 1)) }} />
            {ranges && <span className="absolute inset-y-0 left-2 flex items-center text-[10px] text-ink-2">{ranges[i]}</span>}
          </div>
          <span className="tnum text-right text-ink">{fmtDuration(s, { short: true })}</span>
          <span className="tnum text-right text-muted">{Math.round((s / total) * 100)}%</span>
        </div>
      ))}
    </div>
  );
}
