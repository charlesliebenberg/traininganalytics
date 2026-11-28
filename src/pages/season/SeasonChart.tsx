import { useMemo } from 'react';
import { parseISO } from 'date-fns';
import type { PmcPoint, RaceEvent } from '../../../shared/types';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate } from '../../lib/format';
import { SCENARIO_NAMES, scenarioColor, signed, type ForecastData, type ScenarioId } from '../../lib/forecast';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { formColor } from '../../components/charts';
import type { PlanPhase } from '../../components/plan';

const zoneOf = (tsb: number, ctl: number) => {
  const rel = ctl > 5 ? tsb / ctl : tsb / 30;
  return rel >= 0.25 ? 'transition' : rel >= 0.05 ? 'fresh' : rel >= -0.1 ? 'neutral' : rel >= -0.3 ? 'optimal' : 'overload';
};
const PRIORITY_RANK: Record<string, number> = { A: 0, B: 1, C: 2 };

/**
 * The season in one picture: fitness and fatigue as they were, and where each way forward takes
 * fitness to race day — the chosen one bold — with form underneath, the plan's phases behind, and
 * every race marked. A click picks that week out of the timeline below.
 */
export function FitnessChart({ history, d, selected, events, phases, height = 340, onPick }: { history: PmcPoint[]; d: ForecastData | null; selected: ScenarioId; events: RaceEvent[]; phases: PlanPhase[]; height?: number; onPick?: (date: string) => void }) {
  const t = useTokens();
  const option = useMemo(() => {
    const ts = (date: string) => parseISO(date).getTime();
    const past = history.filter((p) => !p.projected);
    const now = past[past.length - 1];
    const sel = d?.scenarios.find((s) => s.id === selected) ?? d?.scenarios[0] ?? null;
    const end = d?.end ?? now?.date;
    const top = 48;
    const gap = 30;
    const avail = height - top - 28 - gap;
    const h1 = Math.round(avail * 0.64);
    const grids = [
      { left: 40, right: 30, top, height: h1 },
      { left: 40, right: 30, top: top + h1 + gap, height: avail - h1 },
    ];
    const line = (color: string, width: number, dashed = false) => ({ type: 'line' as const, showSymbol: false, smooth: 0.25, lineStyle: { color, width, type: dashed ? ('dashed' as const) : ('solid' as const), cap: 'round' as const }, itemStyle: { color }, emphasis: { disabled: true } });
    const from = past[0]?.date;
    const inRange = (date: string) => !!from && date >= from && (!end || date <= end);
    const races = events.filter((e) => inRange(e.date)).sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    const series: any[] = [
      {
        ...line(t.ctl, 2.5),
        name: 'Fitness',
        data: past.map((p) => [ts(p.date), p.ctl]),
        areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(t.ctl, 0.16) }, { offset: 1, color: alpha(t.ctl, 0.01) }] } },
        markLine: {
          symbol: 'none',
          silent: true,
          data: [
            ...(now ? [{ xAxis: ts(now.date), lineStyle: { color: t.ink2, type: 'solid', width: 1 }, label: { formatter: 'Today', color: t.ink2, fontSize: 10, fontWeight: 600, position: 'insideEndTop' } }] : []),
            ...races.map((e) => ({ xAxis: ts(e.date), lineStyle: { color: e.priority === 'A' ? t.critical : alpha(t.critical, 0.45), type: e.priority === 'A' ? 'solid' : 'dashed', width: 1 }, label: { formatter: `${e.priority} · ${e.name}`, color: t.ink2, fontSize: 10, position: 'insideEndTop', width: h1 - 14, overflow: 'truncate' } })),
          ],
        },
        markArea: {
          silent: true,
          itemStyle: { color: alpha(t.ink2, t.dark ? 0.06 : 0.035) },
          label: { color: t.muted, fontSize: 10, position: 'insideBottomLeft', distance: [6, 6] },
          // the plan's phases that overlap the chart, cut to it, alternating in shade
          data: phases
            .filter((p) => p.start && p.end && from && p.end >= from && (!end || p.start <= end))
            .map((p, i) => [{ xAxis: ts(p.start! < from! ? from! : p.start!), name: p.name ?? '', itemStyle: { color: alpha(t.ink2, i % 2 ? (t.dark ? 0.05 : 0.03) : t.dark ? 0.09 : 0.055) } }, { xAxis: ts(end && p.end! > end ? end : p.end!) }]),
        },
      },
      { ...line(t.atl, 1.5), name: 'Fatigue', data: past.map((p) => [ts(p.date), p.atl]), lineStyle: { color: alpha(t.atl, 0.8), width: 1.5 } },
      ...(d && now
        ? d.scenarios.map((s) => ({
            ...line(scenarioColor(t, s.id), s.id === selected ? 2.75 : 1.25, s.id !== selected),
            name: SCENARIO_NAMES[s.id],
            z: s.id === selected ? 6 : 3,
            data: [[ts(now.date), now.ctl], ...s.days.map((p) => [ts(p.date), p.ctl])],
            lineStyle: { color: s.id === selected ? scenarioColor(t, s.id) : alpha(scenarioColor(t, s.id), 0.7), width: s.id === selected ? 2.75 : 1.25, type: s.id === selected ? 'solid' : 'dashed', cap: 'round' },
            endLabel: s.id === selected ? { show: true, formatter: (p: any) => `${Math.round(p.value[1])}`, color: t.ink, fontSize: 11, fontWeight: 600, distance: 4 } : undefined,
          }))
        : []),
      {
        type: 'bar',
        name: 'Form',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 5,
        barCategoryGap: '30%',
        data: [...past.map((p) => ({ date: p.date, tsb: p.tsb, ctl: p.ctl, ahead: false })), ...(sel?.days ?? []).map((p) => ({ date: p.date, tsb: p.tsb, ctl: p.ctl, ahead: true }))].map((p) => ({
          value: [ts(p.date), Math.round(p.tsb * 10) / 10],
          itemStyle: { color: alpha(formColor(t, zoneOf(p.tsb, p.ctl)), p.ahead ? 0.5 : 0.95), borderRadius: 2 },
        })),
      },
    ];
    const hist = new Map(past.map((p) => [p.date, p]));
    const ahead = new Map<string, Record<string, number>>();
    for (const s of d?.scenarios ?? []) for (const p of s.days) ahead.set(p.date, { ...(ahead.get(p.date) ?? {}), [s.id]: p.ctl, [`${s.id}:tsb`]: p.tsb, [`${s.id}:load`]: p.load });
    return {
      animation: false,
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.lineStrong, width: 1 } },
      legend: { ...legendStyle(t), left: 0, right: 'auto', data: ['Fitness', 'Fatigue', ...(d?.scenarios.map((s) => SCENARIO_NAMES[s.id]) ?? [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const x = (Array.isArray(ps) ? ps : [ps])[0]?.value?.[0];
          if (x == null) return '';
          const date = new Date(x).toISOString().slice(0, 10);
          const race = races.find((e) => e.date === date);
          const head = `<div style="font-weight:600;margin-bottom:4px">${fmtDate(date, 'EEE d MMM yyyy')}${race ? ` · ${race.priority} ${race.name}` : ''}</div>`;
          const h = hist.get(date);
          if (h) return `${head}${tipRow(t.ctl, 'Fitness', h.ctl.toFixed(1))}${tipRow(t.atl, 'Fatigue', h.atl.toFixed(1))}${tipRow(formColor(t, zoneOf(h.tsb, h.ctl)), 'Form', signed(h.tsb, 1))}${tipRow(t.lineStrong, 'Load', `${Math.round(h.tss)} TSS`)}`;
          const r = ahead.get(date);
          if (!r || !d) return head;
          return `${head}${d.scenarios.map((s) => tipRow(scenarioColor(t, s.id), SCENARIO_NAMES[s.id], `${Math.round(r[s.id] ?? 0)} · form ${signed(r[`${s.id}:tsb`] ?? 0)}`)).join('')}<div style="opacity:.6;font-size:11px;margin-top:6px">Click to see the week</div>`;
        },
      },
      xAxis: grids.map((_, i) => ({ type: 'time', gridIndex: i, min: from ? ts(from) : undefined, max: end ? ts(end) : undefined, ...axisStyle(t, { grid: false }), axisLine: { show: i === 1, lineStyle: { color: t.lineStrong } }, axisLabel: { show: i === 1, color: t.muted, fontSize: 11, hideOverlap: true } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Fitness', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -28] }, scale: true, splitNumber: 3 }),
        valueAxis(t, { gridIndex: 1, name: 'Form', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -28] }, splitNumber: 2 }),
      ],
      series: series.map((s) => (s.type === 'line' ? { ...s, xAxisIndex: 0, yAxisIndex: 0 } : s)),
    };
  }, [history, d, selected, events, phases, t, height]);
  return (
    <Chart
      option={option}
      height={height}
      onEvents={
        onPick
          ? {
              // anywhere on the plot, not only on a line: the pixel's date
              click: (p: any) => {
                const x = p?.value?.[0] ?? p?.data?.value?.[0];
                if (x != null) onPick(new Date(x).toISOString().slice(0, 10));
              },
            }
          : undefined
      }
      onReady={(chart) => {
        if (!onPick) return;
        chart.getZr().on('click', (e: any) => {
          if (e.target) return;
          const pt = [e.offsetX, e.offsetY];
          for (const gi of [0, 1]) {
            if (chart.containPixel({ gridIndex: gi }, pt)) {
              const v = chart.convertFromPixel({ gridIndex: gi }, pt) as number[];
              if (v?.[0] != null) onPick(new Date(v[0]).toISOString().slice(0, 10));
              return;
            }
          }
        });
      }}
    />
  );
}

