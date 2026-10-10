import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { parseISO } from 'date-fns';
import clsx from 'clsx';
import { qs, useApi } from '../lib/api';
import { resolvePreset, type DateRange, type RangePreset } from '../lib/range';
import { alpha, useTokens } from '../lib/theme';
import { durWords, fmtDate, fmtDuration, fmtPace, parseDuration } from '../lib/format';
import { breakNames, makeTimeline, type Gap } from '../lib/timeline';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { RangePicker } from './RangePicker';
import { Button, Card, Input, Segmented, Spinner, SportIcon, Stat, Toggle } from './ui';
import type { Sport } from '../../shared/types';

// ---------- API shape (server/efforts.ts) ----------
type Metric = 'power' | 'pace' | 'hr';
interface EffortRow {
  rank: number;
  id: number;
  date: string;
  name: string;
  sport: Sport;
  trainer: boolean;
  value: number;
  start: number;
  wkg: number | null;
  hr: number | null;
}
interface EffortsData {
  metric: Metric;
  duration: number;
  total: number;
  tooShort: number;
  items: EffortRow[];
}

const PRESET_DURATIONS = [5, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200];
const chip = (sec: number) => (sec < 60 ? `${sec}s` : sec < 3600 ? `${sec / 60}m` : `${sec / 3600}h`);

const METRICS: { value: Metric; label: string }[] = [
  { value: 'power', label: 'Power' },
  { value: 'pace', label: 'Run pace' },
  { value: 'hr', label: 'Heart rate' },
];
const NOUN: Record<Metric, string> = { power: 'ride', pace: 'run', hr: 'activity' };
const plural = (m: Metric, n: number) => (n === 1 ? NOUN[m] : m === 'hr' ? 'activities' : `${NOUN[m]}s`);

/**
 * Best efforts for any duration, all of them: every ride's (or run's) best average over
 * exactly that long, ranked from the top down with nothing cut off — a chart of when they
 * happened and the full table, each row opening the activity with the effort selected.
 */
