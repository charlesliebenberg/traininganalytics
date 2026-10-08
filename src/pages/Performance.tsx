import { useMemo, useState } from 'react';
import { addDays, differenceInCalendarDays, parseISO, subDays, subYears } from 'date-fns';
import type { Thresholds } from '../../shared/types';
import { CURVE_DURATIONS } from '../../shared/analytics/series';
import { ompd, POWER_PROFILE, PROFILE_LEVELS, profileLevel, type PdModel } from '../../shared/analytics/models';
import { qs, useApi } from '../lib/api';
import { resolvePreset, type DateRange } from '../lib/range';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtPaceSec, iso, paceSeconds, paceUnit } from '../lib/format';
import { Card, PageHeader, Segmented, Select, Spinner, Stat, Toggle } from '../components/ui';
import { RangePicker } from '../components/RangePicker';
import { CurveChart, type CurveSeries } from '../components/charts';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { BREAK_DAYS, breakNames, makeTimeline, type Gap } from '../lib/timeline';
import { Link, useNavigate } from 'react-router-dom';

type Kind = 'power' | 'np' | 'hr' | 'speed' | 'vam';
interface Agg {
  durations: number[];
  values: (number | null)[];
  activityIds: (number | null)[];
  dates: (string | null)[];
}

const KIND_LABEL: Record<Kind, string> = { power: 'Power', np: 'Normalized power', hr: 'Heart rate', speed: 'Pace', vam: 'Climbing (VAM)' };

function useCurve(kind: Kind | `fatigue:${number}`, r: { from: string; to: string } | null) {
  const sport = kind === 'speed' ? 'run' : kind === 'hr' || kind === 'vam' ? '' : 'ride';
  return useApi<Agg>(r ? `/curves${qs({ type: kind, from: r.from, to: r.to, sport })}` : null);
}

function compareRange(mode: string, r: DateRange): { from: string; to: string; label: string } | null {
  const days = differenceInCalendarDays(parseISO(r.to), parseISO(r.from)) + 1;
  switch (mode) {
    case 'previous':
      return { from: iso(subDays(parseISO(r.from), days)), to: iso(subDays(parseISO(r.from), 1)), label: 'Previous period' };
    case 'lastyear':
      return { from: iso(subYears(parseISO(r.from), 1)), to: iso(subYears(parseISO(r.to), 1)), label: 'Same period last year' };
    case 'all':
      return { from: '2000-01-01', to: iso(new Date()), label: 'All time' };
    default:
      return null;
  }
}

function ModelCard({ model, cp2, th, weight, basis }: { model: PdModel | null; cp2: { cp: number; wPrime: number; r2: number } | null; th: Thresholds; weight: number; basis: string | null }) {
  const t = useTokens();
  if (!model) return <Card title="Power-duration model">Not enough maximal efforts in this range to fit a model. Include some short sprints and 10–20 min efforts.</Card>;
  const diff = model.eftp - th.ftp;
  const auto = th.sources?.ftp === 'auto';
  const basisText = !auto ? 'set manually' : basis === '20min' ? 'auto · 95 % of your best 20 min' : basis === '60min' ? 'auto · your best hour' : 'auto · 3-point critical-power fit';
  return (
    <Card title="Power-duration model" subtitle="Omni-domain model (Puchowicz 2020) fitted to your curve's envelope">
      <div className="grid grid-cols-2 gap-4">
        <Stat label="Critical power (model)" accent={t.power} value={Math.round(model.eftp)} unit="W" sub={`${(model.eftp / weight).toFixed(2)} W/kg`} title="The model's maximal quasi-steady-state power" />
        <Stat label="60-min power" value={Math.round(model.p60)} unit="W" sub="modelled" title="Power the model predicts you can hold for one hour" />
        <Stat label="W′" value={(model.wPrime / 1000).toFixed(1)} unit="kJ" sub="anaerobic capacity" />
        <Stat label="Pmax" value={Math.round(model.pmax)} unit="W" sub={`${(model.pmax / weight).toFixed(1)} W/kg`} />
        <Stat label="Time to exhaustion" value={model.tte ? fmtDurLabel(model.tte) : '< 20m'} sub="longest effort at CP" />
        <Stat label="Fit error" value={`${(model.error * 100).toFixed(1)}%`} sub={cp2 ? `2-param CP ${Math.round(cp2.cp)} W` : undefined} />
      </div>
      <div className="mt-4 flex items-start justify-between gap-3 rounded-lg bg-surface-2 p-3 text-xs">
        <span className="text-ink-2">
          FTP in use <b className="text-ink">{th.ftp} W</b> ({basisText}) · the model's CP is {diff >= 0 ? '+' : ''}
          {Math.round(diff)} W. CP fitted to the whole curve usually sits a little above FTP, and further when your long efforts weren't all-out.
        </span>
        <Link to={auto ? '/thresholds' : '/settings'} className="shrink-0 text-accent hover:underline">
          {auto ? 'How FTP is set →' : 'Change FTP →'}
        </Link>
      </div>
    </Card>
  );
}

