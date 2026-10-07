import { useMemo } from 'react';
import { Card, Spinner } from '../../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate, fmtNum } from '../../lib/format';
import { monthSummary, peakName, type Months, type MonthRow, type PeakCard } from './types';

const GROUPS = ['Z1–2 endurance', 'Z3 tempo', 'Z4 threshold', 'Z5+ VO2max & above', 'No power data'];

/**
 * The year before a peak next to the comeback so far, month by month: hours per week split
 * by intensity, on one shared scale.
 */
export function Year({ peak, months }: { peak: PeakCard; months: Months | undefined }) {
  const t = useTokens();
  const name = peakName(peak);
  const option = useMemo(() => {
    if (!months) return null;
    // one hue, light → dark with intensity (validated for contrast in both themes), grey for unknown
    const colors = [...[0, 1, 2, 3].map((i) => alpha(t.power, 0.46 + (0.54 * i) / 3)), alpha(t.muted, 0.35)];
    const max = Math.max(1, ...[...months.then, ...months.now].map((m) => m.zones.reduce((s, x) => s + x, 0)));
    const panels = [
      { rows: months.then, title: `12 months to ${name}` },
      { rows: months.now, title: months.comebackStart ? 'Your comeback so far' : 'Your last 12 months' },
    ];
    // split the width by month count so bars are the same size on both sides
    const total = panels[0].rows.length + panels[1].rows.length || 1;
    const split = 4 + (92 * panels[0].rows.length) / total;
    const grids = [
      { left: 44, right: `${100 - split + 2}%`, top: 60, bottom: 28 },
      { left: `${split + 2}%`, right: 12, top: 60, bottom: 28 },
    ];
    const tip = (r: MonthRow) => {
      const z = r.zones;
      return `<b>${fmtDate(`${r.month}-01`, 'MMMM yyyy')}</b>${GROUPS.map((g, i) => (z[i] >= 0.05 ? tipRow(colors[i], g, `${z[i].toFixed(1)} h/wk`) : '')).join('')}${tipRow('transparent', 'Total', `${r.hoursPerWeek.toFixed(1)} h/wk`)}${tipRow('transparent', 'TSS', `${fmtNum(r.tssPerWeek)}/wk`)}${r.races ? tipRow('transparent', 'Races', String(r.races)) : ''}${r.longRides ? tipRow('transparent', 'Rides of 3 h+', String(r.longRides)) : ''}`;
    };
    return {
      animation: false,
      grid: grids,
      legend: { ...legendStyle(t), data: GROUPS },
      title: panels.map((p, i) => ({ text: p.title, left: i === 0 ? 44 : `${split + 2}%`, top: 30, textStyle: { color: t.ink2, fontSize: 12, fontWeight: 500 } })),
      tooltip: { trigger: 'axis', ...tooltipStyle(t), axisPointer: { type: 'shadow', shadowStyle: { color: alpha(t.muted, 0.08) } }, formatter: (ps: any) => tip(panels[ps[0].axisIndex].rows[ps[0].dataIndex]) },
      xAxis: panels.map((p, i) => ({ type: 'category', gridIndex: i, data: p.rows.map((r) => fmtDate(`${r.month}-01`, 'MMM yy')), ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } })),
      yAxis: panels.map((_, i) => valueAxis(t, { gridIndex: i, max: Math.ceil(max / 5) * 5, interval: 5, axisLabel: { show: i === 0, color: t.muted, fontSize: 11 } })),
      series: panels.flatMap((p, i) =>
        GROUPS.map((g, z) => ({
          type: 'bar',
          name: g,
          stack: `p${i}`,
          xAxisIndex: i,
          yAxisIndex: i,
          barMaxWidth: 24,
          data: p.rows.map((r) => Math.round(r.zones[z] * 100) / 100),
          itemStyle: { color: colors[z], borderColor: t.surface, borderWidth: 1 },
        })),
      ),
    };
  }, [months, name, t]);

  const cols = months
    ? [
        { head: `Year before ${name}`, s: monthSummary(months.then), strong: false },
        { head: '3 months before', s: monthSummary(months.then.slice(-3)), strong: false },
        { head: months.comebackStart ? 'Comeback so far' : 'Last 12 months', s: monthSummary(months.now), strong: true },
        { head: 'Last 3 months', s: monthSummary(months.now.slice(-3)), strong: true },
      ]
    : [];
  const rows: { label: string; get: (s: (typeof cols)[number]['s']) => string }[] = [
    { label: 'Hours / week', get: (s) => s.hours.toFixed(1) },
    { label: 'TSS / week', get: (s) => fmtNum(s.tss) },
    { label: 'Hours at threshold and above (Z4+) / week', get: (s) => s.z4plus.toFixed(1) },
    { label: 'Share of riding at tempo (Z3)', get: (s) => `${Math.round(s.z3share * 100)}%` },
    { label: 'Share at VO2max and above (Z5+)', get: (s) => `${Math.round(s.z5share * 100)}%` },
    { label: 'Rides of 3 h+ / week', get: (s) => s.longRidesPerWeek.toFixed(1) },
    { label: 'Races / month', get: (s) => s.racesPerMonth.toFixed(1) },
  ];
  return (
    <Card className="mt-4" title={`The year before ${name}`} subtitle="Hours per week by intensity, month by month, next to your recent months on the same scale. Zones are relative to your FTP at the time.">
      {!option || !months ? (
        <Spinner />
      ) : (
        <>
          <Chart option={option} height={300} />
          <div className="mt-4 overflow-x-auto">
            <table className="tnum w-full min-w-[560px] text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                  <th className="py-2 font-medium" />
                  {cols.map((c) => (
                    <th key={c.head} className="px-3 text-right font-medium whitespace-nowrap">
                      {c.head}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label} className="border-b border-line/60 last:border-0">
                    <td className="py-1.5 pr-2">{r.label}</td>
                    {cols.map((c) => (
                      <td key={c.head} className={c.strong ? 'px-3 text-right font-medium text-ink' : 'px-3 text-right text-ink-2'}>
                        {r.get(c.s)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}
