import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Flag } from 'lucide-react';
import type { FtpPoint } from '../../shared/analytics/trainerroad';
import { useApi } from '../lib/api';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate, fmtNum } from '../lib/format';
import { Badge, Card, Stat } from './ui';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { formColor } from './charts';

/** The plan ahead, from server/plan-outlook.ts. */
export interface PlanOutlook {
  source: 'trainerroad' | 'calendar' | null;
  plannedAhead: number;
  plannedThrough: string | null;
  plan: { name: string | null; volume: string | null; current: { name: string | null; start: string | null; end: string | null } | null; phases: PlanPhase[] } | null;
  race: { id: number; name: string; date: string; priority: string } | null;
  raceDay: { date: string; days: number; ctl: number; atl: number; tsb: number; form: { id: string; label: string; hint: string }; ctlNow: number | null } | null;
  unplanned: { from: string; to: string; days: number }[];
  weeks: OutlookWeek[];
  compliance: { weeks: number; since: string; plannedTss: number; doneTss: number; workouts: number; completed: number; missed: number } | null;
  ftp: {
    app: { now: number; path: FtpPath[] } | null;
    trainerRoad: { now: number | null; history: FtpPoint[]; predicted: FtpPoint[] } | null;
  };
}
export interface PlanPhase {
  name: string | null;
  plan: string | null;
  start: string | null;
  end: string | null;
}
export interface OutlookWeek {
  start: string;
  end: string;
  phase: string | null;
  planned: { tss: number; rideTss: number; seconds: number; n: number };
  done: { tss: number; seconds: number; n: number };
  completed: number;
  missed: number;
  when: 'past' | 'now' | 'ahead';
}
export interface FtpPath {
  date: string;
  value: number;
  low: number;
  high: number;
}

export const usePlanOutlook = () => useApi<PlanOutlook>('/plan/outlook', { staleTime: 5 * 60_000 });

/** TrainerRoad's colour wherever its numbers are drawn; this app's are the accent. */
export const trColor = (t: Tokens) => t.series[3];

/** The TR chip that marks TrainerRoad's own numbers. */
export function TrChip() {
  return <span className="inline-flex h-4 items-center rounded bg-ink px-1 text-[9px] font-bold text-surface">TR</span>;
}

/** The last point of this app's FTP outlook on or before a day. */
export const pathOn = (path: FtpPath[], date: string) => [...path].reverse().find((p) => p.date <= date) ?? null;

/** Phase bands for a time chart: TrainerRoad's phases, as ECharts markArea data. */
export function phaseAreas(phases: PlanPhase[] | undefined, toX: (d: string) => number) {
  return (phases ?? []).filter((p) => p.start && p.end).map((p) => [{ xAxis: toX(p.start!), name: p.name ?? '' }, { xAxis: toX(p.end!) }]);
}

/**
 * The two FTP outlooks, side by side and never mixed: this app's (its own estimate, carried by
 * its capacity model riding the planned load) and TrainerRoad's (its FTP and AI FTP's prediction).
 */
export function FtpOutlook({ o, at }: { o: PlanOutlook; at?: string | null }) {
  const t = useTokens();
  const app = o.ftp.app;
  const tr = o.ftp.trainerRoad;
  const end = at ?? o.race?.date ?? o.plannedThrough;
  const appAt = app && end ? pathOn(app.path, end) : null;
  const pred = tr?.predicted[0] ?? null;
  return (
    <div className="space-y-2 text-[13px]">
      {app && (
        <div className="flex items-start gap-2">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: t.accent }} />
          <div className="min-w-0 flex-1">
            <span className="font-medium">This app</span> <span className="tnum">{app.now} W</span>
            {appAt && appAt.value !== app.now ? (
              <>
                {' '}
                → <b className="tnum">{appAt.value} W</b> by {fmtDate(appAt.date, 'd MMM')}
                {appAt.low !== appAt.high ? <span className="text-muted"> ({appAt.low}–{appAt.high})</span> : null}
              </>
            ) : null}
            <div className="text-[11px] text-muted">its capacity model, riding the rides planned</div>
          </div>
        </div>
      )}
      {tr && (
        <div className="flex items-start gap-2">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: trColor(t) }} />
          <div className="min-w-0 flex-1">
            <span className="font-medium">TrainerRoad</span> <span className="tnum">{tr.now ?? '–'} W</span>
            {pred ? (
              <>
                {' '}
                → <b className="tnum">{pred.value} W</b> predicted by {fmtDate(pred.date, 'd MMM')}
              </>
            ) : null}
            <div className="text-[11px] text-muted">{pred ? 'its FTP and AI FTP’s prediction' : 'its FTP; AI FTP has no prediction out now'}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Weekly load: what was planned and what was ridden, the weeks gone and to come. */
