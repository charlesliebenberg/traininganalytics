/**
 * How load is carried and what it builds: the weekly ramp, monotony and strain, a year of days,
 * and aerobic fitness read from heart rate.
 */
import { useMemo, useState } from 'react';
import { addDays, parseISO, startOfWeek } from 'date-fns';
import type { PmcPoint } from '../../shared/types';
import { monotonyStrain } from '../../shared/analytics/pmc';
import { qs, useApi } from '../lib/api';
import { useTokens, alpha } from '../lib/theme';
import { fmtDate, fmtNum, iso } from '../lib/format';
import { Card, Empty, Segmented, Spinner, Stat } from './ui';
import { AerobicChart, outText, type AerobicSport, type AerobicTrendData } from './insights';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { gapsInDaily, makeTimeline, monthsText } from '../lib/timeline';

export function RampChart({ points }: { points: PmcPoint[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const weekEnd = new Map<string, number>();
    for (const p of points.filter((p) => !p.projected)) weekEnd.set(iso(startOfWeek(parseISO(p.date), { weekStartsOn: 1 })), p.ctl);
    const entries = [...weekEnd.entries()];
    const rows = entries.slice(1).map(([w, ctl], i) => ({ w, ramp: ctl - entries[i][1] }));
    const color = (r: number) => (r > 8 ? t.critical : r > 5 ? t.warning : r >= 0 ? t.good : t.muted);
    return {
      animation: false,
      grid: { left: 36, right: 8, top: 12, bottom: 24 },
      tooltip: { trigger: 'axis' as const, ...tooltipStyle(t), formatter: (ps: any) => `<b>Week of ${fmtDate(rows[ps[0].dataIndex].w, 'd MMM yyyy')}</b>${tipRow(ps[0].color, 'CTL change', `${ps[0].value >= 0 ? '+' : ''}${ps[0].value.toFixed(1)}`)}` },
      xAxis: { type: 'category' as const, data: rows.map((r) => fmtDate(r.w, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t),
      series: [
        {
          type: 'bar' as const,
          barMaxWidth: 14,
          data: rows.map((r) => ({ value: Math.round(r.ramp * 10) / 10, itemStyle: { color: color(r.ramp), borderRadius: r.ramp >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 5 }, { yAxis: 8 }], lineStyle: { color: t.muted, type: 'solid' as const, width: 1 }, label: { color: t.muted, fontSize: 10, formatter: '{c}', position: 'insideEndTop' as const } },
        },
      ],
    };
  }, [points, t]);
  return <Chart option={option} height={220} />;
}

export function MonotonyChart({ points }: { points: PmcPoint[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const actual = points.filter((p) => !p.projected);
    const ms = monotonyStrain(actual.map((p) => p.tss));
    // same squeezed timeline as the PMC: long breaks would otherwise fill the chart
    const gaps = gapsInDaily(actual, (p) => p.tss === 0);
    const tl = gaps.length ? makeTimeline(gaps) : null;
    const x = actual.map((p) => (tl ? tl.toX(parseISO(p.date).getTime()) : parseISO(p.date).getTime()));
    const span = x.length ? x[x.length - 1] - x[0] : 0;
    const label = (v: number) => (tl?.inBreak(v) ? '' : fmtDate(new Date(tl ? tl.fromX(v) : v), span > 300 * 86400_000 ? "MMM ''yy" : 'd MMM'));
    const bands = tl
      ? { markArea: { silent: true, itemStyle: { color: alpha(t.muted, 0.1) }, label: { show: false }, data: tl.breaks.map((g) => [{ xAxis: g.x0, name: `${monthsText(g.days)} off` }, { xAxis: g.x1 }]) } }
      : {};
    return {
      animation: false,
      grid: [
        { left: 44, right: 10, top: 22, height: 70 },
        { left: 44, right: 10, top: 130, height: 70 },
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis' as const,
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const i = ps[0].dataIndex;
          return `<b>${fmtDate(actual[i].date)}</b>${tipRow(t.series[3], 'Monotony', fmtNum(ms[i].monotony, 2))}${tipRow(t.series[4], 'Strain', fmtNum(ms[i].strain))}${tipRow(t.muted, '7-day TSS', fmtNum(ms[i].weekly))}`;
        },
      },
      xAxis: [0, 1].map((i) => ({ type: 'value' as const, gridIndex: i, min: x[0], max: x[x.length - 1], splitNumber: 4, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 1, color: t.muted, fontSize: 10, hideOverlap: true, formatter: label } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Monotony', nameLocation: 'end', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] }, max: (v: { max: number }) => Math.max(2.5, Math.ceil(v.max)) }),
        valueAxis(t, { gridIndex: 1, name: 'Strain', nameLocation: 'end', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] } }),
      ],
      series: [
        {
          type: 'line' as const,
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          data: x.map((v, i) => [v, ms[i].monotony]),
          lineStyle: { color: t.series[3], width: 1.5 },
          itemStyle: { color: t.series[3] },
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 2 }], lineStyle: { color: t.critical, type: 'solid' as const, width: 1 }, label: { color: t.muted, fontSize: 10, formatter: 'high', position: 'insideEndTop' as const } },
          ...bands,
        },
        { type: 'line' as const, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, data: x.map((v, i) => [v, ms[i].strain]), lineStyle: { color: t.series[4], width: 1.5 }, itemStyle: { color: t.series[4] }, areaStyle: { color: alpha(t.series[4], 0.12) }, ...bands },
      ],
    };
  }, [points, t]);
  return <Chart option={option} height={230} />;
}

