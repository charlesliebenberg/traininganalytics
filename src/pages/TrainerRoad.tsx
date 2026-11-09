import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { parseISO } from 'date-fns';
import { AlertTriangle } from 'lucide-react';
import { valueOn, type FtpAgreement, type FtpEvent, type FtpPoint, type ZoneLevel } from '../../shared/analytics/trainerroad';
import { useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDuration, fmtNum, iso } from '../lib/format';
import { Card, PageHeader, Spinner, Stat } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { surveyText, type TrainerRoadRide } from '../components/trainerroad';

interface Forecast {
  date: string;
  trainerRoad: number;
  app: number | null;
  range: [number, number] | null;
  days: number;
}

interface Insights {
  status: { mode: 'account' | 'calendar' | null; lastSyncAt: string | null; lastError: string | null; syncing: boolean };
  read: string | null;
  ftp: { trainerRoad: number | null; app: number | null; events: FtpEvent[]; agreement: FtpAgreement | null; forecasts: Forecast[]; plannedThrough: string | null; appSeries: FtpPoint[]; from: string } | null;
  ai: { can: boolean | null; reason: unknown; status: string | null; modelVersion: string | null; detected: number | null; next: string | null; lastViewed: string | null } | null;
  levels: ZoneLevel[];
  levelsAt: string | null;
  plan: {
    name: string | null;
    volume: unknown;
    start: string | null;
    end: string | null;
    current: { name: string; start: string | null; end: string | null } | null;
    phases: { name: string | null; plan: string | null; volume: unknown; start: string; end: string | null }[];
  } | null;
  rides: TrainerRoadRide[];
}

const KIND: Record<FtpEvent['kind'], string> = {
  applied: 'Applied',
  detected: 'AI FTP Detection',
  pending: 'AI FTP Detection, waiting for you to accept it',
  predicted: 'Predicted',
};
/** AI FTP Detection's status, in words */
const AI_STATUS: Record<string, string> = {
  CanPredict: 'has what it needs',
  NoData: 'has no data yet',
  NoRecentData: 'needs more recent rides',
  NoActivities: 'has no rides to go on',
};
const signed = (x: number, unit = ' W') => `${x > 0.5 ? '+' : x < -0.5 ? '−' : ''}${Math.abs(Math.round(x))}${unit}`;
const pct = (x: number) => `${x > 0.005 ? '+' : x < -0.005 ? '−' : ''}${Math.abs(Math.round(x * 100))}%`;

/** The two FTPs through time: each one's in effect, AI FTP Detection's finds, and what each expects next. */
function FtpChart({ f }: { f: NonNullable<Insights['ftp']> }) {
  const t = useTokens();
  const option = useMemo(() => {
    const today = iso(new Date());
    const x = (d: string) => parseISO(d).getTime();
    const tr = t.series[3];
    const applied = f.events.filter((e) => e.kind === 'applied');
    const appLine = f.app != null ? [...f.appSeries.map((p) => [x(p.date), p.value]), [x(today), f.app]] : [];
    const trLine = applied.length ? [...applied.map((e) => [x(e.date), e.value]), [x(today), applied[applied.length - 1].value]] : [];
    const found = f.events.filter((e) => e.kind === 'detected' || e.kind === 'pending');
    const ahead = (from: number | null, to: (p: Forecast) => number | null) =>
      f.forecasts.flatMap((p) => (from != null && to(p) != null ? [[x(today), from], [x(p.date), to(p)], null] : []));
    const series: Record<string, unknown>[] = [
      { type: 'line', name: 'This app', step: 'end', data: appLine, showSymbol: false, lineStyle: { color: t.accent, width: 2 }, itemStyle: { color: t.accent } },
      { type: 'line', name: 'TrainerRoad', step: 'end', data: trLine, showSymbol: false, lineStyle: { color: tr, width: 2 }, itemStyle: { color: tr } },
      { type: 'scatter', name: 'AI FTP Detection', data: found.map((e) => [x(e.date), e.value]), symbol: 'diamond', symbolSize: 11, itemStyle: { color: tr } },
      { type: 'line', name: 'TrainerRoad’s prediction', data: ahead(f.trainerRoad, (p) => p.trainerRoad), connectNulls: false, symbol: 'circle', symbolSize: 6, lineStyle: { color: tr, type: 'dashed' }, itemStyle: { color: tr } },
      { type: 'line', name: 'This app’s forecast', data: ahead(f.app, (p) => p.app), connectNulls: false, symbol: 'circle', symbolSize: 6, lineStyle: { color: t.accent, type: 'dashed' }, itemStyle: { color: t.accent } },
      // the plausible models' range at the date
      ...f.forecasts
        .filter((p) => p.range)
        .map((p) => ({ type: 'line', name: 'This app’s forecast', data: [[x(p.date), p.range![0]], [x(p.date), p.range![1]]], showSymbol: false, silent: true, lineStyle: { color: alpha(t.accent, 0.3), width: 8 }, tooltip: { show: false } })),
    ];
    return {
      animation: false,
      // the legend gets its own row: on a phone it spans the width and would sit on the axis name
      grid: { left: 52, right: 16, top: 60, bottom: 28 },
      legend: { ...legendStyle(t), data: ['This app', 'TrainerRoad', 'AI FTP Detection', 'TrainerRoad’s prediction', 'This app’s forecast'] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: { axisValue: number }[]) => {
          const d = iso(new Date(ps[0].axisValue));
          const a = d <= today ? valueOn(f.appSeries, d) : null;
          const r = d <= today ? valueOn(applied, d) : null;
          const ev = f.events.filter((e) => e.date === d);
          return `<b>${fmtDate(d, 'EEE d MMM yyyy')}</b>${a != null ? tipRow(t.accent, 'This app', `${a} W`) : ''}${r != null ? tipRow(tr, 'TrainerRoad', `${r} W`) : ''}${ev.map((e) => tipRow('transparent', KIND[e.kind], `${e.value} W`)).join('')}`;
        },
      },
      xAxis: { type: 'time', ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true, formatter: (v: number) => fmtDate(new Date(v), 'd MMM') } },
      yAxis: valueAxis(t, { scale: true, name: 'FTP (W)', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      series,
    };
  }, [f, t]);
  return <Chart option={option} height={300} />;
}

