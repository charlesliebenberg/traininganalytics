import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Flag, Plus, Sparkles, XCircle } from 'lucide-react';
import type { WorkoutStructure } from '../../../shared/types';
import type { Review, ReviewNote } from '../../../shared/analytics/review';
import type { SessionType } from '../../../shared/analytics/session';
import { useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, fmtDuration, fmtNum } from '../../lib/format';
import { typeColor } from '../../lib/session';
import { scenarioColor, SCENARIO_NAMES, signed, type ScenarioId } from '../../lib/forecast';
import { formColor } from '../../components/charts';
import { NoteList, ReviewHeadline } from '../../components/review';
import { surveyFailed, surveyText, type SurveyAnswer } from '../../components/trainerroad';
import { PRIORITY_COLOR } from '../../components/planning';
import { SportIcon } from '../../components/ui';

// ---------- the model the page builds ----------
export interface ChipAct {
  id: number;
  sport: string;
  title: string;
  brief: string | null;
  tss: number;
  moving: number;
  type: SessionType | null;
  felt: SurveyAnswer | null;
}
export interface ChipPlan {
  id: number;
  sport: string;
  title: string;
  tss: number | null;
  duration: number | null;
  missed: boolean;
  followed: boolean;
  structure?: WorkoutStructure | null;
}
export interface DayModel {
  date: string;
  acts: ChipAct[];
  plans: ChipPlan[];
  races: { id: number; name: string; priority: string }[];
  /** the chosen way forward's load on a day with nothing planned */
  target: number | null;
}
export interface WeekModel {
  start: string;
  end: string;
  when: 'past' | 'now' | 'ahead';
  phase: string | null;
  days: DayModel[];
  done: number | null;
  planned: number;
  target: number | null;
  hours: number | null;
  ctl: number | null;
  ctlDelta: number | null;
  tsb: number | null;
  ramp: number | null;
  review: Review | null;
  highlights: ReviewNote[];
  raceWeek: boolean;
}
export type TimelineEntry = WeekModel | { gap: true; from: string; to: string; weeks: number };
const isGap = (e: TimelineEntry): e is { gap: true; from: string; to: string; weeks: number } => 'gap' in e;

interface Props {
  entries: TimelineEntry[];
  today: string;
  dayNames: string[];
  flash: string | null;
  selected: ScenarioId;
  editable: boolean;
  custom: Record<string, number> | null;
  onCustom: (week: string, tss: number) => void;
  onAdd: (date: string) => void;
  onMove: (id: number, date: string) => void;
  head?: ReactNode;
}

/**
 * The season as weeks, oldest at the top: each week's days with what was ridden, planned, missed
 * or raced, and what it came to — the review for the weeks behind you, the plan and where it
 * leads for the weeks ahead. Anything in it opens in the inspector; planned workouts drag to
 * another day; a free day takes a new one.
 */
export function Timeline({ entries, today, dayNames, flash, selected, editable, custom, onCustom, onAdd, onMove, head }: Props) {
  const [over, setOver] = useState<string | null>(null);
  const drop = (date: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('planned')) return;
      e.preventDefault();
      setOver(date);
    },
    onDragLeave: () => setOver((x) => (x === date ? null : x)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = Number(e.dataTransfer.getData('planned'));
      if (id) onMove(id, date);
    },
  });
  return (
    <div className="card overflow-clip">
      {head}
      {/* the days of the week, kept in view while the weeks scroll under them */}
      <div className="sticky top-0 z-20 hidden grid-cols-[92px_repeat(7,minmax(0,1fr))_184px] border-b border-line bg-surface/95 backdrop-blur lg:grid">
        <div className="eyebrow px-4 py-2.5">Week</div>
        {dayNames.map((d) => (
          <div key={d} className="eyebrow px-2 py-2.5">
            {d}
          </div>
        ))}
        <div className="eyebrow px-4 py-2.5">The week</div>
      </div>
      <div>
        {entries.map((e) =>
          isGap(e) ? (
            <div key={`gap-${e.from}`} className="flex items-center gap-3 border-b border-line bg-surface-2/40 px-4 py-2.5 text-[12px] text-muted">
              <span className="h-px flex-1 bg-line" />
              {e.weeks} {e.weeks === 1 ? 'week' : 'weeks'} without training · {fmtDate(e.from, 'd MMM')} – {fmtDate(e.to, 'd MMM yyyy')}
              <span className="h-px flex-1 bg-line" />
            </div>
          ) : (
            <Week key={e.start} w={e} today={today} flash={flash === e.start} selected={selected} editable={editable && e.when !== 'past'} custom={custom} onCustom={onCustom} onAdd={onAdd} over={over} drop={drop} />
          ),
        )}
      </div>
    </div>
  );
}

