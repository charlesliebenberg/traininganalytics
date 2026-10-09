import { useMemo, useState } from 'react';
import { addDays, differenceInCalendarDays, parseISO, startOfWeek } from 'date-fns';
import type { PmcPoint, RaceEvent } from '../../shared/types';
import { monotonyStrain, formZone, dailyTssForCtl, acwr } from '../../shared/analytics/pmc';
import { qs, useApi } from '../lib/api';
import { useRange, resolvePreset } from '../lib/range';
import { useTokens, alpha } from '../lib/theme';
import { fmtDate, fmtNum, iso, SPORT_LABEL } from '../lib/format';
import { Card, Empty, Field, Input, PageHeader, Segmented, Select, Spinner, Stat, Toggle } from '../components/ui';
import { AerobicChart, outText, type AerobicSport, type AerobicTrendData } from '../components/insights';
import { RangePicker } from '../components/RangePicker';
import { FormLegend, PmcChart, formColor } from '../components/charts';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { gapsInDaily, makeTimeline, monthsText } from '../lib/timeline';

function RampChart({ points }: { points: PmcPoint[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const weekEnd = new Map<string, number>();
    for (const p of points.filter((p) => !p.projected)) weekEnd.set(iso(startOfWeek(parseISO(p.date), { weekStartsOn: 1 })), p.ctl);
    const entries = [...weekEnd.entries()];
    const rows = entries.slice(1).map(([w, ctl], i) => ({ w, ramp: ctl - entries[i][1] }));
    const color = (r: number) => (r > 8 ? t.critical : r > 5 ? t.warning : r >= 0 ? t.good : t.muted);
    return {
      animation: false,
      grid: { left: 36, right: 8, top: 12, bottom: 24 },
      tooltip: { trigger: 'axis' as const, ...tooltipStyle(t), formatter: (ps: any) => `<b>Week of ${fmtDate(rows[ps[0].dataIndex].w, 'd MMM yyyy')}</b>${tipRow(ps[0].color, 'CTL change', `${ps[0].value >= 0 ? '+' : ''}${ps[0].value.toFixed(1)}`)}` },
      xAxis: { type: 'category' as const, data: rows.map((r) => fmtDate(r.w, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t),
      series: [
        {
          type: 'bar' as const,
          barMaxWidth: 14,
          data: rows.map((r) => ({ value: Math.round(r.ramp * 10) / 10, itemStyle: { color: color(r.ramp), borderRadius: r.ramp >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })),
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 5 }, { yAxis: 8 }], lineStyle: { color: t.muted, type: 'solid' as const, width: 1 }, label: { color: t.muted, fontSize: 10, formatter: '{c}', position: 'insideEndTop' as const } },
        },
      ],
    };
  }, [points, t]);
  return <Chart option={option} height={220} />;
}

