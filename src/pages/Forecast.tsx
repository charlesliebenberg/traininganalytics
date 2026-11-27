import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import clsx from 'clsx';
import { AlertTriangle, CalendarCheck, ClipboardCopy, Flag, Info, RotateCcw, Sparkles, SlidersHorizontal, Telescope } from 'lucide-react';
import { http, useAction } from '../lib/api';
import { useDebounced } from '../lib/hooks';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate, fmtNum } from '../lib/format';
import { toast } from '../lib/toast';
import { copyText } from '../lib/clipboard';
import { Button, Card, Empty, Field, Input, PageHeader, Select, Spinner, Stat } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { formColor } from '../components/charts';

// ---------- the API (server/forecast.ts) ----------
type ScenarioId = 'planned' | 'filled' | 'best' | 'custom';
interface Race {
  date: string;
  ctl: number;
  tsb: number;
  form: string;
  formLabel: string;
  ratio: number | null;
  ftp: number | null;
  ftpLow: number | null;
  ftpHigh: number | null;
  p5: number | null;
  p20: number | null;
  p60: number | null;
}
interface Scenario {
  id: ScenarioId;
  days: { date: string; load: number; ctl: number; atl: number; tsb: number; cap: number | null; capLow: number | null; capHigh: number | null }[];
  weeks: { start: string; tss: number; hours: number; ctl: number; tsb: number; ramp: number }[];
  race: Race;
  totals: { tss: number; hours: number; maxWeekHours: number; maxRamp: number; peakCtl: number };
  warnings: string[];
}
interface Limits {
  maxRamp: number;
  maxHours: number;
  target: number;
}
interface ForecastData {
  today: string;
  end: string;
  race: { id: number; name: string; date: string; priority: string } | null;
  events: { id: number; name: string; date: string; priority: string }[];
  now: { ctl: number; atl: number; tsb: number; form: string; formLabel: string; ftp: number | null; weight: number };
  habits: { rideShare: number; tssPerHour: number; biggestWeek: number; shape: number[] };
  constraints: Limits;
  history: { date: string; ctl: number; atl: number; tsb: number; load: number }[];
  weeks: { start: string; planned: number; done: number | null; phase: string | null }[];
  scenarios: Scenario[];
  trainerRoad: { now: number | null; predicted: { date: string; value: number }[] } | null;
  model: { tau: number; taus: number[]; quantile: number; observations: number; validation: { from: string; mae: number; maeCtl: number } | null; informative: boolean } | null;
}

// ---------- words and colours ----------
const NAMES: Record<ScenarioId, string> = { planned: 'As planned', filled: 'Fill the gaps', best: 'Best path', custom: 'Your plan' };
function scenarioColor(t: Tokens, id: ScenarioId) {
  return { planned: t.ink2, filled: t.series[1], best: t.series[2], custom: t.series[6] }[id];
}
function describe(id: ScenarioId, d: ForecastData) {
  const l = d.constraints;
  switch (id) {
    case 'planned':
      return `The calendar as it stands${d.scenarios.some((s) => s.id === 'filled') ? '; the days with nothing planned count as rest' : ''}.`;
    case 'filled':
      return 'The plan, with its empty days ridden just enough to arrive fresh.';
    case 'best':
      return `The most race-day power within your limits: up to ${fmtNum(l.maxRamp, 1)} CTL and ${fmtNum(l.maxHours, 1)} h a week, a recovery week every fourth, then a taper to arrive fresh.`;
    default:
      return 'The weekly loads you set below, spread over each week in your usual rhythm.';
  }
}
const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
/** How a form zone arrives at a race, in words. */
const ARRIVES: Record<string, string> = { transition: 'detrained', fresh: 'fresh', neutral: 'neither fresh nor fit (grey zone)', optimal: 'still tired from training', overload: 'overreached' };
const hoursText = (h: number) => `${Math.round(h)} h`;
const storageKey = (race: number | null) => `forecast-custom:${race ?? 'horizon'}`;

// ---------- the request ----------
interface Body {
  eventId: number | null;
  constraints: Partial<Limits> | null;
  custom: Record<string, number> | null;
}
function useForecast(body: Body) {
  return useQuery<ForecastData | null>({
    queryKey: ['/forecast', body],
    queryFn: () => http<ForecastData | null>('/forecast', { method: 'POST', json: body }),
    placeholderData: (p) => p,
    staleTime: 60_000,
  });
}