function ProfileCard({ curve, weight, ftp }: { curve: Agg | undefined; weight: number; ftp: number | null }) {
  const t = useTokens();
  if (!curve) return null;
  const rows = POWER_PROFILE.map((p) => {
    const watts = p.t === 3600 ? ftp : curve.values[CURVE_DURATIONS.indexOf(p.t)];
    const wkg = watts ? watts / weight : null;
    return { ...p, watts, wkg, lvl: wkg ? profileLevel(wkg, p.bands) : null };
  });
  const scored = rows.filter((r) => r.lvl);
  let type = '–';
  if (scored.length === 4) {
    const f = scored.map((r) => r.lvl!.fraction);
    const [s5, m1, m5, ftp] = f;
    const spread = Math.max(...f) - Math.min(...f);
    if (spread < 0.12) type = 'All-rounder';
    else if (s5 === Math.max(...f) || m1 === Math.max(...f)) type = s5 > ftp + 0.15 ? 'Sprinter' : 'Puncheur';
    else if (m5 === Math.max(...f)) type = 'Pursuiter / climber';
    else type = 'Time-trialist / diesel';
  }
  return (
    <Card title="Power profile" subtitle={`Coggan benchmarks in W/kg · ${weight} kg`} actions={<span className="text-xs text-ink-2">Profile: <b className="text-ink">{type}</b></span>}>
      <div className="space-y-3">
        {rows.map((r) => (
          <div key={r.label}>
            <div className="mb-1 flex items-baseline justify-between text-xs">
              <span className="font-medium">{r.label}</span>
              <span className="tnum text-ink-2">
                {r.wkg ? `${r.wkg.toFixed(2)} W/kg · ${Math.round(r.watts!)} W` : '–'} <span className="ml-1 text-ink">{r.lvl?.label}</span>
              </span>
            </div>
            <div className="relative flex h-2.5 gap-[2px]">
              {PROFILE_LEVELS.map((l, i) => (
                <div key={l} className="h-full flex-1 rounded-[2px]" style={{ background: r.lvl && i <= r.lvl.level ? t.power : t.surface3, opacity: r.lvl && i <= r.lvl.level ? 0.35 + (0.65 * i) / 7 : 1 }} title={`${l}: ≥ ${r.bands[i]} W/kg`} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[11px] text-muted">Levels: {PROFILE_LEVELS.join(' → ')}. FTP is the one your zones and TSS use.</p>
    </Card>
  );
}

function DurabilityCard({ range, fresh }: { range: { from: string; to: string }; fresh: Agg | undefined }) {
  const t = useTokens();
  const levels = [1000, 2000, 3000];
  const c1 = useCurve('fatigue:1000', range);
  const c2 = useCurve('fatigue:2000', range);
  const c3 = useCurve('fatigue:3000', range);
  const curves = [c1.data, c2.data, c3.data];
  if (!fresh) return null;
  const series: CurveSeries[] = [
    { name: 'Fresh', color: t.series[0], durations: CURVE_DURATIONS, values: fresh.values, width: 2.5 },
    ...levels.map((kj, i) => ({ name: `After ${kj / 1000}k kJ`, color: t.series[i + 1], durations: CURVE_DURATIONS, values: curves[i]?.values ?? [] })),
  ].filter((s) => s.values.some((v) => v != null));
  const at = (c: Agg | undefined, d: number) => c?.values[CURVE_DURATIONS.indexOf(d)] ?? null;
  const cols = [60, 300, 1200];
  return (
    <Card title="Durability · fatigue resistance" subtitle="Your best power after having already done N kilojoules of work. Flatter = more durable — decisive late in long races.">
      <CurveChart series={series} unit="W" minDuration={5} maxDuration={3600} height={280} />
      <table className="tnum mt-3 w-full text-xs">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 font-medium">Retention</th>
            {cols.map((c) => (
              <th key={c} className="text-right font-medium">
                {fmtDurLabel(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {levels.map((kj, i) => (
            <tr key={kj} className="border-t border-line">
              <td className="py-1.5 text-ink-2">after {kj} kJ</td>
              {cols.map((c) => {
                const f = at(fresh, c);
                const v = at(curves[i], c);
                return (
                  <td key={c} className="text-right">
                    {f && v ? `${Math.round((v / f) * 100)}%` : '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function PeaksTable({ kind }: { kind: Kind }) {
  const now = new Date();
  const periods = [
    { label: '7 days', from: iso(subDays(now, 6)) },
    { label: '28 days', from: iso(subDays(now, 27)) },
    { label: '90 days', from: iso(subDays(now, 89)) },
    { label: '12 months', from: iso(subDays(now, 364)) },
    { label: 'All time', from: '2000-01-01' },
  ];
  const to = iso(now);
  const q = [useCurve(kind, { from: periods[0].from, to }), useCurve(kind, { from: periods[1].from, to }), useCurve(kind, { from: periods[2].from, to }), useCurve(kind, { from: periods[3].from, to }), useCurve(kind, { from: periods[4].from, to })];
  const durs = kind === 'np' ? [60, 300, 600, 1200, 1800, 3600, 5400, 7200] : kind === 'vam' ? [300, 600, 1200, 1800, 3600] : [5, 15, 30, 60, 300, 600, 1200, 1800, 3600, 7200];
  const fmt = (v: number) => (kind === 'speed' ? fmtPaceSec(paceSeconds(v, 'run')) : `${Math.round(v)}`);
  const unit = kind === 'hr' ? 'bpm' : kind === 'speed' ? paceUnit('run') : kind === 'vam' ? 'm/h' : 'W';
  return (
    <Card title={`Peak ${KIND_LABEL[kind].toLowerCase()} by period`} subtitle={`Best ${unit} for each duration · click to open the activity`} pad={false}>
      <div className="overflow-x-auto">
        <table className="tnum w-full text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
              <th className="py-2 pl-5 font-medium">Duration</th>
              {periods.map((p) => (
                <th key={p.label} className="px-3 text-right font-medium last:pr-5">
                  {p.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {durs.map((d) => {
              const i = CURVE_DURATIONS.indexOf(d);
              const all = q[4].data?.values[i];
              return (
                <tr key={d} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 pl-5 font-medium">{fmtDurLabel(d)}</td>
                  {q.map((c, k) => {
                    const v = c.data?.values[i];
                    const id = c.data?.activityIds[i];
                    const isBest = v != null && all != null && v === all && k < 4;
                    return (
                      <td key={k} className="px-3 text-right last:pr-5">
                        {v != null && id ? (
                          <Link to={`/activities/${id}`} className={isBest ? 'font-semibold text-accent' : 'text-ink-2 hover:text-ink'} title={c.data?.dates[i] ? fmtDate(c.data.dates[i]!) : ''}>
                            {fmt(v)}
                          </Link>
                        ) : (
                          <span className="text-muted">–</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-5 py-3 text-[11px] text-muted">Highlighted values equal your all-time best.</p>
    </Card>
  );
}

type ModelPoint = { date: string; eftp: number; cp: number; wPrime: number; pmax: number; ftp: number };

function ModelHistory() {
  const t = useTokens();
  const { data } = useApi<ModelPoint[]>(`/model/history${qs({ from: iso(subDays(new Date(), 364)), to: iso(new Date()) })}`);
  const option = useMemo(() => {
    if (!data?.length) return null;
    // weeks without a model are weeks without riding: break the lines there, and squeeze
    // breaks of 3+ months like every other time chart
    const gaps: Gap[] = [];
    for (let i = 1; i < data.length; i++) {
      const days = differenceInCalendarDays(parseISO(data[i].date), parseISO(data[i - 1].date));
      if (days >= BREAK_DAYS) gaps.push({ from: iso(addDays(parseISO(data[i - 1].date), 1)), to: iso(subDays(parseISO(data[i].date), 1)), days: days - 1 });
    }
    const tl = makeTimeline(gaps);
    const x = data.map((d) => tl.toX(parseISO(d.date).getTime()));
    const line = (v: (d: ModelPoint) => number) => {
      const out: (number | null)[][] = [];
      data.forEach((d, i) => {
        if (i && differenceInCalendarDays(parseISO(d.date), parseISO(data[i - 1].date)) > 7) out.push([(x[i - 1] + x[i]) / 2, null]);
        out.push([x[i], v(d)]);
      });
      return out;
    };
    const byX = new Map(x.map((v, i) => [v, data[i]]));
    const grids = [
      { left: 48, right: 12, top: 34, height: 150 },
      { left: 48, right: 12, top: 222, height: 70 },
      { left: 48, right: 12, top: 330, height: 70 },
    ];
    return {
      animation: false,
      grid: grids,
      legend: { ...legendStyle(t), data: ['CP (model, 42 days)', 'FTP in use'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const d = byX.get(ps[0]?.value?.[0]);
          if (!d) return '';
          return `<b>${fmtDate(d.date)}</b><div style="opacity:.6;font-size:10px">42-day window</div>${tipRow(t.power, 'CP (model)', `${d.eftp} W`)}${tipRow(t.muted, 'FTP in use', `${d.ftp} W`)}${tipRow(t.series[2], "W′", `${(d.wPrime / 1000).toFixed(1)} kJ`)}${tipRow(t.series[1], 'Pmax', `${d.pmax} W`)}`;
        },
      },
      xAxis: grids.map((_, i) => ({ type: 'value', gridIndex: i, min: x[0], max: x[x.length - 1], ...axisStyle(t, { grid: false }), axisLabel: { show: i === 2, color: t.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(tl.fromX(v)), 'd MMM yy') } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, min: (v: { min: number }) => Math.floor((v.min - 10) / 10) * 10, name: 'W', nameTextStyle: { color: t.muted, fontSize: 10 } }),
        valueAxis(t, { gridIndex: 1, name: "W′ kJ", min: (v: { min: number }) => Math.floor(v.min / 1000) * 1000, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => (v / 1000).toFixed(0) }, nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] } }),
        valueAxis(t, { gridIndex: 2, name: 'Pmax W', min: (v: { min: number }) => Math.floor(v.min / 100) * 100, nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -36] } }),
      ],
      series: [
        {
          type: 'line',
          name: 'CP (model, 42 days)',
          xAxisIndex: 0,
          yAxisIndex: 0,
          showSymbol: false,
          smooth: 0.3,
          connectNulls: false,
          data: line((d) => d.eftp),
          lineStyle: { color: t.power, width: 2 },
          itemStyle: { color: t.power },
          markArea: tl.breaks.length
            ? {
                silent: true,
                itemStyle: { color: alpha(t.muted, 0.12) },
                label: { show: true, position: 'insideTop', color: t.muted, fontSize: 10, lineHeight: 13, formatter: (p: any) => p.name },
                data: tl.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]),
              }
            : undefined,
        },
        { type: 'line', name: 'FTP in use', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, step: 'end', connectNulls: false, data: line((d) => d.ftp), lineStyle: { color: t.muted, width: 1.5 }, itemStyle: { color: t.muted } },
        { type: 'line', name: "W′", xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, smooth: 0.3, connectNulls: false, data: line((d) => d.wPrime), lineStyle: { color: t.series[2], width: 1.5 }, itemStyle: { color: t.series[2] } },
        { type: 'line', name: 'Pmax', xAxisIndex: 2, yAxisIndex: 2, showSymbol: false, smooth: 0.3, connectNulls: false, data: line((d) => d.pmax), lineStyle: { color: t.series[1], width: 1.5 }, itemStyle: { color: t.series[1] } },
      ],
    };
  }, [data, t]);
  return (
    <Card title="Model history" subtitle="Critical power, W′ and Pmax fitted weekly on rolling 42-day windows, against the FTP in use">
      {option ? <Chart option={option} height={420} /> : <Spinner />}
    </Card>
  );
}

export function Performance() {
  const t = useTokens();
  const nav = useNavigate();
  const [range, setRange] = useState<DateRange>(() => resolvePreset('90d'));
  const [kind, setKind] = useState<Kind>('power');
  const [compare, setCompare] = useState('all');
  const [wkg, setWkg] = useState(false);
  const [showModel, setShowModel] = useState(true);
  const cmp = compareRange(compare, range);
  const main = useCurve(kind, range);
  const other = useCurve(kind, cmp);
  const modelQ = useApi<{ model: PdModel | null; cp2: { cp: number; wPrime: number; r2: number } | null; weight: number; ftp: number }>(`/model${qs({ from: range.from, to: range.to })}`);
  const th = useApi<{ current: Thresholds; ftpBasis: string | null }>('/thresholds');
  const weight = th.data?.current.weight ?? 70;
  const powerLike = kind === 'power' || kind === 'np';
  const scale = (v: (number | null)[]) => (wkg && powerLike ? v.map((x) => (x == null ? null : x / weight)) : v);
  const model = modelQ.data?.model ?? null;

  const series: CurveSeries[] = [];
  if (main.data) series.push({ name: range.label, color: t.series[0], durations: CURVE_DURATIONS, values: scale(main.data.values), meta: { ids: main.data.activityIds, dates: main.data.dates }, width: 2.5, area: true });
  if (other.data && cmp) series.push({ name: cmp.label, color: t.series[1], durations: CURVE_DURATIONS, values: scale(other.data.values), meta: { ids: other.data.activityIds, dates: other.data.dates } });
  if (showModel && model && kind === 'power') {
    const md = CURVE_DURATIONS.filter((d) => d <= 4 * 3600);
    series.push({ name: 'OmPD model', color: t.ink2, durations: md, values: scale(md.map((d) => ompd(d, model))), dashed: true, width: 1.5 });
  }
  const unit = kind === 'hr' ? 'bpm' : kind === 'speed' ? paceUnit('run') : kind === 'vam' ? 'm/h' : wkg ? 'W/kg' : 'W';
  const format = kind === 'speed' ? (v: number) => fmtPaceSec(paceSeconds(v, 'run')) : wkg && powerLike ? (v: number) => v.toFixed(2) : (v: number) => `${Math.round(v)}`;
  const minD = kind === 'np' ? 30 : kind === 'vam' ? 60 : 1;

  return (
    <div>
      <PageHeader
        title="Power & Performance"
        subtitle="Mean-maximal curves, normalized-power curve, power-duration modelling and durability"
        actions={
          <>
            <Select value={compare} onChange={(e) => setCompare(e.target.value)}>
              <option value="none">No comparison</option>
              <option value="previous">vs previous period</option>
              <option value="lastyear">vs same period last year</option>
              <option value="all">vs all time</option>
            </Select>
            <RangePicker value={range} onChange={setRange} />
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card
          title={`${KIND_LABEL[kind]} curve`}
          subtitle={
            kind === 'np'
              ? 'Highest normalized power sustained for each duration — captures the true cost of variable, surging efforts that mean-max power hides'
              : kind === 'vam'
                ? 'Best vertical ascent rate for each duration'
                : 'Best average for every duration. Click a point to open the activity.'
          }
          actions={
            <>
              {powerLike && <Toggle checked={wkg} onChange={setWkg} label="W/kg" />}
              {kind === 'power' && <Toggle checked={showModel} onChange={setShowModel} label="Model" />}
              <Segmented
                size="sm"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'power', label: 'Power' },
                  { value: 'np', label: 'NP' },
                  { value: 'hr', label: 'HR' },
                  { value: 'speed', label: 'Pace' },
                  { value: 'vam', label: 'VAM' },
                ]}
              />
            </>
          }
        >
          {main.isLoading ? (
            <Spinner />
          ) : (
            <CurveChart
              series={series}
              unit={unit}
              format={format}
              minDuration={minD}
              height={440}
              onPointClick={(si, di) => {
                const id = series[si].meta?.ids?.[di];
                if (id) nav(`/activities/${id}`);
              }}
            />
          )}
        </Card>
        <div className="flex flex-col gap-4">
          {kind === 'power' || kind === 'np' ? (
            th.data && <ModelCard model={model} cp2={modelQ.data?.cp2 ?? null} th={th.data.current} weight={weight} basis={th.data.ftpBasis} />
          ) : (
            <Card title="About this curve">
              <p className="text-xs leading-relaxed text-ink-2">
                {kind === 'hr' && 'Mean-maximal heart rate shows the highest sustained HR for each duration — useful to validate max HR and LTHR (≈ best 20–60 min HR in a hard effort).'}
                {kind === 'speed' && 'Your best running pace for every duration — the running equivalent of a power curve. Use the Records page for best times over standard distances.'}
                {kind === 'vam' && 'VAM (velocità ascensionale media) is metres climbed per hour. Values over 1,000 m/h on long climbs indicate strong climbing ability.'}
              </p>
            </Card>
          )}
          {kind === 'power' && <ProfileCard curve={main.data} weight={weight} ftp={th.data?.current.ftp ?? null} />}
        </div>
      </div>
      {kind === 'power' && (
        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <DurabilityCard range={range} fresh={main.data} />
          <ModelHistory />
        </div>
      )}
      <div className="mt-4">
        <PeaksTable kind={kind} />
      </div>
    </div>
  );
}
