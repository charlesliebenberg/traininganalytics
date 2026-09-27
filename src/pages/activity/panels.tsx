import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { ActivityCurves, Lap, Sport, Streams, Thresholds } from '../../../shared/types';
import { CURVE_DURATIONS, bestWindow, fillGaps, rollingMean, toFloat } from '../../../shared/analytics/series';
import { detectIntervals, powerHistogram, quadrantPoint, wPrimeBalance } from '../../../shared/analytics/power';
import { efficiencySeries } from '../../../shared/analytics/heartrate';
import { rangeStats } from '../../../shared/analytics/range';
import { splits, gradeAdjustedSpeed, BEST_EFFORT_DISTANCES } from '../../../shared/analytics/running';
import { HR_ZONES, PACE_ZONES, POWER_ZONES, zoneBounds, zoneIndex } from '../../../shared/analytics/zones';
import { Card, Segmented, Stat, Tabs, Toggle } from '../../components/ui';
import { CurveChart, ZoneBars, type CurveSeries } from '../../components/charts';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { alpha, useTokens } from '../../lib/theme';
import { qs, useApi } from '../../lib/api';
import { fmtDistance, fmtDuration, fmtElevation, fmtNum, fmtPace, fmtPaceSec, fmtSpeed, iso, paceSeconds, paceUnit } from '../../lib/format';
import { isPaceSport } from './StreamsChart';
import { subDays, parseISO } from 'date-fns';

// ---------- selection / range stats ----------
export function SelectionStats({ streams, range, sport, th, onClear, onZoom }: { streams: Streams; range: [number, number]; sport: Sport; th: Thresholds; onClear: () => void; onZoom: () => void }) {
  const st = useMemo(() => rangeStats(streams, range[0], range[1]), [streams, range]);
  const wbal = useMemo(() => {
    if (!streams.watts || !th.ftp) return null;
    const wb = wPrimeBalance(streams.watts, th.ftp, th.wPrime);
    let min = Infinity;
    for (let i = range[0]; i < range[1]; i++) min = Math.min(min, wb[i]);
    return { start: wb[range[0]], min };
  }, [streams, range, th]);
  const work = streams.watts ? streams.watts.slice(range[0], range[1]).reduce((a, b) => a + (b ?? 0), 0) / 1000 : null;
  const pace = isPaceSport(sport);
  return (
    <div className="rounded-xl border border-line bg-surface-2 p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold">
          Selection · {fmtDuration(range[0])} → {fmtDuration(range[1])}
        </div>
        <div className="flex gap-2">
          <button onClick={onZoom} className="text-xs text-accent hover:underline">
            Zoom
          </button>
          <button onClick={onClear} className="text-xs text-muted hover:text-ink">
            Clear
          </button>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Duration" value={<span className="text-base">{fmtDuration(st.duration)}</span>} />
        <Stat label="Distance" value={<span className="text-base">{st.distance ? fmtDistance(st.distance, 2, sport) : '–'}</span>} />
        <Stat label={pace ? 'Pace' : 'Speed'} value={<span className="text-base">{pace ? fmtPace(st.avgSpeed, sport, false) : fmtSpeed(st.avgSpeed)}</span>} />
        {st.avgPower != null && <Stat label="Avg power" value={<span className="text-base">{fmtNum(st.avgPower)} W</span>} sub={th.ftp ? `${Math.round((st.avgPower / th.ftp) * 100)}% FTP` : undefined} />}
        {st.np != null && <Stat label="NP" value={<span className="text-base">{fmtNum(st.np)} W</span>} sub={th.ftp ? `IF ${(st.np / th.ftp).toFixed(2)}` : undefined} />}
        {work != null && <Stat label="Work" value={<span className="text-base">{fmtNum(work)} kJ</span>} sub={`${fmtNum((st.avgPower ?? 0) / th.weight, 2)} W/kg`} />}
        {st.avgHr != null && <Stat label="Avg HR" value={<span className="text-base">{fmtNum(st.avgHr)}</span>} sub={`max ${fmtNum(st.maxHr)}`} />}
        {st.avgCadence != null && <Stat label="Cadence" value={<span className="text-base">{fmtNum(sport === 'run' ? st.avgCadence * 2 : st.avgCadence)}</span>} />}
        {st.elevationGain != null && <Stat label="Elev gain" value={<span className="text-base">{fmtElevation(st.elevationGain)}</span>} />}
        {wbal && <Stat label="W′ min" value={<span className="text-base">{(wbal.min / 1000).toFixed(1)} kJ</span>} sub={`${Math.round((1 - wbal.min / th.wPrime) * 100)}% used`} />}
        {st.np && st.avgHr ? <Stat label="Pw:HR" value={<span className="text-base">{(st.np / st.avgHr).toFixed(2)}</span>} /> : null}
      </div>
    </div>
  );
}