export function LoadCalendar() {
  const t = useTokens();
  const to = iso(new Date());
  const from = iso(addDays(new Date(), -364));
  const { data } = useApi<{ date: string; tss: number }[]>(`/daily${qs({ from, to })}`);
  const option = useMemo(() => {
    if (!data) return null;
    const max = Math.max(150, ...data.map((d) => d.tss));
    return {
      animation: false,
      tooltip: { ...tooltipStyle(t), formatter: (p: any) => `<b>${fmtDate(p.value[0])}</b>${tipRow(t.accent, 'TSS', fmtNum(p.value[1]))}` },
      visualMap: { show: false, min: 0, max, inRange: { color: [t.surface2, alpha(t.accent, 0.35), t.accent] } },
      calendar: {
        range: [from, to],
        top: 24,
        left: 36,
        right: 8,
        cellSize: ['auto', 14],
        splitLine: { show: false },
        itemStyle: { borderColor: t.surface, borderWidth: 3, color: t.surface2 },
        dayLabel: { firstDay: 1, color: t.muted, fontSize: 10, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] },
        monthLabel: { color: t.muted, fontSize: 10 },
        yearLabel: { show: false },
      },
      series: [{ type: 'heatmap' as const, coordinateSystem: 'calendar' as const, data: data.map((d) => [d.date, Math.round(d.tss)]) }],
    };
  }, [data, t, from, to]);
  if (!option) return <Spinner />;
  return <Chart option={option as any} height={150} />;
}

/**
 * Measured aerobic fitness: what the heart rate says the training did, as opposed to CTL,
 * which counts the training.
 */
export function AerobicFitnessCard() {
  const [sport, setSport] = useState<AerobicSport>('ride');
  const { data, isLoading } = useApi<AerobicTrendData | null>(`/aerobic${qs({ sport })}`);
  const m = data?.model;
  const ch = data?.change;
  return (
    <Card
      className="mt-4"
      title="Aerobic fitness"
      subtitle={
        m
          ? `What you hold at ${m.refHr} bpm, read from the steady stretches of every ${sport} with ${sport === 'ride' ? 'power and ' : ''}heart rate — under standard conditions (15 °C, outdoors, rested). CTL counts your training; this measures what it did. The line is fitness with its ±1 sd band; each dot is one ${sport}, which on its own is noisy.`
          : 'What your heart rate says about fitness, from steady riding and running.'
      }
      actions={<Segmented size="sm" value={sport} onChange={setSport} options={[{ value: 'ride', label: 'Ride' }, { value: 'run', label: 'Run' }]} />}
    >
      {isLoading ? (
        <Spinner />
      ) : !data || !m ? (
        <Empty title="Not enough steady data yet">
          This needs at least 8 {sport === 'ride' ? 'rides with power' : 'runs'} recorded with a heart-rate strap, each with 20 minutes or more of steady effort.
        </Empty>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={`At ${m.refHr} bpm`} value={outText(sport, data.current.value)} sub={`likely ${outText(sport, data.current.lo)}–${outText(sport, data.current.hi)}`} />
            <Stat
              label="12-week change"
              value={ch ? `${ch.pct >= 0 ? '+' : '−'}${Math.abs(ch.pct).toFixed(0)}%` : '–'}
              sub={ch ? `±${Math.max(1, Math.round(ch.sdPct))}% · since ${fmtDate(ch.from, 'd MMM')}` : 'needs 3+ weeks of data'}
              title={ch ? `From ${outText(sport, ch.fromValue)} on ${fmtDate(ch.from, 'd MMM yyyy')}` : undefined}
            />
            <Stat label="Heat" value={m.heat >= 0.05 ? `+${m.heat.toFixed(1)} bpm` : 'No effect'} sub={m.heat >= 0.05 ? 'per °C warmer, learned from you' : 'found in your data yet'} title="How much each degree raises your heart rate at the same output, learned from your rides" />
            <Stat label="Fatigue" value={m.fatigue * 10 >= 0.05 ? `−${(m.fatigue * 10).toFixed(1)} bpm` : 'No effect'} sub={m.fatigue * 10 >= 0.05 ? 'per 10 TSB below 0' : 'found in your data yet'} title={`How much carried fatigue holds your heart rate down, learned from your data${m.indoor && sport === 'ride' ? `; indoors your heart rate reads ${Math.abs(m.indoor).toFixed(0)} bpm ${m.indoor < 0 ? 'lower' : 'higher'}` : ''}`} />
          </div>
          <AerobicChart sport={sport} points={data.points} height={300} />
        </>
      )}
    </Card>
  );
}