function MonotonyChart({ points }: { points: PmcPoint[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const actual = points.filter((p) => !p.projected);
    const ms = monotonyStrain(actual.map((p) => p.tss));
    // same squeezed timeline as the PMC: long breaks would otherwise fill the chart
    const gaps = gapsInDaily(actual, (p) => p.tss === 0);
    const tl = gaps.length ? makeTimeline(gaps) : null;
    const x = actual.map((p) => (tl ? tl.toX(parseISO(p.date).getTime()) : parseISO(p.date).getTime()));
    const span = x.length ? x[x.length - 1] - x[0] : 0;
    const label = (v: number) => (tl?.inBreak(v) ? '' : fmtDate(new Date(tl ? tl.fromX(v) : v), span > 300 * 86400_000 ? "MMM ''yy" : 'd MMM'));
    const bands = tl
      ? { markArea: { silent: true, itemStyle: { color: alpha(t.muted, 0.1) }, label: { show: false }, data: tl.breaks.map((g) => [{ xAxis: g.x0, name: `${monthsText(g.days)} off` }, { xAxis: g.x1 }]) } }
      : {};
    return {
      animation: false,
      grid: [
        { left: 44, right: 10, top: 22, height: 70 },
        { left: 44, right: 10, top: 130, height: 70 },
      ],
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis' as const,
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const i = ps[0].dataIndex;
          return `<b>${fmtDate(actual[i].date)}</b>${tipRow(t.series[3], 'Monotony', fmtNum(ms[i].monotony, 2))}${tipRow(t.series[4], 'Strain', fmtNum(ms[i].strain))}${tipRow(t.muted, '7-day TSS', fmtNum(ms[i].weekly))}`;
        },
      },
      xAxis: [0, 1].map((i) => ({ type: 'value' as const, gridIndex: i, min: x[0], max: x[x.length - 1], splitNumber: 4, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 1, color: t.muted, fontSize: 10, hideOverlap: true, formatter: label } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Monotony', nameLocation: 'end', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] }, max: (v: { max: number }) => Math.max(2.5, Math.ceil(v.max)) }),
        valueAxis(t, { gridIndex: 1, name: 'Strain', nameLocation: 'end', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] } }),
      ],
      series: [
        {
          type: 'line' as const,
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          data: x.map((v, i) => [v, ms[i].monotony]),
          lineStyle: { color: t.series[3], width: 1.5 },
          itemStyle: { color: t.series[3] },
          markLine: { symbol: 'none', silent: true, data: [{ yAxis: 2 }], lineStyle: { color: t.critical, type: 'solid' as const, width: 1 }, label: { color: t.muted, fontSize: 10, formatter: 'high', position: 'insideEndTop' as const } },
          ...bands,
        },
        { type: 'line' as const, xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, data: x.map((v, i) => [v, ms[i].strain]), lineStyle: { color: t.series[4], width: 1.5 }, itemStyle: { color: t.series[4] }, areaStyle: { color: alpha(t.series[4], 0.12) }, ...bands },
      ],
    };
  }, [points, t]);
  return <Chart option={option} height={230} />;
}

function LoadCalendar() {
  const t = useTokens();
  const to = iso(new Date());
  const from = iso(addDays(new Date(), -364));
  const { data } = useApi<{ date: string; tss: number }[]>(`/daily${qs({ from, to })}`);
  const option = useMemo(() => {
    if (!data) return null;
    const max = Math.max(150, ...data.map((d) => d.tss));
    return {
      animation: false,
      tooltip: { ...tooltipStyle(t), formatter: (p: any) => `<b>${fmtDate(p.value[0])}</b>${tipRow(t.accent, 'TSS', fmtNum(p.value[1]))}` },
      visualMap: { show: false, min: 0, max, inRange: { color: [t.surface2, alpha(t.accent, 0.35), t.accent] } },
      calendar: {
        range: [from, to],
        top: 24,
        left: 36,
        right: 8,
        cellSize: ['auto', 14],
        splitLine: { show: false },
        itemStyle: { borderColor: t.surface, borderWidth: 3, color: t.surface2 },
        dayLabel: { firstDay: 1, color: t.muted, fontSize: 10, nameMap: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] },
        monthLabel: { color: t.muted, fontSize: 10 },
        yearLabel: { show: false },
      },
      series: [{ type: 'heatmap' as const, coordinateSystem: 'calendar' as const, data: data.map((d) => [d.date, Math.round(d.tss)]) }],
    };
  }, [data, t, from, to]);
  if (!option) return <Spinner />;
  return <Chart option={option as any} height={150} />;
}

