import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseISO } from 'date-fns';
import { RefreshCw, Info } from 'lucide-react';
import type { Preferences, Thresholds as Th } from '../../shared/types';
import { ESTIMATE_CONFIG, MAX_WEEKLY_DECLINE, WINDOW_DAYS, type ThresholdEstimate, type ThresholdSport } from '../../shared/analytics/thresholds';
import { http, qs, useAction, useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtDuration, fmtPace, iso } from '../lib/format';
import { Badge, Button, Card, Empty, PageHeader, Segmented, Spinner, Stat, Toggle } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';

interface SeriesResponse {
  sport: ThresholdSport;
  auto: boolean;
  series: ThresholdEstimate[];
  manual: { date: string; value: number }[];
  state: { running: boolean; lastRun: string | null };
  current: Th;
}
interface DetailResponse {
  estimate: ThresholdEstimate | null;
  curve: { durations: number[]; values: (number | null)[]; activityIds: (number | null)[]; dates: (string | null)[]; filled: boolean[] };
  from: string;
  to: string;
}

const LABEL: Record<ThresholdSport, { name: string; model: string; cp: string; wp: string }> = {
  ride: { name: 'Bike FTP', model: 'critical power', cp: 'Critical power', wp: 'W′' },
  run: { name: 'Run threshold pace', model: 'critical speed', cp: 'Critical speed', wp: 'D′' },
  swim: { name: 'Swim CSS', model: 'critical swim speed', cp: 'Critical speed', wp: 'D′' },
};
const BAND = ['Short', 'Medium', 'Long'];

/** Formatting helpers per sport: power in W, run pace /km, swim pace /100m. */
function fmt(sport: ThresholdSport) {
  if (sport === 'ride') return { value: (v: number) => `${Math.round(v)} W`, axis: (v: number) => `${Math.round(v)}`, unit: 'W' };
  const s = sport === 'run' ? 'run' : 'swim';
  return { value: (v: number) => fmtPace(v, s), axis: (v: number) => fmtPace(v, s, false), unit: sport === 'run' ? 'pace' : 'pace /100m' };
}
const wpText = (sport: ThresholdSport, w: number) => (sport === 'ride' ? `${(w / 1000).toFixed(1)} kJ` : `${Math.round(w)} m`);

function HistoryChart({ sport, data, selected, onSelect }: { sport: ThresholdSport; data: SeriesResponse; selected: string | null; onSelect: (d: string) => void }) {
  const t = useTokens();
  const f = fmt(sport);
  // the click handler is bound once; read the latest data through a ref
  const ref = useRef({ series: data.series, onSelect });
  ref.current = { series: data.series, onSelect };
  const option = useMemo(() => {
    const ts = (d: string) => parseISO(d).getTime();
    const s = data.series;
    const lastDate = s.length ? s[s.length - 1].date : iso(new Date());
    const manual = data.manual.filter((m) => m.value > 0);
    const manualPts = manual.map((m) => [ts(m.date), m.value]).concat(manual.length ? [[ts(lastDate), manual[manual.length - 1].value]] : []);
    const sel = s.find((e) => e.date === selected);
    return {
      animation: false,
      grid: { left: 64, right: 16, top: 34, bottom: 30 },
      legend: { ...legendStyle(t), data: ['Applied', 'Raw fit', ...(manual.length ? ['Manual setting'] : [])] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const x = ps[0].value[0];
          const e = s.find((z) => ts(z.date) === x);
          if (!e) return '';
          return `<b>From ${fmtDate(e.date, 'd MMM yyyy')}</b><div style="opacity:.6;font-size:11px;margin-bottom:4px">window ${fmtDate(e.windowFrom, 'd MMM')} – ${fmtDate(e.windowTo, 'd MMM yyyy')}</div>${tipRow(t.accent, 'Applied', f.value(e.threshold))}${tipRow(t.muted, 'Raw fit', f.value(e.raw))}${tipRow('transparent', LABEL[sport].wp, wpText(sport, e.wPrime))}<div style="opacity:.6;font-size:11px;margin-top:4px">Click to inspect the fit</div>`;
        },
      },
      xAxis: { type: 'time', ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, {
        inverse: sport !== 'ride',
        scale: true,
        axisLabel: { color: t.muted, fontSize: 11, formatter: f.axis },
      }),
      series: [
        {
          type: 'line',
          name: 'Applied',
          step: 'end',
          showSymbol: false,
          data: s.map((e) => [ts(e.date), e.threshold]),
          lineStyle: { color: t.accent, width: 2.5 },
          itemStyle: { color: t.accent },
          markLine: sel ? { symbol: 'none', silent: true, data: [{ xAxis: ts(sel.date) }], lineStyle: { color: t.ink2, type: 'solid', width: 1 }, label: { show: false } } : undefined,
        },
        {
          type: 'scatter',
          name: 'Raw fit',
          symbolSize: 6,
          data: s.map((e) => [ts(e.date), e.raw]),
          itemStyle: { color: alpha(t.muted, 0.7) },
        },
        ...(manual.length ? [{ type: 'line', name: 'Manual setting', step: 'end', showSymbol: false, data: manualPts, lineStyle: { color: t.series[1], width: 1.5 }, itemStyle: { color: t.series[1] } }] : []),
      ],
    };
  }, [data, t, selected, sport, f]);
  return (
    <Chart
      option={option}
      height={300}
      onReady={(c) =>
        c.getZr().on('click', (ev: any) => {
          const pt = c.convertFromPixel({ gridIndex: 0 }, [ev.offsetX, ev.offsetY]);
          if (!pt) return;
          const x = pt[0];
          let best: ThresholdEstimate | null = null;
          for (const e of ref.current.series) if (!best || Math.abs(parseISO(e.date).getTime() - x) < Math.abs(parseISO(best.date).getTime() - x)) best = e;
          if (best) ref.current.onSelect(best.date);
        })
      }
    />
  );
}

