import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarDays, CheckCircle2, Download, PenLine, Trash2 } from 'lucide-react';
import type { Activity, PlannedWorkout, Thresholds } from '../../../shared/types';
import { describe, workoutMetrics } from '../../../shared/analytics/workout';
import { http, useAction, useApi } from '../../lib/api';
import { useInspectLink } from '../../lib/inspect';
import { exportWorkout } from '../../lib/download';
import { fmtDate, fmtDuration, fmtNum, iso } from '../../lib/format';
import { activityTitle } from '../../lib/session';
import { WorkoutProfile } from '../charts';
import { compliance } from '../planning';
import { Badge, Button, Field, Input, SportBadge, buttonClass } from '../ui';
import { PanelLoading, PanelMissing, PanelSection, PanelShell } from './Inspector';

type Planned = PlannedWorkout & { activity: Activity | null; thresholds: Thresholds };

/** A planned workout: its shape and targets, export for the trainer, and how it went once ridden. */
export function PlannedPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data: p, isLoading } = useApi<Planned>(`/planned/${id}`);
  const inspectLink = useInspectLink();
  const [moving, setMoving] = useState(false);
  const del = useAction(() => http(`/planned/${id}`, { method: 'DELETE' }), { onSuccess: onClose, success: 'Workout removed' });
  if (isLoading) return <PanelLoading onClose={onClose} />;
  if (!p) return <PanelMissing title="Workout not found" onClose={onClose} />;
  const th = p.thresholds;
  const m = p.structure ? workoutMetrics(p.structure, th?.ftp) : null;
  const today = iso(new Date());
  const c = compliance(p, p.activity, today);
  const followed = p.source === 'trainerroad';
  const figs = [
    { label: 'Duration', value: fmtDuration(p.plannedDuration ?? m?.duration, { short: true }) },
    { label: 'TSS', value: fmtNum(p.plannedTss ?? m?.tss) },
    { label: 'IF', value: fmtNum(p.plannedIf ?? m?.if, 2) },
    ...(m?.work ? [{ label: 'Work', value: `${Math.round(m.work)} kJ` }] : []),
  ];

  return (
    <PanelShell
      icon={<SportBadge sport={p.sport} size={38} />}
      eyebrow={`${fmtDate(p.date, 'EEEE d MMMM')}${followed ? ' · TrainerRoad' : ''}`}
      title={p.title}
      subtitle={p.activity ? `${c.label}${c.ratio != null ? ` · ${Math.round(c.ratio * 100)}% of planned` : ''}` : p.date < today ? 'Not done' : 'Planned'}
      onClose={onClose}
      footer={
        <>
          {p.structure && !followed && (
            <Link to={`/season/workouts?planned=${p.id}`} className={buttonClass('secondary')}>
              <PenLine className="h-4 w-4" />
              Edit in the builder
            </Link>
          )}
          {!followed && (
            <Button icon={<CalendarDays className="h-4 w-4" />} onClick={() => setMoving((x) => !x)} aria-pressed={moving}>
              Move
            </Button>
          )}
          <Link {...inspectLink('d', p.date)} className={buttonClass('ghost')}>
            Its day
          </Link>
          {!followed && (
            <Button variant="ghost" className="ml-auto text-critical" icon={<Trash2 className="h-4 w-4" />} loading={del.isPending} onClick={() => del.mutate(undefined)} aria-label="Remove this workout" />
          )}
        </>
      }
    >
      {moving && <MoveWorkout p={p} onDone={() => setMoving(false)} />}
      <div className="grid grid-cols-4 gap-3 rounded-2xl bg-surface-2 p-3">
        {figs.map((f) => (
          <div key={f.label} className="min-w-0">
            <div className="text-[11px] text-muted">{f.label}</div>
            <div className="figure mt-1 truncate text-[17px]">{f.value}</div>
          </div>
        ))}
      </div>

      {p.structure && (
        <PanelSection title="The workout">
          <WorkoutProfile structure={p.structure} ftp={th?.ftp} height={160} />
          <p className="mt-2 text-[12.5px] leading-5 text-ink-2">{describe(p.structure)}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[11.5px] text-muted">Export</span>
            {(['zwo', 'erg', 'mrc', 'fit'] as const).map((f) => (
              <Button key={f} size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => exportWorkout(f, { name: p.title, description: p.description, sport: p.sport, structure: p.structure! }, th?.ftp ?? 250)}>
                .{f}
              </Button>
            ))}
          </div>
        </PanelSection>
      )}

      {p.description && (
        <PanelSection title="Notes">
          <p className="text-[13px] whitespace-pre-line text-ink-2">{p.description}</p>
        </PanelSection>
      )}

      {p.activity && (
        <PanelSection title="Done">
          <Link {...inspectLink('a', p.activity.id)} className="flex items-center gap-3 rounded-2xl border border-line p-3 hover:bg-surface-2">
            <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: c.color }} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-medium text-ink">{activityTitle(p.activity)}</span>
              <span className="block text-[12px] text-muted">
                {fmtDuration(p.activity.movingTime, { short: true })} · {fmtNum(p.activity.tss)} TSS
              </span>
            </span>
            {c.ratio != null && <Badge>{Math.round(c.ratio * 100)}%</Badge>}
          </Link>
        </PanelSection>
      )}
      {followed && <p className="mt-6 text-[12px] text-muted">Planned in TrainerRoad: move or change it there, and it follows here within the hour.</p>}
    </PanelShell>
  );
}

function MoveWorkout({ p, onDone }: { p: PlannedWorkout; onDone: () => void }) {
  const [date, setDate] = useState(p.date);
  const [title, setTitle] = useState(p.title);
  const save = useAction((b: { date: string; title: string }) => http(`/planned/${p.id}`, { method: 'PATCH', json: b }).then(() => b), { onSuccess: onDone, success: (b) => `Saved for ${fmtDate(b.date, 'EEE d MMM')}` });
  return (
    <div className="mb-4 grid grid-cols-2 gap-3 rounded-2xl border border-line p-3">
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Date">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
      <div className="col-span-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" loading={save.isPending} disabled={!date || !title.trim()} onClick={() => save.mutate({ date, title: title.trim() })}>
          Save
        </Button>
      </div>
    </div>
  );
}
