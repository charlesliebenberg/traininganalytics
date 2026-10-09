import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseISO } from 'date-fns';
import type { WorkSet } from '../../shared/analytics/session';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDuration, fmtPace } from '../lib/format';
import { breakNames, makeTimeline, type Gap } from '../lib/timeline';
import { TYPE_LABEL, outText, setLabel, type SetProgress } from '../lib/session';

/**
 * The main set rep by rep: output as bars from zero (so an even set looks even), with the
 * heart rate each rep ended at under its label.
 */
export function SetChart({ set, sport, thr, height = 170 }: { set: WorkSet; sport: string; thr: number; height?: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const run = sport === 'run';
    const reps = set.reps;
    const fmt = (v: number) => (run ? fmtPace(v, 'run', false) : `${Math.round(v)}`);
    return {
      animation: false,
      grid: { left: 40, right: 8, top: 22, bottom: reps.some((r) => r.hrEnd != null) ? 40 : 24 },
      tooltip: {
        trigger: 'axis' as const,
        ...tooltipStyle(t),
        axisPointer: { type: 'shadow' as const, shadowStyle: { color: alpha(t.muted, 0.08) } },
        formatter: (ps: any) => {
          const r = reps[ps[0].dataIndex];
          return `<b>${set.kind === 'ladder' ? 'Effort' : 'Rep'} ${ps[0].dataIndex + 1} · ${fmtDuration(r.end - r.start)}</b>${tipRow(t.power, run ? 'Pace' : 'Power', `${outText(sport, r.out)} · ${Math.round(r.rel * 100)}%`)}${r.hr != null ? tipRow(t.hr, 'Heart rate', `${Math.round(r.hr)} avg · ${Math.round(r.hrEnd!)} at the end`) : ''}${r.hrDrop != null ? tipRow('transparent', 'A minute later', `−${Math.round(r.hrDrop)} bpm`) : ''}<div style="opacity:.6;font-size:11px;margin-top:4px">Starts ${fmtDuration(r.start)} into the ${run ? 'run' : 'ride'}</div>`;
        },
      },
      xAxis: {
        type: 'category' as const,
        data: reps.map((r, i) => `${i + 1}${r.hrEnd != null ? `\n${Math.round(r.hrEnd)} bpm` : ''}`),
        ...axisStyle(t, { grid: false }),
        axisLabel: { color: t.muted, fontSize: 10, lineHeight: 13, interval: 0 },
      },
      yAxis: valueAxis(t, { min: 0, splitNumber: 3, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => (run ? fmtPace(v, 'run', false) : `${Math.round(v)}`) } }),
      series: [
        {
          type: 'bar' as const,
          barMaxWidth: 34,
          data: reps.map((r) => Math.round(r.out * (run ? 1000 : 1)) / (run ? 1000 : 1)),
          itemStyle: { color: t.power, borderRadius: [4, 4, 0, 0] },
          label: { show: reps.length <= 12, position: 'top' as const, color: t.ink2, fontSize: 10, formatter: (p: any) => fmt(p.value) },
          markLine: thr ? { symbol: 'none', silent: true, data: [{ yAxis: thr }], lineStyle: { color: t.muted, type: 'dashed' as const, width: 1 }, label: { formatter: run ? 'threshold' : 'FTP', color: t.muted, fontSize: 10, position: 'insideEndTop' as const } } : undefined,
        },
      ],
    };
  }, [set, sport, thr, t]);
  return <Chart option={option} height={height} />;
}

/**
 * The same set over the last year: each comparable session's output, this one ringed. Up is
 * better for runs too (it plots speed, labelled as pace).
 */
export function SetProgressChart({ p, sport, height = 150 }: { p: SetProgress; sport: string; height?: number }) {
  const t = useTokens();
  const nav = useNavigate();
  const option = useMemo(() => {
    const run = sport === 'run';
    const pts = p.series;
    const cur = p.current.id;
    return {
      animation: false,
      grid: { left: 40, right: 12, top: 14, bottom: 24 },
      tooltip: {
        trigger: 'item' as const,
        ...tooltipStyle(t),
        formatter: (e: any) => {
          const s = pts[e.dataIndex];
          return `<b>${fmtDate(s.date, 'EEE d MMM yyyy')}</b>${tipRow(t.accent, setLabel(s), outText(sport, s.out))}${s.hrEnd != null ? tipRow(t.hr, 'Heart rate at the end of reps', `${Math.round(s.hrEnd)} bpm`) : ''}${s.id !== cur ? '<div style="opacity:.6;font-size:11px;margin-top:4px">Click to open</div>' : ''}`;
        },
      },
      xAxis: { type: 'time' as const, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(v), 'd MMM') } },
      yAxis: valueAxis(t, { scale: true, splitNumber: 3, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => (run ? fmtPace(v, 'run', false) : `${Math.round(v)}`) } }),
      series: [
        {
          type: 'line' as const,
          data: pts.map((s) => ({
            value: [s.date, s.out],
            symbolSize: s.id === cur ? 11 : 7,
            itemStyle: s.id === cur ? { color: t.accent, borderColor: t.surface, borderWidth: 2 } : { color: alpha(t.accent, 0.55) },
          })),
          lineStyle: { color: alpha(t.accent, 0.5), width: 1.5 },
          cursor: 'pointer',
        },
      ],
    };
  }, [p, sport, t]);
  return (
    <Chart
      option={option}
      height={height}
      onEvents={{
        click: (e: any) => {
          const s = p.series[e.dataIndex];
          if (s && s.id !== p.current.id) nav(`/activities/${s.id}`);
        },
      }}
    />
  );
}