function CurveFitChart({ sport, detail }: { sport: ThresholdSport; detail: DetailResponse }) {
  const t = useTokens();
  const f = fmt(sport);
  const cfg = ESTIMATE_CONFIG[sport];
  const option = useMemo(() => {
    const e = detail.estimate!;
    const lo = Math.max(10, cfg.tMin / 4);
    const hi = Math.min(4 * 3600, cfg.tMax * 2.5);
    const curve = detail.curve.durations.map((d, i) => [d, detail.curve.values[i]] as [number, number | null]).filter(([d, v]) => v != null && d >= lo && d <= hi);
    const model: [number, number][] = [];
    for (let d = cfg.tMin * 0.6; d <= hi; d *= 1.08) model.push([d, e.cp + e.wPrime / d]);
    const ticks = [15, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200].filter((x) => x >= lo && x <= hi);
    return {
      animation: false,
      grid: { left: 64, right: 16, top: 34, bottom: 30 },
      legend: { ...legendStyle(t), data: ['Best efforts (6 months)', `${LABEL[sport].model} model`, 'Chosen efforts'] },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(t),
        formatter: (p: any) => {
          const [d, v] = p.value;
          const pick = e.points.find((q) => q.t === d);
          if (pick) return `<b>${BAND[pick.band]} effort · ${fmtDurLabel(d)}</b>${tipRow(t.series[1], 'Best', f.value(v))}${tipRow('transparent', 'vs envelope', `${(pick.score * 100).toFixed(1)}%`)}${pick.date ? `<div style="opacity:.6;font-size:11px">${fmtDate(pick.date)}</div>` : ''}`;
          return `<b>${fmtDurLabel(Math.round(d))}</b>${tipRow(p.color, p.seriesName, f.value(v))}`;
        },
      },
      xAxis: { type: 'log', min: lo, max: hi, ...axisStyle(t), splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 11, customValues: ticks, formatter: (v: number) => fmtDurLabel(Math.round(v)) }, axisTick: { show: true, customValues: ticks } },
      yAxis: valueAxis(t, { inverse: sport !== 'ride', scale: true, axisLabel: { color: t.muted, fontSize: 11, formatter: f.axis } }),
      series: [
        {
          type: 'line',
          name: 'Best efforts (6 months)',
          showSymbol: false,
          data: curve,
          lineStyle: { color: t.series[0], width: 2 },
          itemStyle: { color: t.series[0] },
          areaStyle: { color: alpha(t.series[0], 0.08), origin: sport === 'ride' ? 'start' : 'end' },
          markArea: { silent: true, itemStyle: { color: alpha(t.ink2, 0.06) }, label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, formatter: 'model range' }, data: [[{ xAxis: cfg.tMin }, { xAxis: cfg.tMax }]] },
        },
        { type: 'line', name: `${LABEL[sport].model} model`, showSymbol: false, data: model, lineStyle: { color: t.ink2, width: 1.5, type: 'dashed' }, itemStyle: { color: t.ink2 } },
        {
          type: 'scatter',
          name: 'Chosen efforts',
          symbolSize: 13,
          z: 10,
          itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2 },
          data: e.points.map((p, i) => ({ value: [p.t, p.value], label: { position: i % 2 ? 'bottom' : 'top' } })),
          label: { show: true, color: t.ink, fontSize: 11, fontWeight: 600, distance: 8, formatter: (p: any) => `${fmtDurLabel(p.value[0])} · ${f.axis(p.value[1])}` },
        },
      ],
    };
  }, [detail, t, sport, f, cfg]);
  return <Chart option={option} height={340} />;
}

