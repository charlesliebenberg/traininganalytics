import { useMemo } from 'react';
import { addDays, parseISO } from 'date-fns';
import { CURVE_DURATIONS } from '../../../shared/analytics/series';
import { Card, Spinner } from '../../components/ui';
import { CurveChart } from '../../components/charts';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { qs, useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { fmtDate, fmtDurLabel, fmtNum } from '../../lib/format';
import { curveKept, durability } from './findings';
import { peakName, type Compare, type HrCompareResponse, type PeakCard } from './types';

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** Durations in prose: "your sprint", "20 minutes". */
const durWords: Record<number, string> = { 5: 'sprint (5 s)', 60: '1-minute power', 300: '5-minute power', 1200: '20-minute power', 3600: 'hour' };

/** Best power by duration (then vs the last 90 days), deep into a ride, and steady power at the same heart rate. */
export function Gap({ peak, hr }: { peak: PeakCard; hr: HrCompareResponse | undefined }) {
  const t = useTokens();
  const name = peakName(peak);
  const { data } = useApi<Compare>(`/comeback/compare${qs({ date: peak.date })}`);
  const kept = curveKept(data);
  const worst = kept.length ? kept.reduce((a, b) => (b.kept < a.kept ? b : a)) : null;
  const best = kept.length ? kept.reduce((a, b) => (b.kept > a.kept ? b : a)) : null;
  const du = durability(data);

  const hrOption = useMemo(() => {
    if (!hr || (!hr.then.length && !hr.now.length)) return null;
    const all = [...hr.then, ...hr.now];
    const line = (pts: typeof hr.then) => pts.map((p) => [p.hr, p.power, p.rides, p.windows]);
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 34, bottom: 40 },
      legend: { ...legendStyle(t), data: [name, 'Last 4 months'] },
      tooltip: {
        trigger: 'item',
        ...tooltipStyle(t),
        formatter: (p: any) => {
          const [bpm] = p.data;
          const th = hr.then.find((x) => x.hr === bpm);
          const nw = hr.now.find((x) => x.hr === bpm);
          return `<b>${bpm} bpm</b>${th ? tipRow(t.muted, name, `${th.power} W`) : ''}${nw ? tipRow(t.accent, 'Last 4 months', `${nw.power} W`) : ''}<div style="opacity:.6;font-size:11px;margin-top:4px">steady 10-min stretches: ${th ? `${th.windows} then (${th.rides} rides)` : 'none then'}, ${nw ? `${nw.windows} now (${nw.rides} rides)` : 'none now'}</div>`;
        },
      },
      xAxis: { type: 'value', min: Math.floor(Math.min(...all.map((p) => p.hr)) / 5) * 5 - 5, max: Math.ceil(Math.max(...all.map((p) => p.hr)) / 5) * 5 + 5, name: 'Heart rate (bpm)', nameLocation: 'middle', nameGap: 26, ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { scale: true, name: 'Steady power (W)', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      series: [
        { type: 'line', name, data: line(hr.then), symbol: 'circle', symbolSize: 8, lineStyle: { color: t.muted, width: 2 }, itemStyle: { color: t.muted, borderColor: t.surface, borderWidth: 2 } },
        { type: 'line', name: 'Last 4 months', data: line(hr.now), symbol: 'circle', symbolSize: 8, lineStyle: { color: t.accent, width: 2 }, itemStyle: { color: t.accent, borderColor: t.surface, borderWidth: 2 } },
      ],
    };
  }, [hr, name, t]);

  const c = hr?.comparison;
  const am = hr?.aerobic;
  // the heart-rate "then" reaches well past the peak when it had to look further for rides
  const widened = hr ? hr.thenRange[1] > fmtDate(addDays(parseISO(peak.date), 60), 'yyyy-MM-dd') : false;
  return (
    <Card className="mt-4" title="Where the gap is" subtitle={`Around ${name} vs recently: your best power for each duration, how much of it you keep deep into a ride, and the power you hold at the same heart rate.`}>
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-ink-2">Best power by duration</div>
          {!data ? (
            <Spinner />
          ) : (
            <>
              <CurveChart
                height={280}
                unit="W"
                series={[
                  { name: `Around ${name}`, color: t.muted, durations: CURVE_DURATIONS, values: data.then, width: 2 },
                  { name: 'Last 90 days', color: t.accent, durations: CURVE_DURATIONS, values: data.now, width: 2, area: true },
                ]}
              />
              <table className="tnum mt-2 w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                    <th className="py-1.5 font-medium">Duration</th>
                    <th className="text-right font-medium">{name}</th>
                    <th className="text-right font-medium">Now</th>
                    <th className="text-right font-medium">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  {[5, 60, 300, 1200, 3600].map((d) => {
                    const i = CURVE_DURATIONS.indexOf(d);
                    const k = kept.find((x) => x.t === d);
                    return (
                      <tr key={d} className="border-b border-line/60 last:border-0">
                        <td className="py-1.5">{fmtDurLabel(d)}</td>
                        <td className="text-right">{data.then[i] ?? '–'}</td>
                        <td className="text-right">{data.now[i] ?? '–'}</td>
                        <td className={k && k === worst ? 'text-right font-semibold text-ink' : 'text-right text-ink-2'}>{k ? pct(k.kept) : '–'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {best && worst && best !== worst && (
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {best.kept >= 0.98 ? `Your ${durWords[best.t]} is back (${pct(best.kept)})` : `Closest is your ${durWords[best.t]} (${pct(best.kept)})`}; the gap is widest at {durWords[worst.t]} ({pct(worst.kept)}). Best efforts actually ridden at each length, {fmtDate(data.from, 'd MMM')} – {fmtDate(data.to, 'd MMM yyyy')} against the last 90 days.
                </p>
              )}

              <div className="mt-5 mb-1 text-xs font-medium text-ink-2">Deep into a ride</div>
              <table className="tnum w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                    <th className="py-1.5 font-medium">Best 20 min</th>
                    <th className="text-right font-medium">{name}</th>
                    <th className="text-right font-medium">Now</th>
                    <th className="text-right font-medium">Kept</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-line/60">
                    <td className="py-1.5">fresh</td>
                    <td className="text-right">{data.then[CURVE_DURATIONS.indexOf(1200)] ?? '–'}</td>
                    <td className="text-right">{data.now[CURVE_DURATIONS.indexOf(1200)] ?? '–'}</td>
                    <td className="text-right text-ink-2">{du?.fresh != null ? pct(du.fresh) : '–'}</td>
                  </tr>
                  {data.durability.kj.map((kj, i) => {
                    const a = data.durability.then[i];
                    const b = data.durability.now[i];
                    if (!a.value && !b.value) return null;
                    const ok = !!a.value && !!b.value && a.rides >= 3 && b.rides >= 3;
                    const rides = (n: number) => <span className="ml-1 text-[11px] text-muted">({n})</span>;
                    return (
                      <tr key={kj} className="border-b border-line/60 last:border-0">
                        <td className="py-1.5">after {fmtNum(kj)} kJ</td>
                        <td className="text-right">
                          {a.value ?? '–'}
                          {rides(a.rides)}
                        </td>
                        <td className="text-right">
                          {b.value ?? '–'}
                          {rides(b.rides)}
                        </td>
                        <td className={du?.worst?.kj === kj ? 'text-right font-semibold text-ink' : 'text-right text-ink-2'} title={ok ? undefined : 'Too few rides that deep to compare'}>
                          {ok ? pct(b.value! / a.value!) : '–'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-xs leading-relaxed text-muted">
                {du?.worst && du.fresh != null
                  ? du.worst.kept <= du.fresh - 0.06
                    ? `Late in a ride you're further from ${name} than fresh: ${pct(du.worst.kept)} after ${fmtNum(du.worst.kj)} kJ against ${pct(du.fresh)} fresh. Durability is usually the last thing to come back.`
                    : `Deep into a ride you've kept about as much as fresh (${pct(du.worst.kept)} after ${fmtNum(du.worst.kj)} kJ, ${pct(du.fresh)} fresh).`
                  : `Too few rides went that deep in one of the periods to compare.`}{' '}
                The best 20 minutes after that much work in a ride; in brackets, how many rides went that deep.
              </p>
            </>
          )}
        </div>
        <div className="min-w-0">
          <div className="mb-1 text-xs font-medium text-ink-2">Steady power at the same heart rate</div>
          {!hr ? (
            <Spinner />
          ) : !hrOption ? (
            <p className="py-10 text-center text-xs text-muted">No rides with both power and heart rate to compare.</p>
          ) : (
            <>
              <Chart option={hrOption} height={280} />
              <p className="mt-2 text-xs leading-relaxed text-muted">
                Each point is the median power of steady 10-minute stretches at that heart rate ({fmtDate(hr.thenRange[0], 'MMM yyyy')} – {fmtDate(hr.thenRange[1], 'MMM yyyy')}
                {widened ? `: heart rate was recorded on few rides around ${name}, so this looks as far after it as before` : ''} vs the last 4 months
                {hr.outdoorOnly ? ', outdoor rides only — indoors, heat raises heart rate' : ''}).{' '}
                {c?.ratio != null && c.shared.length >= 3
                  ? `Where both periods have data you make ${pct(c.ratio)} of the power you did then at the same heart rate${am ? ` — ${pct(am.ratio)} once heat, fatigue and indoor riding are taken out of both${am.ageBpm >= 1 ? `, ${pct(am.ageRatio)} allowing for the ${Math.round(am.ageBpm)} bpm heart rate falls with age` : ''}` : ''}. `
                  : `There's too little overlap to compare (${hr.thenRides} rides then, ${hr.nowRides} now). `}
                Heart rate stops rising near your limit, so the top of each line — how high it reaches — shows what you could sustain. This assumes both power meters read alike.
              </p>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