// ---------- interval sets over time (Trends) ----------
export interface KeySet extends SetSummaryOut {
  change: number | null;
  lastId: number | null;
}
type SetSummaryOut = import('../../shared/analytics/session').SetSummary;

const REP_BUCKETS: [number, string][] = [
  [45, 'sprint'],
  [150, '1–2½-min'],
  [390, '3–6-min'],
  [810, '8–13-min'],
  [1560, '15–25-min'],
  [Infinity, '30-min+'],
];
/** Sets that are the same workout family: kind of session, reps or one sustained effort, and rep length. */
export function familyOf(s: SetSummaryOut): { key: string; label: string } {
  const b = REP_BUCKETS.findIndex(([max]) => s.dur <= max);
  const single = s.kind === 'single';
  return { key: `${s.type}|${single ? 's' : 'r'}|${b}`, label: `${TYPE_LABEL[s.type]} · ${REP_BUCKETS[b][1]} ${single ? 'efforts' : 'reps'}` };
}

/**
 * Each interval or sustained set, by family: is the same workout getting stronger? Families
 * with two or more sets get a line (most frequent first, six at most); the rest are grey dots.
 */
export function KeySetsChart({ sets, sport = 'ride', height = 300 }: { sets: KeySet[]; sport?: string; height?: number }) {
  const t = useTokens();
  const nav = useNavigate();
  const option = useMemo(() => {
    const ts = sets.map((s) => parseISO(s.date).getTime());
    const gaps: Gap[] = [];
    const sorted = [...ts].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const days = Math.round((sorted[i] - sorted[i - 1]) / 86400000);
      if (days >= 90) gaps.push({ from: fmtDate(new Date(sorted[i - 1] + 86400000), 'yyyy-MM-dd'), to: fmtDate(new Date(sorted[i] - 86400000), 'yyyy-MM-dd'), days: days - 1 });
    }
    const tl = makeTimeline(gaps);
    const groups = new Map<string, { label: string; items: { s: KeySet; x: number }[] }>();
    sets.forEach((s, i) => {
      const f = familyOf(s);
      if (!groups.has(f.key)) groups.set(f.key, { label: f.label, items: [] });
      groups.get(f.key)!.items.push({ s, x: tl.toX(ts[i]) });
    });
    const fams = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
    const lined = fams.filter((f) => f.items.length >= 2).slice(0, 6);
    const rest = fams.filter((f) => !lined.includes(f)).flatMap((f) => f.items.map((it) => ({ ...it, label: f.label })));
    const xs = sets.map((_, i) => tl.toX(ts[i]));
    const span = Math.max(...xs) - Math.min(...xs) || 86400000;
    const tip = (s: KeySet, label: string) =>
      `<b>${fmtDate(s.date, 'EEE d MMM yyyy')}</b><div style="opacity:.7;margin-bottom:2px">${label}</div>${tipRow(t.power, setLabel(s), outText(sport, s.out))}${s.hrEnd != null ? tipRow(t.hr, 'Heart rate, end of reps', `${Math.round(s.hrEnd)} bpm`) : ''}${s.change != null ? tipRow('transparent', 'vs last time', `${s.change >= 0 ? '+' : '−'}${Math.abs(s.change * 100).toFixed(1)}%`) : ''}<div style="opacity:.6;font-size:11px;margin-top:4px">Click to open</div>`;
    return {
      animation: false,
      grid: { left: 44, right: 12, top: lined.length ? 40 : 14, bottom: 26 },
      legend: lined.length ? { ...legendStyle(t), data: lined.map((f) => f.label) } : undefined,
      tooltip: { trigger: 'item' as const, ...tooltipStyle(t), formatter: (e: any) => (e.data?.s ? tip(e.data.s, e.data.label) : '') },
      xAxis: {
        type: 'value' as const,
        min: Math.min(...xs) - span * 0.03,
        max: Math.max(...xs) + span * 0.03,
        ...axisStyle(t, { grid: false }),
        axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => (tl.inBreak(v) ? '' : fmtDate(new Date(tl.fromX(v)), span > 200 * 86400000 ? "MMM ''yy" : 'd MMM')) },
      },
      yAxis: valueAxis(t, { scale: true, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => `${v} W` } }),
      series: [
        ...lined.map((f, i) => ({
          type: 'line' as const,
          name: f.label,
          symbolSize: 8,
          cursor: 'pointer',
          lineStyle: { color: t.series[i], width: 2 },
          itemStyle: { color: t.series[i], borderColor: t.surface, borderWidth: 1 },
          data: f.items.map((it) => ({ value: [it.x, Math.round(it.s.out)], s: it.s, label: f.label })),
          ...(i === 0 && tl.breaks.length ? { markArea: { silent: true, itemStyle: { color: alpha(t.muted, 0.12) }, label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, formatter: (p: any) => p.name }, data: tl.breaks.map((g, j, all) => [{ xAxis: g.x0, name: breakNames(all)[j] }, { xAxis: g.x1 }]) } } : {}),
        })),
        {
          type: 'scatter' as const,
          name: 'Other sets',
          symbolSize: 6,
          cursor: 'pointer',
          itemStyle: { color: alpha(t.ink2, 0.35) },
          data: rest.map((it) => ({ value: [it.x, Math.round(it.s.out)], s: it.s, label: it.label })),
        },
      ],
    };
  }, [sets, sport, t]);
  return <Chart option={option} height={height} onEvents={{ click: (e: any) => e.data?.s && nav(`/activities/${e.data.s.id}`) }} />;
}