function GoalCalculator({ current }: { current: PmcPoint | undefined }) {
  const [target, setTarget] = useState(Math.round((current?.ctl ?? 40) + 15));
  const [date, setDate] = useState(iso(addDays(new Date(), 70)));
  const days = Math.max(1, differenceInCalendarDays(parseISO(date), new Date()));
  const ctl = current?.ctl ?? 0;
  const daily = dailyTssForCtl(ctl, target, days);
  const ramp = ((target - ctl) / days) * 7;
  const verdict = ramp > 8 ? { c: 'text-critical', t: 'Aggressive — injury/overtraining risk; consider a later date or lower target' } : ramp > 5 ? { c: 'text-ink', t: 'Challenging but achievable for experienced athletes' } : ramp > 0 ? { c: 'text-good-text', t: 'Sustainable progression' } : { c: 'text-ink-2', t: 'Maintenance or taper' };
  return (
    <Card title="Fitness goal calculator" subtitle="What sustained load reaches a target fitness by a date?">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Target CTL">
          <Input type="number" value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        </Field>
        <Field label="By date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
        <Stat label="Daily TSS" value={fmtNum(daily)} />
        <Stat label="Weekly TSS" value={fmtNum(daily * 7)} />
        <Stat label="Ramp" value={`${ramp >= 0 ? '+' : ''}${ramp.toFixed(1)}`} unit="/wk" />
      </div>
      <p className={`mt-3 text-xs ${verdict.c}`}>{verdict.t}</p>
      <p className="mt-1 text-[11px] text-muted">Assumes constant daily load; real plans oscillate (hard/easy days, recovery weeks) around this average.</p>
    </Card>
  );
}

/**
 * Measured aerobic fitness: what the heart rate says the training did, as opposed to CTL,
 * which counts the training.
 */
function AerobicFitnessCard() {
  const [sport, setSport] = useState<AerobicSport>('ride');
  const { data, isLoading } = useApi<AerobicTrendData | null>(`/aerobic${qs({ sport })}`);
  const m = data?.model;
  const ch = data?.change;
  return (
    <Card
      className="mt-4"
      title="Aerobic fitness"
      subtitle={
        m
          ? `What you hold at ${m.refHr} bpm, read from the steady stretches of every ${sport} with ${sport === 'ride' ? 'power and ' : ''}heart rate — under standard conditions (15 °C, outdoors, rested). CTL counts your training; this measures what it did. The line is fitness with its ±1 sd band; each dot is one ${sport}, which on its own is noisy.`
          : 'What your heart rate says about fitness, from steady riding and running.'
      }
      actions={<Segmented size="sm" value={sport} onChange={setSport} options={[{ value: 'ride', label: 'Ride' }, { value: 'run', label: 'Run' }]} />}
    >
      {isLoading ? (
        <Spinner />
      ) : !data || !m ? (
        <Empty title="Not enough steady data yet">
          This needs at least 8 {sport === 'ride' ? 'rides with power' : 'runs'} recorded with a heart-rate strap, each with 20 minutes or more of steady effort.
        </Empty>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Stat label={`At ${m.refHr} bpm`} value={outText(sport, data.current.value)} sub={`likely ${outText(sport, data.current.lo)}–${outText(sport, data.current.hi)}`} />
            <Stat
              label="12-week change"
              value={ch ? `${ch.pct >= 0 ? '+' : '−'}${Math.abs(ch.pct).toFixed(0)}%` : '–'}
              sub={ch ? `±${Math.max(1, Math.round(ch.sdPct))}% · since ${fmtDate(ch.from, 'd MMM')}` : 'needs 3+ weeks of data'}
              title={ch ? `From ${outText(sport, ch.fromValue)} on ${fmtDate(ch.from, 'd MMM yyyy')}` : undefined}
            />
            <Stat label="Heat" value={`${m.heat.toFixed(1)} bpm`} sub="more per °C, from you" title="How much each degree raises your heart rate at the same output, learned from your rides" />
            <Stat label="Fatigue" value={`${(m.fatigue * 10).toFixed(1)} bpm`} sub="less per 10 TSB below 0" title={`How much carried fatigue holds your heart rate down, learned from your data${m.indoor && sport === 'ride' ? `; indoors your heart rate reads ${Math.abs(m.indoor).toFixed(0)} bpm ${m.indoor < 0 ? 'lower' : 'higher'}` : ''}`} />
          </div>
          <AerobicChart sport={sport} points={data.points} height={300} />
        </>
      )}
    </Card>
  );
}

