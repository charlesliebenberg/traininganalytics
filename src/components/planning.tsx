/**
 * Putting things on the calendar, from anywhere: a workout from the library, a quick one, or a
 * race — and how a ride measured up to what was planned.
 */
import { useState } from 'react';
import type { Activity, PlannedWorkout, Sport, WorkoutTemplate } from '../../shared/types';
import { workoutMetrics } from '../../shared/analytics/workout';
import { http, useAction, useApi } from '../lib/api';
import { fmtDate, fmtDuration, SPORT_LABEL } from '../lib/format';
import { Button, Field, Input, Modal, Segmented, Select, SportBadge, Tabs } from './ui';
import { MiniProfile } from './charts';

export function compliance(p: PlannedWorkout, a: Pick<Activity, 'tss' | 'movingTime'> | undefined | null, today: string): { ratio: number | null; color: string; label: string } {
  if (!a) {
    if (p.date < today) return { ratio: 0, color: 'var(--critical)', label: 'Missed' };
    return { ratio: null, color: 'var(--line-strong)', label: 'Planned' };
  }
  const ratio = p.plannedTss && a.tss ? a.tss / p.plannedTss : p.plannedDuration ? a.movingTime / p.plannedDuration : null;
  if (ratio == null) return { ratio, color: 'var(--good)', label: 'Completed' };
  if (ratio >= 0.8 && ratio <= 1.2) return { ratio, color: 'var(--good)', label: 'On plan' };
  if (ratio >= 0.5 && ratio <= 1.5) return { ratio, color: 'var(--warning)', label: ratio < 1 ? 'Under' : 'Over' };
  return { ratio, color: 'var(--serious)', label: ratio < 1 ? 'Well under' : 'Well over' };
}

export const PRIORITY_COLOR: Record<string, string> = { A: 'var(--critical)', B: 'var(--serious)', C: 'var(--muted)' };

/** Add to a day: a workout from the library, a quick one, or a race. */
export function AddModal({ date, onClose, initial = 'library' }: { date: string; onClose: () => void; initial?: 'library' | 'quick' | 'event' }) {
  const templates = useApi<WorkoutTemplate[]>('/templates');
  const [tab, setTab] = useState<'library' | 'quick' | 'event'>(initial);
  const [sport, setSport] = useState<Sport>('ride');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [tss, setTss] = useState(60);
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState<'A' | 'B' | 'C'>('B');
  const [search, setSearch] = useState('');
  const [raceDate, setRaceDate] = useState(date);
  const add = useAction((b: unknown) => http('/planned', { method: 'POST', json: b }), { onSuccess: onClose, success: `Added to ${fmtDate(date, 'EEE d MMM')}` });
  const addEvent = useAction((b: unknown) => http('/events', { method: 'POST', json: b }), { onSuccess: onClose, success: 'Race added' });
  const filtered = (templates.data ?? []).filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.category.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal open onClose={onClose} title={`Add to ${fmtDate(date, 'EEEE d MMMM')}`} width={620}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'library', label: 'From the library' }, { value: 'quick', label: 'Quick workout' }, { value: 'event', label: 'Race or event' }]} />
      <div className="pt-4">
        {tab === 'library' && (
          <>
            <Input placeholder="Search workouts" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3 w-full" autoFocus />
            <div className="-mx-2 max-h-[48vh] space-y-0.5 overflow-y-auto">
              {filtered.map((w) => {
                const m = workoutMetrics(w.structure);
                return (
                  <button key={w.id} onClick={() => add.mutate({ date, sport: w.sport, title: w.name, description: w.description, structure: w.structure })} className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left hover:bg-surface-2">
                    <SportBadge sport={w.sport} size={30} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{w.name}</div>
                      <div className="tnum text-[11.5px] text-muted">
                        {w.category} · {fmtDuration(m.duration, { short: true })} · {Math.round(m.tss)} TSS · IF {m.if.toFixed(2)}
                      </div>
                    </div>
                    <div className="w-28 shrink-0">
                      <MiniProfile structure={w.structure} height={24} />
                    </div>
                  </button>
                );
              })}
              {templates.data && !filtered.length && <p className="px-2 py-6 text-center text-xs text-muted">No workout matches “{search}”.</p>}
            </div>
          </>
        )}
        {tab === 'quick' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Sport">
              <Select value={sport} onChange={(e) => setSport(e.target.value as Sport)}>
                {Object.entries(SPORT_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Title">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Easy spin" />
            </Field>
            <Field label="Duration (min)">
              <Input type="number" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </Field>
            <Field label="Planned TSS">
              <Input type="number" value={tss} onChange={(e) => setTss(Number(e.target.value))} />
            </Field>
            <Field label="Notes" className="col-span-2">
              <Input value={desc} onChange={(e) => setDesc(e.target.value)} />
            </Field>
            <div className="col-span-2 flex justify-end">
              <Button variant="primary" loading={add.isPending} onClick={() => add.mutate({ date, sport, title: title || `${SPORT_LABEL[sport]}`, description: desc, plannedDuration: minutes * 60, plannedTss: tss, plannedIf: Math.sqrt(tss / 100 / (minutes / 60)) })}>
                Add workout
              </Button>
            </div>
          </div>
        )}
        {tab === 'event' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" className="col-span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Gran Fondo" autoFocus />
            </Field>
            <Field label="Date">
              <Input type="date" value={raceDate} onChange={(e) => setRaceDate(e.target.value)} />
            </Field>
            <Field label="Priority" hint="A: the goal you peak for · B: important · C: train through it">
              <Segmented value={priority} onChange={setPriority} options={[{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }]} />
            </Field>
            <Field label="Sport">
              <Select value={sport} onChange={(e) => setSport(e.target.value as Sport)}>
                {Object.entries(SPORT_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="col-span-2 flex justify-end">
              <Button variant="primary" loading={addEvent.isPending} disabled={!title || !raceDate} onClick={() => addEvent.mutate({ date: raceDate, name: title, priority, sport })}>
                Add race
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