// ---------- charts ----------
function FitnessChart({ d, selected, height = 340 }: { d: ForecastData; selected: ScenarioId; height?: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const ts = (date: string) => parseISO(date).getTime();
    const sel = d.scenarios.find((s) => s.id === selected) ?? d.scenarios[0];
    const now = d.history[d.history.length - 1];
    // the legend gets a row of its own above the axis name (it pages on a phone)
    const h1 = Math.round((height - 110) * 0.66);
    const grids = [
      { left: 44, right: 16, top: 52, height: h1 },
      { left: 44, right: 16, top: 52 + h1 + 34, height: height - 110 - h1 - 4 },
    ];
    const line = (color: string, width: number, dashed = false) => ({ type: 'line' as const, showSymbol: false, smooth: 0.2, lineStyle: { color, width, type: dashed ? ('dashed' as const) : ('solid' as const) }, itemStyle: { color }, emphasis: { disabled: true } });
    const series: any[] = [
      { ...line(t.ctl, 2.5), name: 'Fitness so far', data: d.history.map((p) => [ts(p.date), p.ctl]), areaStyle: { color: alpha(t.ctl, 0.08) } },
      ...d.scenarios.map((s) => ({
        ...line(scenarioColor(t, s.id), s.id === selected ? 3 : 1.5, s.id !== selected),
        name: NAMES[s.id],
        z: s.id === selected ? 5 : 3,
        data: [[ts(now.date), now.ctl], ...s.days.map((p) => [ts(p.date), p.ctl])],
      })),
      {
        type: 'bar',
        name: 'Form',
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 6,
        data: [...d.history.map((p) => ({ date: p.date, tsb: p.tsb, ctl: p.ctl, ahead: false })), ...sel.days.map((p) => ({ date: p.date, tsb: p.tsb, ctl: p.ctl, ahead: true }))].map((p) => {
          const rel = p.ctl > 5 ? p.tsb / p.ctl : p.tsb / 30;
          const id = rel >= 0.25 ? 'transition' : rel >= 0.05 ? 'fresh' : rel >= -0.1 ? 'neutral' : rel >= -0.3 ? 'optimal' : 'overload';
          return { value: [ts(p.date), Math.round(p.tsb * 10) / 10], itemStyle: { color: alpha(formColor(t, id), p.ahead ? 0.55 : 0.9), borderRadius: 1 } };
        }),
      },
    ];
    // today, and the race
    series[0].markLine = {
      symbol: 'none',
      silent: true,
      data: [
        { xAxis: ts(now.date), lineStyle: { color: t.muted, type: 'solid', width: 1 }, label: { formatter: 'Today', color: t.muted, fontSize: 10, position: 'insideEndTop' } },
        ...(d.race ? [{ xAxis: ts(d.race.date), lineStyle: { color: t.critical, type: 'solid', width: 1 }, label: { formatter: `${d.race.priority} · ${d.race.name}`, color: t.ink2, fontSize: 10, position: 'insideEndTop', width: h1 - 12, overflow: 'truncate' } }] : []),
      ],
    };
    const byDate = new Map<string, Record<string, number>>();
    for (const s of d.scenarios) for (const p of s.days) byDate.set(p.date, { ...(byDate.get(p.date) ?? {}), [s.id]: p.ctl, [`${s.id}:tsb`]: p.tsb });
    const hist = new Map(d.history.map((p) => [p.date, p]));
    return {
      animation: false,
      grid: grids,
      axisPointer: { link: [{ xAxisIndex: 'all' }], lineStyle: { color: t.muted, width: 1 } },
      legend: { ...legendStyle(t), data: ['Fitness so far', ...d.scenarios.map((s) => NAMES[s.id])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const x = (Array.isArray(ps) ? ps : [ps])[0]?.value?.[0];
          if (x == null) return '';
          const date = new Date(x).toISOString().slice(0, 10);
          const h = hist.get(date);
          if (h) return `<b>${fmtDate(date)}</b>${tipRow(t.ctl, 'Fitness', h.ctl.toFixed(1))}${tipRow(t.muted, 'Form', h.tsb.toFixed(1))}${tipRow(t.ink2, 'TSS', String(Math.round(h.load)))}`;
          const r = byDate.get(date);
          if (!r) return '';
          return `<b>${fmtDate(date)}</b>${d.scenarios.map((s) => tipRow(scenarioColor(t, s.id), NAMES[s.id], `CTL ${r[s.id]?.toFixed(0)} · form ${signed(r[`${s.id}:tsb`] ?? 0)}`)).join('')}`;
        },
      },
      xAxis: grids.map((_, i) => ({ type: 'time', gridIndex: i, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 1, color: t.muted, fontSize: 11, hideOverlap: true } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Fitness (CTL)', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] }, scale: true, splitNumber: 4 }),
        valueAxis(t, { gridIndex: 1, name: 'Form', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] }, splitNumber: 2 }),
      ],
      series: series.map((s, i) => (i === 0 || s.type === 'line' ? { ...s, xAxisIndex: 0, yAxisIndex: 0 } : s)),
    };
  }, [d, selected, t, height]);
  return <Chart option={option} height={height} />;
}