// ---------- laps / intervals / splits ----------
type SegTab = 'laps' | 'intervals' | 'splits';

export function SegmentsCard({ streams, laps, sport, th, onHover, onPick, active }: { streams: Streams; laps: Lap[] | null; sport: Sport; th: Thresholds; onHover: (r: [number, number] | null) => void; onPick: (r: [number, number]) => void; active: [number, number] | null }) {
  const pace = isPaceSport(sport);
  const intervals = useMemo(() => {
    const r30 = streams.watts ? rollingMean(toFloat(streams.watts), 30) : undefined;
    const src = streams.watts && th.ftp ? detectIntervals(streams.watts, th.ftp) : streams.speed && pace ? detectIntervals(streams.speed, th.runThresholdSpeed) : [];
    return src.map((iv, i) => ({ ...rangeStats(streams, iv.start, iv.end, r30), name: `Interval ${i + 1}` }));
  }, [streams, th, pace]);
  const splitRows = useMemo(() => {
    if (!streams.distance) return [];
    const unit = sport === 'ride' ? 5000 : 1000;
    const gap = streams.speed && streams.grade ? gradeAdjustedSpeed(streams.speed, streams.grade) : null;
    return splits({ distance: streams.distance, heartrate: streams.heartrate, altitude: streams.altitude, gap, watts: streams.watts, cadence: streams.cadence }, unit);
  }, [streams, sport]);
  const tabs: { value: SegTab; label: string }[] = [
    ...(laps?.length ? [{ value: 'laps' as const, label: `Laps (${laps.length})` }] : []),
    { value: 'intervals', label: `Detected intervals (${intervals.length})` },
    ...(splitRows.length ? [{ value: 'splits' as const, label: `Splits (${splitRows.length})` }] : []),
  ];
  const [tab, setTab] = useState<SegTab>(tabs[0].value);
  const rows: Lap[] =
    tab === 'laps'
      ? laps ?? []
      : tab === 'intervals'
        ? intervals
        : splitRows.map((s) => ({ name: `${s.index}`, start: s.start, duration: s.time, distance: s.distance, avgPower: s.avgPower, np: null, avgHr: s.avgHr, maxHr: null, avgCadence: s.avgCadence, avgSpeed: s.speed, elevationGain: s.elevation }));
  const hasPower = rows.some((r) => r.avgPower);
  const maxSpeed = Math.max(...rows.map((r) => r.avgSpeed ?? 0), 0.1);
  return (
    <Card pad={false}>
      <div className="px-5 pt-2">
        <Tabs value={tab} onChange={setTab} tabs={tabs} />
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-8 text-center text-xs text-muted">{tab === 'intervals' ? 'No sustained efforts above ~88% of threshold detected.' : 'Nothing to show.'}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="tnum w-full min-w-[760px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="py-2 pr-3 pl-5 font-medium">{tab === 'splits' ? (sport === 'ride' ? '5 km' : distUnitLabel()) : '#'}</th>
                <th className="px-3 font-medium">Start</th>
                <th className="px-3 text-right font-medium">Time</th>
                <th className="px-3 text-right font-medium">Distance</th>
                {hasPower && <th className="px-3 text-right font-medium">Avg W</th>}
                {hasPower && <th className="px-3 text-right font-medium">NP</th>}
                {hasPower && <th className="px-3 text-right font-medium">% FTP</th>}
                <th className="px-3 text-right font-medium">Avg HR</th>
                <th className="px-3 text-right font-medium">Cadence</th>
                <th className="px-3 font-medium">{pace ? 'Pace' : 'Speed'}</th>
                <th className="py-2 pr-5 pl-3 text-right font-medium">Elev</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const range: [number, number] = [r.start, r.start + r.duration];
                const isActive = active && active[0] === range[0] && active[1] === range[1];
                return (
                  <tr
                    key={i}
                    className={clsx('cursor-pointer border-b border-line/60 last:border-0', isActive ? 'bg-accent-soft' : 'hover:bg-surface-2')}
                    onMouseEnter={() => onHover(range)}
                    onMouseLeave={() => onHover(null)}
                    onClick={() => onPick(range)}
                  >
                    <td className="py-1.5 pr-3 pl-5 font-medium">{r.name || i + 1}</td>
                    <td className="px-3 text-ink-2">{fmtDuration(r.start)}</td>
                    <td className="px-3 text-right">{fmtDuration(r.duration)}</td>
                    <td className="px-3 text-right text-ink-2">{r.distance ? fmtDistance(r.distance, 2, sport) : '–'}</td>
                    {hasPower && <td className="px-3 text-right font-medium">{fmtNum(r.avgPower)}</td>}
                    {hasPower && <td className="px-3 text-right">{fmtNum(r.np)}</td>}
                    {hasPower && <td className="px-3 text-right text-ink-2">{r.avgPower && th.ftp ? `${Math.round(((r.np ?? r.avgPower) / th.ftp) * 100)}%` : '–'}</td>}
                    <td className="px-3 text-right">{fmtNum(r.avgHr)}</td>
                    <td className="px-3 text-right text-ink-2">{r.avgCadence ? fmtNum(sport === 'run' ? r.avgCadence * 2 : r.avgCadence) : '–'}</td>
                    <td className="px-3">
                      <div className="flex items-center gap-2">
                        <span className="w-20 whitespace-nowrap">{pace ? fmtPace(r.avgSpeed, sport, false) : fmtSpeed(r.avgSpeed)}</span>
                        <div className="h-1.5 w-20 rounded-full bg-surface-3">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${((r.avgSpeed ?? 0) / maxSpeed) * 100}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="py-1.5 pr-5 pl-3 text-right text-ink-2">{r.elevationGain != null ? fmtElevation(r.elevationGain) : '–'}</td>
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
const distUnitLabel = () => (paceUnit().includes('km') ? 'km' : 'mile');

// ---------- zones ----------
export function ZonesCard({ zones, th, sport }: { zones: NonNullable<import('../../../shared/types').Activity['zones']>; th: Thresholds; sport: Sport }) {
  const t = useTokens();
  const lthr = sport === 'run' ? th.runLthr : th.lthr;
  const sections: { title: string; body: React.ReactNode }[] = [];
  if (zones.power) {
    const b = zoneBounds(th.ftp, POWER_ZONES);
    sections.push({ title: `Power · FTP ${th.ftp} W`, body: <ZoneBars seconds={zones.power} labels={POWER_ZONES.map((z) => z.id)} names={POWER_ZONES.map((z) => z.name)} ranges={b.map((x) => `${x.name} · ${Math.round(x.low)}–${Number.isFinite(x.high) ? Math.round(x.high) : '∞'} W`)} color={t.power} /> });
  }
  if (zones.pace) {
    const b = zoneBounds(th.runThresholdSpeed, PACE_ZONES);
    sections.push({
      title: `Grade-adjusted pace · threshold ${fmtPace(th.runThresholdSpeed, 'run')}`,
      body: (
        <ZoneBars
          seconds={zones.pace}
          labels={PACE_ZONES.map((z) => z.id)}
          names={PACE_ZONES.map((z) => z.name)}
          ranges={b.map((x) => `${x.name} · ${x.low ? fmtPaceSec(paceSeconds(x.low)) : '∞'}–${Number.isFinite(x.high) ? fmtPaceSec(paceSeconds(x.high)) : 'max'}`)}
          color={t.speed}
        />
      ),
    });
  }
  if (zones.hr) {
    const b = zoneBounds(lthr, HR_ZONES);
    sections.push({ title: `Heart rate · LTHR ${lthr} bpm`, body: <ZoneBars seconds={zones.hr} labels={HR_ZONES.map((z) => z.id)} names={HR_ZONES.map((z) => z.name)} ranges={b.map((x) => `${x.name} · ${Math.round(x.low)}–${Number.isFinite(x.high) ? Math.round(x.high) : '∞'} bpm`)} color={t.hr} /> });
  }
  if (!sections.length) return null;
  return (
    <Card title="Time in zones">
      <div className="space-y-5">
        {sections.map((sec) => (
          <div key={sec.title}>
            <div className="mb-2 text-xs font-medium text-ink-2">{sec.title}</div>
            {sec.body}
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- mean-max curve for the activity vs history ----------
type CurveKind = 'power' | 'np' | 'hr' | 'speed' | 'vam';

export function ActivityCurveCard({ curves, date, th, sport, onPick }: { curves: ActivityCurves; date: string; th: Thresholds; sport: Sport; onPick: (d: number) => void }) {
  const t = useTokens();
  const kinds = (['power', 'np', 'hr', 'speed', 'vam'] as CurveKind[]).filter((k) => curves[k]?.some((v) => v != null));
  const [kind, setKind] = useState<CurveKind>(kinds[0] ?? 'power');
  const [wkg, setWkg] = useState(false);
  const from90 = iso(subDays(parseISO(date), 90));
  const curveSport = kind === 'speed' ? 'run' : kind === 'hr' || kind === 'vam' ? sport : 'ride';
  const d90 = useApi<{ values: (number | null)[]; dates: (string | null)[] }>(`/curves${qs({ type: kind, from: from90, to: date, sport: curveSport })}`);
  const all = useApi<{ values: (number | null)[]; dates: (string | null)[] }>(`/curves${qs({ type: kind, from: '2000-01-01', to: '2100-01-01', sport: curveSport })}`);
  if (!kinds.length) return null;
  const isPower = kind === 'power' || kind === 'np';
  const scale = (v: (number | null)[]) => (wkg && isPower ? v.map((x) => (x == null ? null : x / th.weight)) : v);
  const series: CurveSeries[] = [
    { name: 'This activity', color: t.series[0], durations: CURVE_DURATIONS, values: scale(curves[kind]!), width: 2.5 },
    ...(d90.data ? [{ name: '90-day best', color: t.series[1], durations: CURVE_DURATIONS, values: scale(d90.data.values), meta: { dates: d90.data.dates }, width: 1.5 }] : []),
    ...(all.data ? [{ name: 'All-time best', color: t.series[2], durations: CURVE_DURATIONS, values: scale(all.data.values), meta: { dates: all.data.dates }, width: 1.5 }] : []),
  ];
  const unit = kind === 'hr' ? 'bpm' : kind === 'speed' ? paceUnit(sport) : kind === 'vam' ? 'm/h' : wkg ? 'W/kg' : 'W';
  const format = kind === 'speed' ? (v: number) => fmtPaceSec(paceSeconds(v, sport)) : wkg && isPower ? (v: number) => v.toFixed(2) : (v: number) => `${Math.round(v)}`;
  const labels: Record<CurveKind, string> = { power: 'Power', np: 'NP', hr: 'Heart rate', speed: 'Pace', vam: 'VAM' };
  const minD = kind === 'np' ? 30 : kind === 'vam' ? 60 : 1;
  return (
    <Card
      title="Mean-maximal curves"
      subtitle={kind === 'np' ? 'Best normalized power for every duration — rewards surging, variable efforts' : 'Best effort for every duration vs your history. Click a point to find it in the ride.'}
      actions={
        <>
          {isPower && <Toggle checked={wkg} onChange={setWkg} label="W/kg" />}
          <Segmented size="sm" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: labels[k] }))} />
        </>
      }
    >
      <CurveChart series={series} unit={unit} format={format} minDuration={minD} invert={false} onPointClick={(si, di) => si === 0 && (kind === 'power' || kind === 'hr' || kind === 'speed') && onPick(CURVE_DURATIONS[di])} height={300} />
    </Card>
  );
}

/** Find the best window of a given duration in the activity. */
export function findBest(streams: Streams, key: 'watts' | 'heartrate' | 'speed', d: number): [number, number] | null {
  const v = key === 'heartrate' ? fillGaps(streams.heartrate ?? []) : streams[key] ? toFloat(streams[key]!) : null;
  if (!v) return null;
  const b = bestWindow(v, d);
  return b ? [b.start, b.start + d] : null;
}

// ---------- power distribution ----------
export function DistributionCard({ streams, th }: { streams: Streams; th: Thresholds }) {
  const t = useTokens();
  const option = useMemo(() => {
    const bin = th.ftp > 300 ? 25 : 20;
    const h = powerHistogram(streams.watts!, bin, streams.moving).filter((b) => b.bin <= th.ftp * 2.2);
    const zc = (w: number) => alpha(t.power, 0.35 + (0.65 * zoneIndex(w / th.ftp, POWER_ZONES)) / (POWER_ZONES.length - 1));
    return {
      animation: false,
      grid: { left: 44, right: 10, top: 16, bottom: 30 },
      tooltip: { trigger: 'axis' as const, ...tooltipStyle(t), formatter: (ps: any) => { const p = ps[0]; return `<b>${p.name}–${Number(p.name) + bin} W</b>${tipRow(p.color, 'Time', fmtDuration(p.value))}`; } },
      xAxis: { type: 'category' as const, data: h.map((b) => String(b.bin)), ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, interval: Math.ceil(h.length / 10) } },
      yAxis: valueAxis(t, { axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => fmtDuration(v, { short: true }) } }),
      series: [{ type: 'bar' as const, barCategoryGap: '8%', data: h.map((b) => ({ value: b.seconds, itemStyle: { color: zc(b.bin + bin / 2), borderRadius: [2, 2, 0, 0] } })) }],
    };
  }, [streams, th, t]);
  return (
    <Card title="Power distribution" subtitle="Moving time in each power bin, shaded by zone">
      <Chart option={option} height={240} />
    </Card>
  );
}

// ---------- quadrant analysis ----------
export function QuadrantCard({ streams, th, crank }: { streams: Streams; th: Thresholds; crank: number }) {
  const t = useTokens();
  const { option, quads } = useMemo(() => {
    const w = streams.watts!;
    const c = streams.cadence!;
    const pts: [number, number][] = [];
    let cadSum = 0,
      cadN = 0;
    for (let i = 0; i < w.length; i++) {
      const cc = c[i];
      if (!cc || cc < 20 || !w[i]) continue;
      cadSum += cc;
      cadN++;
    }
    const avgCad = cadN ? cadSum / cadN : 90;
    const ref = quadrantPoint(th.ftp, avgCad, crank);
    const q = [0, 0, 0, 0];
    const step = Math.max(1, Math.floor(w.length / 6000));
    for (let i = 0; i < w.length; i++) {
      const cc = c[i];
      if (!cc || cc < 20 || !w[i]) continue;
      const p = quadrantPoint(w[i], cc, crank);
      const hiF = p.aepf >= ref.aepf;
      const hiV = p.cpv >= ref.cpv;
      q[hiF && hiV ? 0 : hiF ? 1 : !hiV ? 2 : 3]++;
      if (i % step === 0) pts.push([p.cpv, p.aepf]);
    }
    const total = q.reduce((a, b) => a + b, 0) || 1;
    // FTP isopower curve: AEPF = FTP / CPV
    const iso: [number, number][] = [];
    for (let v = 0.6; v <= 2.4; v += 0.05) iso.push([v, th.ftp / v]);
    return {
      quads: q.map((x) => x / total),
      option: {
        animation: false,
        grid: { left: 48, right: 12, top: 14, bottom: 40 },
        tooltip: { ...tooltipStyle(t), formatter: (p: any) => (p.seriesIndex === 0 ? `CPV ${p.value[0].toFixed(2)} m/s<br/>AEPF ${Math.round(p.value[1])} N` : 'FTP isopower') },
        xAxis: { type: 'value' as const, name: 'Circumferential pedal velocity (m/s)', nameLocation: 'middle' as const, nameGap: 26, min: 0.4, max: 2.4, ...axisStyle(t) },
        yAxis: valueAxis(t, { name: 'Pedal force (N)', min: 0, max: (v: { max: number }) => Math.ceil(Math.min(v.max, th.ftp * 3) / 100) * 100, nameTextStyle: { color: t.muted, fontSize: 10 } }),
        series: [
          {
            type: 'scatter' as const,
            symbolSize: 3,
            large: true,
            itemStyle: { color: alpha(t.power, 0.35) },
            data: pts,
            markLine: {
              symbol: 'none',
              silent: true,
              lineStyle: { color: t.ink2, type: 'solid' as const, width: 1 },
              label: { show: false },
              data: [{ xAxis: ref.cpv }, { yAxis: ref.aepf }],
            },
          },
          { type: 'line' as const, showSymbol: false, data: iso, lineStyle: { color: t.serious, width: 1.5 }, silent: true },
        ],
      },
    };
  }, [streams, th, crank, t]);
  const names = ['Q1 · high force, high speed', 'Q2 · high force, low speed', 'Q3 · low force, low speed', 'Q4 · low force, high speed'];
  return (
    <Card title="Quadrant analysis" subtitle="Neuromuscular demands: pedal force vs velocity. Lines at FTP and your average cadence; curve = FTP isopower.">
      <Chart option={option} height={250} />
      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {names.map((n, i) => (
          <div key={n} className="flex justify-between">
            <span className="text-ink-2">{n}</span>
            <span className="tnum font-medium">{Math.round(quads[i] * 100)}%</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

// ---------- decoupling ----------
export function DecouplingCard({ streams, sport, decoupling }: { streams: Streams; sport: Sport; decoupling: number | null }) {
  const t = useTokens();
  const bike = !!streams.watts && sport === 'ride';
  const output = useMemo(() => (bike ? streams.watts! : streams.speed && streams.grade ? gradeAdjustedSpeed(streams.speed, streams.grade) : streams.speed ?? []), [streams, bike]);
  const option = useMemo(() => {
    const ef = efficiencySeries(output, streams.heartrate ?? [], 300);
    const step = Math.max(1, Math.floor(ef.length / 1500));
    const data: [number, number][] = [];
    for (let i = 0; i < ef.length; i += step) if (ef[i] != null) data.push([i, bike ? ef[i]! : ef[i]! * 60]);
    const half = Math.floor(ef.length / 2);
    return {
      animation: false,
      grid: { left: 44, right: 12, top: 14, bottom: 26 },
      tooltip: { trigger: 'axis' as const, ...tooltipStyle(t), formatter: (ps: any) => `${fmtDuration(ps[0].value[0])}${tipRow(t.series[2], bike ? 'Power : HR' : 'Speed : HR', ps[0].value[1].toFixed(2))}` },
      xAxis: { type: 'value' as const, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => fmtDuration(v, { short: true }) }, max: ef.length },
      yAxis: valueAxis(t, { min: (v: { min: number }) => Math.floor(v.min * 10) / 10, max: (v: { max: number }) => Math.ceil(v.max * 10) / 10, axisLabel: { color: t.muted, fontSize: 10, formatter: (v: number) => v.toFixed(1) } }),
      series: [
        {
          type: 'line' as const,
          showSymbol: false,
          data,
          lineStyle: { color: t.series[2], width: 1.8 },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: half, lineStyle: { color: t.muted, type: 'solid' as const }, label: { formatter: 'halfway', color: t.muted, fontSize: 10 } }] },
        },
      ],
    };
  }, [output, streams, t, bike]);
  const verdict = decoupling == null ? null : decoupling < 5 ? { c: 'text-good-text', l: 'Well coupled — aerobically fit for this duration' } : decoupling < 8 ? { c: 'text-ink', l: 'Moderate drift' } : { c: 'text-critical', l: 'Significant drift — aerobic endurance limiter or fatigue/heat' };
  return (
    <Card title={bike ? 'Aerobic decoupling (Pw:HR)' : 'Aerobic decoupling (Pa:HR)'} subtitle="Rolling 5-min output per heartbeat; a falling line means cardiac drift">
      <div className="mb-2 flex items-baseline gap-3">
        <span className="text-2xl font-semibold">{decoupling != null ? `${decoupling.toFixed(1)}%` : '–'}</span>
        {verdict && <span className={clsx('text-xs', verdict.c)}>{verdict.l}</span>}
      </div>
      <Chart option={option} height={200} />
    </Card>
  );
}

// ---------- best efforts (run) ----------
export function BestEffortsCard({ efforts }: { efforts: Record<string, number> }) {
  const rows = BEST_EFFORT_DISTANCES.filter((d) => efforts[d.key] != null);
  if (!rows.length) return null;
  return (
    <Card title="Best efforts">
      <div className="space-y-1.5">
        {rows.map((d) => (
          <div key={d.key} className="flex justify-between text-[13px]">
            <span className="text-ink-2">{d.label}</span>
            <span className="tnum font-medium">
              {fmtDuration(efforts[d.key])} <span className="ml-2 text-xs text-muted">{fmtPace(d.meters / efforts[d.key], 'run')}</span>
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}
