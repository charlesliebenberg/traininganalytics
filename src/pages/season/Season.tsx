import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { addDays, differenceInCalendarDays, parseISO, startOfWeek, subDays } from 'date-fns';
import { AlertTriangle, BookmarkCheck, CalendarPlus, ChevronUp, ClipboardCopy, Dumbbell, Flag, Save, Wand2, X } from 'lucide-react';
import type { PlannedWorkout, PmcPoint, Preferences, RaceEvent, SeasonPlan } from '../../../shared/types';
import { http, qs, useAction, useApi } from '../../lib/api';
import { useDebounced } from '../../lib/hooks';
import { fmtDate, iso } from '../../lib/format';
import { activityTitle, sessionBrief } from '../../lib/session';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../lib/toast';
import { isGapEntry, type JournalGap, type JournalPage, type JournalWeek } from '../../lib/weeks';
import { SCENARIO_NAMES, scenarioBlurb, useForecast, type Limits, type ScenarioId } from '../../lib/forecast';
import { usePlanOutlook } from '../../components/plan';
import { AddModal } from '../../components/planning';
import { Button, Card, Empty, PageHeader, Segmented, Select, Skeleton, buttonClass } from '../../components/ui';
import { FitnessChart, PowerChart } from './SeasonChart';
import { Comparison, CustomTools, HowItWorks, LimitsMenu, ScenarioStrip, copyPlan } from './Scenarios';
import { Timeline, type ChipAct, type ChipPlan, type DayModel, type TimelineEntry, type WeekModel } from './Timeline';
import { SeasonYear } from './Year';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const storageKey = (race: number | null) => `forecast-custom:${race ?? 'horizon'}`;
/** how many weeks behind you show before you ask for more */
const PAST_SHOWN = 3;

interface CalendarData {
  planned: PlannedWorkout[];
  events: RaceEvent[];
}

/**
 * Season: your training as one timeline. The weeks behind you, reviewed; this week; the weeks
 * ahead, planned — and where each way of riding them takes you on race day. It is the journal,
 * the calendar, the forecast and the plan in one place.
 */
export function Season() {
  const loc = useLocation();
  const year = loc.pathname.startsWith('/season/year');
  return (
    <div>
      {year ? <SeasonYear lens={<Lens year />} /> : <SeasonTimeline lens={<Lens year={false} />} />}
    </div>
  );
}

