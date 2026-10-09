import { useMemo } from 'react';
import { addDays, addMonths, differenceInCalendarDays, parseISO } from 'date-fns';
import { daysToTarget, loadForTarget, ltlFor, projectCapacity } from '../../../shared/analytics/capacity';
import { Card, Spinner } from '../../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { useApi } from '../../lib/api';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate, fmtNum } from '../../lib/format';
import { monthSummary, peakName, tauText, type Months, type Overview, type PeakCard, type Story } from './types';

const DAY = 86400_000;
const HORIZON_WEEKS = 104;
const r10 = (x: number) => Math.round(x / 10) * 10;

/** Load needed per target date, and when a steady load gets there — across the plausible models. */
export function WayBack({ o, peak, months, weeklyTss, setWeeklyTss }: { o: Overview; peak: PeakCard; months: Months | undefined; weeklyTss: number; setWeeklyTss: (n: number) => void }) {
  const t = useTokens();
  const { data: story } = useApi<Story>('/comeback/story');
  const cap = o.capacity;
  const name = peakName(peak);
  const target = peak.capacity;
  const tph = o.now.weeklyHours > 0.5 ? Math.max(35, Math.min(90, o.now.weeklyTss / o.now.weeklyHours)) : 60;
  const fits = cap ? cap.fits.filter((f) => f.plausible) : [];
  const best = cap ? cap.fits.find((f) => f.tau === cap.tau) ?? null : null;
  const peakLoad = months?.then.length ? monthSummary(months.then).tss : null;

  const arrival = useMemo(() => {
    if (!target || !fits.length) return null;
    const days = fits.map((f) => daysToTarget(f, f.tau, f.ltlNow, weeklyTss / 7, target));
    const finite = days.filter((d) => Number.isFinite(d));
    return {
      all: finite.length === days.length,
      soonest: finite.length ? Math.min(...finite) : null,
      latest: finite.length ? Math.max(...finite) : null,
      plateau: Math.min(...fits.map((f) => f.a + (f.b * weeklyTss) / 7)),
    };
  }, [fits, target, weeklyTss]);

  const tradeoff = useMemo(() => {
    if (!target || !fits.length) return [];
    return [6, 9, 12, 18].map((m) => {
      const when = addMonths(new Date(), m);
      const days = differenceInCalendarDays(when, new Date());
      const loads = fits.map((f) => loadForTarget(f, f.tau, f.ltlNow, target, days) * 7);
      return { when, low: Math.min(...loads), high: Math.max(...loads) };
    });
  }, [fits, target]);

  const option = useMemo(() => {
    if (!cap || !best || !target || !story) return null;
    const today = new Date();
    const past = story.weeks.filter((w) => differenceInCalendarDays(today, parseISO(w.week)) <= 26 * 7);
    const weeks = Array.from({ length: HORIZON_WEEKS }, (_, i) => addDays(today, (i + 1) * 7).getTime());
    const project = (f: (typeof fits)[number], weekly: number) => {
      const path = projectCapacity(f, f.tau, f.ltlNow, Array(HORIZON_WEEKS * 7).fill(weekly / 7));
      return weeks.map((ts, i) => [ts, Math.round(path[(i + 1) * 7 - 1] * 10) / 10]);
    };
    const main = project(best, weeklyTss);
    // beyond the highest capacity in the fitted history the model is extrapolating: fade it
    const ceiling = cap.a + cap.b * cap.ltlRange[1];
    const cross = main.findIndex((p) => p[1] > ceiling);
    const within = cross < 0 ? main : main.slice(0, cross + 1);
    const beyond = cross < 0 ? [] : main.slice(cross);
    const paths = fits.map((f) => project(f, weeklyTss));
    const lows = weeks.map((_, i) => Math.min(...paths.map((p) => p[i][1])));
    const highs = weeks.map((_, i) => Math.max(...paths.map((p) => p[i][1])));
    const refs: { label: string; weekly: number }[] = [];
    if (Math.abs(o.now.weeklyTss - weeklyTss) >= 20) refs.push({ label: `last 6 weeks (${r10(o.now.weeklyTss)})`, weekly: o.now.weeklyTss });
    if (peakLoad && Math.abs(peakLoad - weeklyTss) >= 20) refs.push({ label: `the year before ${name} (${r10(peakLoad)})`, weekly: peakLoad });
    const startX = parseISO(past[0]?.week ?? fmtDate(today, 'yyyy-MM-dd')).getTime();
    return {
      animation: false,
      grid: { left: 48, right: 150, top: 40, bottom: 30 },
      legend: { ...legendStyle(t), data: ['Best 20 min of the week', 'Capacity', `At ${fmtNum(weeklyTss)} TSS a week`] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const ts = ps[0].axisValue;
          const rows = ps
            .filter((p: any) => !['band-low', 'band', 'beyond'].includes(p.seriesName) && p.value?.[1] != null)
            .map((p: any) => tipRow(p.color, p.seriesName, `${Math.round(p.value[1])} W`))
            .join('');
          const i = weeks.findIndex((w) => w === ts);
          const band = i >= 0 ? `<div style="opacity:.6;font-size:11px;margin-top:4px">plausible range ${Math.round(lows[i])}–${Math.round(highs[i])} W</div>` : '';
          return `<b>${fmtDate(new Date(ts), 'd MMM yyyy')}</b>${rows}${band}`;
        },
      },
      xAxis: { type: 'time', min: startX, max: weeks[weeks.length - 1], ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(v), "MMM ''yy") } },
      yAxis: valueAxis(t, { scale: true, name: '20-min power (W)', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      series: [
        { type: 'scatter', name: 'Best 20 min of the week', symbolSize: 8, data: past.filter((w) => w.best).map((w) => [parseISO(w.week).getTime() + 3 * DAY, w.best]), itemStyle: { color: alpha(t.muted, 0.55), borderColor: t.surface, borderWidth: 1 } },
        { type: 'line', name: 'Capacity', showSymbol: false, data: past.map((w) => [parseISO(w.week).getTime() + 3 * DAY, w.capacity]), lineStyle: { color: t.accent, width: 2 }, itemStyle: { color: t.accent } },
        // plausible range as a band: an invisible base plus the stacked width
        { type: 'line', name: 'band-low', stack: 'band', silent: true, showSymbol: false, data: weeks.map((ts, i) => [ts, lows[i]]), lineStyle: { opacity: 0 }, tooltip: { show: false } },
        { type: 'line', name: 'band', stack: 'band', silent: true, showSymbol: false, data: weeks.map((ts, i) => [ts, highs[i] - lows[i]]), lineStyle: { opacity: 0 }, areaStyle: { color: alpha(t.accent, 0.12) }, tooltip: { show: false } },
        ...(beyond.length
          ? [
              {
                type: 'line',
                name: 'beyond',
                showSymbol: false,
                silent: true,
                data: beyond,
                lineStyle: { color: alpha(t.accent, 0.35), width: 2, type: 'dotted' },
                tooltip: { show: false },
                endLabel: { show: true, color: t.muted, fontSize: 10, formatter: `${fmtNum(weeklyTss)} TSS/wk\n(beyond your history)` },
              },
            ]
          : []),
        {
          type: 'line',
          name: `At ${fmtNum(weeklyTss)} TSS a week`,
          showSymbol: false,
          data: within,
          lineStyle: { color: t.accent, width: 2, type: 'dashed' },
          itemStyle: { color: t.accent },
          endLabel: { show: !beyond.length, color: t.ink, fontSize: 11, formatter: `${fmtNum(weeklyTss)} TSS/wk` },
          markLine: {
            symbol: 'none',
            silent: true,
            data: [{ yAxis: Math.round(target) }],
            lineStyle: { color: t.series[1], width: 1.5, type: 'solid' },
            label: { position: 'insideStartTop', color: t.ink2, fontSize: 11, formatter: `${name} capacity · ${Math.round(target)} W` },
          },
        },
        ...refs.map((r) => ({
          type: 'line',
          name: `At ${r.label}`,
          showSymbol: false,
          data: project(best, r.weekly),
          lineStyle: { color: t.muted, width: 1.5, type: 'dashed' },
          itemStyle: { color: t.muted },
          endLabel: { show: true, color: t.ink2, fontSize: 10, formatter: r.label },
        })),
      ],
    };
  }, [cap, best, target, story, weeklyTss, fits, o.now.weeklyTss, peakLoad, name, t]);

  if (!cap || !target)
    return (
      <Card className="mt-4" title="What it takes to get back">
        <p className="text-xs text-muted">
          Projecting the way back needs at least a year of rides with power (30+ weeks with a hard 20-minute effort or more) so the model can learn how your power follows your training load.
        </p>
      </Card>
    );

  const today = new Date();
  const v = cap.validation;
  const plausibleTaus = fits.map((f) => f.tau);
  return (
    <Card
      className="mt-4"
      title="What it takes to get back"
      subtitle={`Your 20-minute capacity follows your training load over roughly the last ${tauText(cap.tau)}. Dashed: where a steady weekly load takes it, with the range of models that fit your history almost as well.`}
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
        <div className="min-w-0">{option ? <Chart option={option} height={340} /> : <Spinner />}</div>
        <div className="flex flex-col gap-4">
          <div>
            <div className="flex items-baseline justify-between">
              <label htmlFor="weekly-load" className="text-xs font-medium text-ink-2">
                Steady weekly load
              </label>
              <span className="text-sm font-semibold text-ink">
                {fmtNum(weeklyTss)} <span className="text-xs font-normal text-muted">TSS · ≈ {(weeklyTss / tph).toFixed(1)} h</span>
              </span>
            </div>
            <input id="weekly-load" type="range" min={200} max={1200} step={10} value={weeklyTss} onChange={(e) => setWeeklyTss(Number(e.target.value))} className="mt-2 w-full accent-[var(--accent)]" />
            <div className="mt-1 flex justify-between text-[11px] text-muted">
              <button type="button" className="hover:text-ink" onClick={() => setWeeklyTss(r10(o.now.weeklyTss))}>
                last 6 weeks: {fmtNum(r10(o.now.weeklyTss))}
              </button>
              {peakLoad != null && (
                <button type="button" className="hover:text-ink" onClick={() => setWeeklyTss(r10(peakLoad))}>
                  year before {name}: {fmtNum(r10(peakLoad))}
                </button>
              )}
            </div>
          </div>
          <div className="rounded-xl bg-surface-2 p-4">
            <div className="text-xs text-ink-2">Back to your {name} capacity ({Math.round(target)} W)</div>
            {arrival?.all && arrival.soonest != null && arrival.latest != null ? (
              <>
                <div className="mt-1 text-2xl font-semibold text-ink">
                  {arrival.latest === 0 ? 'Already there' : arrival.soonest === arrival.latest ? fmtDate(addDays(today, arrival.latest), 'MMM yyyy') : `${fmtDate(addDays(today, arrival.soonest), 'MMM yyyy')} – ${fmtDate(addDays(today, arrival.latest), 'MMM yyyy')}`}
                </div>
                <div className="mt-0.5 text-xs text-muted">holding {fmtNum(weeklyTss)} TSS a week, recovery weeks included</div>
              </>
            ) : (
              <>
                <div className="mt-1 text-2xl font-semibold text-ink">Not at this load</div>
                <div className="mt-0.5 text-xs text-muted">it levels off around {arrival ? Math.round(arrival.plateau) : '–'} W for 20 minutes</div>
              </>
            )}
          </div>
          {arrival?.latest === 0 ? (
            <p className="text-xs leading-relaxed text-ink-2">
              You're already at your {name} capacity. Holding about {fmtNum(r10(Math.max(...fits.map((f) => ltlFor(f, target) * 7))))} TSS a week keeps you there for good; less lets it drift back down over months.
            </p>
          ) : (
            <div>
              <div className="mb-1.5 text-xs font-medium text-ink-2">To be back by…</div>
              <table className="tnum w-full text-[13px]">
                <tbody>
                  {tradeoff.map((r) => (
                    <tr key={r.when.toISOString()} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5">{fmtDate(r.when, 'MMM yyyy')}</td>
                      <td className="text-right">
                        {r.high > 1500 ? 'more than you can train' : r.low === r.high || r.high - r.low < 20 ? `${fmtNum(r10(r.high))} TSS/wk` : `${fmtNum(r10(r.low))}–${fmtNum(r10(r.high))} TSS/wk`}
                      </td>
                      <td className="w-20 text-right text-ink-2">{r.high > 1500 ? '' : Math.round(r.low / tph) === Math.round(r.high / tph) ? `${Math.round(r.high / tph)} h` : `${Math.round(r.low / tph)}–${Math.round(r.high / tph)} h`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted">
            Learned from {cap.observations} weeks of your best efforts: capacity = {Math.round(cap.a)} W + {cap.b.toFixed(2)} × long-term load. Time constants of {plausibleTaus.map(tauText).join(', ')} fit your history about equally well, hence the ranges.
            {v ? ` Fitted only on rides before ${fmtDate(v.from, 'MMM yyyy')}, it predicted your monthly bests since within ±${Math.round(v.mae)} W (6-week CTL: ±${Math.round(v.maeCtl)} W).` : ''} Above ~{Math.round(cap.a + cap.b * cap.ltlRange[1])} W (dotted) it extrapolates beyond anything in your history. Hours assume your recent ~{Math.round(tph)} TSS an hour.
          </p>
        </div>
      </div>
    </Card>
  );
}
