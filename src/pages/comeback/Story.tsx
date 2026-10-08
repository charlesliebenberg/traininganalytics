import { useMemo, useRef } from 'react';
import { parseISO } from 'date-fns';
import { Card, Spinner } from '../../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { useApi } from '../../lib/api';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate } from '../../lib/format';
import { breakNames, makeTimeline, monthsText } from '../../lib/timeline';
import { peakName, type PeakCard, type Story as StoryData } from './types';

const DAY = 86400_000;

/**
 * Every week of riding: best 20-min power (dots), the capacity the training supported (line),
 * peaks (diamonds, clickable) and hours (bars below, same time axis). Long breaks are squeezed.
 */
export function Story({ peaks, selected, onSelect }: { peaks: PeakCard[]; selected: string | null; onSelect: (d: string) => void }) {
  const t = useTokens();
  const { data } = useApi<StoryData>('/comeback/story');
  const ref = useRef({ onSelect });
  ref.current = { onSelect };
  const option = useMemo(() => {
    if (!data?.weeks.length) return null;
    const tl = makeTimeline(data.gaps);
    // plot each week at its middle
    const X = (d: string) => tl.toX(parseISO(d).getTime() + 3 * DAY);
    const weeks = data.weeks.filter((w) => !tl.hidden(w.week) || w.hours > 0);
    const xs = weeks.map((w) => X(w.week));
    const capacity: (number | null)[][] = [];
    weeks.forEach((w, i) => {
      if (i && tl.breakBetween(weeks[i - 1].week, w.week)) capacity.push([null, null]);
      capacity.push([xs[i], w.capacity]);
    });
    const peakPts = peaks
      .filter((p) => (p.best20 ?? p.p20) != null)
      .map((p) => ({ value: [X(p.date), p.best20 ?? p.p20], date: p.date, name: peakName(p) }));
    const nearest = (x: number) => {
      let best = 0;
      for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
      return weeks[best];
    };
    const grids = [
      { left: 48, right: 16, top: 36, height: 210 },
      { left: 48, right: 16, top: 282, height: 64 },
    ];
    // the axis follows capacity: a short ride's weekly "best" far below it isn't informative
    const caps = weeks.map((w) => w.capacity).filter((c): c is number => c != null);
    const bests = weeks.map((w) => w.best).filter((b): b is number => b != null);
    const yMin = Math.floor((Math.min(...(caps.length ? caps : bests)) * 0.75) / 50) * 50;
    const x0 = xs[0] - 10 * DAY;
    const x1 = xs[xs.length - 1] + 10 * DAY;
    const breakArea = (labels: boolean) => ({
      silent: true,
      itemStyle: { color: alpha(t.muted, 0.1) },
      label: { show: labels, color: t.muted, fontSize: 10, position: 'insideBottom' },
      data: tl.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]),
    });
    return {
      animation: false,
      grid: grids,
      legend: { ...legendStyle(t), data: ['Capacity', 'Best 20 min of the week', 'Peaks'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const w = nearest(ps[0].axisValue);
          return `<b>Week of ${fmtDate(w.week, 'd MMM yyyy')}</b>${w.best ? tipRow(t.muted, 'Best 20 min', `${w.best} W`) : ''}${w.capacity != null ? tipRow(t.accent, 'Capacity', `${Math.round(w.capacity)} W`) : ''}${tipRow(alpha(t.muted, 0.5), 'Hours', w.hours.toFixed(1))}${tipRow('transparent', 'TSS', String(w.tss))}`;
        },
      },
      xAxis: grids.map((_, i) => ({
        type: 'value',
        gridIndex: i,
        min: x0,
        max: x1,
        splitNumber: 8,
        ...axisStyle(t, { grid: false }),
        axisLabel: { show: i === 1, color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(tl.fromX(v)), 'MMM yy') },
      })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, min: yMin }),
        valueAxis(t, { gridIndex: 1, splitNumber: 2, name: 'Hours / week', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      ],
      series: [
        {
          type: 'scatter',
          name: 'Best 20 min of the week',
          xAxisIndex: 0,
          yAxisIndex: 0,
          symbolSize: 8,
          data: weeks.map((w, i) => (w.best ? [xs[i], w.best] : null)).filter(Boolean),
          itemStyle: { color: alpha(t.muted, 0.55), borderColor: t.surface, borderWidth: 1 },
          z: 2,
        },
        {
          type: 'line',
          name: 'Capacity',
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          connectNulls: false,
          data: capacity,
          lineStyle: { color: t.accent, width: 2 },
          itemStyle: { color: t.accent },
          markArea: breakArea(true),
          z: 3,
        },
        {
          type: 'scatter',
          name: 'Peaks',
          xAxisIndex: 0,
          yAxisIndex: 0,
          symbol: 'diamond',
          cursor: 'pointer',
          itemStyle: { color: t.series[1] },
          labelLayout: { hideOverlap: true },
          data: peakPts.map((p) => ({
            ...p,
            symbolSize: p.date === selected ? 18 : 13,
            itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2, opacity: p.date === selected ? 1 : 0.75 },
            label: { show: true, position: 'top', distance: 6, color: p.date === selected ? t.ink : t.ink2, fontSize: 11, fontWeight: p.date === selected ? 600 : 400, formatter: p.name },
          })),
          z: 4,
        },
        {
          type: 'bar',
          name: 'Hours',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barWidth: 2,
          data: weeks.map((w, i) => [xs[i], w.hours]),
          itemStyle: { color: alpha(t.muted, 0.5) },
          markArea: breakArea(false),
        },
      ],
    };
  }, [data, peaks, selected, t]);

  const onEvents = useMemo(
    () => ({
      click: (p: any) => {
        if (p.seriesName === 'Peaks' && p.data?.date) ref.current.onSelect(p.data.date);
      },
    }),
    [],
  );

  return (
    <Card
      className="mt-4"
      title="Your riding history"
      subtitle="20-minute power. Dots: your best 20 minutes each week. Line: the capacity your training supported at the time (the model further down). Diamonds: your peaks — click one to compare with it. Breaks of 3+ months are squeezed."
    >
      {!option || !data ? (
        <Spinner />
      ) : (
        <>
          <Chart option={option} height={372} onEvents={onEvents} />
          {data.eras.length > 1 && (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {data.eras.map((e, i) => [
                i > 0 && data.gaps[i - 1] && (
                  <div key={`gap-${e.from}`} className="flex items-center px-1 text-muted">
                    {monthsText(data.gaps[i - 1].days)} off →
                  </div>
                ),
                <div key={e.from} className="rounded-lg bg-surface-2 px-3 py-2">
                  <div className="font-medium text-ink">
                    {i === data.eras.length - 1 && data.gaps.length ? 'Comeback · ' : ''}
                    {fmtDate(e.from, 'MMM yyyy')} – {i === data.eras.length - 1 ? 'now' : fmtDate(e.to, 'MMM yyyy')}
                  </div>
                  <div className="text-ink-2">
                    {e.hoursPerWeek.toFixed(1)} h/week{e.best20 ? ` · best 20 min ${e.best20} W` : ''}
                  </div>
                </div>,
              ])}
            </div>
          )}
        </>
      )}
    </Card>
  );
}
