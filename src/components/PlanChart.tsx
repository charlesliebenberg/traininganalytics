import { useMemo } from 'react';
import type { SeasonWeek } from '../../shared/types';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate } from '../lib/format';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from './Chart';

/**
 * Phase colours: base → build → peak as a rising ramp of one hue (purple, which none of the
 * fitness, fatigue and form lines below use), taper and race set apart, prep and recovery quiet.
 */
export function phaseColor(t: Tokens, phase: string): string {
  const p = phase.split(' ')[0];
  switch (p) {
    case 'Prep':
      return alpha(t.ink2, 0.35);
    case 'Base':
      return alpha(t.power, 0.45);
    case 'Build':
      return alpha(t.power, 0.72);
    case 'Peak':
      return t.power;
    case 'Taper':
      return t.series[2];
    case 'Race':
      return t.critical;
    default:
      return alpha(t.muted, 0.45);
  }
}


/** A plan week by week: its load by phase, and the fitness, fatigue and form it builds. */
export function PlanChart({ weeks }: { weeks: SeasonWeek[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const cats = weeks.map((w) => fmtDate(w.weekStart, 'd MMM'));
    return {
      animation: false,
      // the legend gets its own row: on a phone it spans the width and would sit on the axis name
      grid: [
        { left: 48, right: 12, top: 52, height: 150 },
        { left: 48, right: 12, top: 240, height: 120 },
      ],
      legend: { ...legendStyle(t), data: ['Fitness (CTL)', 'Fatigue (ATL)', 'Form (TSB)'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const w = weeks[ps[0].dataIndex];
          return `<b>Week of ${fmtDate(w.weekStart, 'd MMM yyyy')}</b><div style="margin:2px 0 4px;opacity:.7">${w.phase}${w.event ? ` · ${w.event}` : ''}</div>${tipRow(phaseColor(t, w.phase), 'Weekly TSS', String(w.tss))}${tipRow('transparent', 'Hours', `${w.hours}`)}${tipRow(t.ctl, 'CTL (end)', w.ctl.toFixed(0))}${tipRow(t.atl, 'ATL (end)', w.atl.toFixed(0))}${tipRow(t.tsb, 'TSB (end)', w.tsb.toFixed(0))}`;
        },
      },
      xAxis: [0, 1].map((i) => ({ type: 'category', gridIndex: i, data: cats, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 1, color: t.muted, fontSize: 10, hideOverlap: true } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Weekly TSS', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 1, name: 'CTL / ATL / TSB', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      ],
      series: [
        {
          type: 'bar',
          xAxisIndex: 0,
          yAxisIndex: 0,
          barCategoryGap: '18%',
          data: weeks.map((w) => ({ value: w.tss, itemStyle: { color: phaseColor(t, w.phase), borderRadius: [3, 3, 0, 0] } })),
          markLine: {
            symbol: 'none',
            silent: true,
            data: weeks.filter((w) => w.event).map((w) => ({ xAxis: fmtDate(w.weekStart, 'd MMM'), label: { formatter: w.event!, color: t.ink2, fontSize: 10, position: 'insideEndTop', width: 140, overflow: 'truncate' }, lineStyle: { color: t.critical, type: 'solid', width: 1 } })),
          },
        },
        { type: 'line', name: 'Fitness (CTL)', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, smooth: 0.3, data: weeks.map((w) => w.ctl), lineStyle: { color: t.ctl, width: 2.5 }, itemStyle: { color: t.ctl } },
        { type: 'line', name: 'Fatigue (ATL)', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, smooth: 0.3, data: weeks.map((w) => w.atl), lineStyle: { color: t.atl, width: 1.5 }, itemStyle: { color: t.atl } },
        { type: 'bar', name: 'Form (TSB)', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 8, data: weeks.map((w) => ({ value: w.tsb, itemStyle: { color: alpha(t.tsb, 0.7) } })), itemStyle: { color: t.tsb } },
      ],
    };
  }, [weeks, t]);
  return <Chart option={option} height={388} />;
}
