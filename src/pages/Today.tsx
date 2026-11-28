import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { addDays, differenceInCalendarDays, parseISO, startOfWeek } from 'date-fns';
import { ArrowRight, BatteryCharging, CheckCircle2, Coffee, Flag, Flame, Moon, Plus } from 'lucide-react';
import type { Activity, PlannedWorkout, PmcPoint, Preferences, RaceEvent, Thresholds, WorkoutStep, WorkoutStructure } from '../../shared/types';
import { FORM_ZONES, formZone } from '../../shared/analytics/pmc';
import { sleepAdvice, type SleepRead } from '../../shared/analytics/sleep';
import { useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { useInspectLink } from '../lib/inspect';
import { fmtDate, fmtDistance, fmtDuration, fmtNum, iso } from '../lib/format';
import { activityTitle, sessionBrief, typeColor } from '../lib/session';
import { ARRIVES, SCENARIO_NAMES, scenarioColor, signed, useForecast } from '../lib/forecast';
import type { JournalWeek } from '../lib/weeks';
import { Chart, tipRow, tooltipStyle } from '../components/Chart';
import { WorkoutProfile, formColor, fmtForm } from '../components/charts';
import { InsightPanel, type ActivityInsights } from '../components/insights';
import { NoteList, ReviewHeadline } from '../components/review';
import { RouteThumb } from '../components/RouteThumb';
import { AddModal } from '../components/planning';
import { useStatus } from '../components/Layout';
import { Card, Skeleton, SportBadge, SportIcon, buttonClass } from '../components/ui';
import { Onboarding } from './Onboarding';

interface DashboardData {
  today: PmcPoint;
  pmc: PmcPoint[];
  recent: Activity[];
  upcoming: PlannedWorkout[];
  events: RaceEvent[];
  thresholds: Thresholds;
  latest: (ActivityInsights & { id: number }) | null;
  sleep: SleepRead | null;
}

type Tone = 'good' | 'neutral' | 'warning';

/** The heart of a workout, in watts at today's FTP: "4 × 5 min at 378–390 W", "Endurance at 200–240 W". */
export function keySet(s: WorkoutStructure, ftp: number | null): string | null {
  const dur = (sec: number) => (sec < 90 ? `${sec} s` : sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  const at = (st: WorkoutStep) => {
    if (s.target === 'power' && ftp) {
      const lo = Math.round(st.low * ftp);
      const hi = Math.round(st.high * ftp);
      return lo === hi ? `${lo} W` : `${Math.min(lo, hi)}–${Math.max(lo, hi)} W`;
    }
    const lo = Math.round(st.low * 100);
    const hi = Math.round(st.high * 100);
    return `${lo === hi ? lo : `${lo}–${hi}`}% ${s.target === 'pace' ? 'of threshold pace' : 'of LTHR'}`;
  };
  // the block with the most hard work in it: time, weighted steeply by intensity
  let best: string | null = null;
  let score = 0;
  for (const b of s.blocks) {
    if (b.kind === 'repeat') {
      const work = b.steps.filter((x) => x.intent === 'active').sort((a, c) => c.high - a.high)[0];
      const v = work ? b.count * work.duration * work.high ** 4 : 0;
      if (work && work.high >= 0.75 && v > score) {
        score = v;
        best = `${b.count} × ${dur(work.duration)} at ${at(work)}`;
      }
    } else if (b.intent === 'active' && b.high >= 0.75) {
      const v = b.duration * b.high ** 4;
      if (v > score) {
        score = v;
        best = `${dur(b.duration)} at ${at(b)}`;
      }
    }
  }
  if (best) return best;
  const steps = s.blocks.flatMap((b) => (b.kind === 'repeat' ? b.steps : [b])).filter((x) => x.intent === 'active');
  const main = [...steps].sort((a, c) => c.duration - a.duration)[0];
  return main ? `Steady at ${at(main)}` : null;
}

/** The day's call without a night's sleep to go on: from form alone. */
function formCall(tsb: number | null, ctl: number | null, planned: PlannedWorkout[]): { title: string; detail: string; tone: Tone } {
  if (tsb == null || ctl == null) return { title: 'Train as planned', detail: 'Not enough history yet to read your form.', tone: 'neutral' };
  const z = formZone(tsb, ctl);
  const hard = planned.some((p) => (p.plannedIf ?? 0) >= 0.8);
  switch (z.id) {
    case 'overload':
      return { title: hard ? 'Think twice about the hard session' : 'Keep it easy', detail: `Form ${Math.round(tsb)}: fatigue is well above your fitness. Easy riding or rest lets the training land.`, tone: 'warning' };
    case 'optimal':
      return { title: 'Train as planned', detail: `Form ${Math.round(tsb)}: tired but productive, the range that builds fitness.`, tone: 'good' };
    case 'fresh':
      return { title: hard ? 'A good day for the key session' : 'Fresh', detail: `Form +${Math.round(tsb)}: rested enough to go hard${hard ? '' : ', or to race'}.`, tone: 'good' };
    case 'transition':
      return { title: 'Fresh, maybe too fresh', detail: `Form +${Math.round(tsb)}: well rested; days like this in a row cost fitness.`, tone: 'neutral' };
    default:
      return { title: 'Train as planned', detail: `Form ${Math.round(tsb)}: neither tired nor fresh.`, tone: 'neutral' };
  }
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

/**
 * Today: how you are, what to do about it, and where it fits — this week, the race ahead, and
 * what your last ride said. Everything here opens beside the page or leads into the season.
 */
export function Today() {
  const status = useStatus();
  const { data, isLoading } = useApi<DashboardData>('/dashboard');
  const prefs = useApi<Preferences>('/preferences');
  const day = iso(new Date());
  const weekStart = (prefs.data?.weekStart ?? 1) as 0 | 1;
  const ws = iso(startOfWeek(parseISO(day), { weekStartsOn: weekStart }));
  const week = useApi<JournalWeek | null>(`/journal/week?start=${ws}`);
  const forecast = useForecast({ eventId: null, constraints: null, custom: null });
  const [adding, setAdding] = useState(false);
  if (status.data && status.data.activityCount === 0 && !status.data.job) return <Onboarding />;
  if (isLoading || !data)
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-80" />
        <Skeleton className="h-56 !rounded-2xl" />
        <Skeleton className="h-40 !rounded-2xl" />
      </div>
    );

  const point = data.today;
  const planned = data.upcoming.filter((p) => p.date === day);
  const done = data.recent.filter((a) => a.localDate === day);
  const fresh = data.sleep && data.sleep.night.date === day ? data.sleep : null;
  const call = fresh ? sleepAdvice(fresh, point?.tsb ?? null, planned.map((p) => ({ title: p.title, plannedIf: p.plannedIf }))) : formCall(point?.tsb ?? null, point?.ctl ?? null, planned);
  // the default name isn't a name
  const name = prefs.data?.athleteName?.trim() && prefs.data.athleteName.trim().toLowerCase() !== 'athlete' ? prefs.data.athleteName.trim().split(/\s+/)[0] : null;
  const f = forecast.data;
  const daysTo = f?.race ? differenceInCalendarDays(parseISO(f.race.date), parseISO(day)) : null;
  const w = week.data;
  const latestAct = data.latest ? data.recent.find((a) => a.id === data.latest!.id) : undefined;

  return (
    <div>
      {/* ---- the greeting, and the day in a sentence ---- */}
      <header className="mb-6">
        <div className="eyebrow">{fmtDate(day, 'EEEE d MMMM')}</div>
        <h1 className="mt-1.5 text-[28px] leading-9 font-semibold tracking-[-0.02em] text-ink sm:text-[32px] sm:leading-10">
          {greeting()}
          {name ? `, ${name}` : ''}.
        </h1>
        <p className="mt-1.5 text-[14px] text-ink-2">
          {[
            point ? `Form ${fmtForm(point.tsb)}, ${formZone(point.tsb, point.ctl).label.toLowerCase()}` : null,
            w ? `${Math.round(w.review.stats.tss)} TSS so far this week${w.planned.length ? ` of ${Math.round(w.planned.reduce((s, p) => s + (p.tss ?? 0), 0))} planned` : ''}` : null,
            f?.race && daysTo != null ? `${daysTo} days to ${f.race.name}` : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>

      {/* ---- the call and today's session, beside form ---- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Call call={call} point={point} sleep={fresh} hadSleep={!!data.sleep} />
          <Session planned={planned} done={done} ftp={data.thresholds.ftp || null} latest={data.latest} onAdd={() => setAdding(true)} restDay={call.tone === 'warning'} />
        </div>
        <FormCard pmc={data.pmc} today={point} />
      </div>

      {/* ---- this week ---- */}
      <section className="mt-4">
        <WeekStrip w={w} loading={week.isLoading} start={ws} today={day} upcoming={data.upcoming} />
      </section>

      {/* ---- the race ahead, and the last ride ---- */}
      <div className="mt-4 grid items-start gap-4 xl:grid-cols-2">
        <RaceAhead f={f} loading={forecast.isLoading} daysTo={daysTo} />
        {data.latest && latestAct && (data.latest.aerobic || data.latest.efforts.length > 0 || data.latest.session) ? <Latest latest={data.latest} a={latestAct} /> : <Recent recent={data.recent} />}
      </div>
      {data.latest && latestAct && (data.latest.aerobic || data.latest.efforts.length > 0 || data.latest.session) && (
        <div className="mt-4">
          <Recent recent={data.recent} />
        </div>
      )}
      {adding && <AddModal date={day} onClose={() => setAdding(false)} />}
    </div>
  );
}

// ---------- the call ----------
function Call({ call, point, sleep, hadSleep }: { call: { title: string; detail: string; tone: Tone }; point: PmcPoint | undefined; sleep: SleepRead | null; hadSleep: boolean }) {
  const t = useTokens();
  const tint = call.tone === 'good' ? t.good : call.tone === 'warning' ? t.warning : t.accent;
  const Icon = call.tone === 'good' ? CheckCircle2 : call.tone === 'warning' ? Coffee : BatteryCharging;
  return (
    <section className="card relative overflow-hidden p-6" style={{ backgroundImage: `radial-gradient(120% 140% at 0% 0%, ${alpha(tint, t.dark ? 0.16 : 0.1)} 0%, transparent 55%)` }}>
      <div className="eyebrow">Today’s call</div>
      <div className="mt-3 flex items-start gap-3">
        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl" style={{ background: alpha(tint, 0.14), color: tint }}>
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-[22px] leading-7 font-semibold tracking-[-0.015em] text-ink">{call.title}</h2>
          <p className="mt-1.5 max-w-xl text-[14px] leading-6 text-ink-2">{call.detail}</p>
        </div>
      </div>
      <div className="mt-5 flex flex-wrap gap-2 text-[12.5px]">
        {point && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-ink-2 ring-1 ring-line ring-inset">
            <span className="h-2 w-2 rounded-full" style={{ background: formColor(t, formZone(point.tsb, point.ctl).id) }} />
            Form {fmtForm(point.tsb)}
          </span>
        )}
        {sleep?.hrv && (
          <span className={clsx('inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 ring-1 ring-line ring-inset', sleep.hrv.status === 'low' ? 'text-ink' : 'text-ink-2')}>
            <span className="h-2 w-2 rounded-full" style={{ background: sleep.hrv.status === 'low' ? t.warning : t.good }} />
            HRV {Math.round(sleep.hrv.value)} ms · {sleep.hrv.status ?? 'learning'}
          </span>
        )}
        {sleep?.asleep && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1 text-ink-2 ring-1 ring-line ring-inset">
            <Moon className="h-3.5 w-3.5 text-muted" />
            {fmtDuration(sleep.asleep.value, { short: true })} asleep
          </span>
        )}
        {!sleep && hadSleep && <span className="rounded-full bg-surface px-3 py-1 text-muted ring-1 ring-line ring-inset">No sleep data for last night yet</span>}
      </div>
    </section>
  );
}

// ---------- form: where you are among the zones, and the last six weeks ----------
const LO = -0.45;
const HI = 0.4;
function FormCard({ pmc, today }: { pmc: PmcPoint[]; today: PmcPoint | undefined }) {
  const t = useTokens();
  // what's been ridden, and today — form going into today, as every page has it
  const past = pmc.filter((p) => !p.projected || p.date === today?.date);
  const now = today ?? past[past.length - 1];
  const option = useMemo(() => {
    const last = past.slice(-42);
    return {
      animation: false,
      grid: { left: 0, right: 0, top: 6, bottom: 0 },
      tooltip: { trigger: 'axis', ...tooltipStyle(t), formatter: (ps: any) => { const p = last[(Array.isArray(ps) ? ps[0] : ps).dataIndex]; return p ? `<div style="font-weight:600;margin-bottom:4px">${fmtDate(p.date, 'EEE d MMM')}</div>${tipRow(t.ctl, 'Fitness', p.ctl.toFixed(0))}${tipRow(t.atl, 'Fatigue', p.atl.toFixed(0))}${tipRow(formColor(t, formZone(p.tsb, p.ctl).id), 'Form', fmtForm(p.tsb))}` : ''; } },
      xAxis: { type: 'category', show: false, data: last.map((p) => p.date), boundaryGap: false },
      yAxis: { type: 'value', show: false, scale: true },
      series: [
        { type: 'line', name: 'Fitness', data: last.map((p) => p.ctl), showSymbol: false, smooth: 0.3, lineStyle: { color: t.ctl, width: 2 }, areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: alpha(t.ctl, 0.18) }, { offset: 1, color: alpha(t.ctl, 0) }] } } },
        { type: 'line', name: 'Fatigue', data: last.map((p) => p.atl), showSymbol: false, smooth: 0.3, lineStyle: { color: alpha(t.atl, 0.75), width: 1.25 } },
      ],
    };
  }, [past, t]);
  if (!now) return <section className="card p-6" />;
  const rel = now.ctl > 5 ? now.tsb / now.ctl : now.tsb / 30;
  const zone = formZone(now.tsb, now.ctl);
  const pos = ((Math.max(LO, Math.min(HI, rel)) - LO) / (HI - LO)) * 100;
  const zones = [...FORM_ZONES].sort((a, b) => a.min - b.min);
  const weekAgo = past.find((p) => p.date === iso(addDays(parseISO(now.date), -7)));
  return (
    <section className="card flex flex-col p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="eyebrow">Form</div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="figure text-[44px]">{fmtForm(now.tsb)}</span>
            <span className="text-[13px] font-medium text-ink-2">{zone.label}</span>
          </div>
        </div>
        <Link to="/season" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          Season <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      {/* the zones as a bar, form marked on it */}
      <div className="relative mt-4">
        <div className="flex h-2 gap-[3px] overflow-hidden rounded-full">
          {zones.map((z) => {
            const a = Math.max(LO, Number.isFinite(z.min) ? z.min : LO);
            const b = Math.min(HI, Number.isFinite(z.max) ? z.max : HI);
            return <div key={z.id} title={`${z.label}: ${z.hint}`} style={{ flexGrow: Math.max(0.01, b - a), background: alpha(formColor(t, z.id), z.id === zone.id ? 1 : 0.35) }} />;
          })}
        </div>
        <div className="absolute -top-1 h-4 w-4 -translate-x-1/2 rounded-full border-[3px] border-surface shadow" style={{ left: `${pos}%`, background: formColor(t, zone.id) }} aria-hidden />
        <div className="mt-2 flex justify-between text-[10.5px] text-muted">
          <span>Overreached</span>
          <span>Building</span>
          <span>Fresh</span>
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4">
        <div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.ctl }} />
            Fitness
          </div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="figure text-[20px]">{Math.round(now.ctl)}</span>
            {weekAgo && <span className={clsx('tnum text-[11.5px]', now.ctl - weekAgo.ctl > 0.5 ? 'text-good-text' : now.ctl - weekAgo.ctl < -0.5 ? 'text-serious' : 'text-muted')}>{signed(now.ctl - weekAgo.ctl, 1)} this week</span>}
          </div>
        </div>
        <div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.atl }} />
            Fatigue
          </div>
          <div className="figure mt-1 text-[20px]">{Math.round(now.atl)}</div>
        </div>
      </div>
      <div className="-mx-1 mt-3">
        <Chart option={option} height={64} />
      </div>
    </section>
  );
}

