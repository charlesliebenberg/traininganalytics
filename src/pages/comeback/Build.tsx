import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import clsx from 'clsx';
import { SESSION_LABEL, SESSION_TYPES, QUALITY, type BuildSummary, type SessionType } from '../../../shared/analytics/comeback';
import { http, qs, useApi } from '../../lib/api';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate, fmtDurLabel, fmtNum } from '../../lib/format';
import { Badge, Card, Segmented, Spinner, Stat } from '../../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import type { PeakCard } from './types';

/** Fixed colour per session type (categorical slots, in a stable order). */
export function sessionColor(t: ReturnType<typeof useTokens>, s: SessionType): string {
  const map: Record<SessionType, string> = {
    recovery: alpha(t.muted, 0.55),
    endurance: t.series[0],
    tempo: t.series[3],
    threshold: t.series[2],
    vo2: t.series[6],
    anaerobic: t.series[4],
    race: t.series[7],
  };
  return map[s];
}

// ---------- the build ----------
function BuildChart({ b }: { b: BuildSummary }) {
  const t = useTokens();
  const option = useMemo(() => {
    const cats = b.weeks.map((w) => fmtDate(w.weekStart, 'd MMM'));
    const grids = [
      { left: 48, right: 12, top: 34, height: 110 },
      { left: 48, right: 12, top: 180, height: 90 },
      { left: 48, right: 12, top: 306, height: 70 },
    ];
    const used = SESSION_TYPES.filter((s) => b.weeks.some((w) => w.sessions[s]));
    return {
      animation: false,
      grid: grids,
      legend: { ...legendStyle(t), data: used.map((s) => SESSION_LABEL[s]) },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const w = b.weeks[ps[0].dataIndex];
          return `<b>Week of ${fmtDate(w.weekStart, 'd MMM yyyy')}</b>${tipRow(t.accent, 'TSS', fmtNum(w.tss))}${tipRow('transparent', 'Hours', w.hours.toFixed(1))}${tipRow('transparent', 'Training days', String(w.days))}${used
            .filter((s) => w.sessions[s])
            .map((s) => tipRow(sessionColor(t, s), SESSION_LABEL[s], String(w.sessions[s])))
            .join('')}${w.longRides ? tipRow('transparent', 'Long rides (3h+)', String(w.longRides)) : ''}${w.ctl != null ? tipRow(t.ctl, 'CTL', w.ctl.toFixed(0)) : ''}`;
        },
      },
      xAxis: grids.map((_, i) => ({ type: 'category', gridIndex: i, data: cats, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 2, color: t.muted, fontSize: 10, hideOverlap: true } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Weekly TSS', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 1, name: 'Rides by type', minInterval: 1, nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 2, name: 'Fitness (CTL)', scale: true, nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      ],
      series: [
        { type: 'bar', xAxisIndex: 0, yAxisIndex: 0, barCategoryGap: '20%', data: b.weeks.map((w) => Math.round(w.tss)), itemStyle: { color: alpha(t.accent, 0.8), borderRadius: [3, 3, 0, 0] } },
        ...used.map((s) => ({
          type: 'bar',
          name: SESSION_LABEL[s],
          stack: 'sessions',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barCategoryGap: '20%',
          data: b.weeks.map((w) => w.sessions[s]),
          itemStyle: { color: sessionColor(t, s), borderColor: t.surface, borderWidth: 1 },
        })),
        { type: 'line', xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, smooth: 0.3, data: b.weeks.map((w) => (w.ctl == null ? null : Math.round(w.ctl * 10) / 10)), lineStyle: { color: t.ctl, width: 2.5 }, itemStyle: { color: t.ctl }, areaStyle: { color: alpha(t.ctl, 0.08) } },
      ],
    };
  }, [b, t]);
  return <Chart option={option} height={400} />;
}

