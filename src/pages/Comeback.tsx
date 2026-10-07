import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { addDays, parseISO } from 'date-fns';
import { Mountain, Pin, X, Wand2, Check, AlertTriangle, Info } from 'lucide-react';
import clsx from 'clsx';
import type { SeasonWeek } from '../../shared/types';
import { SESSION_LABEL, SESSION_TYPES, QUALITY, ctlForFtp, type BuildSummary, type LoadModel, type SessionType } from '../../shared/analytics/comeback';
import type { EffortPoint } from '../../shared/analytics/thresholds';
import { CURVE_DURATIONS } from '../../shared/analytics/series';
import { http, qs, useAction, useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtNum } from '../lib/format';
import { Badge, Button, Card, Empty, Field, Input, PageHeader, Segmented, Spinner, Stat, Toggle } from '../components/ui';
import { CurveChart } from '../components/charts';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { PlanChart } from './Season';

interface PeakCard {
  date: string;
  ftp: number | null;
  wkg: number | null;
  cp: number | null;
  ctl: number | null;
  p5: number | null;
  p20: number | null;
  p60: number | null;
  durable20: number | null;
  efforts: EffortPoint[];
  windowFrom: string;
  windowTo: string;
  rank?: number;
  pinned?: boolean;
  label?: string;
}
interface Overview {
  peaks: PeakCard[];
  model: LoadModel | null;
  now: { date: string; ftp: number | null; rawFtp: number | null; wkg: number | null; ctl: number | null; atl: number | null };
}
interface Preview {
  config: Record<string, unknown>;
  weeks: (SeasonWeek & { ftp: number | null })[];
  reached: boolean;
  startCtl: number;
  hoursToHold: number;
  ftpAtTarget: number | null;
}

/** Fixed colour per session type (categorical slots, in a stable order). */
function sessionColor(t: ReturnType<typeof useTokens>, s: SessionType): string {
  const map: Record<SessionType, string> = {
    recovery: alpha(t.muted, 0.55),
    endurance: t.series[0],
    tempo: t.series[3],
    threshold: t.series[1],
    vo2: t.series[4],
    anaerobic: t.series[6],
    race: t.series[7],
  };
  return map[s];
}