// ---------- today's session ----------
function Session({ planned, done, ftp, latest, onAdd, restDay }: { planned: PlannedWorkout[]; done: Activity[]; ftp: number | null; latest: DashboardData['latest']; onAdd: () => void; restDay: boolean }) {
  const t = useTokens();
  const inspectLink = useInspectLink();
  const open = planned.filter((p) => !p.activityId || !done.some((a) => a.id === p.activityId));
  if (!open.length && !done.length)
    return (
      <div className="card flex flex-wrap items-center gap-4 p-5">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-surface-2 text-muted">
          <Coffee className="h-5 w-5" />
        </span>
        <div className="min-w-[180px] flex-1">
          <div className="text-[15px] font-semibold text-ink">Nothing planned today</div>
          <p className="text-[13px] text-muted">{restDay ? 'A good day to rest and let the training land.' : 'Rest, or put a workout on it.'}</p>
        </div>
        <button type="button" onClick={onAdd} className={buttonClass('secondary', 'md', 'max-sm:w-full')}>
          <Plus className="h-4 w-4" />
          Add a workout
        </button>
      </div>
    );
  return (
    <div className="grid gap-4">
      {done.map((a) => (
        <Link key={a.id} {...inspectLink('a', a.id)} className="card block p-5 transition-colors hover:border-line-strong">
          <div className="flex items-center gap-3">
            <SportBadge sport={a.sport} size={36} />
            <div className="min-w-0 flex-1">
              <div className="eyebrow flex items-center gap-1.5 text-good-text">
                <CheckCircle2 className="h-3.5 w-3.5" /> Done today
              </div>
              <div className="truncate text-[16px] font-semibold text-ink">{activityTitle(a)}</div>
            </div>
            <div className="text-right">
              <div className="figure text-[22px]">{fmtNum(a.tss)}</div>
              <div className="text-[11px] text-muted">TSS</div>
            </div>
          </div>
          <div className="mt-1.5 pl-12 text-[12.5px] text-muted">{[sessionBrief(a), fmtDuration(a.movingTime, { short: true }), a.distance ? fmtDistance(a.distance, 1, a.sport) : null].filter(Boolean).join(' · ')}</div>
          {latest && latest.id === a.id && (
            <div className="mt-4 border-t border-line pt-4">
              <InsightPanel insights={latest} compact />
            </div>
          )}
        </Link>
      ))}
      {open.map((p) => {
        const key = p.structure ? keySet(p.structure, ftp) : null;
        return (
          <Link key={p.id} {...inspectLink('p', p.id)} className="card block p-5 transition-colors hover:border-line-strong">
            <div className="flex items-center gap-3">
              <SportBadge sport={p.sport} size={36} />
              <div className="min-w-0 flex-1">
                <div className="eyebrow">Today’s session{p.source === 'trainerroad' ? ' · TrainerRoad' : ''}</div>
                <div className="truncate text-[17px] font-semibold text-ink">{p.title}</div>
              </div>
              <div className="hidden gap-5 text-right sm:flex">
                {p.plannedDuration ? <Fig label="Time" value={fmtDuration(p.plannedDuration, { short: true })} /> : null}
                {p.plannedTss != null ? <Fig label="TSS" value={fmtNum(p.plannedTss)} /> : null}
                {p.plannedIf ? <Fig label="IF" value={p.plannedIf.toFixed(2)} /> : null}
              </div>
            </div>
            {key && (
              <div className="mt-3 flex items-center gap-2 text-[15px] font-semibold text-ink">
                <Flame className="h-4 w-4 shrink-0" style={{ color: t.serious }} />
                {key}
              </div>
            )}
            {p.structure && (
              <div className="mt-3">
                <WorkoutProfile structure={p.structure} ftp={ftp ?? undefined} height={130} />
              </div>
            )}
          </Link>
        );
      })}
    </div>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] text-muted">{label}</div>
      <div className="figure mt-0.5 text-[17px]">{value}</div>
    </div>
  );
}

