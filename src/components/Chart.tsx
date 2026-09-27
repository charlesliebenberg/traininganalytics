import { useEffect, useRef } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart, ScatterChart, HeatmapChart, CustomChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  BrushComponent,
  ToolboxComponent,
  AxisPointerComponent,
  CalendarComponent,
  VisualMapComponent,
  TitleComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { EChartsOption } from 'echarts';
import { type Tokens, alpha } from '../lib/theme';

echarts.use([
  BarChart,
  LineChart,
  ScatterChart,
  HeatmapChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  BrushComponent,
  ToolboxComponent,
  AxisPointerComponent,
  CalendarComponent,
  VisualMapComponent,
  TitleComponent,
  CanvasRenderer,
]);

export type { EChartsOption };
export type ECharts = echarts.ECharts;

interface Props {
  option: EChartsOption | object;
  height?: number | string;
  className?: string;
  onEvents?: Record<string, (params: any, chart: ECharts) => void>;
  onReady?: (chart: ECharts) => void;
  notMerge?: boolean;
  group?: string;
}

export function Chart({ option, height = 260, className, onEvents, onReady, notMerge = true, group }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const eventsRef = useRef(onEvents);
  eventsRef.current = onEvents;

  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current, undefined, { renderer: 'canvas' });
    chartRef.current = chart;
    if (group) {
      chart.group = group;
      echarts.connect(group);
    }
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(ref.current);
    onReady?.(chart);
    return () => {
      ro.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setOption(option as EChartsOption, { notMerge, lazyUpdate: false });
  }, [option, notMerge]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onEvents) return;
    const names = Object.keys(onEvents);
    const handlers = names.map((n) => {
      const h = (p: unknown) => eventsRef.current?.[n]?.(p, chart);
      chart.on(n, h);
      return [n, h] as const;
    });
    return () => {
      if (!chart.isDisposed()) handlers.forEach(([n, h]) => chart.off(n, h));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onEvents ? Object.keys(onEvents).join() : '']);

  return <div ref={ref} className={className} style={{ height, width: '100%' }} />;
}

// ---------- shared option builders ----------

export function baseTextStyle(t: Tokens) {
  return { color: t.ink2, fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif', fontSize: 11 };
}

export function axisStyle(t: Tokens, opts: { grid?: boolean } = {}) {
  return {
    axisLine: { show: true, lineStyle: { color: t.lineStrong } },
    axisTick: { show: false },
    axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
    splitLine: { show: opts.grid ?? true, lineStyle: { color: t.line, width: 1 } },
    nameTextStyle: { color: t.muted, fontSize: 11 },
  };
}

export function valueAxis(t: Tokens, extra: Record<string, unknown> = {}) {
  return {
    type: 'value' as const,
    ...axisStyle(t),
    axisLine: { show: false },
    splitNumber: 3,
    ...extra,
  };
}

export function tooltipStyle(t: Tokens) {
  return {
    backgroundColor: t.surface,
    borderColor: t.line,
    borderWidth: 1,
    padding: [8, 10],
    textStyle: { color: t.ink, fontSize: 12 },
    extraCssText: `box-shadow: 0 6px 24px rgba(0,0,0,${t.dark ? 0.5 : 0.12}); border-radius: 10px;`,
  };
}

export function legendStyle(t: Tokens) {
  return {
    top: 0,
    right: 0,
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 14,
    textStyle: { color: t.ink2, fontSize: 12 },
    inactiveColor: t.surface3,
  };
}

export function areaFill(color: string, top = 0.28, bottom = 0.02) {
  return {
    color: {
      type: 'linear' as const,
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: alpha(color, top) },
        { offset: 1, color: alpha(color, bottom) },
      ],
    },
  };
}

/** Row for HTML tooltips: coloured marker + label + value, text in ink tokens. */
export function tipRow(color: string, label: string, value: string) {
  return `<div style="display:flex;align-items:center;gap:8px;justify-content:space-between;min-width:150px"><span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:${color};display:inline-block"></span><span style="opacity:.75">${label}</span></span><b style="font-variant-numeric:tabular-nums">${value}</b></div>`;
}
