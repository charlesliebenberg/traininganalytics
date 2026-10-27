import { useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { parseISO } from 'date-fns';
import { AlertTriangle, ArrowRight, CheckCircle2, Moon } from 'lucide-react';
import type { SleepNight } from '../../shared/types';
import { signedPct as pct, sleepAdvice, type MorningAfter, type SleepRead } from '../../shared/analytics/sleep';
import { qs, useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtNum, iso } from '../lib/format';
import { Card, Spinner, Stat } from './ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from './Chart';

/** "7 h 15" */
export const fmtSleep = (s: number | null | undefined) => (s == null ? '–' : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const bpm = (x: number) => (Math.abs(x) < 0.05 ? '0 bpm' : `${x > 0 ? '+' : '−'}${Math.abs(x).toFixed(1)} bpm`);
/** "7% above normal", "1.5 bpm below normal", "at normal" */
const vsNormal = (x: number, unit: '%' | ' bpm') => {
  const v = unit === '%' ? Math.round(Math.abs(x) * 100) : Math.round(Math.abs(x) * 10) / 10;
  return v === 0 ? 'at normal' : `${v}${unit} ${x > 0 ? 'above' : 'below'} normal`;
};

function Tone({ tone }: { tone: 'good' | 'neutral' | 'warning' }) {
  if (tone === 'good') return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" aria-label="good" />;
  if (tone === 'warning') return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-label="warning" />;
  return <Moon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />;
}

/** Last night against your normal, and what it means for today's training given your form. */
export function LastNightCard({ read, tsb }: { read: SleepRead; tsb: number | null }) {
  const n = read.night;
  // the night you woke up from this morning: anything older says nothing about today
  const fresh = n.date === iso(new Date());
  const advice = sleepAdvice(read, tsb);
  return (
    <Card
      title="Last night"
      subtitle={fresh ? `${n.bedStart && n.bedEnd ? `${fmtDate(n.bedStart, 'HH:mm')} – ${fmtDate(n.bedEnd, 'HH:mm')} · ` : ''}Eight Sleep` : `Latest night: woke ${fmtDate(n.date, 'EEE d MMM')}`}
      actions={
        <Link to="/fitness#recovery" className="flex items-center gap-1 text-xs text-accent hover:underline">
          Recovery <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      {fresh ? (
        <div className="mb-4 flex items-start gap-2">
          <Tone tone={advice.tone} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold text-ink">{advice.title}</div>
            <p className="mt-0.5 text-xs leading-relaxed text-ink-2">{advice.detail}</p>
          </div>
        </div>
      ) : (
        <p className="mb-4 text-xs text-muted">Nothing for last night yet: Eight Sleep may still be processing it, or the Pod didn't record it.</p>
      )}
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Sleep score" value={n.score ?? '–'} sub={n.processing ? 'still processing' : undefined} />
        <Stat label="Asleep" value={fmtSleep(n.asleep)} sub={read.asleep?.typical != null ? `usually ${fmtSleep(read.asleep.typical)}` : n.inBed ? `${fmtSleep(n.inBed)} in bed` : undefined} />
        <Stat
          label="HRV"
          value={read.hrv ? Math.round(read.hrv.value) : '–'}
          unit="ms"
          sub={read.hrv?.vsNormal != null ? `${pct(read.hrv.vsNormal)} on normal` : 'learning your normal'}
          title={read.hrv?.range ? `Against your normal: last night ${pct(read.hrv.vsNormal!)}, the last 7 nights ${pct(read.hrv.rollingVsNormal!)} (normal range for the 7-night average: ${Math.round(read.hrv.range[0])}–${Math.round(read.hrv.range[1])} ms)` : undefined}
        />
        <Stat label="Heart rate asleep" value={read.hr ? Math.round(read.hr.value) : '–'} unit="bpm" sub={read.hr?.vsNormal != null ? `${bpm(read.hr.vsNormal)} on normal` : undefined} />
      </div>
    </Card>
  );
}

/** The night before an activity: how recovered you went into it. */
export function NightBefore({ read }: { read: SleepRead }) {
  const n = read.night;
  const parts = [
    n.asleep != null ? `slept ${fmtSleep(n.asleep)}` : null,
    n.score != null ? `sleep score ${n.score}` : null,
    read.hrv ? `HRV ${Math.round(read.hrv.value)} ms${read.hrv.vsNormal != null ? ` (${vsNormal(read.hrv.vsNormal, '%')})` : ''}` : null,
    read.hr ? `heart rate ${Math.round(read.hr.value)} bpm${read.hr.vsNormal != null ? ` (${vsNormal(read.hr.vsNormal, ' bpm')})` : ''}` : null,
  ].filter(Boolean);
  return (
    <div className="card mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
      <Moon className="h-4 w-4 text-muted" />
      <span className="font-medium text-ink">The night before</span>
      <span className="text-ink-2">{parts.join(' · ')}</span>
      {read.call === 'easy' && (
        <span className="flex items-center gap-1 text-xs text-warning">
          <AlertTriangle className="h-3.5 w-3.5" />
          {read.hrv?.status === 'low' ? 'HRV below your normal range that week' : 'heart rate asleep up on your normal that week'}
        </span>
      )}
    </div>
  );
}

interface TrendNight extends SleepNight {
  hrvRolling: number | null;
  hrvRange: [number, number] | null;
  hrRolling: number | null;
  hrRange: [number, number] | null;
  /** training load the day you woke up */
  load: number | null;
}
interface SleepTrend {
  nights: TrendNight[];
  morningAfter: MorningAfter[];
}

const dayKind = (r: MorningAfter) => (r.key === 'rest' ? 'rest days' : r.key === 'big' ? 'days over 180 TSS' : r.key === 'easy' ? 'days up to 60 TSS' : `days of ${r.label}`);

/** How the heaviest training days land in the night after them, against the lightest, in plain words. */
function morningAfterText(rows: MorningAfter[]): string | null {
  const known = rows.filter((r) => r.hrv != null);
  if (known.length < 2) return null;
  const light = known[0];
  const heavy = known[known.length - 1];
  const hr = heavy.hr != null ? ` and your heart rate asleep ${vsNormal(heavy.hr, ' bpm')}` : '';
  const facts = `The night after ${dayKind(heavy)}, your HRV is ${vsNormal(heavy.hrv!, '%')}${hr}; after ${dayKind(light)}, HRV is ${vsNormal(light.hrv!, '%')}`;
  // only with enough nights on both sides, and a gap past about half a typical night-to-night swing
  if (Math.min(heavy.nights, light.nights) < 8) return `${facts}.`;
  const gap = heavy.hrv! - light.hrv!;
  if (gap <= -0.05) return `${facts}: your big days do show in your sleep.`;
  if (gap < 0.05) return `${facts}: your big days barely show in the night after them.`;
  return `${facts}.`;
}

/** Nightly HRV, heart rate and sleep against your normal, next to your training, and how training shows in the night after it. */
export function RecoveryCard({ from, to }: { from: string; to: string }) {
  const t = useTokens();
  const { data, isLoading } = useApi<SleepTrend>(`/sleep${qs({ from, to })}`);
  // arriving from the dashboard's "Recovery" link
  useEffect(() => {
    if (data?.nights.length && window.location.hash === '#recovery') document.getElementById('recovery')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [data]);
  const option = useMemo(() => {
    if (!data?.nights.length) return null;
    const ns = data.nights;
    const x = (n: TrendNight) => parseISO(n.date).getTime();
    // the legend gets its own row: on a phone it spans the width and would sit on the axis name
    const grids = [
      { left: 48, right: 48, top: 52, height: 120 },
      { left: 48, right: 48, top: 206, height: 90 },
      { left: 48, right: 48, top: 330, height: 80 },
    ];
    const band = (k: 'hrvRange' | 'hrRange', idx: number, color: string) => [
      { type: 'line', name: `${k}-lo`, stack: k, xAxisIndex: idx, yAxisIndex: idx, silent: true, showSymbol: false, connectNulls: false, data: ns.map((n) => [x(n), n[k]?.[0] ?? null]), lineStyle: { opacity: 0 }, tooltip: { show: false } },
      { type: 'line', name: `${k}-hi`, stack: k, xAxisIndex: idx, yAxisIndex: idx, silent: true, showSymbol: false, connectNulls: false, data: ns.map((n) => [x(n), n[k] ? n[k]![1] - n[k]![0] : null]), lineStyle: { opacity: 0 }, areaStyle: { color: alpha(color, 0.12) }, tooltip: { show: false } },
    ];
    const byTime = new Map(ns.map((n) => [x(n), n]));
    return {
      animation: false,
      grid: grids,
      legend: { ...legendStyle(t), data: ['HRV, 7-night average', 'Heart rate asleep, 7-night average', 'Asleep', 'Training load that day'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const n = byTime.get(ps[0].axisValue);
          if (!n) return '';
          return `<b>Night to ${fmtDate(n.date, 'EEE d MMM yyyy')}</b>${n.hrv != null ? tipRow(t.accent, 'HRV', `${Math.round(n.hrv)} ms${n.hrvRolling != null ? ` (week ${Math.round(n.hrvRolling)})` : ''}`) : ''}${n.hr != null ? tipRow(t.hr, 'Heart rate asleep', `${n.hr} bpm`) : ''}${tipRow(t.series[4], 'Asleep', fmtSleep(n.asleep))}${n.score != null ? tipRow('transparent', 'Sleep score', String(n.score)) : ''}${n.load != null ? tipRow(t.muted, 'Training that day', `${Math.round(n.load)} TSS`) : ''}${n.hrvRange ? `<div style="opacity:.6;font-size:11px;margin-top:4px">normal HRV ${Math.round(n.hrvRange[0])}–${Math.round(n.hrvRange[1])} ms</div>` : ''}`;
        },
      },
      xAxis: grids.map((_, i) => ({ type: 'time', gridIndex: i, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 2, color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(v), "d MMM ''yy") } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, scale: true, name: 'HRV (ms)', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 1, scale: true, name: 'Heart rate asleep (bpm)', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 2, min: 0, name: 'Hours asleep', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 2, min: 0, position: 'right', splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 10 }, name: 'TSS', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'right' } }),
      ],
      series: [
        ...band('hrvRange', 0, t.accent),
        { type: 'scatter', name: 'HRV', xAxisIndex: 0, yAxisIndex: 0, symbolSize: 4, data: ns.filter((n) => n.hrv != null).map((n) => [x(n), n.hrv]), itemStyle: { color: alpha(t.muted, 0.5) } },
        { type: 'line', name: 'HRV, 7-night average', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, connectNulls: false, data: ns.map((n) => [x(n), n.hrvRolling]), lineStyle: { color: t.accent, width: 2 }, itemStyle: { color: t.accent } },
        ...band('hrRange', 1, t.hr),
        { type: 'scatter', name: 'Heart rate asleep', xAxisIndex: 1, yAxisIndex: 1, symbolSize: 4, data: ns.filter((n) => n.hr != null).map((n) => [x(n), n.hr]), itemStyle: { color: alpha(t.muted, 0.5) } },
        { type: 'line', name: 'Heart rate asleep, 7-night average', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: ns.map((n) => [x(n), n.hrRolling]), lineStyle: { color: t.hr, width: 2 }, itemStyle: { color: t.hr } },
        { type: 'bar', name: 'Asleep', xAxisIndex: 2, yAxisIndex: 2, barMaxWidth: 6, data: ns.map((n) => [x(n), n.asleep != null ? Math.round((n.asleep / 3600) * 10) / 10 : null]), itemStyle: { color: alpha(t.series[4], 0.75) } },
        { type: 'line', name: 'Training load that day', xAxisIndex: 2, yAxisIndex: 3, showSymbol: false, step: 'middle', data: ns.map((n) => [x(n), n.load]), lineStyle: { color: t.muted, width: 1 }, itemStyle: { color: t.muted } },
      ],
    };
  }, [data, t]);

  if (isLoading) return <Spinner />;
  // no nights (no Eight Sleep, or none in the range): Settings explains how to connect it
  if (!data?.nights.length || !option) return null;
  const summary = morningAfterText(data.morningAfter);
  return (
    <div id="recovery">
      <Card
        className="mt-4"
        title="Sleep & recovery"
        subtitle="Eight Sleep, night by night. Bands: your normal range, from the 60 days before each night; below it for HRV (or above for heart rate) over a week, recovery is behind the training."
      >
        <Chart option={option} height={436} />
        {data.morningAfter.some((r) => r.nights) && (
          <div className="mt-4">
            <div className="mb-1 text-xs font-medium text-ink-2">How training shows in the night after it</div>
            <div className="overflow-x-auto">
              <table className="tnum w-full min-w-[520px] text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                    <th className="py-1.5 font-medium">The day before</th>
                    <th className="text-right font-medium">Nights</th>
                    <th className="text-right font-medium">HRV vs normal</th>
                    <th className="text-right font-medium">Heart rate vs normal</th>
                    <th className="text-right font-medium">Sleep score</th>
                    <th className="text-right font-medium">Asleep</th>
                  </tr>
                </thead>
                <tbody>
                  {data.morningAfter.map((r) => (
                    <tr key={r.key} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5">{r.label}</td>
                      <td className="text-right text-ink-2">{r.nights}</td>
                      <td className="text-right">{r.hrv != null ? pct(r.hrv) : '–'}</td>
                      <td className="text-right">{r.hr != null ? bpm(r.hr) : '–'}</td>
                      <td className="text-right">{r.score != null ? fmtNum(r.score) : '–'}</td>
                      <td className="text-right">{fmtSleep(r.asleep)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {summary ? `${summary} ` : ''}Medians over all your nights, each against the nights a month either side of it (so a change in fitness doesn’t tilt every row); training load is every sport, the day before. A row needs 3 nights.
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