// ---------- this week ----------
function WeekStrip({ w, loading, start, today, upcoming }: { w: JournalWeek | null | undefined; loading: boolean; start: string; today: string; upcoming: PlannedWorkout[] }) {
  const t = useTokens();
  const inspectLink = useInspectLink();
  if (loading) return <Skeleton className="h-44 !rounded-2xl" />;
  const days = Array.from({ length: 7 }, (_, i) => iso(addDays(parseISO(start), i)));
  const plannedTss = w ? w.planned.reduce((s, p) => s + (p.tss ?? 0), 0) : upcoming.filter((p) => days.includes(p.date)).reduce((s, p) => s + (p.plannedTss ?? 0), 0);
  const doneTss = w ? w.review.stats.tss : 0;
  const max = Math.max(80, ...days.map((d) => Math.max(w?.daily.find((x) => x.date === d)?.tss ?? 0, (w?.planned ?? []).filter((p) => p.date === d).reduce((s, p) => s + (p.tss ?? 0), 0))));
  const highlights = w ? [...w.review.signals.slice(0, 2), ...w.review.notes.filter((n) => n.tone === 'warn').slice(0, 1)] : [];
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          This week
          {w && <ReviewHeadline r={w.review} weeks={1} className="!text-[13px]" />}
        </span>
      }
      subtitle={`${Math.round(doneTss)} TSS done${plannedTss ? ` of ${Math.round(plannedTss)} planned` : ''}${w ? ` · ${w.review.stats.hours.toFixed(1)}\u00a0h · ${w.review.stats.sessions}\u00a0sessions` : ''}`}
      actions={
        <Link {...inspectLink('w', start)} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          The full week <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
        {days.map((d) => {
          const acts = w?.daily.find((x) => x.date === d)?.acts ?? [];
          const plans = (w?.planned ?? []).filter((p) => p.date === d && !p.done);
          const doneT = acts.reduce((s, a) => s + a.tss, 0);
          const planT = plans.reduce((s, p) => s + (p.tss ?? 0), 0);
          const isToday = d === today;
          const missed = plans.some((p) => p.missed);
          return (
            <Link key={d} {...inspectLink('d', d)} className={clsx('group flex min-w-0 flex-col rounded-xl p-1.5 transition-colors hover:bg-surface-2 sm:p-2', isToday && 'bg-accent-soft/70 ring-1 ring-accent/30')} title={[...acts.map((a) => `${activityTitle(a)} · ${a.tss} TSS`), ...plans.map((p) => `${p.missed ? 'Missed: ' : 'Planned: '}${p.title}${p.tss ? ` · ${p.tss} TSS` : ''}`)].join('\n') || undefined}>
              <div className={clsx('text-center text-[10.5px] font-semibold uppercase', isToday ? 'text-accent' : 'text-muted')}>{fmtDate(d, 'EEE')}</div>
              <div className="tnum text-center text-[13px] font-semibold text-ink">{fmtDate(d, 'd')}</div>
              {/* the day's load: ridden solid, planned as an outline */}
              <div className="mt-2 flex h-16 items-end justify-center gap-1">
                {acts.map((a) => (
                  <span key={a.id} className="w-2.5 rounded-t-[4px] rounded-b-[2px] sm:w-3" style={{ height: `${Math.max(8, (a.tss / max) * 64)}px`, background: a.type ? typeColor(t, a.type) : `var(--sport-${a.sport})` }} />
                ))}
                {plans.map((p) => (
                  <span key={p.id} className="w-2.5 rounded-t-[4px] rounded-b-[2px] border-[1.5px] border-dashed sm:w-3" style={{ height: `${Math.max(8, ((p.tss ?? 40) / max) * 64)}px`, borderColor: p.missed ? t.critical : t.lineStrong }} />
                ))}
                {!acts.length && !plans.length && <span className="mb-0.5 h-1 w-3 rounded-full bg-surface-3" />}
              </div>
              <div className={clsx('tnum mt-1.5 truncate text-center text-[11px]', missed ? 'text-critical' : doneT ? 'font-medium text-ink' : 'text-muted')}>{doneT ? Math.round(doneT) : planT ? `${Math.round(planT)}` : d < today ? 'rest' : '–'}</div>
            </Link>
          );
        })}
      </div>
      {highlights.length > 0 && w && (
        <div className="mt-4 border-t border-line pt-4">
          <NoteList notes={highlights} r={w.review} weeks={1} />
        </div>
      )}
    </Card>
  );
}