export function PlanWeeksChart({ weeks, height = 150 }: { weeks: OutlookWeek[]; height?: number }) {
  const t = useTokens();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 36, right: 8, top: 24, bottom: 22 },
      legend: { show: true, top: 0, right: 0, itemWidth: 10, itemHeight: 8, textStyle: { color: t.muted, fontSize: 10 }, data: ['Planned', 'Ridden'] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: { dataIndex: number }[]) => {
          const w = weeks[ps[0].dataIndex];
          return `<b>Week of ${fmtDate(w.start, 'd MMM')}</b>${w.phase ? `<div style="opacity:.6;font-size:11px">${w.phase}</div>` : ''}${tipRow(alpha(t.ink2, 0.35), 'Planned', `${Math.round(w.planned.tss)} TSS · ${w.planned.n} workouts`)}${w.when !== 'ahead' ? tipRow(t.accent, 'Ridden', `${Math.round(w.done.tss)} TSS`) : ''}${w.completed || w.missed ? tipRow('transparent', 'Workouts', `${w.completed} done${w.missed ? `, ${w.missed} missed` : ''}`) : ''}`;
        },
      },
      xAxis: { type: 'category', data: weeks.map((w) => fmtDate(w.start, 'd MMM')), ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } },
      yAxis: valueAxis(t, { splitNumber: 3 }),
      series: [
        { type: 'bar', name: 'Planned', barGap: '-100%', barMaxWidth: 22, data: weeks.map((w) => ({ value: Math.round(w.planned.tss), itemStyle: { color: alpha(t.ink2, w.when === 'ahead' ? 0.28 : 0.16), borderRadius: [2, 2, 0, 0] } })), itemStyle: { color: alpha(t.ink2, 0.28) } },
        { type: 'bar', name: 'Ridden', barMaxWidth: 12, data: weeks.map((w) => (w.when === 'ahead' ? null : { value: Math.round(w.done.tss), itemStyle: { color: t.accent, borderRadius: [2, 2, 0, 0] } })), itemStyle: { color: t.accent } },
      ],
    }),
    [weeks, t],
  );
  return <Chart option={option} height={height} />;
}

/** "Nothing planned 2–11 Jan: the projection counts it as rest." */
export function UnplannedNote({ o }: { o: PlanOutlook }) {
  if (!o.unplanned.length || !o.race) return null;
  return (
    <p className="flex items-start gap-1.5 text-xs text-ink-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      <span>
        Nothing planned {o.unplanned.map((g) => `${fmtDate(g.from, 'd MMM')}–${fmtDate(g.to, 'd MMM')}`).join(', ')} before {o.race.name}: the projections count {o.unplanned.length > 1 ? 'those days' : 'it'} as rest
        {o.source === 'trainerroad' ? ', until TrainerRoad fills it in' : ''}.
      </span>
    </p>
  );
}

/** How the plan's been followed, in a line. */
export function complianceText(c: NonNullable<PlanOutlook['compliance']>) {
  const pct = c.plannedTss ? Math.round((c.doneTss / c.plannedTss) * 100) : null;
  return `${c.completed} of ${c.workouts} workouts done${c.missed ? `, ${c.missed} missed` : ''}${pct != null ? ` · ${Math.round(c.doneTss)} of ${Math.round(c.plannedTss)} TSS ridden (${pct}%)` : ''}`;
}