// ---------- peaks ----------
function PeakCards({ peaks, selected, onSelect }: { peaks: PeakCard[]; selected: string | null; onSelect: (d: string) => void }) {
  const unpin = useAction((d: string) => http(`/comeback/pins/${d}`, { method: 'DELETE' }));
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {peaks.map((p) => (
        <button
          key={p.date}
          onClick={() => onSelect(p.date)}
          className={clsx('card relative p-4 text-left transition-colors', selected === p.date ? 'border-accent ring-1 ring-accent' : 'hover:border-line-strong')}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold">{p.label ?? fmtDate(p.date, 'MMMM yyyy')}</span>
            {p.pinned ? (
              <span className="flex items-center gap-1">
                <Badge>Pinned</Badge>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    unpin.mutate(p.date);
                  }}
                  className="rounded p-0.5 text-muted hover:text-critical"
                  aria-label="Remove pin"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </span>
            ) : (
              <Badge>#{p.rank}</Badge>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-muted">{p.label ? fmtDate(p.date, 'd MMM yyyy') : `week of ${fmtDate(p.date, 'd MMM')}`}</div>
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold">{p.ftp ?? '–'}</span>
            <span className="text-xs text-muted">W FTP{p.wkg ? ` · ${p.wkg.toFixed(2)} W/kg` : ''}</span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
            <div>
              <div className="text-muted">CTL</div>
              <div className="font-medium">{p.ctl ?? '–'}</div>
            </div>
            <div>
              <div className="text-muted">5 min</div>
              <div className="font-medium">{p.p5 ?? '–'}</div>
            </div>
            <div>
              <div className="text-muted">20 min</div>
              <div className="font-medium">{p.p20 ?? '–'}</div>
            </div>
            <div title="Best 20 min after 2,000 kJ">
              <div className="text-muted">Durable</div>
              <div className="font-medium">{p.durable20 ?? '–'}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function PinForm() {
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const pin = useAction(() => http('/comeback/pins', { method: 'POST', json: { date, label } }), { onSuccess: () => (setDate(''), setLabel('')) });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Pin a peak the data doesn't show">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8" />
      </Field>
      <Input placeholder="Label, e.g. Nationals 2019" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-56" />
      <Button size="sm" icon={<Pin className="h-3.5 w-3.5" />} disabled={!date} loading={pin.isPending} onClick={() => pin.mutate(undefined)}>
        Pin
      </Button>
    </div>
  );
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

function BuildSection({ peak, weeks, setWeeks }: { peak: PeakCard; weeks: number; setWeeks: (n: number) => void }) {
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
        <Stat label="Fitness (CTL)" value={`${fmtNum(b.ctlStart)} → ${fmtNum(b.ctlPeak)}`} sub={b.avgRamp != null ? `+${b.avgRamp.toFixed(1)}/wk avg · max +${(b.maxRamp ?? 0).toFixed(1)}` : undefined} />
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
function RecipeTable({ peaks, weeks }: { peaks: PeakCard[]; weeks: number }) {
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
    { label: 'CTL gain / week', get: (b) => b.avgRamp, fmt: (v) => `+${v.toFixed(1)}` },
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
        <table className="tnum w-full text-[13px]">
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

// ---------- now vs then ----------
function NowVsThen({ peak, now }: { peak: PeakCard; now: Overview['now'] }) {
  const t = useTokens();
  const { data } = useApi<{ durations: number[]; then: (number | null)[]; now: (number | null)[] }>(`/comeback/compare${qs({ date: peak.date })}`);
  const keys = [5, 60, 300, 1200, 3600];
  const name = peak.label ?? fmtDate(peak.date, 'MMM yyyy');
  return (
    <Card className="mt-4" title={`Now vs ${name}`} subtitle="Best power for each duration: your peak's 6-month window vs the last 90 days. The biggest gaps show what to rebuild first.">
      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="FTP now" value={now.ftp ?? '–'} unit="W" sub={peak.ftp && now.ftp ? `${Math.round((now.ftp / peak.ftp) * 100)}% of ${peak.ftp} W` : undefined} />
        <Stat label="CTL now" value={now.ctl ?? '–'} sub={peak.ctl ? `peak was ${peak.ctl}` : undefined} />
        <Stat label="Fitness gap" value={peak.ctl != null && now.ctl != null ? `${Math.max(0, peak.ctl - now.ctl)}` : '–'} sub="CTL points to rebuild" />
        <Stat label="Weekly TSS then" value={peak.ctl ? fmtNum(peak.ctl * 7) : '–'} sub="to hold that CTL" />
      </div>
      {!data ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <CurveChart
            height={300}
            unit="W"
            series={[
              { name, color: t.series[1], durations: CURVE_DURATIONS, values: data.then, width: 2 },
              { name: 'Last 90 days', color: t.series[0], durations: CURVE_DURATIONS, values: data.now, width: 2.5, area: true },
            ]}
          />
          <table className="tnum h-fit w-full text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="py-2 font-medium">Duration</th>
                <th className="text-right font-medium">Then</th>
                <th className="text-right font-medium">Now</th>
                <th className="text-right font-medium">Kept</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => {
                const i = CURVE_DURATIONS.indexOf(k);
                const a = data.then[i];
                const b = data.now[i];
                const pct = a && b ? (b / a) * 100 : null;
                return (
                  <tr key={k} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5">{fmtDurLabel(k)}</td>
                    <td className="text-right">{a ?? '–'}</td>
                    <td className="text-right">{b ?? '–'}</td>
                    <td className={clsx('text-right font-medium', pct != null && pct < 85 && 'text-critical')}>{pct != null ? `${Math.round(pct)}%` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---------- load → FTP model ----------
function ModelCard({ model, target, setTarget, now }: { model: LoadModel; target: number; setTarget: (n: number) => void; now: Overview['now'] }) {
  const t = useTokens();
  const need = ctlForFtp(model, target);
  const option = useMemo(() => {
    const years = [...new Set(model.points.map((p) => p.date.slice(0, 4)))].sort();
    const [lo, hi] = [Math.max(0, model.ctlRange[0] - 10), model.ctlRange[1] + 15];
    const line = (off: number) => [
      [lo, model.a + model.b * lo + off],
      [hi, model.a + model.b * hi + off],
    ];
    return {
      animation: false,
      grid: { left: 52, right: 16, top: 34, bottom: 40 },
      legend: { ...legendStyle(t), data: years },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(t),
        formatter: (p: any) => (p.seriesType === 'scatter' ? `<b>${fmtDate(p.data[2])}</b>${tipRow(p.color, 'FTP (fit)', `${Math.round(p.data[1])} W`)}${tipRow('transparent', 'CTL (8-wk avg)', p.data[0].toFixed(0))}` : ''),
      },
      xAxis: { type: 'value', min: Math.floor(lo / 10) * 10, max: Math.ceil(hi / 10) * 10, name: 'Fitness: CTL averaged over the previous 8 weeks', nameLocation: 'middle', nameGap: 26, ...axisStyle(t) },
      yAxis: valueAxis(t, { scale: true, name: 'FTP (W)', nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: [
        ...years.map((y, i) => ({
          type: 'scatter',
          name: y,
          symbolSize: 9,
          data: model.points.filter((p) => p.date.startsWith(y)).map((p) => [p.ctl, p.ftp, p.date]),
          // older years lighter: one hue, ordered by time
          itemStyle: { color: alpha(t.accent, 0.3 + (0.7 * i) / Math.max(1, years.length - 1)), borderColor: t.surface, borderWidth: 1 },
        })),
        { type: 'line', showSymbol: false, silent: true, data: line(0), lineStyle: { color: t.ink2, width: 2 } },
        { type: 'line', showSymbol: false, silent: true, data: line(model.sd), lineStyle: { color: t.muted, width: 1, type: 'dashed' } },
        { type: 'line', showSymbol: false, silent: true, data: line(-model.sd), lineStyle: { color: t.muted, width: 1, type: 'dashed' } },
        {
          type: 'scatter',
          symbol: 'diamond',
          symbolSize: 16,
          data: [[need.ctl, target]],
          itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2 },
          label: { show: true, position: 'right', color: t.ink, fontSize: 11, fontWeight: 600, formatter: `target ${target} W` },
        },
        ...(now.ctl != null && now.ftp != null
          ? [{ type: 'scatter', symbol: 'circle', symbolSize: 12, data: [[now.ctl, now.ftp]], itemStyle: { color: t.good, borderColor: t.surface, borderWidth: 2 }, label: { show: true, position: 'left', color: t.ink, fontSize: 11, formatter: 'now' } }]
          : []),
      ],
    };
  }, [model, t, need.ctl, target, now]);
  const weak = model.r2 < 0.3;
  return (
    <Card className="mt-4" title="What load does your FTP need?" subtitle="Learned from your own history: each dot is an FTP estimate against the fitness (CTL) you carried into it. Line = best fit, dashed = typical spread.">
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Chart option={option} height={340} />
        <div className="flex flex-col gap-4">
          <Field label="Target FTP (W)">
            <Input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          </Field>
          <div className="rounded-xl bg-surface-2 p-4">
            <div className="text-xs text-ink-2">For you, {target} W has come with a CTL of about</div>
            <div className="mt-1 text-3xl font-semibold">{Math.round(need.ctl)}</div>
            <div className="mt-1 text-xs text-muted">
              {need.high - need.low > 50 ? 'range too wide to pin down' : `likely range ${Math.max(0, Math.round(need.low))}–${Math.round(need.high)}`} · roughly {fmtNum(need.ctl * 7)} TSS/week sustained
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Per +10 CTL" value={`+${(model.b * 10).toFixed(0)}`} unit="W" />
            <Stat label="R²" value={model.r2.toFixed(2)} />
            <Stat label="Data points" value={model.n} />
          </div>
          <p className={clsx('flex gap-2 text-[11px] leading-relaxed', weak ? 'text-ink' : 'text-muted')}>
            {weak ? <AlertTriangle className="h-4 w-4 shrink-0 text-warning" /> : <Info className="h-4 w-4 shrink-0" />}
            {weak
              ? 'The relationship in your data is loose (R² < 0.3), so treat the CTL figure as a ballpark. More synced history with power usually tightens it.'
              : 'Your response today may differ from years ago (age, time off, training age), so check progress with the Thresholds page as you build.'}
          </p>
        </div>
      </div>
    </Card>
  );
}

// ---------- the plan ----------
function PlanSection({ peak, defaultTarget, defaultHours, mix, tssPerHour }: { peak: PeakCard; defaultTarget: number; defaultHours: number; mix: BuildSummary['mix'] | null; tssPerHour: number | null }) {
  const t = useTokens();
  const nav = useNavigate();
  const [target, setTarget] = useState(defaultTarget);
  const [hours, setHours] = useState(defaultHours);
  const [initialRamp, setInitialRamp] = useState(3);
  const [ramp, setRamp] = useState(5);
  const [pattern, setPattern] = useState<'2:1' | '3:1' | '4:1'>('3:1');
  const [copyMix, setCopyMix] = useState(true);
  useEffect(() => setTarget(defaultTarget), [defaultTarget]);
  useEffect(() => setHours(defaultHours), [defaultHours]);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    const h = setTimeout(
      () =>
        http<Preview>('/comeback/plan-preview', { method: 'POST', json: { targetCtl: target, maxWeeklyHours: hours, initialRamp, maxRamp: ramp, pattern, mix: copyMix && mix ? mix : undefined, tssPerHour: copyMix ? tssPerHour : undefined } })
          .then(setPreview)
          .catch(() => setPreview(null)),
      250,
    );
    return () => clearTimeout(h);
  }, [target, hours, initialRamp, ramp, pattern, copyMix, mix, tssPerHour]);
  const create = useAction(
    async () => {
      const plan = await http<{ id: number }>('/plans', { method: 'POST', json: { name: `Comeback → ${peak.label ?? fmtDate(peak.date, 'MMM yyyy')} fitness`, config: preview!.config } });
      return http(`/plans/${plan.id}/apply`, { method: 'POST', json: { weeks: 4 } });
    },
    { onSuccess: () => nav('/calendar') },
  );
  const ftpOption = useMemo(() => {
    if (!preview || !preview.weeks.some((w) => w.ftp != null)) return null;
    return {
      animation: false,
      grid: { left: 48, right: 12, top: 16, bottom: 24 },
      tooltip: { trigger: 'axis', ...tooltipStyle(t), formatter: (ps: any) => `<b>Week of ${fmtDate(preview.weeks[ps[0].dataIndex].weekStart, 'd MMM')}</b>${tipRow(t.power, 'Predicted FTP', `${ps[0].value} W`)}` },
      xAxis: { type: 'category', data: preview.weeks.map((w) => fmtDate(w.weekStart, 'd MMM')), ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } },
      yAxis: valueAxis(t, { scale: true }),
      series: [{ type: 'line', showSymbol: false, smooth: 0.3, data: preview.weeks.map((w) => w.ftp), lineStyle: { color: t.power, width: 2 }, itemStyle: { color: t.power }, markLine: peak.ftp ? { symbol: 'none', silent: true, data: [{ yAxis: peak.ftp }], lineStyle: { color: t.muted, type: 'solid', width: 1 }, label: { formatter: `peak ${peak.ftp} W`, color: t.muted, fontSize: 10, position: 'insideEndTop' } } : undefined }],
    };
  }, [preview, t, peak.ftp]);
  const end = preview?.weeks[preview.weeks.length - 1];
  return (
    <Card className="mt-4" title="Your way back" subtitle="A build with no race taper: gentle for the first month (tendons and joints adapt slower than fitness), then up to your normal ramp, with recovery weeks in your usual rhythm.">
      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="grid h-fit grid-cols-2 gap-3">
          <Field label="Target CTL" className="col-span-2" hint={`peak was ${peak.ctl ?? '–'}`}>
            <Input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
          </Field>
          <Field label="Max hours / week" className="col-span-2">
            <Input type="number" value={hours} onChange={(e) => setHours(Number(e.target.value))} />
          </Field>
          <Field label="First 4 weeks" hint="CTL / week">
            <Input type="number" step={0.5} value={initialRamp} onChange={(e) => setInitialRamp(Number(e.target.value))} />
          </Field>
          <Field label="Then up to" hint="CTL / week">
            <Input type="number" step={0.5} value={ramp} onChange={(e) => setRamp(Number(e.target.value))} />
          </Field>
          <Field label="Rhythm" className="col-span-2">
            <Segmented value={pattern} onChange={setPattern} options={[{ value: '2:1', label: '2:1' }, { value: '3:1', label: '3:1' }, { value: '4:1', label: '4:1' }]} />
          </Field>
          {mix && (
            <div className="col-span-2">
              <Toggle checked={copyMix} onChange={setCopyMix} label={`Copy this peak's training style (${mix.quality.toFixed(1)} quality/wk, ${Math.round(mix.vo2Share * 100)}% VO2${mix.longRides >= 0.4 ? ', long rides' : ''}${tssPerHour ? `, ~${Math.round(tssPerHour)} TSS/h` : ''})`} />
            </div>
          )}
          <Button className="col-span-2 mt-2" variant="primary" icon={<Wand2 className="h-4 w-4" />} disabled={!preview} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            Create plan & fill next 4 weeks
          </Button>
          <p className="col-span-2 text-[11px] text-muted">Saved as your active season plan; the rest of the weeks can be filled from the Season Planner.</p>
        </div>
        <div className="min-w-0">
          {!preview ? (
            <Spinner />
          ) : (
            <>
              {!preview.reached && (
                <div className="mb-3 flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-xs">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
                  Within {hours} h/week this plan tops out at CTL {end?.ctl.toFixed(0)}. Holding CTL {target} takes roughly {preview.hoursToHold.toFixed(0)}+ hours a week of mostly endurance riding. Raise the hours or lower the target.
                </div>
              )}
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label={preview.reached ? 'Weeks to target' : 'Plan length'} value={preview.weeks.length} sub={end ? `≈ ${fmtDate(addDays(parseISO(end.weekStart), 6), 'd MMM yyyy')}` : undefined} />
                <Stat label="CTL" value={`${preview.startCtl} → ${end?.ctl.toFixed(0)}`} />
                <Stat label="Peak week" value={fmtNum(Math.max(...preview.weeks.map((w) => w.tss)))} unit="TSS" sub={`${Math.max(...preview.weeks.map((w) => w.hours)).toFixed(1)} h`} />
                <Stat label="Predicted FTP at the end" value={end?.ftp ?? '–'} unit={end?.ftp ? 'W' : undefined} sub="from your load model" />
              </div>
              <PlanChart weeks={preview.weeks} />
              {ftpOption && (
                <>
                  <div className="mt-2 text-xs font-medium text-ink-2">Predicted FTP along the way</div>
                  <Chart option={ftpOption} height={150} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}

export function Comeback() {
  const { data, isLoading } = useApi<Overview>('/comeback/overview');
  const [selected, setSelected] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(16);
  const [target, setTarget] = useState<number | null>(null);
  const peaks = data?.peaks ?? [];
  const best = useMemo(() => [...peaks].sort((a, b) => (b.ftp ?? 0) - (a.ftp ?? 0))[0], [peaks]);
  const peak = peaks.find((p) => p.date === selected) ?? best;
  useEffect(() => setTarget(peak?.ftp ?? null), [peak?.date, peak?.ftp]);
  const build = useApi<BuildSummary>(peak ? `/comeback/build${qs({ date: peak.date, weeks })}` : null);

  if (isLoading || !data) return <Spinner />;
  const model = data.model;
  const tgt = target ?? peak?.ftp ?? 250;
  // the peak's CTL, nudged up if a trustworthy model says that FTP needs more
  const modelCtl = model && model.r2 >= 0.3 && peak?.ftp ? ctlForFtp(model, peak.ftp).ctl : 0;
  const defaultTarget = Math.round(Math.min((peak?.ctl ?? 60) * 1.2, Math.max(peak?.ctl ?? 60, modelCtl)));
  // your own load per hour during that build (≈ how hard your riding typically was)
  const tssPerHour = build.data && build.data.avgHours > 1 ? Math.max(35, Math.min(90, build.data.avgTss / build.data.avgHours)) : null;
  // enough hours to build to and hold the target with recovery weeks, at that rate
  const defaultHours = Math.ceil(((defaultTarget * 7) / (tssPerHour ?? 0.72 ** 2 * 100)) * 1.2);

  return (
    <div>
      <PageHeader title="Comeback" subtitle="Your best seasons, the training behind them, and what it takes to get back" />
      {!peaks.length ? (
        <Card>
          <Empty icon={<Mountain className="h-8 w-8" />} title="No peaks found yet">
            Peaks come from your weekly FTP estimates, which need rides with power. If your history is still syncing from Strava, check back once it finishes (Settings → Connections), or pin a date you know you were flying below.
          </Empty>
          <div className="flex justify-center pb-6">
            <PinForm />
          </div>
        </Card>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
            <div className="text-xs text-muted">Detected from your FTP history (the highest points at least 6 months apart). Select one to explore it.</div>
            <PinForm />
          </div>
          <PeakCards peaks={peaks} selected={peak?.date ?? null} onSelect={setSelected} />
          {peak && (
            <>
              <BuildSection peak={peak} weeks={weeks} setWeeks={setWeeks} />
              {peaks.length >= 2 && <RecipeTable peaks={peaks} weeks={weeks} />}
              <NowVsThen peak={peak} now={data.now} />
              {model ? (
                <ModelCard model={model} target={tgt} setTarget={setTarget} now={data.now} />
              ) : (
                <Card className="mt-4" title="What load does your FTP need?">
                  <p className="text-xs text-muted">Not enough history yet to learn your load → FTP relationship (needs FTP estimates across a range of fitness levels). Until then, plan with your peak's CTL as the target.</p>
                </Card>
              )}
              <PlanSection peak={peak} defaultTarget={defaultTarget} defaultHours={defaultHours} mix={build.data?.mix ?? null} tssPerHour={tssPerHour} />
            </>
          )}
        </>
      )}
    </div>
  );
}