function Week({ w, today, flash, selected, editable, custom, onCustom, onAdd, over, drop }: { w: WeekModel; today: string; flash: boolean; selected: ScenarioId; editable: boolean; custom: Record<string, number> | null; onCustom: (week: string, tss: number) => void; onAdd: (date: string) => void; over: string | null; drop: (date: string) => Record<string, unknown> }) {
  const inspectLink = useInspectLink();
  const now = w.when === 'now';
  return (
    <section
      id={`week-${w.start}`}
      className={clsx('relative scroll-mt-16 border-b border-line last:border-b-0', now && 'bg-accent-soft/40', w.when === 'ahead' && 'bg-surface', flash && 'animate-flash')}
      aria-label={`Week of ${fmtDate(w.start, 'd MMMM')}`}
    >
      {now && <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden />}
      {/* wide: a calendar row */}
      <div className="hidden grid-cols-[92px_repeat(7,minmax(0,1fr))_184px] lg:grid">
        <Link {...inspectLink('w', w.start)} className="group flex flex-col gap-1 px-4 py-3 hover:bg-surface-2/60">
          <span className={clsx('text-[13px] leading-tight font-semibold', now ? 'text-accent' : 'text-ink')}>{fmtDate(w.start, 'd MMM')}</span>
          <span className="text-[11px] text-muted">{now ? 'This week' : w.when === 'ahead' ? weeksAway(w.start, today) : fmtDate(w.end, '– d MMM')}</span>
          {w.phase && <span className="mt-1 w-fit max-w-full truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-2 ring-1 ring-line ring-inset">{w.phase}</span>}
          {w.raceWeek && (
            <span className="mt-0.5 inline-flex items-center gap-1 text-[10.5px] font-semibold text-critical">
              <Flag className="h-3 w-3" />
              Race week
            </span>
          )}
        </Link>
        {w.days.map((d) => (
          <Day key={d.date} d={d} today={today} selected={selected} onAdd={onAdd} over={over === d.date} drop={d.date >= today ? drop(d.date) : {}} />
        ))}
        <div className="border-l border-line px-4 py-3">
          <Summary w={w} selected={selected} editable={editable} custom={custom} onCustom={onCustom} />
        </div>
      </div>
      {w.when !== 'ahead' && w.highlights.length > 0 && (
        <div className="hidden border-t border-dashed border-line px-4 py-2 lg:block lg:pl-[108px]">
          <NoteList notes={w.highlights.slice(0, 2)} r={w.review!} weeks={1} />
        </div>
      )}

      {/* narrow: the week as a list of days */}
      <div className="lg:hidden">
        <div className="flex items-start justify-between gap-3 px-4 pt-3.5 pb-2">
          <Link {...inspectLink('w', w.start)} className="min-w-0">
            <div className={clsx('text-[14px] font-semibold', now ? 'text-accent' : 'text-ink')}>
              {fmtDate(w.start, 'd MMM')} – {fmtDate(w.end, 'd MMM')}
              {now && <span className="ml-1.5 text-[11px] font-medium text-muted">this week</span>}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted">
              {w.phase && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 font-medium text-ink-2 ring-1 ring-line ring-inset">{w.phase}</span>}
              {w.raceWeek && <span className="font-semibold text-critical">Race week</span>}
              {w.review && w.when !== 'ahead' && <ReviewHeadline r={w.review} weeks={1} className="!text-[11.5px]" />}
            </div>
          </Link>
          <div className="shrink-0 text-right">
            <SummaryCompact w={w} selected={selected} editable={editable} custom={custom} onCustom={onCustom} />
          </div>
        </div>
        <div className="space-y-px px-2 pb-2">
          {w.days
            .filter((d) => d.acts.length || d.plans.length || d.races.length || d.target || d.date === today)
            .map((d) => (
              <DayLine key={d.date} d={d} today={today} selected={selected} onAdd={onAdd} />
            ))}
          {w.days.every((d) => !d.acts.length && !d.plans.length && !d.races.length && !d.target && d.date !== today) && <p className="px-2 pb-1 text-[12px] text-muted">{w.when === 'past' ? 'No training.' : 'Nothing planned yet.'}</p>}
        </div>
      </div>
    </section>
  );
}

/** Weeks from this one: today sits in this week, so any later week start is 1, 2, 3… weeks on. */
const weeksAway = (start: string, today: string) => {
  const n = Math.ceil((new Date(start).getTime() - new Date(today).getTime()) / (7 * 86400000));
  return n <= 1 ? 'Next week' : `In ${n} weeks`;
};

function Day({ d, today, selected, onAdd, over, drop }: { d: DayModel; today: string; selected: ScenarioId; onAdd: (date: string) => void; over: boolean; drop: Record<string, unknown> }) {
  const inspectLink = useInspectLink();
  const isToday = d.date === today;
  const ahead = d.date >= today;
  return (
    <div {...drop} className={clsx('group/day relative flex min-h-[104px] min-w-0 flex-col border-l border-line p-1.5 transition-colors', over && 'bg-accent-soft', isToday && 'bg-accent-soft/70')}>
      <div className="mb-1 flex items-center justify-between px-1">
        <Link {...inspectLink('d', d.date)} className={clsx('tnum rounded-md text-[11.5px] font-semibold hover:text-accent', isToday ? 'flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-white hover:text-white' : 'text-muted')} aria-label={fmtDate(d.date, 'EEEE d MMMM')}>
          {fmtDate(d.date, 'd')}
        </Link>
        {ahead && (
          <button type="button" onClick={() => onAdd(d.date)} className="rounded-md p-0.5 text-muted opacity-0 transition-opacity group-hover/day:opacity-100 hover:bg-surface-3 hover:text-ink focus:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Add to ${fmtDate(d.date, 'EEEE d MMMM')}`} title="Add a workout or race">
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <Chips d={d} today={today} selected={selected} />
        {/* the rest of the cell opens the day */}
        <Link {...inspectLink('d', d.date)} className="min-h-3 flex-1 rounded-md" aria-hidden tabIndex={-1} />
      </div>
    </div>
  );
}

function DayLine({ d, today, selected, onAdd }: { d: DayModel; today: string; selected: ScenarioId; onAdd: (date: string) => void }) {
  const inspectLink = useInspectLink();
  const isToday = d.date === today;
  const empty = !d.acts.length && !d.plans.length && !d.races.length && !d.target;
  return (
    <div className={clsx('flex gap-2.5 rounded-xl px-2 py-1.5', isToday && 'bg-accent-soft/70')}>
      <Link {...inspectLink('d', d.date)} className="w-10 shrink-0 pt-1 text-center">
        <div className={clsx('text-[10px] font-semibold uppercase', isToday ? 'text-accent' : 'text-muted')}>{fmtDate(d.date, 'EEE')}</div>
        <div className="tnum text-[14px] leading-tight font-semibold">{fmtDate(d.date, 'd')}</div>
      </Link>
      <div className="min-w-0 flex-1 space-y-1 py-0.5">
        {empty ? <div className="py-1.5 text-[12px] text-muted">{d.date < today ? 'Rest' : 'Nothing planned'}</div> : <Chips d={d} today={today} selected={selected} wide />}
      </div>
      {d.date >= today && (
        <button type="button" onClick={() => onAdd(d.date)} className="self-start rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink" aria-label={`Add to ${fmtDate(d.date, 'EEEE d MMMM')}`}>
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function Chips({ d, today, selected, wide = false }: { d: DayModel; today: string; selected: ScenarioId; wide?: boolean }) {
  const t = useTokens();
  const inspectLink = useInspectLink();
  return (
    <>
      {d.races.map((r) => (
        <Link key={r.id} {...inspectLink('e', r.id)} className="flex items-center gap-1 rounded-lg px-1.5 py-1 text-[11.5px] font-semibold text-ink hover:brightness-95" style={{ background: `color-mix(in srgb, ${PRIORITY_COLOR[r.priority]} 16%, var(--surface))` }}>
          <Flag className="h-3 w-3 shrink-0" style={{ color: PRIORITY_COLOR[r.priority] }} />
          <span className="truncate">
            {r.priority} · {r.name}
          </span>
        </Link>
      ))}
      {d.acts.map((a) => {
        const failed = a.felt && surveyFailed(a.felt);
        return (
          <Link
            key={a.id}
            {...inspectLink('a', a.id)}
            className={clsx('block rounded-lg border bg-surface px-1.5 py-1 shadow-[0_1px_0_rgba(0,0,0,0.02)] transition-colors hover:border-line-strong', failed ? 'border-critical/50' : 'border-line')}
            style={{ borderLeft: `3px solid ${a.type ? typeColor(t, a.type) : `var(--sport-${a.sport})`}` }}
            title={[a.title, a.brief, a.felt ? `Felt: ${surveyText(a.felt)}` : null].filter(Boolean).join('\n')}
          >
            <div className="flex items-center gap-1">
              <SportIcon sport={a.sport as never} className="h-3 w-3" />
              <span className={clsx('truncate font-medium text-ink', wide ? 'text-[13px]' : 'text-[11.5px]')}>{a.title}</span>
            </div>
            <div className={clsx('tnum truncate text-muted', wide ? 'text-[11.5px]' : 'text-[10.5px]')}>
              {[a.brief ?? fmtDuration(a.moving, { short: true }), `${a.tss} TSS`, failed ? 'didn’t pass' : null].filter(Boolean).join(' · ')}
            </div>
          </Link>
        );
      })}
      {d.plans.map((p) => {
        const movable = !p.followed && !p.missed && d.date >= today;
        return (
          <Link
            key={p.id}
            {...inspectLink('p', p.id)}
            draggable={movable}
            onDragStart={movable ? (e) => e.dataTransfer.setData('planned', String(p.id)) : undefined}
            className={clsx('block rounded-lg border border-dashed px-1.5 py-1 transition-colors hover:bg-surface-2', p.missed ? 'border-critical/50 opacity-75' : 'border-line-strong', movable && 'cursor-grab active:cursor-grabbing')}
            title={p.missed ? 'Planned, not done' : p.followed ? 'Planned in TrainerRoad' : 'Planned · drag to move'}
          >
            <div className="flex items-center gap-1">
              {p.missed ? <XCircle className="h-3 w-3 shrink-0 text-critical" /> : <SportIcon sport={p.sport as never} className="h-3 w-3" colored={false} />}
              <span className={clsx('truncate font-medium', p.missed ? 'text-ink-2 line-through decoration-critical/40' : 'text-ink-2', wide ? 'text-[13px]' : 'text-[11.5px]')}>{p.title}</span>
            </div>
            <div className={clsx('tnum truncate text-muted', wide ? 'text-[11.5px]' : 'text-[10.5px]')}>
              {[p.missed ? 'missed' : null, p.duration ? fmtDuration(p.duration, { short: true }) : null, p.tss != null ? `${fmtNum(p.tss)} TSS` : null].filter(Boolean).join(' · ')}
            </div>
          </Link>
        );
      })}
      {d.target != null && d.target >= 10 && selected !== 'planned' && (
        <div className="rounded-lg border border-dotted px-1.5 py-1" style={{ borderColor: scenarioColor(t, selected) }} title={`${SCENARIO_NAMES[selected]}: about ${Math.round(d.target)} TSS on this free day`}>
          <div className="flex items-center gap-1">
            <Sparkles className="h-3 w-3 shrink-0" style={{ color: scenarioColor(t, selected) }} />
            <span className={clsx('tnum truncate font-medium text-ink-2', wide ? 'text-[13px]' : 'text-[11.5px]')}>≈ {Math.round(d.target / 5) * 5} TSS</span>
          </div>
          <div className={clsx('truncate text-muted', wide ? 'text-[11.5px]' : 'text-[10.5px]')}>{SCENARIO_NAMES[selected].toLowerCase()}</div>
        </div>
      )}
    </>
  );
}

/** What a week came to — or, ahead, what it's meant to and where it leaves you. */
function Summary({ w, selected, editable, custom, onCustom }: { w: WeekModel; selected: ScenarioId; editable: boolean; custom: Record<string, number> | null; onCustom: (week: string, tss: number) => void }) {
  const t = useTokens();
  const goal = w.target ?? (w.planned || null);
  const shown = w.when === 'ahead' ? null : w.done;
  const pct = goal && shown != null ? Math.min(100, (shown / goal) * 100) : null;
  return (
    <div className="flex h-full flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        {w.when === 'ahead' ? (
          editable && custom ? (
            <label className="flex items-baseline gap-1.5">
              <input
                type="number"
                inputMode="numeric"
                step={10}
                min={0}
                value={custom[w.start] ?? Math.round(w.target ?? 0)}
                onChange={(e) => onCustom(w.start, Math.max(0, Number(e.target.value) || 0))}
                className="tnum h-7 w-20 rounded-lg border border-line bg-surface px-2 text-right text-[14px] font-semibold focus:border-accent focus:outline-none"
                aria-label={`Your load for the week of ${fmtDate(w.start, 'd MMM')}`}
              />
              <span className="text-[11px] text-muted">TSS</span>
            </label>
          ) : (
            <span className="figure text-[20px]">
              {goal != null ? Math.round(goal) : '–'}
              <span className="ml-1 text-[11px] font-medium tracking-normal text-muted">{w.target != null && selected !== 'planned' ? 'target' : 'planned'}</span>
            </span>
          )
        ) : (
          <span className="figure text-[20px]">
            {shown != null ? Math.round(shown) : '–'}
            {goal ? <span className="ml-1 text-[11px] font-medium tracking-normal text-muted">/ {Math.round(goal)}</span> : <span className="ml-1 text-[11px] font-medium tracking-normal text-muted">TSS</span>}
          </span>
        )}
        {w.hours != null && <span className="tnum text-[11px] text-muted">{w.hours.toFixed(1)} h</span>}
      </div>
      {pct != null && (
        <div className="h-1 overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full" style={{ width: `${pct}%`, background: shown! / goal! > 1.2 ? t.warning : t.ink2 }} />
        </div>
      )}
      {w.ctl != null && (
        <div className="tnum flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.ctl }} />
          Fitness {Math.round(w.ctl)}
          {w.ctlDelta != null && <span className={clsx(w.ctlDelta > 0.5 ? 'text-good-text' : w.ctlDelta < -0.5 ? 'text-serious' : 'text-muted')}>{signed(w.ctlDelta, 1)}</span>}
        </div>
      )}
      {w.tsb != null && w.ctl != null && (
        <div className="tnum flex items-center gap-1.5 text-[11.5px] text-ink-2">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: formColor(t, zone(w.tsb, w.ctl)) }} />
          Form {signed(w.tsb)}
          {w.when === 'ahead' && <span className="text-muted">at the end</span>}
        </div>
      )}
      {w.review && w.when !== 'ahead' && <ReviewHeadline r={w.review} weeks={1} className="mt-auto !text-[12px]" />}
    </div>
  );
}

function SummaryCompact({ w, selected, editable, custom, onCustom }: { w: WeekModel; selected: ScenarioId; editable: boolean; custom: Record<string, number> | null; onCustom: (week: string, tss: number) => void }) {
  const goal = w.target ?? (w.planned || null);
  if (w.when === 'ahead' && editable && custom)
    return (
      <input
        type="number"
        inputMode="numeric"
        step={10}
        min={0}
        value={custom[w.start] ?? Math.round(w.target ?? 0)}
        onChange={(e) => onCustom(w.start, Math.max(0, Number(e.target.value) || 0))}
        className="tnum h-8 w-20 rounded-lg border border-line bg-surface px-2 text-right text-[14px] font-semibold"
        aria-label={`Your load for the week of ${fmtDate(w.start, 'd MMM')}`}
      />
    );
  return (
    <>
      <div className="figure text-[17px]">
        {w.when === 'ahead' ? (goal != null ? Math.round(goal) : '–') : w.done != null ? Math.round(w.done) : '–'}
        <span className="ml-1 text-[11px] font-medium tracking-normal text-muted">{w.when === 'ahead' ? (w.target != null && selected !== 'planned' ? 'target' : 'planned') : goal ? `/ ${Math.round(goal)}` : 'TSS'}</span>
      </div>
      {w.ctl != null && (
        <div className="tnum mt-0.5 text-[11px] text-muted">
          Fitness {Math.round(w.ctl)}
          {w.tsb != null ? ` · form ${signed(w.tsb)}` : ''}
        </div>
      )}
    </>
  );
}

const zone = (tsb: number, ctl: number) => {
  const rel = ctl > 5 ? tsb / ctl : tsb / 30;
  return rel >= 0.25 ? 'transition' : rel >= 0.05 ? 'fresh' : rel >= -0.1 ? 'neutral' : rel >= -0.3 ? 'optimal' : 'overload';
};
