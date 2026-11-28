import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { parseISO, subDays } from 'date-fns';
import { ArrowRight, Mountain, Route, Trophy, Zap } from 'lucide-react';
import type { Thresholds } from '../../../shared/types';
import { qs, useApi } from '../../lib/api';
import { alpha, useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, fmtDistance, fmtElevation, fmtNum, iso } from '../../lib/format';
import { useForecast } from '../../lib/forecast';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { AerobicChart, outText, type AerobicTrendData } from '../../components/insights';
import { usePlanOutlook } from '../../components/plan';
import { Card, Skeleton } from '../../components/ui';
import { ProfileCard, useCurve, type ModelResponse } from './Power';
import type { Now as ComebackNow, PeakCard } from '../comeback/types';

interface History {
  points: { date: string; cp: number; wPrime: number; pmax: number | null; ftp: number }[];
}
interface Highlight {
  id: number;
  name: string;
  local_date: string;
  value: number;
}
interface RecordsData {
  highlights: Record<'longestRide' | 'longestRun' | 'mostClimbing' | 'biggestTss' | 'mostWork' | 'highestNp', Highlight | null>;
}

/**
 * Performance at a glance: your FTP and where it's going, what kind of rider the numbers say you
 * are, your aerobic engine, how close you are to your best, and your records — each opening into
 * the detail behind it.
 */