function LinearFitChart({ sport, e }: { sport: ThresholdSport; e: ThresholdEstimate }) {
  const t = useTokens();
  const option = useMemo(() => {
    const isBike = sport === 'ride';
    const yv = (p: { t: number; value: number }) => (isBike ? (p.value * p.t) / 1000 : p.value * p.t);
    const maxT = Math.max(...e.points.map((p) => p.t)) * 1.15;
    const line: [number, number][] = [
      [0, isBike ? e.wPrime / 1000 : e.wPrime],
      [maxT / 60, isBike ? (e.cp * maxT + e.wPrime) / 1000 : e.cp * maxT + e.wPrime],
    ];
    const yName = isBike ? 'Work (kJ)' : 'Distance (m)';
    return {
      animation: false,
      grid: { left: 60, right: 16, top: 30, bottom: 40 },
      tooltip: { trigger: 'item', ...tooltipStyle(t), formatter: (p: any) => `${fmtDuration(p.value[0] * 60)} → ${Math.round(p.value[1]).toLocaleString()} ${isBike ? 'kJ' : 'm'}` },
      xAxis: { type: 'value', min: 0, name: 'Duration (min)', nameLocation: 'middle', nameGap: 26, ...axisStyle(t) },
      yAxis: valueAxis(t, { min: 0, name: yName, nameTextStyle: { color: t.muted, fontSize: 10 } }),
      series: [
        { type: 'line', showSymbol: false, data: line, lineStyle: { color: t.ink2, width: 1.5, type: 'dashed' }, silent: true },
        {
          type: 'scatter',
          symbolSize: 12,
          data: e.points.map((p) => [p.t / 60, yv(p)]),
          itemStyle: { color: t.series[1], borderColor: t.surface, borderWidth: 2 },
          label: { show: true, position: 'left', color: t.ink2, fontSize: 10, formatter: (p: any) => BAND[e.points[p.dataIndex].band] },
        },
      ],
    };
  }, [e, t, sport]);
  return <Chart option={option} height={260} />;
}

