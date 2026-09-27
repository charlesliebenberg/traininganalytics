import { useEffect, useMemo, useRef } from 'react';
import type { Sport, Streams, Thresholds } from '../../../shared/types';
import { rollingMean, toFloat } from '../../../shared/analytics/series';
import { wPrimeBalance } from '../../../shared/analytics/power';
import { gradeAdjustedSpeed } from '../../../shared/analytics/running';
import { Chart, axisStyle, tooltipStyle, tipRow, type ECharts, type EChartsOption } from '../../components/Chart';
import { alpha, useTokens, type Tokens } from '../../lib/theme';
import { distUnit, distValue, elevUnit, elevValue, fmtDuration, fmtPaceSec, paceSeconds, paceUnit, speedUnit, speedValue } from '../../lib/format';

export type ChannelKey = 'watts' | 'heartrate' | 'cadence' | 'speed' | 'gap' | 'altitude' | 'wbal' | 'temp' | 'grade';

export interface Channel {
  key: ChannelKey;
  label: string;
  unit: string;
  color: string;
  height: number;
  values: (number | null)[];
  format: (v: number) => string;
  inverse?: boolean;
  area?: boolean;
  min?: number;
}

export const isPaceSport = (s: Sport) => s === 'run' || s === 'walk' || s === 'hike' || s === 'swim';