export function BuildSection({ peak, weeks, setWeeks }: { peak: PeakCard; weeks: number; setWeeks: (n: number) => void }) {
  const t = useTokens();
  const { data: b, isLoading } = useApi<BuildSummary>(`/comeback/build${qs({ date: peak.date, weeks })}`);
  if (isLoading || !b) return <Spinner />;
  const s = b.sessionsPerWeek;
  const totalZ = b.seiler.reduce((a, x) => a + x, 0) || 1;
  const rhythm = b.cycle ? `${b.cycle - 1}:1` : '–';
  return (
    <Card
      className="mt-4"
      title={`The ${weeks} weeks before ${peak.label ?? fmtDate(peak.date, 'MMMM yyyy')}`}
      subtitle={`${fmtDate(b.from, 'd MMM yyyy')} → ${fmtDate(b.to, 'd MMM yyyy')} · what you actually did to get there`}
      actions={<Segmented size="sm" value={weeks} onChange={setWeeks} options={[12, 16, 20].map((n) => ({ value: n, label: `${n} wks` }))} />}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Hours / week" value={b.avgHours.toFixed(1)} />
        <Stat label="TSS / week" value={fmtNum(b.avgTss)} sub={`best 4 wks: ${fmtNum(b.peakBlockTss)}`} />
        <Stat label="Fitness (CTL)" value={`${fmtNum(b.ctlStart)} → ${fmtNum(b.ctlPeak)}`} sub={b.avgRamp != null ? `${b.avgRamp >= 0 ? '+' : ''}${b.avgRamp.toFixed(1)}/wk avg · max ${(b.maxRamp ?? 0) >= 0 ? '+' : ''}${(b.maxRamp ?? 0).toFixed(1)}` : undefined} />
        <Stat label="Load rhythm" value={rhythm} sub={b.cycle ? 'load : recovery weeks' : 'no regular recovery weeks'} />
        <Stat label="Form on the day" value={b.tsbAtPeak != null ? `${b.tsbAtPeak >= 0 ? '+' : ''}${b.tsbAtPeak.toFixed(0)}` : '–'} sub="TSB" />
        <Stat label="Days / week" value={b.daysPerWeek.toFixed(1)} sub={`${b.missedWeeks} light weeks (< 2 days)`} />
        <Stat label="Longest break" value={`${b.longestBreak} d`} />
        <Stat label="Polarization" value={b.polarization != null ? b.polarization.toFixed(2) : '–'} sub={b.polarization != null && b.polarization > 2 ? 'polarized' : 'pyramidal / threshold'} />
      </div>
      <div className="mt-4">
        <BuildChart b={b} />
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl bg-surface-2 p-4">
          <div className="mb-2 text-xs font-medium text-ink-2">Typical week</div>
          <div className="text-[13px] leading-relaxed">
            <b>{b.mix.quality.toFixed(1)}</b> quality sessions:
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {QUALITY.filter((q) => s[q] >= 0.05).map((q) => (
                <Badge key={q} color={sessionColor(t, q)}>
                  {s[q].toFixed(1)} {SESSION_LABEL[q].toLowerCase()}
                </Badge>
              ))}
            </div>
            <div className="mt-2 text-ink-2">
              plus {s.endurance.toFixed(1)} endurance{s.recovery >= 0.1 ? ` and ${s.recovery.toFixed(1)} recovery` : ''} rides
            </div>
          </div>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <div className="mb-2 text-xs font-medium text-ink-2">Long rides (3 h+)</div>
          <div className="text-[13px]">
            <b>{b.longRide.perWeek.toFixed(1)}</b> per week{b.longRide.perWeek > 0 ? ` · avg ${b.longRide.avgHours.toFixed(1)} h · longest ${b.longRide.longestHours.toFixed(1)} h` : ''}
          </div>
          <div className="mt-1 text-[11px] text-muted">Long rides build durability: how much power you keep late in a hard day.</div>
        </div>
        <div className="rounded-xl bg-surface-2 p-4">
          <div className="mb-2 text-xs font-medium text-ink-2">Intensity distribution (3-zone)</div>
          <div className="flex h-3 overflow-hidden rounded-full">
            {b.seiler.map((z, i) => (
              <div key={i} style={{ width: `${(z / totalZ) * 100}%`, background: alpha(t.accent, 0.35 + i * 0.32) }} className="border-r border-surface-2 last:border-0" />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-ink-2">
            {['Easy', 'Moderate', 'Hard'].map((l, i) => (
              <span key={l}>
                {l} {Math.round((b.seiler[i] / totalZ) * 100)}%
              </span>
            ))}
          </div>
        </div>
      </div>
      {b.keySessions.length > 0 && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-ink-2">Biggest sessions of the build</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {b.keySessions.map((k) => (
              <Link key={k.id} to={`/activities/${k.id}`} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-[13px] hover:bg-surface-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: sessionColor(t, k.type) }} />
                <span className="min-w-0 flex-1 truncate">{k.name}</span>
                <span className="text-[11px] text-muted">{fmtDate(k.date, 'd MMM yy')}</span>
                <span className="tnum w-24 text-right text-[11px] text-ink-2">
                  {fmtDurLabel(k.minutes * 60)} · {k.tss} TSS
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- compare peaks ----------
export function RecipeTable({ peaks, weeks }: { peaks: PeakCard[]; weeks: number }) {
  const { data } = useQuery({
    queryKey: ['recipes', peaks.map((p) => p.date).join(','), weeks],
    queryFn: () => Promise.all(peaks.map((p) => http<BuildSummary>(`/comeback/build${qs({ date: p.date, weeks })}`))),
  });
  if (!data) return <Spinner />;
  const rows: { label: string; get: (b: BuildSummary) => number | null; fmt: (v: number) => string }[] = [
    { label: 'Hours / week', get: (b) => b.avgHours, fmt: (v) => v.toFixed(1) },
    { label: 'TSS / week', get: (b) => b.avgTss, fmt: (v) => fmtNum(v) },
    { label: 'Best 4-week TSS', get: (b) => b.peakBlockTss, fmt: (v) => fmtNum(v) },
    { label: 'CTL at peak', get: (b) => b.ctlPeak, fmt: (v) => fmtNum(v) },
    { label: 'CTL gain / week', get: (b) => b.avgRamp, fmt: (v) => `${v >= 0 ? '+' : ''}${v.toFixed(1)}` },
    { label: 'Training days / week', get: (b) => b.daysPerWeek, fmt: (v) => v.toFixed(1) },
    { label: 'Quality sessions / week', get: (b) => b.mix.quality, fmt: (v) => v.toFixed(1) },
    { label: 'Threshold / week', get: (b) => b.sessionsPerWeek.threshold, fmt: (v) => v.toFixed(1) },
    { label: 'VO2 / week', get: (b) => b.sessionsPerWeek.vo2, fmt: (v) => v.toFixed(1) },
    { label: 'Tempo / SST / week', get: (b) => b.sessionsPerWeek.tempo, fmt: (v) => v.toFixed(1) },
    { label: 'Long rides / week', get: (b) => b.longRide.perWeek, fmt: (v) => v.toFixed(1) },
    { label: 'Easy share (3-zone)', get: (b) => (b.seiler[0] / (b.seiler.reduce((a, x) => a + x, 0) || 1)) * 100, fmt: (v) => `${Math.round(v)}%` },
  ];
  return (
    <Card className="mt-4" title="What your peaks had in common" subtitle={`The ${weeks} weeks before each peak, side by side. Ticked rows were consistent across peaks (within ±15%), which makes them the likeliest parts of your recipe.`} pad={false}>
      <div className="overflow-x-auto">
        <table className="tnum w-full min-w-[560px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
              <th className="py-2 pl-5 font-medium">Before the peak</th>
              {peaks.map((p) => (
                <th key={p.date} className="px-3 text-right font-medium">
                  {p.label ?? fmtDate(p.date, 'MMM yyyy')}
                </th>
              ))}
              <th className="px-3 pr-5 text-center font-medium">Consistent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const vals = data.map(r.get);
              const nums = vals.filter((v): v is number => v != null);
              const mean = nums.reduce((a, x) => a + x, 0) / (nums.length || 1);
              const consistent = nums.length >= 2 && mean > 0.05 && nums.every((v) => Math.abs(v - mean) / mean <= 0.15);
              return (
                <tr key={r.label} className={clsx('border-b border-line/60 last:border-0', consistent && 'bg-accent-soft/40')}>
                  <td className="py-1.5 pl-5">{r.label}</td>
                  {vals.map((v, i) => (
                    <td key={i} className="px-3 text-right">
                      {v == null ? '–' : r.fmt(v)}
                    </td>
                  ))}
                  <td className="px-3 pr-5 text-center">{consistent ? <Check className="mx-auto h-4 w-4 text-good" /> : ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