export function Overview() {
  const t = useTokens();
  const today = iso(new Date());
  const from90 = iso(subDays(parseISO(today), 90));
  const th = useApi<{ current: Thresholds }>('/thresholds');
  const model = useApi<ModelResponse>('/model');
  const hist = useApi<History>(`/model/history${qs({ from: iso(subDays(parseISO(today), 365)), to: today })}`);
  const curve = useCurve('power', { from: from90, to: today });
  const aerobic = useApi<AerobicTrendData | null>(`/aerobic${qs({ sport: 'ride' })}`);
  const peaks = useApi<{ peaks: PeakCard[]; now: ComebackNow }>('/comeback/overview');
  const records = useApi<RecordsData>('/records');
  const outlook = usePlanOutlook();
  const f = useForecast({ eventId: null, constraints: null, custom: null });
  const inspectLink = useInspectLink();

  const cur = th.data?.current;
  const ftp = cur?.ftp ?? model.data?.ftp ?? null;
  const weight = cur?.weight ?? model.data?.weight ?? 70;
  const m = model.data?.model;
  const pts = hist.data?.points ?? [];
  const ago = [...pts].reverse().find((p) => p.date <= from90);
  const delta = ftp && ago ? ftp - ago.ftp : null;
  const tr = outlook.data?.ftp.trainerRoad;
  const race = f.data?.race ? f.data : null;
  const raceFtps = race ? race.scenarios.map((s) => s.race.ftp).filter((v): v is number => v != null) : [];
  const peak = peaks.data?.peaks[0];
  const nowFtp = peaks.data?.now.ftp ?? ftp;

  return (
    <div className="space-y-4">
      {/* ---- FTP: now, lately, and where it's going ---- */}
      <section className="card grid overflow-hidden lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.6fr)]">
        <div className="flex flex-col gap-4 border-b border-line p-6 lg:border-r lg:border-b-0">
          <div>
            <div className="eyebrow flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: t.power }} />
              FTP
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="figure text-[56px] text-ink">{ftp ?? '–'}</span>
              <span className="text-[16px] font-medium text-muted">W</span>
            </div>
            <div className="mt-1 text-[14px] text-ink-2">
              {ftp && weight ? `${(ftp / weight).toFixed(2)} W/kg` : ''} <span className="text-muted">· {weight} kg</span>
            </div>
            <div className="mt-2 text-[12.5px] text-muted">
              {cur?.sources?.ftp === 'auto' ? 'Estimated every day from your hardest efforts' : cur?.sources?.ftp === 'manual' ? 'Set by you' : 'Default'}
              {delta != null && Math.abs(delta) >= 1 && (
                <span className={delta > 0 ? 'text-good-text' : 'text-serious'}>
                  {' '}
                  · {delta > 0 ? '+' : '−'}
                  {Math.abs(Math.round(delta))} W in 90 days
                </span>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3 border-t border-line pt-4">
            <Mini label="Critical power" value={m ? `${Math.round(m.cp)}` : '–'} unit="W" />
            <Mini label="W′" value={m ? (m.wPrime / 1000).toFixed(1) : '–'} unit="kJ" />
            <Mini label="Sprint" value={m?.pmax ? `${Math.round(m.pmax)}` : '–'} unit="W" />
          </div>
          <div className="mt-auto flex flex-wrap gap-2">
            {tr?.now != null && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2 ring-1 ring-line ring-inset">
                <span className="h-2 w-2 rotate-45 rounded-[1px]" style={{ background: t.series[3] }} />
                TrainerRoad says {tr.now} W
              </span>
            )}
            {race && raceFtps.length > 0 && (
              <Link to="/season" className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2 ring-1 ring-line ring-inset hover:text-ink">
                {race.race!.name}: {Math.round(Math.min(...raceFtps))}–{Math.round(Math.max(...raceFtps))} W
                <ArrowRight className="h-3 w-3" />
              </Link>
            )}
          </div>
        </div>
        <div className="min-w-0 p-4 pt-5">
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[13px] font-semibold">The last year</span>
            <Link to="/performance/thresholds" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              Thresholds <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
          {hist.data ? <FtpYear points={pts} tr={tr?.history ?? []} /> : <Skeleton className="h-[230px]" />}
        </div>
      </section>

      {/* ---- what kind of rider, the engine underneath, against your best, and your bests ---- */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-4">
          <div className="min-w-0">
          {curve.data ? <ProfileCard curve={curve.data} weight={weight} ftp={ftp} /> : <Skeleton className="h-48 !rounded-2xl" />}
        </div>
          <Card
          title="Against your best"
          subtitle="Your FTP now beside the peak of your best season"
          actions={
            <Link to="/performance/peaks" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              Peaks <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          {peaks.isLoading ? (
            <Skeleton className="h-32" />
          ) : !peak?.ftp || !nowFtp ? (
            <p className="text-[13px] text-muted">Peaks come from your daily FTP estimates, which need rides with power.</p>
          ) : (
            <PeakBar peak={peak} now={nowFtp} />
          )}
        </Card>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card
          title="Aerobic engine"
          subtitle={aerobic.data ? `What you hold at ${aerobic.data.model.refHr} bpm, from the steady parts of your rides` : 'What your heart rate says about fitness'}
          actions={
            <Link to="/performance/endurance" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              Endurance <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          {aerobic.isLoading ? (
            <Skeleton className="h-40" />
          ) : !aerobic.data ? (
            <p className="text-[13px] text-muted">Needs at least 8 rides with power and a heart-rate strap, each with 20 minutes or more of steady effort.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                <div>
                  <span className="figure text-[30px]">{outText('ride', aerobic.data.current.value)}</span>
                  <span className="ml-2 text-[12px] text-muted">
                    likely {outText('ride', aerobic.data.current.lo)}–{outText('ride', aerobic.data.current.hi)}
                  </span>
                </div>
                {aerobic.data.change && (
                  <div className="text-[13px]">
                    <span className={aerobic.data.change.pct >= 0 ? 'font-semibold text-good-text' : 'font-semibold text-serious'}>
                      {aerobic.data.change.pct >= 0 ? '+' : '−'}
                      {Math.abs(aerobic.data.change.pct).toFixed(0)}%
                    </span>
                    <span className="text-muted"> in 12 weeks (±{Math.max(1, Math.round(aerobic.data.change.sdPct))}%)</span>
                  </div>
                )}
              </div>
              <div className="mt-2">
                <AerobicChart sport="ride" points={aerobic.data.points} height={190} compact />
              </div>
            </>
          )}
        </Card>
          <Card
          title="Records"
          subtitle="Your biggest days, each a click from its ride"
          actions={
            <Link to="/performance/records" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
              All records <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          {!records.data ? (
            <Skeleton className="h-32" />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['highestNp', 'Highest NP', Zap, (v: number) => `${Math.round(v)} W`],
                  ['longestRide', 'Longest ride', Route, (v: number) => fmtDistance(v, 0)],
                  ['mostClimbing', 'Most climbing', Mountain, (v: number) => fmtElevation(v)],
                  ['biggestTss', 'Biggest day', Trophy, (v: number) => `${Math.round(v)} TSS`],
                ] as const
              ).map(([k, label, Icon, fmt]) => {
                const r = records.data!.highlights[k];
                if (!r) return null;
                return (
                  <Link key={k} {...inspectLink('a', r.id)} className="flex min-w-0 items-center gap-3 rounded-xl border border-line p-3 hover:bg-surface-2">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-surface-2 text-muted">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[11.5px] text-muted">{label}</span>
                      <span className="figure block text-[17px]">{fmt(r.value)}</span>
                      <span className="block truncate text-[11px] text-muted">
                        {r.name} · {fmtDate(r.local_date, 'd MMM yyyy')}
                      </span>
                    </span>
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
        </div>
      </div>
    </div>
  );
}

function Mini({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[11.5px] text-muted">{label}</div>
      <div className="mt-1 flex items-baseline gap-0.5">
        <span className="figure text-[18px]">{value}</span>
        <span className="text-[11px] text-muted">{unit}</span>
      </div>
    </div>
  );
}

/** FTP over the last year — this app's estimate as it changed, TrainerRoad's beside it. */
function FtpYear({ points, tr }: { points: History['points']; tr: { date: string; value: number }[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const ts = (d: string) => parseISO(d).getTime();
    const first = points[0]?.date;
    const trIn = tr.filter((p) => !first || p.date >= first);
    const all = [...points.map((p) => p.ftp), ...trIn.map((p) => p.value)].filter((v) => v > 0);
    return {
      animation: false,
      grid: { left: 44, right: 16, top: 16, bottom: 26 },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const x = arr[0]?.value?.[0];
          if (x == null) return '';
          return `<div style="font-weight:600;margin-bottom:4px">${fmtDate(new Date(x).toISOString().slice(0, 10), 'd MMM yyyy')}</div>${arr.map((p: any) => tipRow(p.color, p.seriesName, `${Math.round(p.value[1])} W`)).join('')}`;
        },
      },
      xAxis: { type: 'time', ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true } },
      yAxis: valueAxis(t, { min: all.length ? Math.floor((Math.min(...all) - 10) / 10) * 10 : undefined, max: all.length ? Math.ceil((Math.max(...all) + 10) / 10) * 10 : undefined, axisLabel: { color: t.muted, fontSize: 11, formatter: '{value} W' } }),
      series: [
        {
          type: 'line',
          name: 'FTP',
          step: 'end',
          showSymbol: false,
          data: points.map((p) => [ts(p.date), p.ftp]),
          lineStyle: { color: t.power, width: 2.25 },
          itemStyle: { color: t.power },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(t.power, 0.16) }, { offset: 1, color: alpha(t.power, 0) }] } },
        },
        ...(trIn.length
          ? [{ type: 'line', name: 'TrainerRoad', step: 'end', symbol: 'diamond', symbolSize: 8, data: trIn.map((p) => [ts(p.date), p.value]), lineStyle: { color: t.series[3], width: 1.25, type: 'dashed' }, itemStyle: { color: t.series[3], borderColor: t.surface, borderWidth: 1.5 } }]
          : []),
      ],
    };
  }, [points, tr, t]);
  return <Chart option={option} height={230} />;
}

/** Now against the peak, on one bar. */
function PeakBar({ peak, now }: { peak: PeakCard; now: number }) {
  const t = useTokens();
  const pct = (now / peak.ftp!) * 100;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <div>
          <div className="text-[11.5px] text-muted">Now</div>
          <div className="figure mt-1 text-[30px]">
            {now}
            <span className="ml-1 text-[13px] font-medium text-muted">W</span>
          </div>
        </div>
        <div>
          <div className="text-[11.5px] text-muted">Peak · {fmtDate(peak.date, 'MMM yyyy')}</div>
          <div className="figure mt-1 text-[30px] text-ink-2">
            {peak.ftp}
            <span className="ml-1 text-[13px] font-medium text-muted">W</span>
          </div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[11.5px] text-muted">Of your best</div>
          <div className={`figure mt-1 text-[30px] ${pct >= 100 ? 'text-good-text' : ''}`}>{fmtNum(pct)}%</div>
        </div>
      </div>
      <div className="relative mt-4 h-2.5 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, pct)}%`, background: t.power }} />
      </div>
      <p className="mt-2.5 text-[12.5px] text-muted">
        {pct >= 100 ? 'You’re at or above your best season’s peak.' : `${Math.round(peak.ftp! - now)} W to go${peak.ctl ? `: that peak was built on fitness ${Math.round(peak.ctl)}` : ''}. The peaks page shows how it was built and the way back.`}
      </p>
    </div>
  );
}