/** FTP to race day under each way forward, the chosen one's likely range shaded, with TrainerRoad's own. */
export function PowerChart({ d, selected, height = 300 }: { d: ForecastData; selected: ScenarioId; height?: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const ftp = d.now.ftp ?? 0;
    const ts = (date: string) => parseISO(date).getTime();
    const sel = d.scenarios.find((s) => s.id === selected) ?? d.scenarios[0];
    const start = [ts(d.today), ftp];
    const color = scenarioColor(t, sel.id);
    const series: any[] = [
      { type: 'line', name: 'low', stack: 'band', silent: true, showSymbol: false, data: [start, ...sel.days.map((p) => [ts(p.date), ftp * (p.capLow ?? 1)])], lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { type: 'line', name: 'range', stack: 'band', silent: true, showSymbol: false, data: [[ts(d.today), 0], ...sel.days.map((p) => [ts(p.date), ftp * ((p.capHigh ?? 1) - (p.capLow ?? 1))])], lineStyle: { opacity: 0 }, areaStyle: { color: alpha(color, 0.14) }, tooltip: { show: false } },
      ...d.scenarios.map((s) => ({
        type: 'line',
        name: SCENARIO_NAMES[s.id],
        showSymbol: false,
        smooth: 0.2,
        z: s.id === selected ? 5 : 3,
        lineStyle: { color: s.id === selected ? scenarioColor(t, s.id) : alpha(scenarioColor(t, s.id), 0.7), width: s.id === selected ? 2.75 : 1.25, type: s.id === selected ? 'solid' : 'dashed' },
        itemStyle: { color: scenarioColor(t, s.id) },
        data: [start, ...s.days.map((p) => [ts(p.date), ftp * (p.cap ?? 1)])],
        endLabel: s.id === selected ? { show: true, formatter: (p: any) => `${Math.round(p.value[1])} W`, color: t.ink, fontSize: 11, fontWeight: 600 } : undefined,
      })),
    ];
    if (d.trainerRoad?.predicted.length || d.trainerRoad?.now) {
      series.push({
        type: 'scatter',
        name: 'TrainerRoad',
        symbol: 'diamond',
        symbolSize: 11,
        itemStyle: { color: t.series[3], borderColor: t.surface, borderWidth: 2 },
        data: [...(d.trainerRoad.now ? [{ value: [ts(d.today), d.trainerRoad.now], label: 'its FTP now' }] : []), ...d.trainerRoad.predicted.filter((p) => p.date <= d.end).map((p) => ({ value: [ts(p.date), p.value], label: `predicted for ${fmtDate(p.date, 'd MMM')}` }))],
        tooltip: { formatter: (p: any) => `<b>TrainerRoad</b>${tipRow(t.series[3], p.data.label, `${p.value[1]} W`)}` },
      });
    }
    const values = series.flatMap((s) => s.data.map((p: any) => (Array.isArray(p) ? p[1] : p.value[1]))).filter((v: number) => v > 50);
    return {
      animation: false,
      grid: { left: 44, right: 58, top: 48, bottom: 28 },
      legend: { ...legendStyle(t), left: 0, right: 'auto', data: [...d.scenarios.map((s) => SCENARIO_NAMES[s.id]), ...(d.trainerRoad ? ['TrainerRoad'] : [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const names = new Set(Object.values(SCENARIO_NAMES));
          const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => names.has(p.seriesName));
          if (!arr.length) return '';
          const date = new Date(arr[0].value[0]).toISOString().slice(0, 10);
          return `<div style="font-weight:600;margin-bottom:4px">${fmtDate(date, 'EEE d MMM yyyy')}</div>${arr.map((p: any) => tipRow(p.color, p.seriesName, `${Math.round(p.value[1])} W`)).join('')}`;
        },
      },
      xAxis: { type: 'time', ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true } },
      yAxis: valueAxis(t, { name: 'FTP', minInterval: 1, min: Math.floor((Math.min(...values) - 5) / 5) * 5, max: Math.ceil((Math.max(...values) + 5) / 5) * 5, nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -28] }, axisLabel: { color: t.muted, fontSize: 11, formatter: '{value} W' } }),
      series,
    };
  }, [d, selected, t]);
  return <Chart option={option} height={height} />;
}