export function Fitness() {
  const t = useTokens();
  const { range } = useRange();
  const [localRange, setLocalRange] = useState(() => (['7d', '28d', '42d'].includes(range.preset) ? resolvePreset('180d') : range));
  const [sport, setSport] = useState('');
  const [projection, setProjection] = useState(true);
  const events = useApi<RaceEvent[]>('/events');
  const nextA = events.data?.find((e) => e.date >= iso(new Date()) && e.priority === 'A');
  const to = projection && localRange.to >= iso(new Date()) ? [iso(addDays(new Date(), 42)), nextA ? iso(addDays(parseISO(nextA.date), 7)) : ''].sort().pop()! : localRange.to;
  const { data: points, isLoading } = useApi<PmcPoint[]>(`/pmc${qs({ from: localRange.from, to, sport })}`);
  const todayStr = iso(new Date());
  const current = points?.filter((p) => p.date <= todayStr).pop();
  const zone = current ? formZone(current.tsb, current.ctl) : null;
  const ms = useMemo(() => (points ? monotonyStrain(points.filter((p) => !p.projected).map((p) => p.tss)).pop() : null), [points]);
  const visibleEvents = (events.data ?? []).filter((e) => points?.length && e.date >= points[0].date && e.date <= points[points.length - 1].date);

  return (
    <div>
      <PageHeader
        title="Fitness & Form"
        subtitle="Performance management: chronic load (fitness), acute load (fatigue) and training stress balance (form)"
        actions={
          <>
            <Toggle checked={projection} onChange={setProjection} label="Project planned training" />
            <Select value={sport} onChange={(e) => setSport(e.target.value)}>
              <option value="">All sports</option>
              {Object.entries(SPORT_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <RangePicker value={localRange} onChange={setLocalRange} presets={['90d', '180d', '365d', '730d', 'ytd', 'lastyear', 'all']} />
          </>
        }
      />
      <div className="card mb-4 grid grid-cols-2 gap-4 p-5 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="Fitness (CTL)" accent={t.ctl} value={fmtNum(current?.ctl, 1)} />
        <Stat label="Fatigue (ATL)" accent={t.atl} value={fmtNum(current?.atl, 1)} />
        <Stat label="Form (TSB)" accent={zone ? formColor(t, zone.id) : undefined} value={fmtNum(current?.tsb, 1)} sub={zone?.label} title={zone?.hint} />
        <Stat label="Ramp rate" value={`${current && current.ramp >= 0 ? '+' : ''}${fmtNum(current?.ramp, 1)}`} unit="CTL/wk" />
        <Stat label="ACWR" value={fmtNum(current ? acwr(current.atl, current.ctl) : null, 2)} sub="0.8–1.3 sweet spot" title="Acute:chronic workload ratio" />
        <Stat label="Monotony (7d)" value={fmtNum(ms?.monotony, 2)} sub="> 2 is risky" />
        <Stat label="Strain (7d)" value={fmtNum(ms?.strain)} />
      </div>
      <Card
        title="Performance management chart"
        subtitle={`Hover for daily values · scroll to zoom${
          points?.some((p) => p.projected)
            ? points.some((p) => p.projected && p.tss > 0)
              ? ' · dashed = projected from your planned workouts and season plan'
              : ' · dashed = what happens if you rest: nothing is planned yet'
            : ''
        }${points && gapsInDaily(points.filter((p) => !p.projected), (p) => p.tss === 0).length ? ' · breaks of 3+ months are squeezed' : ''}`}
        actions={<FormLegend />}
      >
        {isLoading || !points ? <Spinner /> : <PmcChart points={points} events={visibleEvents} height={520} />}
      </Card>
      <AerobicFitnessCard />
      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card title="Weekly ramp rate" subtitle="CTL gained per week — keep most weeks under 5–8">
          {points && <RampChart points={points.filter((p) => !p.projected).slice(-7 * 26)} />}
        </Card>
        <Card title="Monotony & strain" subtitle="Foster: low day-to-day variation plus high load predicts illness and overreaching">
          {points && <MonotonyChart points={points} />}
        </Card>
        <GoalCalculator current={current} />
      </div>
      <Card className="mt-4" title="Training load calendar" subtitle="Daily TSS over the last 12 months">
        <LoadCalendar />
      </Card>
    </div>
  );
}