function Lens({ year }: { year: boolean }) {
  return (
    <div className="inline-flex rounded-[10px] bg-surface-2 p-0.5" role="group" aria-label="View">
      <Link to="/season" aria-pressed={!year} className={clsx('rounded-lg px-3 py-1 text-[12.5px] font-medium', !year ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}>
        Weeks
      </Link>
      <Link to="/season/year" aria-pressed={year} className={clsx('rounded-lg px-3 py-1 text-[12.5px] font-medium', year ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}>
        The year
      </Link>
    </div>
  );
}

function SeasonTimeline({ lens }: { lens: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const prefs = useApi<Preferences>('/preferences');
  const weekStart = (prefs.data?.weekStart ?? 1) as 0 | 1;
  const raceParam = Number(params.get('race')) || null;
  const selected = ((params.get('s') as ScenarioId | null) ?? 'planned') as ScenarioId;
  const wanted = params.get('week');
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v == null) p.delete(k);
    else p.set(k, v);
    setParams(p, { replace: true });
  };

  // ---- the forecast: the race, your limits, your own plan (kept per race, in this browser) ----
  const [limits, setLimits] = useState<Limits | null>(null);
  const [custom, setCustomState] = useState<Record<string, number> | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const raw = useMemo(() => ({ eventId: raceParam, constraints: limits, custom }), [raceParam, limits, custom]);
  const body = useDebounced(raw, 250);
  const f = useForecast(body);
  const d = f.data ?? null;
  const key = storageKey(d?.race?.id ?? null);
  useEffect(() => {
    if (!f.data && f.isLoading) return;
    if (loadedFor === key) return;
    setLoadedFor(key);
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      setCustomState(saved && typeof saved === 'object' ? saved : null);
    } catch {
      setCustomState(null);
    }
  }, [f.data, f.isLoading, key, loadedFor]);
  const setCustom = (c: Record<string, number> | null) => {
    setCustomState(c);
    try {
      if (c) localStorage.setItem(key, JSON.stringify(c));
      else localStorage.removeItem(key);
    } catch {}
    if (c && selected !== 'custom') setParam('s', 'custom');
    if (!c && selected === 'custom') setParam('s', null);
  };
  const shownLimits = limits ?? d?.constraints ?? null;
  const today = d?.today ?? iso(new Date());
  const sel = d?.scenarios.find((s) => s.id === selected) ?? d?.scenarios.find((s) => s.id === 'planned') ?? null;
  const save = useAction((b: typeof body & { scenario: ScenarioId }) => http<{ id: number; name: string; weeks: number }>('/forecast/save', { method: 'POST', json: b }), {
    success: (r) => `Kept “${r.name}” as your plan: its ${r.weeks} weeks now guide every projection`,
  });
  // the plan kept last is the one projections ride
  const plans = useApi<SeasonPlan[]>('/plans');
  const kept = plans.data?.length ? [...plans.data].sort((a, b) => b.id - a.id)[0] : null;
  const unkeep = useAction((id: number) => http(`/plans/${id}`, { method: 'DELETE' }), { success: 'Plan removed: projections follow your calendar alone' });
  // without a plan kept elsewhere (TrainerRoad), the kept plan can put real workouts on the days
  const fill = useAction((id: number) => http<{ created: number }>(`/plans/${id}/apply`, { method: 'POST', json: { weeks: 4 } }), { success: (r) => (r.created ? `Put ${r.created} workouts on the next four weeks, sized to the plan` : 'Nothing to add: the next weeks are already planned') });

  // ---- the weeks: behind you from the journal, ahead from the calendar ----
  const thisWeek = iso(startOfWeek(parseISO(today), { weekStartsOn: weekStart }));
  const lastWeek = iso(startOfWeek(parseISO(d?.end ?? iso(addDays(parseISO(today), 56))), { weekStartsOn: weekStart }));
  const journal = useInfiniteQuery<JournalPage>({
    queryKey: ['/journal'],
    queryFn: ({ pageParam }) => http<JournalPage>(`/journal${qs({ before: pageParam as string | null })}`),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
  });
  const cal = useApi<CalendarData>(`/calendar${qs({ from: thisWeek, to: iso(addDays(parseISO(lastWeek), 6)) })}`, { placeholderData: (p) => p });
  const events = useApi<RaceEvent[]>('/events');
  const outlook = usePlanOutlook();
  const history = useApi<PmcPoint[]>(`/pmc${qs({ from: iso(subDays(parseISO(today), 7 * 14)), to: today })}`);
  const [pastShown, setPastShown] = useState(PAST_SHOWN);
  const [adding, setAdding] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const move = useAction(({ id, date }: { id: number; date: string }) => http(`/planned/${id}`, { method: 'PATCH', json: { date } }).then(() => date), { success: (x) => `Moved to ${fmtDate(x, 'EEE d MMM')}` });

  const journalEntries = useMemo(() => journal.data?.pages.flatMap((p) => p.weeks) ?? [], [journal.data]);
  const pastAll = useMemo(() => journalEntries.filter((e) => (isGapEntry(e) ? e.to < thisWeek : e.start < thisWeek)).reverse(), [journalEntries, thisWeek]);
  const entries = useMemo<TimelineEntry[]>(() => {
    const eventsOn = (date: string) => (events.data ?? []).filter((e) => e.date === date).map((e) => ({ id: e.id, name: e.name, priority: e.priority }));
    const raceDate = d?.race?.date ?? null;
    const inWeek = (ws: string, date: string | null) => !!date && date >= ws && date <= iso(addDays(parseISO(ws), 6));
    const chipAct = (a: JournalWeek['daily'][number]['acts'][number]): ChipAct => ({ id: a.id, sport: a.sport, title: activityTitle(a), brief: sessionBrief({ sport: a.sport, sessionType: a.type, sessionLong: a.long, mainSet: a.mainSet }), tss: a.tss, moving: a.moving, type: a.type, felt: a.felt });
    const scenarioDay = new Map(sel && selected !== 'planned' ? sel.days.map((x) => [x.date, x.load]) : []);
    const fromJournal = (w: JournalWeek, when: 'past' | 'now'): WeekModel => {
      const days: DayModel[] = w.daily.map((day) => {
        const plans: ChipPlan[] = w.planned.filter((p) => p.date === day.date && !p.done).map((p) => ({ id: p.id, sport: p.sport, title: p.title, tss: p.tss, duration: p.duration, missed: p.missed, followed: p.source === 'trainerroad' }));
        const free = !plans.length && day.date > today;
        return { date: day.date, acts: day.acts.map(chipAct), plans, races: eventsOn(day.date), target: free ? (scenarioDay.get(day.date) ?? null) : null };
      });
      const sw = when === 'now' && selected !== 'planned' ? sel?.weeks.find((x) => x.start === w.start) : undefined;
      const warn = w.review.notes.filter((n) => n.tone === 'warn');
      return {
        start: w.start,
        end: w.end,
        when,
        phase: w.phase,
        days,
        done: w.review.stats.tss,
        planned: w.planned.reduce((s, p) => s + (p.tss ?? 0), 0),
        target: sw ? sw.tss : null,
        hours: w.review.stats.hours,
        ctl: w.pmc.ctl1,
        ctlDelta: w.pmc.ctl0 != null && w.pmc.ctl1 != null ? w.pmc.ctl1 - w.pmc.ctl0 : null,
        tsb: w.pmc.tsb1,
        ramp: null,
        review: w.review,
        highlights: [...w.review.signals.slice(0, 2), ...warn.slice(0, 1)],
        raceWeek: inWeek(w.start, raceDate),
      };
    };
    const ahead = (ws: string, when: 'now' | 'ahead'): WeekModel => {
      const days: DayModel[] = Array.from({ length: 7 }, (_, i) => {
        const date = iso(addDays(parseISO(ws), i));
        const plans: ChipPlan[] = (cal.data?.planned ?? [])
          .filter((p) => p.date === date && !p.activityId)
          .map((p) => ({ id: p.id, sport: p.sport, title: p.title, tss: p.plannedTss, duration: p.plannedDuration, missed: date < today, followed: p.source === 'trainerroad', structure: p.structure }));
        return { date, acts: [], plans, races: eventsOn(date), target: !plans.length && date > today ? (scenarioDay.get(date) ?? null) : null };
      });
      const sw = sel?.weeks.find((x) => x.start === ws);
      const fw = d?.weeks.find((x) => x.start === ws);
      const planned = days.reduce((s, x) => s + x.plans.reduce((a, p) => a + (p.tss ?? 0), 0), 0);
      return {
        start: ws,
        end: iso(addDays(parseISO(ws), 6)),
        when,
        phase: fw?.phase ?? null,
        days,
        done: when === 'now' ? 0 : null,
        planned,
        target: selected !== 'planned' && sw ? sw.tss : null,
        hours: sw ? sw.hours : null,
        ctl: sw?.ctl ?? null,
        ctlDelta: sw?.ramp ?? null,
        tsb: sw?.tsb ?? null,
        ramp: sw?.ramp ?? null,
        review: null,
        highlights: [],
        raceWeek: inWeek(ws, raceDate),
      };
    };
    const past: TimelineEntry[] = pastAll.slice(-pastShown).map((e) => (isGapEntry(e) ? (e as JournalGap) : fromJournal(e, 'past')));
    const cur = journalEntries.find((e): e is JournalWeek => !isGapEntry(e) && e.start === thisWeek);
    const now = cur ? fromJournal(cur, 'now') : ahead(thisWeek, 'now');
    const future: WeekModel[] = [];
    for (let ws = iso(addDays(parseISO(thisWeek), 7)); ws <= lastWeek; ws = iso(addDays(parseISO(ws), 7))) future.push(ahead(ws, 'ahead'));
    return [...past, now, ...future];
  }, [pastAll, pastShown, journalEntries, thisWeek, lastWeek, cal.data, events.data, d, sel, selected, today]);

  // ---- going to a week: from a link (?week=), the chart, or "earlier weeks" ----
  const goToWeek = (date: string) => {
    const ws = iso(startOfWeek(parseISO(date), { weekStartsOn: weekStart }));
    if (ws < thisWeek) {
      const idx = pastAll.findIndex((e) => !isGapEntry(e) && e.start === ws);
      if (idx >= 0) setPastShown((n) => Math.max(n, pastAll.length - idx));
    }
    setFlash(ws);
    requestAnimationFrame(() => setTimeout(() => document.getElementById(`week-${ws}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 30));
    setTimeout(() => setFlash((x) => (x === ws ? null : x)), 1800);
  };
  const gone = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || gone.current === wanted || !journal.data) return;
    const ws = iso(startOfWeek(parseISO(wanted), { weekStartsOn: weekStart }));
    const loaded = ws >= thisWeek || pastAll.some((e) => (isGapEntry(e) ? e.from <= ws && e.to >= ws : e.start <= ws));
    if (!loaded && journal.hasNextPage && !journal.isFetchingNextPage) {
      journal.fetchNextPage();
      return;
    }
    gone.current = wanted;
    goToWeek(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, journal.data, journal.hasNextPage, journal.isFetchingNextPage, pastAll, thisWeek, weekStart]);
  const earlier = () => {
    const next = pastShown + 4;
    if (pastAll.length < next && journal.hasNextPage && !journal.isFetchingNextPage) journal.fetchNextPage();
    setPastShown(next);
  };
  const moreBehind = pastAll.length > pastShown || journal.hasNextPage;

  const [chartLens, setChartLens] = useState<'fitness' | 'ftp'>('fitness');
  const dayNames = Array.from({ length: 7 }, (_, i) => DAY_NAMES[(i + weekStart) % 7]);
  const daysTo = d?.race ? differenceInCalendarDays(parseISO(d.race.date), parseISO(today)) : null;
  const upcoming = (events.data ?? []).filter((e) => e.date > today);
  const loading = f.isLoading || journal.isLoading;

  return (
    <>
      <PageHeader
        eyebrow={<span className="inline-flex items-center gap-2">Season</span>}
        title={d?.race ? `Towards ${d.race.name}` : 'The weeks ahead'}
        subtitle={
          d?.race ? (
            <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1 font-medium text-ink-2">
                <Flag className="h-3.5 w-3.5 text-critical" />
                {d.race.priority} race · {fmtDate(d.race.date, 'EEEE d MMMM yyyy')}
              </span>
              <span>· {daysTo} days to go · fitness {Math.round(d.now.ctl)} today</span>
            </span>
          ) : (
            'Your weeks behind and ahead. Add a race to see where your training takes you on the day.'
          )
        }
        actions={
          <>
            {lens}
            {upcoming.length > 1 && (
              <Select value={String(d?.race?.id ?? '')} onChange={(e) => setParam('race', e.target.value || null)} aria-label="Race to plan for" className="max-w-52">
                {upcoming.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.priority} · {e.name} · {fmtDate(e.date, 'd MMM')}
                  </option>
                ))}
              </Select>
            )}
            <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setAdding(iso(addDays(parseISO(today), 28)) + '#race')}>
              Add a race
            </Button>
            <Link to="/season/workouts" className={buttonClass('ghost')} title="Build and keep workouts, then put them on any day">
              <Dumbbell className="h-4 w-4" />
              Workouts
            </Link>
          </>
        }
      />

      {/* ---- the ways forward ---- */}
      {d ? (
        <section aria-label="Ways to race day" className="mb-4">
          <ScenarioStrip d={d} selected={sel?.id ?? 'planned'} onSelect={(id) => setParam('s', id === 'planned' ? null : id)} onStartCustom={() => {
            const best = d.scenarios.find((s) => s.id === 'best') ?? d.scenarios[0];
            setCustom(Object.fromEntries(best.weeks.map((w) => [w.start, Math.round(w.tss / 5) * 5])));
          }} />
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-[min(100%,320px)] flex-1 text-[12.5px] text-muted">
              <span className="font-medium text-ink-2">{SCENARIO_NAMES[sel?.id ?? 'planned']}:</span> {scenarioBlurb(sel?.id ?? 'planned', d)}
              {sel?.warnings.map((w) => (
                <span key={w} className="ml-2 inline-flex items-center gap-1 text-ink-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                  {w}
                </span>
              ))}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {shownLimits && <LimitsMenu d={d} limits={shownLimits} setLimits={setLimits} />}
              <Button icon={<ClipboardCopy className="h-4 w-4" />} onClick={() => sel && copyText(copyPlan(d, sel)).then(() => toast(`${SCENARIO_NAMES[sel.id]} copied: week by week, to paste anywhere`), (e: Error) => toast(e.message, 'error'))}>
                Copy
              </Button>
              <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} disabled={!sel} onClick={() => sel && save.mutate({ ...body, scenario: sel.id })} title="Keep it as your plan: its weekly targets show here and guide every projection; workouts you plan stay in charge of their days">
                Make it my plan
              </Button>
            </div>
          </div>
          {selected === 'custom' && <div className="mt-3"><CustomTools d={d} setCustom={setCustom} /></div>}
          {kept && (
            <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-line bg-surface px-3.5 py-2 text-[12.5px]">
              <BookmarkCheck className="h-4 w-4 shrink-0 text-good" />
              <span className="font-medium text-ink">Your plan: {kept.name}</span>
              <span className="text-muted">kept {fmtDate(kept.createdAt, 'd MMM')} · its weekly targets fill the days nothing is planned on, in every projection</span>
              {outlook.data?.source !== 'trainerroad' && (
                <Button size="sm" variant="ghost" className="ml-auto" icon={<Wand2 className="h-3.5 w-3.5" />} loading={fill.isPending} onClick={() => fill.mutate(kept.id)} title="Generate workouts for the next four weeks, each week's sized to the plan's target">
                  Fill the next 4 weeks
                </Button>
              )}
              <Button size="sm" variant="ghost" className={outlook.data?.source !== 'trainerroad' ? '' : 'ml-auto'} icon={<X className="h-3.5 w-3.5" />} loading={unkeep.isPending} onClick={() => confirm(`Stop following “${kept.name}”?`) && unkeep.mutate(kept.id)}>
                Remove
              </Button>
            </div>
          )}
        </section>
      ) : loading ? (
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-[132px] !rounded-2xl" />
          ))}
        </div>
      ) : null}

      {/* ---- the picture ---- */}
      <Card
        className="mb-4"
        title={chartLens === 'fitness' ? 'Fitness and form' : 'FTP'}
        subtitle={chartLens === 'fitness' ? `The last 14 weeks as ridden${d ? `, then each way to ${d.race ? 'race day' : fmtDate(d.end, 'd MMM')}: ${SCENARIO_NAMES[sel?.id ?? 'planned'].toLowerCase()} in bold` : ''} · click a day to find its week` : `Where your FTP goes under each way forward, the likely range shaded${d?.trainerRoad ? ', with TrainerRoad’s own' : ''}`}
        actions={d ? <Segmented size="sm" value={chartLens} onChange={setChartLens} options={[{ value: 'fitness', label: 'Fitness' }, { value: 'ftp', label: 'FTP' }]} /> : undefined}
      >
        {history.data ? chartLens === 'fitness' || !d ? <FitnessChart history={history.data} d={d} selected={sel?.id ?? 'planned'} events={events.data ?? []} phases={outlook.data?.plan?.phases ?? []} onPick={goToWeek} height={330} /> : <PowerChart d={d} selected={sel?.id ?? 'planned'} height={330} /> : <Skeleton className="h-[330px]" />}
      </Card>

      {/* ---- the weeks ---- */}
      {loading && !journal.data ? (
        <Skeleton className="h-96 !rounded-2xl" />
      ) : !journalEntries.length && !cal.data?.planned.length ? (
        <Card>
          <Empty icon={<CalendarPlus />} title="Nothing here yet">
            Every week you train shows up here with its review, and every workout you plan with where it takes you. <Link to="/settings?tab=import" className="text-accent hover:underline">Import activities</Link> or connect Strava.
          </Empty>
        </Card>
      ) : (
        <Timeline
          entries={entries}
          today={today}
          dayNames={dayNames}
          flash={flash}
          selected={sel?.id ?? 'planned'}
          editable={selected === 'custom' && !!custom}
          custom={custom}
          onCustom={(week, tss) => setCustom({ ...(custom ?? {}), [week]: tss })}
          onAdd={(date) => setAdding(date)}
          onMove={(id, date) => move.mutate({ id, date })}
          head={
            moreBehind ? (
              <button type="button" onClick={earlier} className="flex w-full items-center justify-center gap-1.5 border-b border-line py-2.5 text-[12.5px] font-medium text-ink-2 hover:bg-surface-2 hover:text-ink">
                <ChevronUp className="h-4 w-4" />
                {journal.isFetchingNextPage ? 'Loading earlier weeks…' : 'Earlier weeks'}
              </button>
            ) : undefined
          }
        />
      )}

      {/* ---- the ways forward, side by side, and how it's worked out ---- */}
      {d && (
        <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <Card title="The ways forward, side by side" subtitle="Best of each row in green">
            <Comparison d={d} />
          </Card>
          <Card title="How the forecast works">
            <HowItWorks d={d} />
          </Card>
        </div>
      )}
      {adding && <AddModal date={adding.replace('#race', '')} initial={adding.endsWith('#race') ? 'event' : 'library'} onClose={() => setAdding(null)} />}
    </>
  );
}