// ---------- the race ahead ----------
function RaceAhead({ f, loading, daysTo }: { f: ReturnType<typeof useForecast>['data']; loading: boolean; daysTo: number | null }) {
  const t = useTokens();
  const inspectLink = useInspectLink();
  if (loading) return <Skeleton className="h-56 !rounded-2xl" />;
  if (!f?.race)
    return (
      <Card title="The race ahead">
        <p className="text-[13px] text-ink-2">
          No race yet. <Link to="/season" className="font-medium text-accent hover:underline">Add one in your season</Link> and see where your training takes you on the day.
        </p>
      </Card>
    );
  const best = Math.max(...f.scenarios.map((s) => s.race.ftp ?? -Infinity));
  return (
    <section className="card overflow-hidden">
      <Link {...inspectLink('e', f.race.id)} className="flex items-center gap-4 border-b border-line p-5 hover:bg-surface-2/60">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-critical/10 text-critical">
          <Flag className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="eyebrow block">The race ahead · {f.race.priority} race</span>
          <span className="block truncate text-[18px] font-semibold text-ink">{f.race.name}</span>
          <span className="block text-[12.5px] text-muted">{fmtDate(f.race.date, 'EEEE d MMMM yyyy')}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="figure block text-[34px]">{daysTo}</span>
          <span className="text-[11.5px] text-muted">days to go</span>
        </span>
      </Link>
      <div className="divide-y divide-line">
        {f.scenarios.map((s) => (
          <Link key={s.id} to={`/season${s.id === 'planned' ? '' : `?s=${s.id}`}`} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/60">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: scenarioColor(t, s.id) }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium text-ink">{SCENARIO_NAMES[s.id]}</span>
              <span className="block truncate text-[12px] text-muted">
                arrives {ARRIVES[s.race.form] ?? s.race.formLabel.toLowerCase()} · form {signed(s.race.tsb)} · fitness {Math.round(s.race.ctl)}
              </span>
            </span>
            {s.race.ftp != null && (
              <span className={clsx('figure shrink-0 text-[19px]', s.race.ftp === best && 'text-good-text')}>
                {Math.round(s.race.ftp)}
                <span className="ml-0.5 text-[11px] font-medium text-muted">W</span>
              </span>
            )}
          </Link>
        ))}
      </div>
      <div className="border-t border-line px-5 py-3">
        <Link to="/season" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-ink hover:text-accent">
          Plan the way there <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}

// ---------- the last ride, and the ones before ----------
function Latest({ latest, a }: { latest: NonNullable<DashboardData['latest']>; a: Activity }) {
  const inspectLink = useInspectLink();
  return (
    <Card
      title={`Your latest ${a.sport === 'run' ? 'run' : a.sport === 'ride' ? 'ride' : 'session'}`}
      subtitle={`${activityTitle(a)} · ${fmtDate(a.localDate, 'EEE d MMM')}`}
      actions={
        <Link {...inspectLink('a', a.id)} className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          Open <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      <InsightPanel insights={latest} compact />
    </Card>
  );
}

function Recent({ recent }: { recent: Activity[] }) {
  const inspectLink = useInspectLink();
  return (
    <Card
      title="Recently"
      pad={false}
      actions={
        <Link to="/activities" className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink">
          All activities <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
      <div className="divide-y divide-line pb-1">
        {recent.slice(0, 5).map((a) => (
          <Link key={a.id} {...inspectLink('a', a.id)} className="flex items-center gap-3.5 px-5 py-3 hover:bg-surface-2/60">
            <RouteThumb polyline={a.polyline} color={`var(--sport-${a.sport})`} fallback={<SportIcon sport={a.sport} className="h-4 w-4" />} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-medium text-ink">{activityTitle(a)}</div>
              <div className="truncate text-[12px] text-muted">
                {fmtDate(a.startTime, 'EEE d MMM')} · {[sessionBrief(a), fmtDuration(a.movingTime, { short: true })].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="tnum shrink-0 text-right text-[13px] font-semibold text-ink">
              {fmtNum(a.tss)}
              <span className="block text-[10.5px] font-normal text-muted">TSS</span>
            </div>
          </Link>
        ))}
      </div>
    </Card>
  );
}