export function BestEffortsCard() {
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const metric = (['power', 'pace', 'hr'].includes(params.get('metric') ?? '') ? params.get('metric') : 'power') as Metric;
  const duration = Math.max(1, Math.min(12 * 3600, Number(params.get('d')) || 1200));
  const [range, setRange] = useState<DateRange>(() => resolvePreset((params.get('range') as RangePreset) || 'all'));
  const [text, setText] = useState('');
  const [wkg, setWkg] = useState(false);
  const [shown, setShown] = useState(50);
  const typed = text ? parseDuration(text) : null;
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    p.set(k, v);
    setParams(p, { replace: true });
    setShown(50);
  };
  const { data, isLoading } = useApi<EffortsData>(`/efforts${qs({ metric, duration, from: range.from, to: range.to })}`);
  const items = data?.items ?? [];
  const best = items[0];
  const year = String(new Date().getFullYear());
  const thisYear = items.find((r) => r.date.startsWith(year));
  const recent = items.find((r) => Date.parse(r.date) >= Date.now() - 90 * 86400000);
  const show = (r: EffortRow) => (metric === 'power' ? (wkg && r.wkg != null ? `${r.wkg.toFixed(2)} W/kg` : `${Math.round(r.value)} W`) : metric === 'pace' ? fmtPace(r.value, 'run') : `${Math.round(r.value)} bpm`);
  const open = (r: EffortRow) => nav(`/activities/${r.id}?sel=${r.start},${r.start + duration}`);
  return (
    <Card
      title="Best efforts"
      subtitle={`Every ${NOUN[metric]}'s best ${durWords(duration)}, ranked — all of them, not just the top few. Click one to open it with the effort selected.`}
      actions={
        <>
          <Segmented size="sm" value={metric} onChange={(v) => set('metric', v)} options={METRICS} />
          <RangePicker
            value={range}
            onChange={(r) => {
              setRange(r);
              set('range', r.preset);
            }}
            presets={['all', 'ytd', 'lastyear', '365d', '90d']}
          />
        </>
      }
    >
      {/* the duration: quick picks, or anything typed */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {PRESET_DURATIONS.map((d) => (
            <button key={d} onClick={() => (setText(''), set('d', String(d)))} className={clsx('rounded-md border px-2 py-1 text-xs tnum', d === duration ? 'border-accent bg-accent-soft font-medium text-accent' : 'border-line text-ink-2 hover:bg-surface-2')}>
              {chip(d)}
            </button>
          ))}
        </div>
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed && typed <= 12 * 3600) set('d', String(typed));
          }}
        >
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Any duration: 7:30, 45s, 1h20" className="w-60" aria-label="Duration" />
          <Button type="submit" size="sm" disabled={!typed || typed > 12 * 3600}>
            Show
          </Button>
          {text && <span className={clsx('text-xs', typed ? 'text-ink-2' : 'text-critical')}>{typed ? (typed > 12 * 3600 ? 'up to 12 hours' : `= ${durWords(typed)}`) : 'try 7:30, 45s or 1h20'}</span>}
        </form>
        {metric === 'power' && (
          <div className="ml-auto">
            <Toggle checked={wkg} onChange={setWkg} label="W/kg" />
          </div>
        )}
      </div>

      {isLoading || !data ? (
        <Spinner />
      ) : !items.length ? (
        <p className="py-10 text-center text-[13px] text-muted">
          No {plural(metric, 2)} {range.preset === 'all' ? '' : 'in this range '}with {metric === 'power' ? 'power' : metric === 'pace' ? 'pace' : 'heart rate'} lasting {durWords(duration)}.
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-4">
            <Stat label={`Best ${durWords(duration)}`} value={show(best)} sub={`${fmtDate(best.date, 'd MMM yyyy')}${best.hr ? ` · ${best.hr} bpm` : ''}`} />
            <Stat label="Ranked" value={data.total.toLocaleString()} sub={data.tooShort ? `${data.tooShort.toLocaleString()} under ${durWords(duration)}` : plural(metric, data.total)} />
            {range.preset === 'all' || range.preset === 'lastyear' ? (
              <Stat label={`Best in ${year}`} value={thisYear ? show(thisYear) : '–'} sub={thisYear ? `#${thisYear.rank} of ${data.total} · ${fmtDate(thisYear.date, 'd MMM')}` : `no ${plural(metric, 2)} yet`} />
            ) : (
              <Stat label="Median" value={show(items[Math.floor(items.length / 2)])} sub="half were better" />
            )}
            <Stat label="Best in 90 days" value={recent ? show(recent) : '–'} sub={recent ? `#${recent.rank} of ${data.total} · ${fmtDate(recent.date, 'd MMM')}` : `no ${plural(metric, 2)} lately`} />
          </div>
          <div className="mt-4">
            <EffortsChart items={items} metric={metric} wkg={wkg} onOpen={open} />
          </div>
          <div className="mt-2 overflow-x-auto">
            <table className="tnum w-full text-[13px] sm:min-w-[640px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  <th className="py-2 pr-3 font-medium">#</th>
                  <th className="px-3 text-right font-medium">{metric === 'power' ? (wkg ? 'W/kg' : 'Power') : metric === 'pace' ? 'Pace' : 'Heart rate'}</th>
                  {metric === 'power' && <th className="px-3 text-right font-medium">{wkg ? 'Power' : 'W/kg'}</th>}
                  <th className="hidden px-3 text-right font-medium sm:table-cell">Of best</th>
                  {metric !== 'hr' && <th className="hidden px-3 text-right font-medium sm:table-cell">Avg HR</th>}
                  <th className="px-3 font-medium">Date</th>
                  <th className="px-3 font-medium">Activity</th>
                  <th className="hidden py-2 pl-3 text-right font-medium sm:table-cell">From</th>
                </tr>
              </thead>
              <tbody>
                {items.slice(0, shown).map((r) => (
                  <tr key={r.id} onClick={() => open(r)} className={clsx('cursor-pointer border-b border-line/60 hover:bg-surface-2', r.rank === 1 && 'font-medium')}>
                    <td className="py-1.5 pr-3 text-ink-2">{r.rank}</td>
                    <td className="px-3 text-right font-medium text-ink">{show(r)}</td>
                    {metric === 'power' && <td className="px-3 text-right text-ink-2">{wkg ? `${Math.round(r.value)} W` : r.wkg != null ? r.wkg.toFixed(2) : '–'}</td>}
                    <td className="hidden px-3 text-right text-ink-2 sm:table-cell">{Math.round((r.value / best.value) * 1000) / 10}%</td>
                    {metric !== 'hr' && <td className="hidden px-3 text-right text-ink-2 sm:table-cell">{r.hr ?? '–'}</td>}
                    <td className="px-3 whitespace-nowrap text-ink-2">
                      <span className="sm:hidden">{fmtDate(r.date, "d MMM ''yy")}</span>
                      <span className="hidden sm:inline">{fmtDate(r.date, 'EEE d MMM yyyy')}</span>
                    </td>
                    <td className="max-w-[130px] px-3 sm:max-w-[280px]">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {metric === 'hr' && <SportIcon sport={r.sport} className="h-3.5 w-3.5 shrink-0" />}
                        <Link to={`/activities/${r.id}?sel=${r.start},${r.start + duration}`} onClick={(e) => e.stopPropagation()} className="truncate text-ink hover:text-accent hover:underline">
                          {r.name}
                        </Link>
                        {r.trainer && <span className="shrink-0 text-[10px] text-muted">indoor</span>}
                      </div>
                    </td>
                    <td className="hidden py-1.5 pl-3 text-right text-ink-2 sm:table-cell">{fmtDuration(r.start)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shown < items.length && (
            <div className="mt-3 flex items-center justify-center gap-2">
              <span className="text-xs text-muted">
                Showing {shown} of {items.length.toLocaleString()}
              </span>
              <Button size="sm" onClick={() => setShown((s) => s + 100)}>
                Show 100 more
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShown(items.length)}>
                Show all
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/**
 * Each activity's best over the duration through time (long breaks squeezed): the top ten in
 * the accent colour and larger, the rest muted. Runs plot speed so that up is faster.
 */
function EffortsChart({ items, metric, wkg, onOpen }: { items: EffortRow[]; metric: Metric; wkg: boolean; onOpen: (r: EffortRow) => void }) {
  const t = useTokens();
  const option = useMemo(() => {
    const byDate = [...items].sort((a, b) => a.date.localeCompare(b.date));
    const ts = byDate.map((r) => parseISO(r.date).getTime());
    const gaps: Gap[] = [];
    for (let i = 1; i < ts.length; i++) {
      const days = Math.round((ts[i] - ts[i - 1]) / 86400000);
      if (days >= 90) gaps.push({ from: fmtDate(new Date(ts[i - 1] + 86400000), 'yyyy-MM-dd'), to: fmtDate(new Date(ts[i] - 86400000), 'yyyy-MM-dd'), days: days - 1 });
    }
    const tl = makeTimeline(gaps);
    const xs = ts.map((v) => tl.toX(v));
    const span = (xs[xs.length - 1] ?? 0) - (xs[0] ?? 0) || 86400000;
    const y = (r: EffortRow) => (metric === 'power' && wkg && r.wkg != null ? r.wkg : r.value);
    const fmt = (v: number) => (metric === 'power' ? (wkg ? v.toFixed(2) : `${Math.round(v)}`) : metric === 'pace' ? fmtPace(v, 'run', false) : `${Math.round(v)}`);
    const unit = metric === 'power' ? (wkg ? 'W/kg' : 'W') : metric === 'pace' ? '' : 'bpm';
    const point = (r: EffortRow, i: number) => ({ value: [xs[i], y(r)], r });
    const top = byDate.map(point).filter((p) => p.r.rank <= 10);
    const rest = byDate.map(point).filter((p) => p.r.rank > 10);
    return {
      animation: false,
      grid: { left: 48, right: 12, top: 12, bottom: 26 },
      tooltip: {
        trigger: 'item' as const,
        ...tooltipStyle(t),
        formatter: (e: any) => {
          const r: EffortRow = e.data.r;
          return `<b>#${r.rank} · ${fmtDate(r.date, 'EEE d MMM yyyy')}</b><div style="opacity:.75;margin-bottom:2px">${r.name}</div>${tipRow(t.accent, metric === 'power' ? 'Power' : metric === 'pace' ? 'Pace' : 'Heart rate', `${metric === 'pace' ? fmtPace(r.value, 'run') : fmt(y(r))} ${unit}`)}${r.hr != null && metric !== 'hr' ? tipRow(t.hr, 'Heart rate', `${r.hr} bpm`) : ''}<div style="opacity:.6;font-size:11px;margin-top:4px">Click to open the effort</div>`;
        },
      },
      xAxis: {
        type: 'value' as const,
        min: (xs[0] ?? 0) - span * 0.02,
        max: (xs[xs.length - 1] ?? 0) + span * 0.02,
        ...axisStyle(t, { grid: false }),
        axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => (tl.inBreak(v) ? '' : fmtDate(new Date(tl.fromX(v)), span > 200 * 86400000 ? "MMM ''yy" : 'd MMM')) },
      },
      yAxis: valueAxis(t, { scale: true, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => `${fmt(v)}${unit && unit !== 'bpm' ? ` ${unit}` : ''}` } }),
      series: [
        {
          type: 'scatter' as const,
          name: 'Each',
          symbolSize: 6,
          cursor: 'pointer',
          itemStyle: { color: alpha(t.ink2, 0.35) },
          data: rest,
          markArea: tl.breaks.length ? { silent: true, itemStyle: { color: alpha(t.muted, 0.12) }, label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, formatter: (p: any) => p.name }, data: tl.breaks.map((g, j, all) => [{ xAxis: g.x0, name: breakNames(all)[j] }, { xAxis: g.x1 }]) } : undefined,
        },
        { type: 'scatter' as const, name: 'Top ten', symbolSize: 10, z: 5, cursor: 'pointer', itemStyle: { color: t.accent, borderColor: t.surface, borderWidth: 1.5 }, data: top },
      ],
    };
  }, [items, metric, wkg, t]);
  return <Chart option={option} height={240} onEvents={{ click: (e: any) => e.data?.r && onOpen(e.data.r) }} />;
}