function PowerChart({ d, selected, height = 300 }: { d: ForecastData; selected: ScenarioId; height?: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const ftp = d.now.ftp ?? 0;
    const ts = (date: string) => parseISO(date).getTime();
    const sel = d.scenarios.find((s) => s.id === selected) ?? d.scenarios[0];
    const start = [ts(d.today), ftp];
    const color = scenarioColor(t, sel.id);
    const series: any[] = [
      // the selected scenario's range: a transparent base and the band's height, stacked
      { type: 'line', name: 'low', stack: 'band', silent: true, showSymbol: false, data: [start, ...sel.days.map((p) => [ts(p.date), ftp * (p.capLow ?? 1)])], lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { type: 'line', name: 'range', stack: 'band', silent: true, showSymbol: false, data: [[ts(d.today), 0], ...sel.days.map((p) => [ts(p.date), ftp * ((p.capHigh ?? 1) - (p.capLow ?? 1))])], lineStyle: { opacity: 0 }, areaStyle: { color: alpha(color, 0.16) }, tooltip: { show: false } },
      ...d.scenarios.map((s) => ({
        type: 'line',
        name: NAMES[s.id],
        showSymbol: false,
        z: s.id === selected ? 5 : 3,
        lineStyle: { color: scenarioColor(t, s.id), width: s.id === selected ? 3 : 1.5, type: s.id === selected ? 'solid' : 'dashed' },
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
        itemStyle: { color: t.series[3] },
        data: [...(d.trainerRoad.now ? [{ value: [ts(d.today), d.trainerRoad.now], label: 'its FTP now' }] : []), ...d.trainerRoad.predicted.filter((p) => p.date <= d.end).map((p) => ({ value: [ts(p.date), p.value], label: `predicted for ${fmtDate(p.date, 'd MMM')}` }))],
        tooltip: { formatter: (p: any) => `<b>TrainerRoad</b>${tipRow(t.series[3], p.data.label, `${p.value[1]} W`)}` },
      });
    }
    const values = series.flatMap((s) => s.data.map((p: any) => (Array.isArray(p) ? p[1] : p.value[1]))).filter((v: number) => v > 50);
    return {
      animation: false,
      grid: { left: 48, right: 56, top: 52, bottom: 28 },
      legend: { ...legendStyle(t), data: [...d.scenarios.map((s) => NAMES[s.id]), ...(d.trainerRoad ? ['TrainerRoad'] : [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const names = new Set(Object.values(NAMES));
          const arr = (Array.isArray(ps) ? ps : [ps]).filter((p: any) => names.has(p.seriesName));
          if (!arr.length) return '';
          const date = new Date(arr[0].value[0]).toISOString().slice(0, 10);
          return `<b>${fmtDate(date)}</b>${arr.map((p: any) => tipRow(p.color, p.seriesName, `${Math.round(p.value[1])} W`)).join('')}`;
        },
      },
      xAxis: { type: 'time', ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true } },
      yAxis: valueAxis(t, { name: 'FTP (W)', minInterval: 1, min: Math.floor((Math.min(...values) - 5) / 5) * 5, max: Math.ceil((Math.max(...values) + 5) / 5) * 5, nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] } }),
      series,
    };
  }, [d, selected, t]);
  return <Chart option={option} height={height} />;
}

function WeeksChart({ d, selected, height = 240 }: { d: ForecastData; selected: ScenarioId; height?: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const weeks = d.weeks.map((w) => w.start);
    return {
      animation: false,
      grid: { left: 44, right: 12, top: 48, bottom: 26 },
      legend: { ...legendStyle(t), data: d.scenarios.map((s) => NAMES[s.id]) },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const i = ps[0]?.dataIndex;
          if (i == null) return '';
          const w = d.weeks[i];
          return `<b>Week of ${fmtDate(w.start, 'd MMM')}</b>${w.phase ? `<div style="opacity:.6;font-size:11px">${w.phase}</div>` : ''}${d.scenarios.map((s) => tipRow(scenarioColor(t, s.id), NAMES[s.id], `${s.weeks[i]?.tss ?? 0} TSS · ${hoursText(s.weeks[i]?.hours ?? 0)}`)).join('')}`;
        },
      },
      xAxis: { type: 'category', data: weeks.map((w) => fmtDate(w, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { name: 'TSS', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] } }),
      series: d.scenarios.map((s) => ({
        type: 'bar',
        name: NAMES[s.id],
        barMaxWidth: 14,
        barGap: '15%',
        itemStyle: { color: alpha(scenarioColor(t, s.id), s.id === selected ? 1 : 0.55), borderRadius: [2, 2, 0, 0] },
        data: d.weeks.map((w) => s.weeks.find((x) => x.start === w.start)?.tss ?? 0),
      })),
    };
  }, [d, selected, t]);
  return <Chart option={option} height={height} />;
}

