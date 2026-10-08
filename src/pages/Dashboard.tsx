import { Link, useNavigate } from 'react-router-dom';
import { useMemo } from 'react';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { ArrowRight, CalendarPlus, Flag, Zap } from 'lucide-react';
import type { Activity, PlannedWorkout, PmcPoint, RaceEvent, Thresholds } from '../../shared/types';
import type { PdModel } from '../../shared/analytics/models';
import { useApi } from '../lib/api';
import { Card, PageHeader, Spinner, Stat, SportIcon, Button, Badge } from '../components/ui';
import { PmcChart, FormLegend, formColor, MiniProfile } from '../components/charts';
import { RouteThumb } from '../components/RouteThumb';
import { Chart, axisStyle, legendStyle, tooltipStyle, valueAxis, tipRow } from '../components/Chart';
import { useTokens } from '../lib/theme';
import { fmtDate, fmtDistance, fmtDuration, fmtNum, fmtPace, SPORT_LABEL } from '../lib/format';
import { useStatus } from '../components/Layout';
import { Onboarding } from './Onboarding';

interface DashboardData {
  today: PmcPoint;
  form: { id: string; label: string; hint: string } | null;
  pmc: PmcPoint[];
  week: { n: number; time: number; distance: number; tss: number; planned: { tss: number; time: number; n: number }; start: string; end: string };
  recent: Activity[];
  upcoming: PlannedWorkout[];
  events: RaceEvent[];
  nextEvent: (RaceEvent & { projected: PmcPoint | null }) | null;
  model: PdModel | null;
  thresholds: Thresholds;
  ftpBasis: 'cp' | '20min' | '60min' | null;
  weekly: { start: string; sports: Record<string, { time: number; tss: number }> }[];
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function WeeklyVolume({ weekly }: { weekly: DashboardData['weekly'] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const sports = [...new Set(weekly.flatMap((w) => Object.keys(w.sports)))].sort((a, b) => ['ride', 'run', 'swim', 'strength'].indexOf(a) - ['ride', 'run', 'swim', 'strength'].indexOf(b));
    return {
      animation: false,
      grid: { left: 36, right: 8, top: 30, bottom: 24 },
      legend: { ...legendStyle(t), data: sports.map((s) => SPORT_LABEL[s as keyof typeof SPORT_LABEL] ?? s) },
      tooltip: {
        trigger: 'axis' as const,
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const total = arr.reduce((a: number, p: any) => a + (p.value ?? 0), 0);
          return `<b>Week of ${fmtDate(weekly[arr[0].dataIndex].start, 'd MMM')}</b>${arr.filter((p: any) => p.value).map((p: any) => tipRow(p.color, p.seriesName, `${p.value.toFixed(1)} h`)).join('')}${tipRow('transparent', 'Total', `${total.toFixed(1)} h`)}`;
        },
      },
      xAxis: { type: 'category' as const, data: weekly.map((w) => fmtDate(w.start, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { axisLabel: { color: t.muted, fontSize: 11, formatter: '{value}h' } }),
      series: sports.map((s, i) => ({
        type: 'bar' as const,
        name: SPORT_LABEL[s as keyof typeof SPORT_LABEL] ?? s,
        stack: 'v',
        barMaxWidth: 18,
        itemStyle: { color: t.sport[s] ?? t.muted, borderRadius: i === sports.length - 1 ? [3, 3, 0, 0] : 0, borderColor: t.surface, borderWidth: 1 },
        data: weekly.map((w) => Math.round(((w.sports[s]?.time ?? 0) / 3600) * 10) / 10),
      })),
    };
  }, [weekly, t]);
  return <Chart option={option} height={220} />;
}

function Progress({ value, max, color }: { value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

export function Dashboard() {
  const status = useStatus();
  const { data, isLoading } = useApi<DashboardData>('/dashboard');
  const t = useTokens();
  const nav = useNavigate();
  if (status.data && status.data.activityCount === 0 && !status.data.job) return <Onboarding />;
  if (isLoading || !data) return <Spinner />;
  const { today, form, week, model, thresholds } = data;
  const formC = form ? formColor(t, form.id) : t.muted;
  const daysTo = data.nextEvent ? differenceInCalendarDays(parseISO(data.nextEvent.date), new Date()) : null;
  const wkg = thresholds.ftp && thresholds.weight ? thresholds.ftp / thresholds.weight : null;
  const auto = thresholds.sources?.ftp === 'auto';
  const basis = !auto ? 'set manually' : data.ftpBasis === '20min' ? '95% of your best 20 minutes' : data.ftpBasis === '60min' ? 'your best hour' : 'the critical-power fit';
  const projected = data.pmc.filter((p) => p.projected);
  const planned = projected.some((p) => p.tss > 0);

  return (
    <div>
      <PageHeader
        title={`${greeting()}`}
        subtitle={fmtDate(new Date(), 'EEEE d MMMM yyyy')}
        actions={
          <>
            <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => nav('/calendar')}>
              Plan training
            </Button>
            <Button variant="primary" icon={<Zap className="h-4 w-4" />} onClick={() => nav('/performance')}>
              Performance
            </Button>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="card p-4">
          <Stat label="Fitness · CTL" accent={t.ctl} value={fmtNum(today?.ctl, 0)} sub={`${today && today.ramp >= 0 ? '+' : ''}${fmtNum(today?.ramp, 1)} / week ramp`} />
        </div>
        <div className="card p-4">
          <Stat label="Fatigue · ATL" accent={t.atl} value={fmtNum(today?.atl, 0)} sub={`ACWR ${today && today.ctl > 1 ? (today.atl / today.ctl).toFixed(2) : '–'}`} />
        </div>
        <div className="card p-4">
          <Stat label="Form · TSB" accent={formC} value={fmtNum(today?.tsb, 0)} sub={<span title={form?.hint}>{form?.label}</span>} />
        </div>
        <div className="card p-4">
          <Stat label="This week · TSS" value={fmtNum(week.tss ?? 0, 0)} unit={week.planned?.tss ? `/ ${Math.round(week.planned.tss)} planned` : undefined} />
          <Progress value={week.tss ?? 0} max={week.planned?.tss || week.tss || 1} color={t.accent} />
        </div>
        <div className="card p-4">
          <Stat label="This week · time" value={fmtDuration(week.time ?? 0, { short: true })} sub={`${week.n ?? 0} activities · ${fmtDistance(week.distance ?? 0, 0)}`} />
        </div>
        <div className="card p-4">
          <Stat
            label="FTP"
            accent={t.power}
            value={thresholds.ftp || '–'}
            unit="W"
            sub={`${wkg ? `${wkg.toFixed(2)} W/kg · ` : ''}${auto ? 'auto' : 'manual'}`}
            title={`The FTP every zone and TSS uses — ${auto ? `estimated automatically, set by ${basis}` : basis}.${model ? ` The power-duration model's critical power for the last 90 days is ${Math.round(model.eftp)} W.` : ''}`}
          />
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Performance management"
          subtitle={`Fitness, fatigue and form${projected.length ? (planned ? ' — dashed lines project your planned workouts' : ' — dashed lines show what happens if you rest (nothing planned)') : ''}`}
          actions={
            <Link to="/fitness" className="flex items-center gap-1 text-xs text-accent hover:underline">
              Details <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          <PmcChart points={data.pmc} events={data.events} height={330} compact />
          <div className="mt-2">
            <FormLegend />
          </div>
        </Card>
        <div className="flex flex-col gap-4">
          {data.nextEvent && (
            <Card title="Next goal event">
              <div className="flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                  <Flag className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-semibold">{data.nextEvent.name}</span>
                    <Badge>{data.nextEvent.priority} race</Badge>
                  </div>
                  <div className="text-xs text-muted">{fmtDate(data.nextEvent.date)}</div>
                </div>
                <div className="text-right">
                  <div className="text-2xl font-semibold">{daysTo}</div>
                  <div className="text-[11px] text-muted">days to go</div>
                </div>
              </div>
              {data.nextEvent.projected && (
                <div className="mt-4 grid grid-cols-3 gap-3 rounded-lg bg-surface-2 p-3">
                  <Stat label="Proj. CTL" value={fmtNum(data.nextEvent.projected.ctl, 0)} />
                  <Stat label="Proj. TSB" value={fmtNum(data.nextEvent.projected.tsb, 0)} />
                  <Stat label="vs today" value={`${data.nextEvent.projected.ctl - today.ctl >= 0 ? '+' : ''}${fmtNum(data.nextEvent.projected.ctl - today.ctl, 0)}`} />
                </div>
              )}
              {!data.nextEvent.projected && <p className="mt-3 text-xs text-muted">Plan workouts up to race day to see projected fitness and form.</p>}
            </Card>
          )}
          <Card
            title="Up next"
            actions={
              <Link to="/calendar" className="text-xs text-accent hover:underline">
                Calendar
              </Link>
            }
            pad={false}
          >
            <div className="px-2 pb-2">
              {data.upcoming.length === 0 && <p className="px-3 py-6 text-center text-xs text-muted">No planned workouts. Build one in the Workout Builder or generate a plan.</p>}
              {data.upcoming.map((p) => (
                <Link to="/calendar" key={p.id} className="flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-surface-2">
                  <SportIcon sport={p.sport} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{p.title}</div>
                    <div className="text-[11px] text-muted">
                      {fmtDate(p.date, 'EEE d MMM')} · {fmtDuration(p.plannedDuration, { short: true })} · {fmtNum(p.plannedTss)} TSS
                    </div>
                  </div>
                  {p.structure && (
                    <div className="w-24">
                      <MiniProfile structure={p.structure} height={22} />
                    </div>
                  )}
                </Link>
              ))}
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Recent activities"
          pad={false}
          actions={
            <Link to="/activities" className="flex items-center gap-1 text-xs text-accent hover:underline">
              All activities <ArrowRight className="h-3 w-3" />
            </Link>
          }
        >
          <div className="divide-y divide-line">
            {data.recent.map((a) => (
              <Link key={a.id} to={`/activities/${a.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-surface-2">
                <RouteThumb polyline={a.polyline} color={`var(--sport-${a.sport})`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <SportIcon sport={a.sport} className="h-3.5 w-3.5" />
                    <span className="truncate text-[13px] font-medium">{a.name}</span>
                  </div>
                  <div className="text-[11px] text-muted">{fmtDate(a.startTime, 'EEE d MMM · HH:mm')}</div>
                </div>
                {/* fixed columns so rows line up; pace for runs, normalized power for rides */}
                <div className="hidden grid-cols-[72px_80px_76px_44px] gap-4 text-right sm:grid">
                  <Stat label="Time" value={<span className="text-sm">{fmtDuration(a.movingTime)}</span>} />
                  <Stat label="Distance" value={<span className="text-sm">{a.distance ? fmtDistance(a.distance, 1, a.sport) : '–'}</span>} />
                  {a.sport === 'run' || a.sport === 'swim' ? (
                    <Stat label="Pace" value={<span className="text-sm">{a.avgSpeed ? fmtPace(a.avgSpeed, a.sport, false) : '–'}</span>} />
                  ) : (
                    <Stat label={a.np ? 'NP' : 'Avg HR'} value={<span className="text-sm">{a.np ? `${a.np} W` : a.avgHr ? `${a.avgHr}` : '–'}</span>} />
                  )}
                  <Stat label="TSS" value={<span className="text-sm">{fmtNum(a.tss)}</span>} />
                </div>
              </Link>
            ))}
          </div>
        </Card>
        <Card title="Weekly volume" subtitle="Hours per week by sport, last 16 weeks">
          <WeeklyVolume weekly={data.weekly} />
        </Card>
      </div>
    </div>
  );
}
