import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { CalendarDays, Flag, Plus } from 'lucide-react';
import type { Activity, PlannedWorkout, PmcPoint, RaceEvent, Thresholds } from '../../../shared/types';
import type { SleepRead } from '../../../shared/analytics/sleep';
import { formZone } from '../../../shared/analytics/pmc';
import { useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, fmtDistance, fmtDuration, fmtNum } from '../../lib/format';
import { activityTitle, sessionBrief, typeColor } from '../../lib/session';
import { formColor, fmtForm, MiniProfile } from '../charts';
import { NightBefore } from '../sleep';
import { AddModal, compliance, PRIORITY_COLOR } from '../planning';
import { SportBadge, buttonClass } from '../ui';
import { PanelLoading, PanelSection, PanelShell } from './Inspector';

interface Day {
  date: string;
  today: string;
  activities: Activity[];
  planned: PlannedWorkout[];
  events: RaceEvent[];
  before: PmcPoint | null;
  after: PmcPoint | null;
  sleep: SleepRead | null;
  thresholds: Thresholds;
}

const when = (d: string, today: string) => {
  const n = differenceInCalendarDays(parseISO(d), parseISO(today));
  return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : n === -1 ? 'Yesterday' : n > 0 ? `In ${n} days` : `${-n} days ago`;
};

/** A day: what was done and planned, races, form going into it, and the night before. */
export function DayPanel({ date, onClose }: { date: string; onClose: () => void }) {
  const t = useTokens();
  const { data: d, isLoading } = useApi<Day>(`/day?date=${date}`);
  const inspectLink = useInspectLink();
  const [adding, setAdding] = useState<null | 'library' | 'event'>(null);
  if (isLoading || !d) return <PanelLoading onClose={onClose} />;
  const matched = new Set(d.activities.map((a) => a.id));
  const open = d.planned.filter((p) => !p.activityId || !matched.has(p.activityId));
  const form = d.before ? formZone(d.before.tsb, d.before.ctl) : null;
  const past = d.date < d.today;
  const empty = !d.activities.length && !open.length && !d.events.length;

  return (
    <PanelShell
      eyebrow={when(d.date, d.today)}
      title={fmtDate(d.date, 'EEEE d MMMM')}
      subtitle={
        d.before && form ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: formColor(t, form.id) }} />
            Form {past || d.date === d.today ? 'going in' : 'expected'} {fmtForm(d.before.tsb)} · {form.label} · fitness {Math.round(d.before.ctl)}
          </span>
        ) : undefined
      }
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={() => setAdding('library')} className={buttonClass('primary')}>
            <Plus className="h-4 w-4" />
            Add a workout
          </button>
          <button type="button" onClick={() => setAdding('event')} className={buttonClass('secondary')}>
            <Flag className="h-4 w-4" />
            Add a race
          </button>
          <Link {...inspectLink('w', d.date)} className={buttonClass('ghost', 'md', 'ml-auto')}>
            <CalendarDays className="h-4 w-4" />
            Its week
          </Link>
        </>
      }
    >
      {d.events.map((e) => (
        <Link key={e.id} {...inspectLink('e', e.id)} className="mb-3 flex items-center gap-3 rounded-2xl border border-line p-3 hover:bg-surface-2">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[13px] font-bold" style={{ background: `color-mix(in srgb, ${PRIORITY_COLOR[e.priority]} 16%, transparent)` }}>
            {e.priority}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] text-muted">Race day</span>
            <span className="block truncate text-[14px] font-semibold text-ink">{e.name}</span>
          </span>
        </Link>
      ))}

      {d.activities.length > 0 && (
        <PanelSection title="Done" className="mt-2">
          <div className="space-y-2">
            {d.activities.map((a) => {
              const p = d.planned.find((x) => x.activityId === a.id);
              const c = p ? compliance(p, a, d.today) : null;
              return (
                <Link key={a.id} {...inspectLink('a', a.id)} className="flex items-center gap-3 rounded-2xl border border-line p-3 hover:bg-surface-2">
                  <span className="h-10 w-1 shrink-0 rounded-full" style={{ background: a.sessionType ? typeColor(t, a.sessionType) : `var(--sport-${a.sport})` }} />
                  <SportBadge sport={a.sport} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-medium text-ink">{activityTitle(a)}</span>
                    <span className="block truncate text-[12px] text-muted">{[sessionBrief(a), fmtDuration(a.movingTime, { short: true }), a.distance ? fmtDistance(a.distance, 1, a.sport) : null].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="tnum shrink-0 text-right text-[13px] font-semibold">
                    {fmtNum(a.tss)}
                    <span className="block text-[10.5px] font-normal text-muted">{c ? c.label : 'TSS'}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </PanelSection>
      )}

      {open.length > 0 && (
        <PanelSection title={past ? 'Planned, not done' : 'Planned'} className={d.activities.length ? undefined : 'mt-2'}>
          <div className="space-y-2">
            {open.map((p) => {
              const missed = past;
              return (
                <Link key={p.id} {...inspectLink('p', p.id)} className={clsx('block rounded-2xl border border-dashed p-3 hover:bg-surface-2', missed ? 'border-critical/50' : 'border-line-strong')}>
                  <div className="flex items-center gap-3">
                    <SportBadge sport={p.sport} size={32} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-medium text-ink">{p.title}</span>
                      <span className="block truncate text-[12px] text-muted">
                        {[p.plannedDuration ? fmtDuration(p.plannedDuration, { short: true }) : null, p.plannedTss != null ? `${fmtNum(p.plannedTss)} TSS` : null, p.source === 'trainerroad' ? 'TrainerRoad' : null, missed ? 'missed' : null].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                  </div>
                  {p.structure && <MiniProfile structure={p.structure} height={30} className="mt-2.5" />}
                </Link>
              );
            })}
          </div>
        </PanelSection>
      )}

      {empty && (
        <div className="mt-2 rounded-2xl bg-surface-2 px-4 py-6 text-center">
          <p className="text-[13.5px] font-medium text-ink">{past ? 'A rest day' : 'Nothing planned'}</p>
          <p className="mt-1 text-[12.5px] text-muted">{past ? 'No training recorded.' : 'Rest, or put a workout on it.'}</p>
        </div>
      )}

      {d.after && d.after.date === d.date && (
        <PanelSection title={d.after.projected ? 'Where it leaves you (projected)' : 'Where it left you'}>
          <div className="grid grid-cols-3 gap-3 rounded-2xl border border-line p-3">
            <Mini label="Fitness" value={`${Math.round(d.after.ctl)}`} color={t.ctl} />
            <Mini label="Fatigue" value={`${Math.round(d.after.atl)}`} color={t.atl} />
            <Mini label="Form" value={fmtForm(d.after.tsb)} color={t.tsb} />
          </div>
        </PanelSection>
      )}

      {d.sleep && (
        <PanelSection title="The night before">
          <div className="rounded-2xl border border-line">
            <NightBefore read={d.sleep} className="px-4 py-3" />
          </div>
        </PanelSection>
      )}
      {adding && <AddModal date={d.date} initial={adding} onClose={() => setAdding(null)} />}
    </PanelShell>
  );
}

function Mini({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
        {label}
      </div>
      <div className="figure mt-1 text-[18px]">{value}</div>
    </div>
  );
}