/** The dashboard's view of the plan: the race, where the plan takes fitness and form by it, how it's been followed, and both FTP outlooks. */
export function PlanCard({ o, ctlNow }: { o: PlanOutlook; ctlNow: number | null }) {
  const t = useTokens();
  const cur = o.plan?.current;
  const rd = o.raceDay;
  const show = o.weeks.filter((w) => w.when !== 'past' || w.planned.n > 0);
  return (
    <Card
      title={o.race ? 'Plan & goal race' : 'Your plan'}
      subtitle={
        o.source === 'trainerroad' ? (
          <span className="inline-flex items-center gap-1.5">
            <TrChip /> {o.plan?.name ?? 'TrainerRoad'}
            {cur?.name ? ` · ${cur.name}${cur.end ? ` to ${fmtDate(cur.end, 'd MMM')}` : ''}` : ''}
          </span>
        ) : (
          'Your calendar'
        )
      }
      actions={
        <Link to="/calendar" className="flex items-center gap-1 text-xs text-accent hover:underline">
          Calendar <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      {o.race && (
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <Flag className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-semibold">{o.race.name}</span>
              <Badge>{o.race.priority} race</Badge>
            </div>
            <div className="text-xs text-muted">{fmtDate(o.race.date, 'EEE d MMM yyyy')}</div>
          </div>
          {rd && (
            <div className="text-right">
              <div className="text-2xl font-semibold">{rd.days}</div>
              <div className="text-[11px] text-muted">days to go</div>
            </div>
          )}
        </div>
      )}
      {rd && (
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
          <Stat label="Race CTL" value={fmtNum(rd.ctl, 0)} sub={ctlNow != null ? `${rd.ctl - ctlNow >= 0 ? '+' : ''}${fmtNum(rd.ctl - ctlNow, 0)} on today` : undefined} />
          <Stat label="Race TSB" accent={formColor(t, rd.form.id)} value={fmtNum(rd.tsb, 0)} sub={<span title={rd.form.hint}>{rd.form.label}</span>} />
          <Stat label="Planned to" value={o.plannedThrough ? fmtDate(o.plannedThrough, 'd MMM') : '–'} sub={`${o.plannedAhead} workouts`} />
        </div>
      )}
      <div className="mt-3 space-y-1.5">
        <UnplannedNote o={o} />
        {rd && rd.tsb > 25 && !o.unplanned.length && <p className="text-xs text-ink-2">Riding only what’s planned, you’d arrive very fresh: fitness falls in the run-in.</p>}
      </div>
      {show.length > 0 && (
        <div className="mt-2">
          <PlanWeeksChart weeks={show} height={140} />
        </div>
      )}
      {o.compliance && <p className="mt-1 text-xs text-muted">Followed, {o.compliance.weeks === 1 ? 'last week' : `last ${o.compliance.weeks} weeks`}: {complianceText(o.compliance)}</p>}
      {(o.ftp.app || o.ftp.trainerRoad) && (
        <div className="mt-4 border-t border-line pt-3">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">FTP outlook{o.race ? ` to ${o.race.name}` : ''}</div>
          <FtpOutlook o={o} />
        </div>
      )}
    </Card>
  );
}

/**
 * The plan against a past peak's FTP: where this app's capacity model expects your FTP by the
 * plan's end, and where TrainerRoad has its own, each set against the peak, side by side.
 */
export function PlanAgainstPeak({ o, peak, planLoad, onUse }: { o: PlanOutlook; peak: { ftp: number | null; date: string }; planLoad: number | null; onUse?: () => void }) {
  const t = useTokens();
  const app = o.ftp.app;
  const end = app?.path[app.path.length - 1] ?? null;
  const tr = o.ftp.trainerRoad;
  const pred = tr?.predicted[0] ?? null;
  const P = peak.ftp;
  const vs = (w: number) => (P ? `${Math.round((w / P) * 100)}% of it${w < P ? `, ${P - w} W short` : ''}` : '');
  const year = fmtDate(peak.date, 'MMM yyyy');
  return (
    <Card
      className="mt-4"
      title={`Your ${o.source === 'trainerroad' ? 'TrainerRoad ' : ''}plan, against ${year}`}
      subtitle={`Where the rides planned take your FTP${o.plannedThrough ? ` by ${fmtDate(o.plannedThrough, 'd MMM')}` : ''}, beside your FTP at the peak${P ? ` (${P} W)` : ''}. This app’s outlook and TrainerRoad’s are its own each: neither is used in the other.`}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg bg-surface-2 p-3">
          <Stat label="This app, by plan’s end" accent={t.accent} value={end ? end.value : '–'} unit="W" sub={end ? `from ${app!.now} W now${P ? ` · ${vs(end.value)}` : ''}` : 'its capacity model can’t say yet'} />
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <Stat
            label={<span className="inline-flex items-center gap-1"><TrChip /> TrainerRoad</span>}
            accent={trColor(t)}
            value={pred ? pred.value : (tr?.now ?? '–')}
            unit="W"
            sub={tr ? (pred ? `predicted by ${fmtDate(pred.date, 'd MMM')}${P ? ` · ${vs(pred.value)}` : ''}` : `its FTP now, no prediction out${P && tr.now ? ` · ${vs(tr.now)}` : ''}`) : 'not connected'}
          />
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <Stat label="Planned riding" value={planLoad != null ? fmtNum(planLoad, 0) : '–'} unit="TSS/wk" sub="on average, the weeks to come" />
          {onUse && (
            <button type="button" onClick={onUse} className="mt-1 text-[11px] text-accent hover:underline">
              Set the way back to it
            </button>
          )}
        </div>
      </div>
      <div className="mt-3">
        <UnplannedNote o={o} />
      </div>
    </Card>
  );
}