// ---------- pieces ----------
function ScenarioCard({ s, d, selected, onSelect, best }: { s: Scenario; d: ForecastData; selected: boolean; onSelect: () => void; best: { ftp: boolean; form: boolean } }) {
  const t = useTokens();
  const r = s.race;
  const gain = r.ftp != null && d.now.ftp ? r.ftp - d.now.ftp : null;
  return (
    <button onClick={onSelect} aria-pressed={selected} className={clsx('card flex min-w-0 flex-col p-4 text-left transition-colors', selected ? 'border-transparent' : 'hover:border-line-strong')} style={selected ? { boxShadow: `0 0 0 2px ${scenarioColor(t, s.id)}` } : undefined}>
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: scenarioColor(t, s.id) }} />
        <span className="text-[13px] font-semibold text-ink">{NAMES[s.id]}</span>
        {s.warnings.length > 0 && <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-warning" aria-label={`${s.warnings.length} to watch`} />}
      </div>
      <p className="mt-1 line-clamp-2 min-h-[2.4em] text-[11px] leading-snug text-muted">{describe(s.id, d)}</p>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={clsx('text-[26px] leading-none font-semibold tabular-nums', best.ftp ? 'text-good-text' : 'text-ink')}>{r.ftp != null ? Math.round(r.ftp) : '–'}</span>
        <span className="text-xs text-muted">W FTP</span>
        {gain != null && <span className={clsx('ml-auto text-xs font-medium tabular-nums', gain > 0.5 ? 'text-good-text' : gain < -0.5 ? 'text-critical' : 'text-muted')}>{signed(gain)} W</span>}
      </div>
      {r.ftpLow != null && r.ftpHigh != null && Math.round(r.ftpHigh) - Math.round(r.ftpLow) >= 1 && (
        <div className="mt-0.5 text-[11px] text-muted tabular-nums">
          likely {Math.round(r.ftpLow)}–{Math.round(r.ftpHigh)} W
        </div>
      )}
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-[11px]">
        <div>
          <div className="text-muted">Form</div>
          <div className={clsx('flex items-center gap-1 font-medium tabular-nums', best.form ? 'text-good-text' : 'text-ink')}>
            <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: formColor(t, r.form) }} />
            {signed(r.tsb)}
          </div>
        </div>
        <div>
          <div className="text-muted">CTL</div>
          <div className="font-medium text-ink tabular-nums">{Math.round(r.ctl)}</div>
        </div>
        <div>
          <div className="text-muted">Riding</div>
          <div className="font-medium text-ink tabular-nums">{hoursText(s.totals.hours)}</div>
        </div>
      </div>
    </button>
  );
}

