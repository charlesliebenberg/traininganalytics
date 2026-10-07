import { useMemo } from 'react';
import { CURVE_DURATIONS } from '../../../shared/analytics/series';
import { Card, Spinner } from '../../components/ui';
import { CurveChart } from '../../components/charts';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { qs, useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { fmtDate, fmtDurLabel } from '../../lib/format';
import { peakName, type HrCompareResponse, type PeakCard } from './types';

const KEYS = [5, 60, 300, 1200, 3600];

/** Best power per duration (then vs the last 90 days), and steady power at the same heart rate. */
export function Gap({ peak, hr }: { peak: PeakCard; hr: HrCompareResponse | undefined }) {
  const t = useTokens();
  const name = peakName(peak);
  const { data } = useApi<{ durations: number[]; then: (number | null)[]; now: (number | null)[] }>(`/comeback/compare${qs({ date: peak.date })}`);
  const kept = KEYS.map((k) => {
    const i = CURVE_DURATIONS.indexOf(k);
    const a = data?.then[i] ?? null;
    const b = data?.now[i] ?? null;
    return { k, a, b, pct: a && b ? (b / a) * 100 : null };
  });
  const worst = kept.reduce<number | null>((m, x) => (x.pct != null && (m == null || x.pct < m) ? x.pct : m), null);

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
  return (
    <Card className="mt-4" title="Where the gap is" subtitle={`Around ${name} vs recently: your best power for each duration, and the power you hold at the same heart rate.`}>
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
                  { name: `6 months to ${name}`, color: t.muted, durations: CURVE_DURATIONS, values: data.then, width: 2 },
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
                  {kept.map((x) => (
                    <tr key={x.k} className="border-b border-line/60 last:border-0">
                      <td className="py-1.5">{fmtDurLabel(x.k)}</td>
                      <td className="text-right">{x.a ?? '–'}</td>
                      <td className="text-right">{x.b ?? '–'}</td>
                      <td className={x.pct != null && x.pct === worst ? 'text-right font-semibold text-ink' : 'text-right text-ink-2'}>{x.pct != null ? `${Math.round(x.pct)}%` : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
                Each point is the median power of steady 10-minute stretches at that heart rate ({fmtDate(hr.thenRange[0], 'MMM yyyy')} – {fmtDate(hr.thenRange[1], 'MMM yyyy')} vs the last 4 months
                {hr.outdoorOnly ? ', outdoor rides only — indoors, heat raises heart rate' : ''}).{' '}
                {c?.ratio != null && c.shared.length >= 3
                  ? `Where both periods have data you make ${Math.round(c.ratio * 100)}% of the power you did then at the same heart rate. `
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
