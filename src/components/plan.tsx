import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import type { FtpPoint } from '../../shared/analytics/trainerroad';
import { useApi } from '../lib/api';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate, fmtNum } from '../lib/format';
import { Card, Stat } from './ui';
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
  /** what to ride on the unplanned days to arrive fresh, when the plan as it stands doesn't */
  readiness: {
    stretches: { from: string; to: string; days: number; daily: number; hours: number | null; taper: boolean }[];
    ctl: number;
    tsb: number;
    form: { id: string; label: string; hint: string };
  } | null;
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
const span = (from: string, to: string) => (from === to ? fmtDate(from, 'd MMM') : `${fmtDate(from, 'd')}–${fmtDate(to, 'd MMM')}`);
const hoursText = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.floor(h)}${h % 1 >= 0.75 ? '¾' : h % 1 >= 0.5 ? '½' : h % 1 >= 0.25 ? '¼' : ''} h`);
const signedForm = (v: number) => (Math.round(v) > 0 ? `+${Math.round(v)}` : `${Math.round(v)}`);

/**
 * Days with nothing planned before the race count as rest in every projection — and when that
 * leaves race day short of fresh, what riding them would take to arrive fresh and fit.
 */
export function UnplannedNote({ o }: { o: PlanOutlook }) {
  const t = useTokens();
  if (!o.unplanned.length || !o.race) return null;
  const r = o.readiness;
  const rd = o.raceDay;
  return (
    <div className="space-y-2">
      <p className="flex items-start gap-1.5 text-xs text-ink-2">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
        <span>
          Nothing planned {o.unplanned.map((g) => `${fmtDate(g.from, 'd MMM')}–${fmtDate(g.to, 'd MMM')}`).join(', ')} before {o.race.name}: the projections count {o.unplanned.length > 1 ? 'those days' : 'it'} as rest
          {o.source === 'trainerroad' ? ', until TrainerRoad fills it in' : ''}.
        </span>
      </p>
      {r && rd && (
        <div className="rounded-lg border border-line bg-surface-2/60 p-3 text-xs">
          <div className="mb-1.5 font-medium text-ink">To arrive fresh, ride them</div>
          <ul className="space-y-1 text-ink-2">
            {r.stretches.map((s) => (
              <li key={s.from} className="flex justify-between gap-3">
                <span>
                  {span(s.from, s.to)}
                  {s.taper ? <span className="text-muted"> · race week, a taper</span> : null}
                </span>
                <span className="tnum shrink-0 text-ink">
                  ~{s.daily} TSS a day{s.hours ? <span className="text-muted"> · {hoursText(s.hours)}</span> : null}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 flex flex-wrap items-center gap-x-1.5 border-t border-line pt-2 text-ink-2">
            <span>Race day:</span>
            <span className="inline-flex items-center gap-1 font-medium text-ink">
              CTL {Math.round(r.ctl)}, form {signedForm(r.tsb)}
              <span className="h-2 w-2 rounded-sm" style={{ background: formColor(t, r.form.id) }} />
              {r.form.label.toLowerCase()}
            </span>
            <span className="text-muted">
              against CTL {Math.round(rd.ctl)}, {signedForm(rd.tsb)} ({rd.form.label.toLowerCase()}) if they stay empty
            </span>
          </div>
          <Link to="/season?s=filled" className="mt-2 inline-flex items-center gap-1 text-accent hover:underline">
            Compare the ways forward <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      )}
    </div>
  );
}

/** How the plan's been followed, in a line. */
export function complianceText(c: NonNullable<PlanOutlook['compliance']>) {
  const pct = c.plannedTss ? Math.round((c.doneTss / c.plannedTss) * 100) : null;
  return `${c.completed} of ${c.workouts} workouts done${c.missed ? `, ${c.missed} missed` : ''}${pct != null ? ` · ${Math.round(c.doneTss)} of ${Math.round(c.plannedTss)} TSS ridden (${pct}%)` : ''}`;
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