/** The scenarios side by side, the best of each row marked. */
function Comparison({ d }: { d: ForecastData }) {
  const t = useTokens();
  const s = d.scenarios;
  const onRace = d.race ? 'on race day' : `on ${fmtDate(d.end, 'd MMM')}`;
  type Row = { label: string; title?: string; value: (x: Scenario) => number | null; fmt: (v: number) => string; better?: 'high' | 'low' | 'target' };
  const rows: Row[] = [
    { label: `FTP ${onRace}`, value: (x) => x.race.ftp, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '5-minute power', value: (x) => x.race.p5, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '20-minute power', value: (x) => x.race.p20, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '60-minute power', value: (x) => x.race.p60, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: `Fitness (CTL) ${onRace}`, value: (x) => x.race.ctl, fmt: (v) => fmtNum(v), better: 'high' },
    { label: `Form ${d.race ? 'on race morning' : 'then'}`, title: `Best close to ${Math.round(d.constraints.target * 100)}% of fitness: fresh, without losing fitness`, value: (x) => x.race.tsb, fmt: (v) => signed(v), better: d.race ? 'target' : undefined },
    { label: 'Riding to then', value: (x) => x.totals.hours, fmt: (v) => `${Math.round(v)} h` },
    { label: 'Biggest week', value: (x) => x.totals.maxWeekHours, fmt: (v) => `${v.toFixed(1)} h` },
    { label: 'Steepest week', title: 'Most fitness (CTL) gained in a calendar week', value: (x) => x.totals.maxRamp, fmt: (v) => `${signed(v, 1)} CTL` },
  ];
  const bestOf = (r: Row): number | null => {
    const vs = s.map((x) => r.value(x)).filter((v): v is number => v != null);
    if (!r.better || vs.length < 2) return null;
    if (r.better === 'high') return Math.max(...vs);
    if (r.better === 'low') return Math.min(...vs);
    const goal = d.constraints.target;
    return s.map((x) => ({ v: r.value(x), off: Math.abs(x.race.tsb / Math.max(x.race.ctl, 1) - goal) })).sort((a, b) => a.off - b.off)[0].v;
  };
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
            <th className="py-2 pr-3 font-medium" />
            {s.map((x) => (
              <th key={x.id} className="px-3 py-2 text-right font-medium whitespace-nowrap">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: scenarioColor(t, x.id) }} />
                {NAMES[x.id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((r) => s.some((x) => r.value(x) != null))
            .map((r) => {
              const b = bestOf(r);
              return (
                <tr key={r.label} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3 text-ink-2" title={r.title}>
                    {r.label}
                  </td>
                  {s.map((x) => {
                    const v = r.value(x);
                    return (
                      <td key={x.id} className={clsx('px-3 py-2 text-right', v != null && b != null && Math.abs(v - b) < 1e-9 ? 'font-semibold text-good-text' : 'text-ink')}>
                        {v == null ? '–' : r.fmt(v)}
                        {r.label.startsWith('Form') && <span className="ml-1 text-[11px] font-normal text-muted">{x.race.formLabel.toLowerCase()}</span>}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          <tr>
            <td className="py-2 pr-3 align-top text-ink-2">To watch</td>
            {s.map((x) => (
              <td key={x.id} className="px-3 py-2 text-right align-top text-[11px] text-ink-2">
                {x.warnings.length ? x.warnings.map((w) => <div key={w}>{w}</div>) : <span className="text-muted">nothing</span>}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** Your own plan, week by week: start from any scenario and change the loads. */
function Editor({ d, custom, setCustom, limits, setLimits }: { d: ForecastData; custom: Record<string, number> | null; setCustom: (c: Record<string, number> | null) => void; limits: Limits; setLimits: (l: Limits) => void }) {
  const t = useTokens();
  const mine = d.scenarios.find((s) => s.id === 'custom');
  const from = (id: ScenarioId) => {
    const s = d.scenarios.find((x) => x.id === id);
    if (s) setCustom(Object.fromEntries(s.weeks.map((w) => [w.start, w.tss])));
  };
  const scale = (f: number) => custom && setCustom(Object.fromEntries(Object.entries(custom).map(([k, v]) => [k, Math.round((v * f) / 5) * 5])));
  const perHour = d.habits.tssPerHour;
  const first = d.weeks[0]?.start;
  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Start from</span>
          {d.scenarios
            .filter((s) => s.id !== 'custom')
            .map((s) => (
              <Button key={s.id} size="sm" onClick={() => from(s.id)} icon={<span className="h-2 w-2 rounded-full" style={{ background: scenarioColor(t, s.id) }} />}>
                {NAMES[s.id]}
              </Button>
            ))}
          {custom && (
            <>
              <span className="mx-1 h-4 w-px bg-line" />
              <Button size="sm" variant="ghost" onClick={() => scale(0.9)}>
                −10%
              </Button>
              <Button size="sm" variant="ghost" onClick={() => scale(1.1)}>
                +10%
              </Button>
              <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setCustom(null)}>
                Clear
              </Button>
            </>
          )}
        </div>
        {!custom ? (
          <p className="rounded-lg bg-surface-2 p-4 text-[13px] text-ink-2">Pick a scenario to start from, then change any week's load: the forecast follows as you type.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="tnum w-full min-w-[620px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  <th className="py-2 pr-2 font-medium">Week</th>
                  <th className="px-2 text-right font-medium">Planned</th>
                  <th className="px-2 text-right font-medium">Yours</th>
                  <th className="px-2 text-right font-medium">Hours</th>
                  <th className="px-2 text-right font-medium">CTL</th>
                  <th className="px-2 text-right font-medium">Ramp</th>
                  <th className="pl-2 text-right font-medium">Form</th>
                </tr>
              </thead>
              <tbody>
                {d.weeks.map((w) => {
                  const r = mine?.weeks.find((x) => x.start === w.start);
                  const steep = r && r.ramp > Math.max(8, limits.maxRamp + 1);
                  const long = r && r.hours > limits.maxHours * 1.05;
                  return (
                    <tr key={w.start} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5 pr-2">
                        <div className="text-ink">{fmtDate(w.start, 'd MMM')}</div>
                        <div className="text-[10px] text-muted">{w.start === first && w.done != null ? `${w.done} ridden so far` : (w.phase ?? '')}</div>
                      </td>
                      <td className="px-2 text-right text-muted">{w.planned || '–'}</td>
                      <td className="px-2 text-right">
                        <Input
                          type="number"
                          inputMode="numeric"
                          step={10}
                          min={0}
                          value={custom[w.start] ?? 0}
                          onChange={(e) => setCustom({ ...custom, [w.start]: Math.max(0, Number(e.target.value) || 0) })}
                          className="h-8 w-24 text-right"
                          aria-label={`Load for the week of ${fmtDate(w.start, 'd MMM')}`}
                        />
                      </td>
                      <td className={clsx('px-2 text-right', long ? 'font-medium text-warning' : 'text-ink-2')}>{((custom[w.start] ?? 0) / perHour).toFixed(1)}</td>
                      <td className="px-2 text-right text-ink-2">{r ? Math.round(r.ctl) : '–'}</td>
                      <td className={clsx('px-2 text-right', steep ? 'font-medium text-warning' : 'text-ink-2')}>{r ? signed(r.ramp, 1) : '–'}</td>
                      <td className="pl-2 text-right text-ink-2">{r ? signed(r.tsb) : '–'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="space-y-3">
        <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Your limits</div>
        <Field label="Fitness gained a week, at most" hint="CTL a week. 5 is a solid build; above 8, injury and illness risk climb">
          <Input type="number" step={0.5} min={0} max={12} value={limits.maxRamp} onChange={(e) => setLimits({ ...limits, maxRamp: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Hours a week, at most" hint={`Your biggest week lately: ${d.habits.biggestWeek.toFixed(1)} h`}>
          <Input type="number" step={0.5} min={2} max={40} value={limits.maxHours} onChange={(e) => setLimits({ ...limits, maxHours: Number(e.target.value) || 0 })} />
        </Field>
        <Field label={`Form on race morning: ${Math.round(limits.target * 100)}% of fitness`} hint="5–25% is fresh. Lower keeps more fitness; higher, more freshness">
          <input type="range" min={5} max={25} step={1} value={Math.round(limits.target * 100)} onChange={(e) => setLimits({ ...limits, target: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent)]" />
        </Field>
        <p className="text-[11px] text-muted">The best path and the gaps' fill follow these; your plan is checked against them.</p>
      </div>
    </div>
  );
}

function HowItWorks({ d }: { d: ForecastData }) {
  const m = d.model;
  const shape = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `${n} ${Math.round(d.habits.shape[i] * 100)}%`);
  return (
    <ul className="space-y-2 text-[13px] leading-relaxed text-ink-2">
      <li>
        <b className="text-ink">Fitness and form</b> are the same performance management chart as the rest of the app, ridden day by day from today.
      </li>
      <li>
        <b className="text-ink">Power</b> comes from your capacity model: your 20-minute power follows a long-term average of your riding load,
        {m ? ` over about ${m.tau >= 365 ? `${(m.tau / 365).toFixed(1).replace('.0', '')} year${m.tau >= 730 ? 's' : ''}` : `${Math.round(m.tau / 30)} months`} for you` : ''}, learned from your own history
        {m?.validation ? ` — checked on your comeback, it was within ±${Math.round(m.validation.mae)} W a month, against ±${Math.round(m.validation.maeCtl)} W for a model on CTL` : ''}. Every time constant that fits about as well gives its own answer, which is the range shown. FTP, 5, 20 and 60-minute power move with it from today's power-duration model (<Link to="/performance" className="text-accent hover:underline">Power &amp; Performance</Link>).
      </li>
      <li>
        <b className="text-ink">Your habits</b> turn weekly loads into days and hours: {Math.round(d.habits.rideShare * 100)}% of your load is riding, about {Math.round(d.habits.tssPerHour)} TSS an hour, and a week goes {shape.join(', ')}.
      </li>
      <li>
        <b className="text-ink">Not modelled:</b> illness, heat, travel, or the extra few percent fresh legs give on the day. The forecast is what the training supports; treat a range as a range.
      </li>
    </ul>
  );
}

function copyPlan(d: ForecastData, s: Scenario) {
  const lines = [`${NAMES[s.id]} to ${d.race ? `${d.race.name}, ${fmtDate(d.race.date, 'd MMM yyyy')}` : fmtDate(d.end, 'd MMM yyyy')}`];
  for (const w of s.weeks) lines.push(`Week of ${fmtDate(w.start, 'd MMM')}: ${w.tss} TSS, about ${w.hours.toFixed(1)} h (CTL ${Math.round(w.ctl)}, form ${signed(w.tsb)})`);
  const r = s.race;
  lines.push(`${d.race ? 'Race day' : 'Then'}: CTL ${Math.round(r.ctl)}, form ${signed(r.tsb)} (${r.formLabel.toLowerCase()})${r.ftp != null ? `, FTP about ${Math.round(r.ftp)} W${r.ftpLow != null && r.ftpHigh != null ? ` (${Math.round(r.ftpLow)}–${Math.round(r.ftpHigh)})` : ''}` : ''}`);
  return lines.join('\n');
}

// ---------- the page ----------
export function Forecast() {
  const [params, setParams] = useSearchParams();
  const eventId = Number(params.get('event')) || null;
  const selected = (params.get('s') as ScenarioId | null) ?? 'planned';
  const setParam = (k: string, v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(k, v);
        return n;
      },
      { replace: true },
    );
  const select = (s: ScenarioId) => setParam('s', s);
  const [limits, setLimitsState] = useState<Limits | null>(null);
  const [custom, setCustomState] = useState<Record<string, number> | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const raw = useMemo<Body>(() => ({ eventId, constraints: limits, custom }), [eventId, limits, custom]);
  const body = useDebounced(raw, 250);
  const { data: d, isLoading, isFetching } = useForecast(body);

  // your plan is kept for each race, in this browser
  const key = storageKey(d?.race?.id ?? null);
  useEffect(() => {
    if (!d || loadedFor === key) return;
    setLoadedFor(key);
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      setCustomState(saved && typeof saved === 'object' ? saved : null);
    } catch {
      setCustomState(null);
    }
  }, [d, key, loadedFor]);
  const setCustom = (c: Record<string, number> | null) => {
    setCustomState(c);
    try {
      if (c) localStorage.setItem(key, JSON.stringify(c));
      else localStorage.removeItem(key);
    } catch {}
    if (c) select('custom');
  };
  const shownLimits = limits ?? d?.constraints ?? null;
  const save = useAction((b: Body & { scenario: ScenarioId }) => http<{ id: number; name: string; weeks: number }>('/forecast/save', { method: 'POST', json: b }), {
    success: (r) => `Saved “${r.name}” as your season plan: ${r.weeks} weeks of targets, on the Calendar and Season Planner`,
  });

  if (isLoading) return <Spinner />;
  if (!d) {
    return (
      <>
        <PageHeader title="Forecast" />
        <Card>
          <Empty icon={<Telescope className="h-8 w-8" />} title="Nothing to forecast yet">
            The forecast rides your training forward from today: it needs some history first. <Link to="/settings?tab=import" className="text-accent hover:underline">Import activities</Link> or connect Strava.
          </Empty>
        </Card>
      </>
    );
  }
  const sel = d.scenarios.find((s) => s.id === selected) ?? d.scenarios[0];
  const daysTo = differenceInCalendarDays(parseISO(d.end), parseISO(d.today));
  const topFtp = Math.max(...d.scenarios.map((s) => s.race.ftp ?? -Infinity));
  const freshest = d.scenarios.map((s) => ({ id: s.id, off: Math.abs(s.race.tsb / Math.max(s.race.ctl, 1) - d.constraints.target) })).sort((a, b) => a.off - b.off)[0]?.id;
  const gain = (s: Scenario) => (s.race.ftp != null && d.now.ftp ? s.race.ftp - d.now.ftp : null);
  const planned = d.scenarios.find((s) => s.id === 'planned')!;
  const best = d.scenarios.find((s) => s.id === 'best');
  const headline =
    d.race && best && planned.race.ftp != null && best.race.ftp != null
      ? planned.race.form === 'fresh' && best.race.ftp - planned.race.ftp < 2
        ? `Your plan has you arriving fresh, at about ${Math.round(planned.race.ftp)} W: close to the best your limits allow.`
        : `As planned, you'd arrive ${ARRIVES[planned.race.form] ?? planned.race.formLabel.toLowerCase()} (form ${signed(planned.race.tsb)}) at about ${Math.round(planned.race.ftp)} W. Within your limits there's about ${Math.round(best.race.ftp)} W on the table, arriving ${ARRIVES[best.race.form] ?? 'fresh'}.`
      : null;

  return (
    <div>
      <PageHeader
        title="Forecast"
        subtitle={d.race ? `${d.race.priority} race · ${d.race.name} · ${fmtDate(d.race.date, 'EEE d MMM yyyy')} · ${daysTo} days` : `The next ${Math.round(daysTo / 7)} weeks: add a race to forecast race day`}
        actions={
          <>
            {isFetching && <span className="text-xs text-muted">Updating…</span>}
            {d.events.length > 1 && (
              <Select value={d.race?.id ?? ''} onChange={(e) => setParam('event', e.target.value)} aria-label="Race">
                {d.events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.priority} · {e.name} ({fmtDate(e.date, 'd MMM')})
                  </option>
                ))}
              </Select>
            )}
            {!d.race && (
              <Link to="/season" className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface-2 px-3.5 text-[13px] font-medium text-ink hover:bg-surface-3">
                <Flag className="h-4 w-4" /> Add a race
              </Link>
            )}
          </>
        }
      />

      {headline && (
        <div className="mb-4 flex items-start gap-3 rounded-xl border border-line bg-surface px-4 py-3">
          <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
          <p className="text-[13px] text-ink">
            {headline} <span className="text-muted">Today: FTP {d.now.ftp ?? '–'} W, fitness {Math.round(d.now.ctl)}, form {signed(d.now.tsb)}.</span>
          </p>
        </div>
      )}

      <div className={clsx('grid gap-3 sm:grid-cols-2', d.scenarios.length + (d.scenarios.some((s) => s.id === 'custom') ? 0 : 1) >= 4 ? 'xl:grid-cols-4' : 'xl:grid-cols-3')}>
        {d.scenarios.map((s) => (
          <ScenarioCard key={s.id} s={s} d={d} selected={s.id === sel.id} onSelect={() => select(s.id)} best={{ ftp: s.race.ftp != null && d.scenarios.length > 1 && Math.abs(s.race.ftp - topFtp) < 0.5, form: !!d.race && s.id === freshest }} />
        ))}
        {!d.scenarios.some((s) => s.id === 'custom') && (
          <button onClick={() => setCustom(Object.fromEntries((best ?? planned).weeks.map((w) => [w.start, w.tss])))} className="card flex min-h-[176px] flex-col items-center justify-center gap-2 border-dashed p-4 text-center text-muted hover:border-line-strong hover:text-ink">
            <SlidersHorizontal className="h-5 w-5" />
            <span className="text-[13px] font-medium">Make your own</span>
            <span className="text-[11px]">Start from the best path and change any week</span>
          </button>
        )}
      </div>

      {sel.warnings.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-ink-2">
          {sel.warnings.map((w) => (
            <span key={w} className="inline-flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-warning" />
              {w}
            </span>
          ))}
        </div>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Fitness and form" subtitle={`${NAMES[sel.id]} in bold, the others dashed · form shown for ${NAMES[sel.id].toLowerCase()}`}>
          <FitnessChart d={d} selected={sel.id} />
        </Card>
        <Card
          title="FTP"
          subtitle={d.now.ftp && sel.race.ftp != null ? `${NAMES[sel.id]}: ${d.now.ftp} W today, about ${Math.round(sel.race.ftp)} W ${d.race ? 'on race day' : 'then'} (${signed(gain(sel) ?? 0)} W), the band its likely range${d.trainerRoad ? ' · TrainerRoad’s own FTP and prediction for reference' : ''}` : 'Needs a capacity model: power that has followed your training load'}
        >
          {d.now.ftp && d.model?.informative ? <PowerChart d={d} selected={sel.id} /> : <Empty title="No power forecast">Your 20-minute power hasn't followed your training load enough to forecast it from load. Fitness and form still are.</Empty>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card
          title="The scenarios side by side"
          subtitle="Best of each row in green"
          actions={
            <>
            {sel.id !== 'planned' && (
              <Button
                size="sm"
                variant="primary"
                icon={<CalendarCheck className="h-3.5 w-3.5" />}
                loading={save.isPending}
                title="Keep it as your season plan: the Calendar shows its weekly targets, and every projection uses them in weeks with nothing scheduled"
                onClick={() =>
                  confirm(`Use ${NAMES[sel.id].toLowerCase()} as your weekly targets? It becomes your active season plan: the Calendar shows its targets, and projections use them in weeks with nothing scheduled. Planned workouts, TrainerRoad’s included, stay in charge wherever there are any.`) &&
                  save.mutate({ eventId, constraints: limits, custom, scenario: sel.id })
                }
              >
                Use as my targets
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<ClipboardCopy className="h-3.5 w-3.5" />}
              title={`Copy ${NAMES[sel.id].toLowerCase()} week by week, to share`}
              onClick={() => copyText(copyPlan(d, sel)).then(() => toast(`${NAMES[sel.id]} copied: week by week, to paste anywhere`), (e: Error) => toast(e.message, 'error'))}
            >
              Copy {NAMES[sel.id].toLowerCase()}
            </Button>
            </>
          }
        >
          <Comparison d={d} />
        </Card>
        <Card title="Weekly load" subtitle="TSS a week under each scenario, this week with what's been ridden">
          <WeeksChart d={d} selected={sel.id} />
        </Card>
      </div>

      <Card className="mt-4" title="Your plan" subtitle="Change any week's load and see where it takes you. Kept in this browser, for this race.">
        {shownLimits && <Editor d={d} custom={custom} setCustom={setCustom} limits={shownLimits} setLimits={(l) => setLimitsState(l)} />}
      </Card>

      <Card className="mt-4" title={<span className="inline-flex items-center gap-1.5"><Info className="h-3.5 w-3.5 text-muted" />How the forecast works</span>}>
        <HowItWorks d={d} />
        <div className="mt-4 grid grid-cols-2 gap-4 rounded-lg bg-surface-2 p-3 sm:grid-cols-4">
          <Stat label="Today" value={d.now.ftp ?? '–'} unit="W FTP" sub={`${d.now.weight ? `${((d.now.ftp ?? 0) / d.now.weight).toFixed(2)} W/kg · ` : ''}form ${signed(d.now.tsb)}`} />
          <Stat label="Fitness" value={Math.round(d.now.ctl)} sub={`fatigue ${Math.round(d.now.atl)}`} />
          <Stat label="Your load" value={Math.round(d.habits.tssPerHour)} unit="TSS/h" sub={`${Math.round(d.habits.rideShare * 100)}% riding`} />
          <Stat label="Model" value={d.model ? `${d.model.taus.length}` : '–'} unit="fits" sub={d.model ? `τ ${d.model.taus.map((x) => `${Math.round(x / 30)}m`).join(', ')}` : 'none'} />
        </div>
      </Card>
    </div>
  );
}