function FtpCard({ f, ai }: { f: NonNullable<Insights['ftp']>; ai: Insights['ai'] }) {
  const diff = f.trainerRoad != null && f.app != null ? f.trainerRoad - f.app : null;
  const first = f.events.find((e) => e.kind === 'applied');
  const a = f.agreement;
  return (
    <Card title="FTP: TrainerRoad’s and this app’s" subtitle="TrainerRoad’s FTP as it applied it, what its AI FTP Detection found and predicts, against this app’s own daily estimate from your power (Thresholds)">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="TrainerRoad" value={f.trainerRoad ?? '–'} unit="W" sub="in use there" />
        <Stat label="AI FTP Detection" value={ai?.detected ?? '–'} unit="W" sub={ai?.detected != null && f.trainerRoad != null ? `${signed(ai.detected - f.trainerRoad)} on TrainerRoad’s` : 'nothing found'} />
        <Stat label="This app" value={f.app ?? '–'} unit="W" sub="today’s estimate" />
        <Stat label="TrainerRoad − this app" value={diff != null ? signed(diff, '') : '–'} unit="W" sub={diff != null && f.app ? pct(diff / f.app) : undefined} />
      </div>
      {f.forecasts.map((p) => (
        <p key={p.date} className="mt-4 text-[13px] leading-relaxed text-ink-2">
          TrainerRoad predicts <b className="text-ink">{p.trainerRoad} W</b> by {fmtDate(p.date, 'EEE d MMM')}, in {p.days} days.{' '}
          {p.app != null ? (
            <>
              This app’s capacity model, riding the load planned in the calendar until then, expects <b className="text-ink">{p.app} W</b>
              {p.range && p.range[0] !== p.range[1] ? ` (${p.range[0]}–${p.range[1]} W across its plausible fits)` : ''}
              {Math.abs(p.trainerRoad - p.app) < 1 ? ': the same.' : `: TrainerRoad’s is ${Math.abs(Math.round(p.trainerRoad - p.app))} W ${p.trainerRoad > p.app ? 'higher' : 'lower'}.`}
            </>
          ) : (
            'This app’s capacity model can’t say: it needs a riding history where load has moved your 20-minute power.'
          )}
          {f.plannedThrough && f.plannedThrough < p.date ? ` The rides planned in the calendar run out on ${fmtDate(f.plannedThrough, 'd MMM')}; after that the forecast counts no riding.` : ''}
        </p>
      ))}
      <div className="mt-4">
        <FtpChart f={f} />
      </div>
      {a && first && (
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Since TrainerRoad’s first FTP, on {fmtDate(first.date, 'd MMM yyyy')}, its FTP has been{' '}
          {Math.abs(a.mean) < 0.5 ? 'level with this app’s on average' : `${Math.abs(Math.round(a.mean))} W (${Math.abs(Math.round(a.meanPct * 100))}%) ${a.mean < 0 ? 'under' : 'over'} this app’s on average`}, {Math.round(a.meanAbs)} W apart either way on a
          typical day ({a.days} days).
        </p>
      )}
      {f.events.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="tnum w-full min-w-[480px] text-[13px]">
            <thead>
              <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                <th className="py-1.5 font-medium">Date</th>
                <th className="pl-3 text-right font-medium">TrainerRoad</th>
                <th className="pl-3 text-right font-medium">This app</th>
                <th className="pl-3 text-right font-medium">Difference</th>
                <th className="pl-4 font-medium">From</th>
              </tr>
            </thead>
            <tbody>
              {[...f.events].reverse().map((e) => (
                <tr key={`${e.date}-${e.kind}-${e.value}`} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 whitespace-nowrap">{fmtDate(e.date, 'd MMM yyyy')}</td>
                  <td className="pl-3 text-right">{e.value} W</td>
                  <td className="pl-3 text-right">{e.app != null ? `${e.app} W` : '–'}</td>
                  <td className="pl-3 text-right">{e.diff != null ? signed(e.diff) : '–'}</td>
                  <td className="pl-4 text-ink-2">
                    {KIND[e.kind]}
                    {e.lowConfidence ? ' (low confidence)' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function AiCard({ ai }: { ai: NonNullable<Insights['ai']> }) {
  return (
    <Card title="AI FTP Detection" subtitle="TrainerRoad’s model of your FTP from your rides">
      <div className="grid grid-cols-2 gap-3 text-[13px]">
        <div>
          <div className="text-[11px] text-muted uppercase">Now</div>
          {ai.can == null ? '–' : ai.can ? 'can run' : `can’t run${ai.reason != null ? ` (${String(ai.reason)})` : ''}`}
          {ai.status ? `; ${AI_STATUS[ai.status] ?? ai.status}` : ''}
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">Next</div>
          {ai.next ? fmtDate(ai.next, 'EEE d MMM') : '–'}
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">Finds</div>
          {ai.detected != null ? `${ai.detected} W` : '–'}
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">Model</div>
          {ai.modelVersion ?? '–'}
        </div>
      </div>
    </Card>
  );
}

function LevelsCard({ levels, at }: { levels: ZoneLevel[]; at: string | null }) {
  const t = useTokens();
  return (
    <Card title="Progression levels" subtitle={`TrainerRoad’s 1–10 for what you can do in each zone; the tick is where it expects you by the end of the plan${at ? ` · ${fmtDate(at, 'd MMM')}` : ''}`}>
      <div className="space-y-3">
        {levels.map((l) => (
          <div key={l.id} className="text-[13px]">
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium">{l.zone}</span>
              <span className="tnum">
                <b>{l.level != null ? l.level.toFixed(1) : '–'}</b>
                {l.predicted != null && <span className="text-muted"> → {l.predicted.toFixed(1)}</span>}
              </span>
            </div>
            <div className="relative mt-1 h-1.5 rounded-full bg-surface-3">
              {l.level != null && <div className="h-full rounded-full" style={{ width: `${Math.min(100, l.level * 10)}%`, background: t.accent }} />}
              {l.predicted != null && <div className="absolute top-[-3px] h-3 w-0.5 rounded" style={{ left: `${Math.min(100, l.predicted * 10)}%`, background: t.ink2 }} />}
            </div>
            <div className="mt-0.5 text-[11px] text-muted">
              {l.changed?.to != null ? `${l.changed.from != null ? `${l.changed.from.toFixed(1)} → ` : ''}${l.changed.to.toFixed(1)}${l.changed.date ? ` on ${fmtDate(l.changed.date, 'd MMM')}` : ''}` : ''}
              {l.ai?.to != null && l.ai.from != null && l.ai.to !== l.ai.from ? `${l.changed?.to != null ? ' · ' : ''}${l.ai.to.toFixed(1)} with AI FTP Detection’s FTP` : ''}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PlanCard({ plan }: { plan: NonNullable<Insights['plan']> }) {
  const today = iso(new Date());
  return (
    <Card title={plan.name ?? 'Plan'} subtitle={[plan.volume ? `${String(plan.volume)} volume` : null, plan.start && plan.end ? `${fmtDate(plan.start, 'd MMM')} – ${fmtDate(plan.end, 'd MMM yyyy')}` : null].filter(Boolean).join(' · ') || undefined}>
      <div className="space-y-1.5 text-[13px]">
        {plan.phases.map((p) => {
          const now = p.start <= today && (!p.end || p.end >= today);
          return (
            <div key={`${p.start}-${p.name}`} className={now ? 'font-medium text-ink' : 'text-ink-2'}>
              {p.name ?? p.plan ?? 'Phase'}
              {p.plan && p.plan !== p.name ? <span className="text-muted"> · {p.plan}</span> : null}
              <span className="text-muted">
                {' '}
                · {fmtDate(p.start, 'd MMM')}
                {p.end ? ` – ${fmtDate(p.end, 'd MMM')}` : ''}
                {now ? ' · now' : ''}
              </span>
            </div>
          );
        })}
        {!plan.phases.length && plan.current && (
          <div>
            {plan.current.name} now{plan.current.end ? `, to ${fmtDate(plan.current.end, 'd MMM')}` : ''}
          </div>
        )}
      </div>
    </Card>
  );
}

function RidesCard({ rides }: { rides: TrainerRoadRide[] }) {
  return (
    <Card title="Your rides, as TrainerRoad saw them" subtitle="The last four weeks: TrainerRoad’s TSS from its FTP, how you said each felt in its survey, and the same ride here" pad={false}>
      <div className="overflow-x-auto px-5 pb-4">
        <table className="tnum w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
              <th className="py-1.5 font-medium">Date</th>
              <th className="font-medium">Workout</th>
              <th className="text-right font-medium">TSS there</th>
              <th className="text-right font-medium">TSS here</th>
              <th className="pl-4 font-medium">How it felt</th>
            </tr>
          </thead>
          <tbody>
            {rides.map((r) => (
              <tr key={r.id} className="border-b border-line/60 align-top last:border-0">
                <td className="py-1.5 whitespace-nowrap">{r.started ? fmtDate(r.started.slice(0, 10), 'EEE d MMM') : '–'}</td>
                <td>
                  {r.activity ? (
                    <Link to={`/activities/${r.activity.id}`} className="text-accent hover:underline">
                      {r.name ?? r.activity.name}
                    </Link>
                  ) : (
                    (r.name ?? '–')
                  )}
                  {r.duration ? <span className="text-muted"> · {fmtDuration(r.duration, { short: true })}</span> : null}
                </td>
                <td className="text-right" title={r.if != null ? `IF ${r.if.toFixed(2)} by TrainerRoad’s FTP` : undefined}>
                  {fmtNum(r.tss)}
                </td>
                <td className="text-right">{r.activity ? fmtNum(r.activity.tss) : '–'}</td>
                <td className="pl-4 text-ink-2">{r.survey ? surveyText(r.survey) : <span className="text-muted">not answered</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rides.length && <p className="py-6 text-center text-xs text-muted">No rides recorded in TrainerRoad in the last four weeks.</p>}
      </div>
    </Card>
  );
}

export function TrainerRoad() {
  // what TrainerRoad says changes with a sync, not by the minute
  const { data: d, isLoading } = useApi<Insights>('/trainerroad/insights', { refetchInterval: (q) => (q.state.data?.status.syncing ? 3000 : false) });
  const header = <PageHeader title="TrainerRoad" subtitle="TrainerRoad’s view of you beside this app’s: FTP and AI FTP Detection against this app’s model, progression levels, your plan, and how your rides felt" />;
  if (isLoading || !d) return <>{header}<Spinner /></>;
  const s = d.status;
  if (!s.mode || s.mode === 'calendar' || !d.read)
    return (
      <>
        {header}
        <Card>
          <p className="text-[13px] text-ink-2">
            {!s.mode
              ? 'TrainerRoad isn’t set up yet: '
              : s.mode === 'calendar'
                ? 'TrainerRoad is read from its calendar export, which carries the plan only. FTP, AI FTP Detection, progression levels and ride ratings need the TrainerRoad login: '
                : s.lastError
                  ? `TrainerRoad couldn’t be read: ${s.lastError}. `
                  : 'TrainerRoad hasn’t been read yet: it will be within the hour. '}
            <Link to="/settings" className="text-accent hover:underline">
              Settings → TrainerRoad
            </Link>
            .
          </p>
        </Card>
      </>
    );
  return (
    <>
      {header}
      {s.lastError && (
        <div className="mb-4 flex items-start gap-2 rounded-lg bg-surface-2 p-2.5 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          The last sync failed ({s.lastError}): this is from {fmtDate(d.read, 'd MMM HH:mm')}.
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-3">
        <div className="min-w-0 xl:col-span-2">{d.ftp && <FtpCard f={d.ftp} ai={d.ai} />}</div>
        <div className="flex min-w-0 flex-col gap-4">
          {d.ai && <AiCard ai={d.ai} />}
          {d.levels.length > 0 && <LevelsCard levels={d.levels} at={d.levelsAt} />}
          {d.plan && <PlanCard plan={d.plan} />}
        </div>
      </div>
      <div className="mt-4">
        <RidesCard rides={d.rides} />
      </div>
    </>
  );
}