/** Build display channels (smoothed) from raw streams. */
export function buildChannels(s: Streams, sport: Sport, th: Thresholds, t: Tokens, smoothing: number): Channel[] {
  const n = s.time.length;
  const sm = (v: (number | null)[] | null | undefined, zeroAsNull = false): (number | null)[] | null => {
    if (!v) return null;
    const f = toFloat(v);
    const r = smoothing > 1 ? rollingMean(f, smoothing) : f;
    const out: (number | null)[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = v[i] == null || (zeroAsNull && !v[i]) ? null : r[i];
    return out;
  };
  const chans: Channel[] = [];
  if (s.watts) chans.push({ key: 'watts', label: 'Power', unit: 'W', color: t.power, height: 110, values: sm(s.watts)!, format: (v) => `${Math.round(v)}`, area: true, min: 0 });
  if (s.heartrate) chans.push({ key: 'heartrate', label: 'Heart rate', unit: 'bpm', color: t.hr, height: 90, values: sm(s.heartrate)!, format: (v) => `${Math.round(v)}` });
  if (s.speed) {
    if (isPaceSport(sport)) {
      const toPace = (v: (number | null)[]) => v.map((x) => (x == null || x < 0.8 ? null : paceSeconds(x, sport)));
      chans.push({ key: 'speed', label: 'Pace', unit: paceUnit(sport), color: t.speed, height: 90, values: toPace(sm(s.speed, true)!), format: fmtPaceSec, inverse: true });
      if (s.grade && sport !== 'swim') {
        const gap = gradeAdjustedSpeed(s.speed, s.grade);
        chans.push({ key: 'gap', label: 'Grade-adjusted pace', unit: paceUnit(sport), color: t.series[2], height: 80, values: toPace(sm(gap, true)!), format: fmtPaceSec, inverse: true });
      }
    } else chans.push({ key: 'speed', label: 'Speed', unit: speedUnit(), color: t.speed, height: 80, values: sm(s.speed)!.map((v) => (v == null ? null : speedValue(v))), format: (v) => v.toFixed(1), min: 0 });
  }
  if (s.cadence && s.cadence.some((c) => c)) chans.push({ key: 'cadence', label: 'Cadence', unit: sport === 'run' ? 'spm' : 'rpm', color: t.cadence, height: 70, values: sm(s.cadence, true)!.map((v) => (v == null ? null : sport === 'run' ? v * 2 : v)), format: (v) => `${Math.round(v)}` });
  if (s.watts && th.ftp) chans.push({ key: 'wbal', label: "W′ balance", unit: 'kJ', color: t.wbal, height: 70, values: wPrimeBalance(s.watts, th.ftp, th.wPrime).map((v) => v / 1000), format: (v) => v.toFixed(1), area: true });
  if (s.altitude && s.altitude.some((a) => a)) chans.push({ key: 'altitude', label: 'Elevation', unit: elevUnit(), color: t.altitude, height: 70, values: s.altitude.map((v) => (v == null ? null : elevValue(v))), format: (v) => `${Math.round(v)}`, area: true });
  if (s.temp) chans.push({ key: 'temp', label: 'Temperature', unit: '°', color: t.temp, height: 60, values: sm(s.temp)!, format: (v) => v.toFixed(1) });
  return chans;
}

function downsample(x: number[], ys: (number | null)[][], target = 5000) {
  const n = x.length;
  const step = Math.max(1, Math.ceil(n / target));
  if (step === 1) return { x, ys, step };
  const nx: number[] = [];
  const nys = ys.map(() => [] as (number | null)[]);
  for (let i = 0; i < n; i += step) {
    nx.push(x[i]);
    ys.forEach((y, k) => {
      let s = 0;
      let c = 0;
      for (let j = i; j < Math.min(n, i + step); j++) {
        const v = y[j];
        if (v != null) {
          s += v;
          c++;
        }
      }
      nys[k].push(c ? s / c : null);
    });
  }
  return { x: nx, ys: nys, step };
}

export interface StreamsChartProps {
  streams: Streams;
  channels: Channel[];
  xMode: 'time' | 'distance';
  highlight: [number, number] | null;
  onHover?: (index: number | null) => void;
  onSelect?: (range: [number, number] | null) => void;
  zoom?: [number, number] | null;
}

export function StreamsChart({ streams, channels, xMode, highlight, onHover, onSelect, zoom }: StreamsChartProps) {
  const t = useTokens();
  const chartRef = useRef<ECharts | null>(null);
  const zoomRef = useRef<{ start: number; end: number }>({ start: 0, end: 100 });
  const n = streams.time.length;
  const xRaw = useMemo(() => {
    if (xMode === 'distance' && streams.distance) {
      let last = 0;
      return streams.distance.map((d) => (last = d ?? last)).map((d) => distValue(d));
    }
    return streams.time;
  }, [streams, xMode]);

  const indexForX = (x: number) => {
    if (xMode === 'time') return Math.max(0, Math.min(n - 1, Math.round(x)));
    let lo = 0,
      hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xRaw[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  useEffect(() => {
    if (zoom) {
      const x0 = xRaw[zoom[0]];
      const x1 = xRaw[Math.min(n - 1, zoom[1])];
      const span = xRaw[n - 1] - xRaw[0] || 1;
      zoomRef.current = { start: Math.max(0, ((x0 - xRaw[0]) / span) * 100 - 1), end: Math.min(100, ((x1 - xRaw[0]) / span) * 100 + 1) };
    } else zoomRef.current = { start: 0, end: 100 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  const { option, height } = useMemo(() => {
    const ds = downsample(xRaw as number[], channels.map((c) => c.values));
    let top = 22;
    const gap = 26;
    const grids = channels.map((c) => {
      const g = { left: 52, right: 16, top, height: c.height - 22 };
      top += c.height - 22 + gap;
      return g;
    });
    top -= gap - 8;
    const bottom = top + 44;
    const hl = highlight ? [[{ xAxis: xRaw[highlight[0]] }, { xAxis: xRaw[Math.min(n - 1, highlight[1] - 1)] }]] : [];
    const xFmt = (v: number) => (xMode === 'time' ? fmtDuration(v) : `${v.toFixed(1)} ${distUnit()}`);
    const option = {
      animation: false,
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.ink2, width: 1 }, label: { show: false } },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        axisPointer: { type: 'line', animation: false },
        position: (pt: number[], _p: unknown, _d: unknown, _r: unknown, size: { viewSize: number[]; contentSize: number[] }) => {
          const x = pt[0] + 16 + size.contentSize[0] > size.viewSize[0] ? pt[0] - size.contentSize[0] - 16 : pt[0] + 16;
          return [x, 8];
        },
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          if (!arr.length) return '';
          const i = indexForX(arr[0].axisValue);
          const head = `<div style="font-weight:600;margin-bottom:4px">${fmtDuration(streams.time[i])}${streams.distance?.[i] != null ? ` · ${distValue(streams.distance[i]!).toFixed(2)} ${distUnit()}` : ''}</div>`;
          return head + channels.map((c) => (c.values[i] != null ? tipRow(c.color, c.label, `${c.format(c.values[i]!)} ${c.unit}`) : '')).join('');
        },
      },
      brush: { xAxisIndex: 'all', brushLink: 'all', brushType: 'lineX', brushMode: 'single', transformable: false, throttleType: 'debounce', throttleDelay: 100, brushStyle: { color: alpha(t.accent, 0.12), borderColor: alpha(t.accent, 0.6), borderWidth: 1 }, outOfBrush: { colorAlpha: 1 } },
      toolbox: { show: false },
      dataZoom: [
        { type: 'inside', xAxisIndex: channels.map((_, i) => i), zoomOnMouseWheel: true, moveOnMouseMove: false, moveOnMouseWheel: false, start: zoomRef.current.start, end: zoomRef.current.end },
        {
          type: 'slider',
          xAxisIndex: channels.map((_, i) => i),
          top: top + 22,
          height: 22,
          start: zoomRef.current.start,
          end: zoomRef.current.end,
          borderColor: t.line,
          backgroundColor: t.surface2,
          fillerColor: alpha(t.accent, 0.12),
          handleStyle: { color: t.surface, borderColor: t.lineStrong },
          dataBackground: { lineStyle: { color: t.lineStrong }, areaStyle: { color: t.surface3 } },
          selectedDataBackground: { lineStyle: { color: t.accent }, areaStyle: { color: alpha(t.accent, 0.2) } },
          textStyle: { color: t.muted, fontSize: 10 },
          labelFormatter: (v: number) => xFmt(v),
          moveHandleSize: 0,
        },
      ],
      xAxis: channels.map((_, i) => ({
        type: 'value',
        gridIndex: i,
        min: xRaw[0],
        max: xRaw[n - 1],
        ...axisStyle(t, { grid: false }),
        axisLine: { show: true, lineStyle: { color: t.line } },
        axisLabel: { show: i === channels.length - 1, color: t.muted, fontSize: 10, formatter: xFmt, hideOverlap: true },
      })),
      yAxis: channels.map((c, i) => ({
        type: 'value',
        gridIndex: i,
        inverse: c.inverse,
        min: c.min ?? ((v: { min: number }) => Math.floor(v.min)),
        max: (v: { max: number }) => Math.ceil(v.max),
        splitNumber: 2,
        ...axisStyle(t),
        axisLine: { show: false },
        axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => c.format(v), showMaxLabel: false },
        name: `${c.label} · ${c.unit}`,
        nameLocation: 'end',
        nameGap: 6,
        nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -48], fontWeight: 500 },
      })),
      series: channels.map((c, i) => ({
        type: 'line',
        name: c.label,
        xAxisIndex: i,
        yAxisIndex: i,
        showSymbol: false,
        sampling: 'lttb',
        connectNulls: false,
        lineStyle: { width: c.key === 'altitude' ? 1 : 1.3, color: c.color },
        itemStyle: { color: c.color },
        areaStyle: c.area ? { color: alpha(c.color, c.key === 'altitude' ? 0.25 : 0.18), origin: 'start' } : undefined,
        emphasis: { disabled: true },
        data: ds.x.map((x, k) => [x, ds.ys[i][k]]),
        markArea: hl.length ? { silent: true, itemStyle: { color: alpha(t.serious, 0.12), borderColor: alpha(t.serious, 0.5), borderWidth: 1 }, data: hl as any } : undefined,
      })),
    } as EChartsOption;
    return { option, height: bottom + 14 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, xRaw, highlight, t, zoom]);

  useEffect(() => {
    chartRef.current?.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
  }, [option]);

  return (
    <Chart
      option={option}
      height={height}
      onReady={(c) => {
        chartRef.current = c;
        c.dispatchAction({ type: 'takeGlobalCursor', key: 'brush', brushOption: { brushType: 'lineX', brushMode: 'single' } });
        c.getZr().on('globalout', () => onHover?.(null));
      }}
      onEvents={{
        updateAxisPointer: (p: any) => {
          const v = p.axesInfo?.[0]?.value;
          if (v != null) onHover?.(indexForX(v));
        },
        brushEnd: (p: any) => {
          const r = p.areas?.[0]?.coordRange;
          if (!r) return onSelect?.(null);
          const [a, b] = Array.isArray(r[0]) ? r[0] : r;
          const s = indexForX(Math.min(a, b));
          const e = indexForX(Math.max(a, b));
          if (e - s >= 3) onSelect?.([s, e + 1]);
        },
        datazoom: (_p: any, chart: ECharts) => {
          const dz = (chart.getOption() as any).dataZoom?.[0];
          if (dz) zoomRef.current = { start: dz.start, end: dz.end };
        },
      }}
    />
  );
}