export function Thresholds() {
  const t = useTokens();
  const [sport, setSport] = useState<ThresholdSport>('ride');
  const { data, isLoading } = useApi<SeriesResponse>(`/estimates${qs({ sport })}`, { refetchInterval: (q) => ((q.state.data as SeriesResponse | undefined)?.state.running ? 3000 : false) });
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => setSelected(null), [sport]);
  const today = iso(new Date());
  const current = data?.series.filter((e) => e.date <= today).pop() ?? data?.series[data.series.length - 1];
  const sel = selected ?? current?.date ?? null;
  const detail = useApi<DetailResponse>(sel ? `/estimates/detail${qs({ sport, date: sel })}` : null);
  const prefs = useApi<Preferences>('/preferences');
  const setAuto = useAction((v: boolean) => http('/preferences', { method: 'PUT', json: { autoThresholds: { ...prefs.data!.autoThresholds, [sport]: v } } }));
  const refresh = useAction(() => http('/estimates/refresh', { method: 'POST' }));
  const f = fmt(sport);
  const e = detail.data?.estimate ?? null;
  const manualNow = data?.manual.filter((m) => m.date <= today).pop() ?? data?.manual[0];

  return (
    <div>
      <PageHeader
        title="Thresholds"
        subtitle={`FTP, run threshold pace and swim CSS estimated weekly from your last ${Math.round(WINDOW_DAYS / 30)} months of best efforts`}
        actions={
          <>
            <Segmented value={sport} onChange={setSport} options={[{ value: 'ride', label: 'Bike FTP' }, { value: 'run', label: 'Run pace' }, { value: 'swim', label: 'Swim CSS' }]} />
            <Button icon={<RefreshCw className={`h-4 w-4 ${data?.state.running ? 'animate-spin' : ''}`} />} loading={refresh.isPending} onClick={() => refresh.mutate(undefined)} title="Recompute all estimates and recalculate activities">
              Recompute
            </Button>
          </>
        }
      />
      {isLoading || !data ? (
        <Spinner />
      ) : !data.series.length ? (
        <Card>
          <Empty title={`Not enough data for ${LABEL[sport].name.toLowerCase()} yet`}>
            Estimates need at least {4} {sport === 'ride' ? 'rides with power' : sport === 'run' ? 'runs' : 'swims'} in a 6-month window, including some hard efforts between {fmtDurLabel(ESTIMATE_CONFIG[sport].tMin)} and {fmtDurLabel(ESTIMATE_CONFIG[sport].tMax)}. Until then your manual value is used.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="card mb-4 grid grid-cols-2 gap-4 p-5 sm:grid-cols-3 xl:grid-cols-6">
            <Stat label={`Current ${ESTIMATE_CONFIG[sport].label}`} accent={t.accent} value={current ? f.value(current.threshold) : '–'} sub={current ? `from ${fmtDate(current.date, 'd MMM')}` : undefined} />
            <Stat label={LABEL[sport].cp} value={current ? f.value(current.cp) : '–'} sub={sport === 'ride' ? `FTP = ${Math.round(ESTIMATE_CONFIG.ride.factor * 100)}% of CP` : 'threshold = CS'} />
            <Stat label={LABEL[sport].wp} value={current ? wpText(sport, current.wPrime) : '–'} sub={sport === 'ride' ? 'anaerobic capacity' : 'distance above CS'} />
            <Stat label="Manual value" value={manualNow?.value ? f.value(manualNow.value) : '–'} sub="Settings → Athlete" />
            <Stat label="Weeks estimated" value={data.series.length} sub={data.state.running ? 'recomputing…' : data.state.lastRun ? `updated ${fmtDate(data.state.lastRun, 'd MMM HH:mm')}` : undefined} />
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted uppercase">Zones & TSS use</div>
              <div className="mt-2">
                <Toggle checked={data.auto} onChange={(v) => setAuto.mutate(v)} label={data.auto ? 'Automatic estimate' : 'Manual value'} />
              </div>
              <div className="mt-1 text-[11px] text-muted">switching recalculates {sport} activities</div>
            </div>
          </div>

          <Card title="History" subtitle="Applied value (used for zones and TSS on that date), the raw fit for each weekly window, and your manual setting. Click anywhere to inspect a week.">
            <HistoryChart sport={sport} data={data} selected={sel} onSelect={setSelected} />
          </Card>

          {detail.isLoading ? (
            <Spinner />
          ) : e && detail.data ? (
            <>
              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
                <Card
                  title={`The fit for ${fmtDate(e.date, 'd MMM yyyy')}`}
                  subtitle={`Best efforts ${fmtDate(e.windowFrom, 'd MMM yyyy')} – ${fmtDate(e.windowTo, 'd MMM yyyy')} (${e.activities} activities). Orange = the three efforts the model is fitted to.`}
                  actions={<Badge>{e.threshold > e.raw + 1e-9 ? 'decline-limited' : 'raw fit'}</Badge>}
                >
                  <CurveFitChart sport={sport} detail={detail.data} />
                </Card>
                <Card title="Linear check" subtitle={sport === 'ride' ? 'Work vs time is a straight line: slope = CP, intercept = W′' : 'Distance vs time is a straight line: slope = CS, intercept = D′'}>
                  <LinearFitChart sport={sport} e={e} />
                  <div className="mt-2 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
                    <Stat label="Slope" value={<span className="text-base">{f.value(e.cp)}</span>} />
                    <Stat label="Intercept" value={<span className="text-base">{wpText(sport, e.wPrime)}</span>} />
                    <Stat label="R²" value={<span className="text-base">{e.r2.toFixed(4)}</span>} />
                  </div>
                </Card>
              </div>
              <Card className="mt-4" title="Efforts used" pad={false}>
                <table className="tnum w-full text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                      <th className="py-2 pl-5 font-medium">Band</th>
                      <th className="px-3 font-medium">Duration</th>
                      <th className="px-3 text-right font-medium">Best {sport === 'ride' ? 'power' : 'pace'}</th>
                      <th className="px-3 text-right font-medium">{sport === 'ride' ? 'Work' : 'Distance'}</th>
                      <th className="px-3 text-right font-medium" title="How far above or below the curve's upper envelope this effort sits">vs envelope</th>
                      <th className="px-3 pr-5 font-medium">Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e.points.map((p) => (
                      <tr key={p.t} className="border-b border-line/60 last:border-0">
                        <td className="py-2 pl-5">{BAND[p.band]}</td>
                        <td className="px-3">{fmtDuration(p.t)}</td>
                        <td className="px-3 text-right font-medium">{f.value(p.value)}</td>
                        <td className="px-3 text-right text-ink-2">{sport === 'ride' ? `${Math.round((p.value * p.t) / 1000)} kJ` : `${Math.round(p.value * p.t)} m`}</td>
                        <td className="px-3 text-right text-ink-2">{(p.score * 100).toFixed(1)}%</td>
                        <td className="px-3 pr-5">
                          {p.activityId ? (
                            <Link to={`/activities/${p.activityId}`} className="text-accent hover:underline">
                              {p.date ? fmtDate(p.date) : 'Open'}
                            </Link>
                          ) : (
                            '–'
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            </>
          ) : (
            <Card className="mt-4">
              <Empty title="No estimate for this week" />
            </Card>
          )}

          <Card className="mt-4" title={<span className="flex items-center gap-2"><Info className="h-4 w-4 text-muted" />How the estimate works</span>}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-ink-2">
              <li>
                Each week, take your best {sport === 'ride' ? 'power' : 'pace'} for every duration over the previous {Math.round(WINDOW_DAYS / 30)} months, between {fmtDurLabel(ESTIMATE_CONFIG[sport].tMin)} and {fmtDurLabel(ESTIMATE_CONFIG[sport].tMax)}. That range is long enough to be aerobic-dominant and short enough that you can go all-out.
              </li>
              <li>Fit a curve to the upper edge of those efforts, so easy sessions that happen to be your "best 30 minutes" don't drag it down.</li>
              <li>
                Out of every combination of three efforts that are well spread in duration (each at least 1.6× longer than the one before, 4× overall), keep the one whose <i>weakest</i> effort sits highest relative to that edge. That gives three genuinely maximal efforts that pin down both the slope and the intercept. A value copied from a longer effort doesn't count as a separate effort.
              </li>
              <li>
                Fit the {LABEL[sport].model} model through those three points (a straight line in {sport === 'ride' ? 'work' : 'distance'} vs time).{' '}
                {sport === 'ride' ? `FTP = ${Math.round(ESTIMATE_CONFIG.ride.factor * 100)}% of CP, because CP from 3–30 min efforts sits slightly above one-hour power.` : sport === 'run' ? 'Threshold pace = critical speed.' : 'CSS is the critical speed.'}
              </li>
              <li>
                Fitness is lost slowly, but a big effort leaves the window all at once. So the applied value can drop by at most {Math.round(MAX_WEEKLY_DECLINE * 100)}% per week. Rises apply immediately.
              </li>
              <li>Each activity uses the estimate that was current on its date. Heart-rate thresholds (LTHR, max HR) stay manual.</li>
            </ol>
          </Card>
        </>
      )}
    </div>
  );
}
