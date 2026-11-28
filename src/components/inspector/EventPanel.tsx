import { useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { AlertTriangle, CalendarRange, Pencil, Trash2 } from 'lucide-react';
import type { RaceEvent } from '../../../shared/types';
import { http, useAction, useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, iso } from '../../lib/format';
import { ARRIVES, SCENARIO_NAMES, scenarioColor, signed, useForecast } from '../../lib/forecast';
import { formColor } from '../charts';
import { PRIORITY_COLOR } from '../planning';
import { Button, Field, Input, Segmented, buttonClass } from '../ui';
import { PanelLoading, PanelMissing, PanelSection, PanelShell } from './Inspector';

/** A race: when, how much it matters, and what each way of getting there brings to the start line. */
export function EventPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const t = useTokens();
  const events = useApi<RaceEvent[]>('/events');
  const e = events.data?.find((x) => x.id === id);
  const today = iso(new Date());
  const ahead = !!e && e.date > today;
  const f = useForecast({ eventId: id, constraints: null, custom: null }, ahead);
  const inspectLink = useInspectLink();
  const [editing, setEditing] = useState(false);
  const del = useAction(() => http(`/events/${id}`, { method: 'DELETE' }), { onSuccess: onClose, success: 'Race removed' });
  if (events.isLoading) return <PanelLoading onClose={onClose} />;
  if (!e) return <PanelMissing title="Race not found" onClose={onClose} />;
  const days = differenceInCalendarDays(parseISO(e.date), parseISO(today));
  const followed = e.source === 'trainerroad';
  const d = f.data && f.data.race?.id === id ? f.data : null;
  const planned = d?.scenarios.find((s) => s.id === 'planned');
  const bestFtp = d ? Math.max(...d.scenarios.map((s) => s.race.ftp ?? -Infinity)) : null;

  return (
    <PanelShell
      icon={
        <span className="flex h-10 w-10 items-center justify-center rounded-xl text-[15px] font-bold" style={{ background: `color-mix(in srgb, ${PRIORITY_COLOR[e.priority]} 16%, transparent)` }}>
          {e.priority}
        </span>
      }
      eyebrow={`${e.priority} race${followed ? ' · from TrainerRoad' : ''}`}
      title={e.name}
      subtitle={`${fmtDate(e.date, 'EEEE d MMMM yyyy')} · ${days > 0 ? `in ${days} days` : days === 0 ? 'today' : `${-days} days ago`}`}
      actions={
        !followed && (
          <Button variant="ghost" size="sm" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing((x) => !x)} aria-pressed={editing}>
            Edit
          </Button>
        )
      }
      onClose={onClose}
      footer={
        <>
          {ahead && (
            <Link to={`/season?race=${e.id}`} className={buttonClass('primary')}>
              <CalendarRange className="h-4 w-4" />
              Plan the way there
            </Link>
          )}
          <Link {...inspectLink('d', e.date)} className={buttonClass('secondary')}>
            Race day
          </Link>
          {!followed && (
            <Button variant="ghost" className="ml-auto text-critical" icon={<Trash2 className="h-4 w-4" />} loading={del.isPending} onClick={() => confirm(`Remove “${e.name}”?`) && del.mutate(undefined)}>
              Remove
            </Button>
          )}
        </>
      }
    >
      {editing && <EditRace e={e} onDone={() => setEditing(false)} />}

      {ahead && (
        <PanelSection title="On race day" className="mt-2" aside={f.isFetching ? <span className="text-[11px] text-muted">updating…</span> : undefined}>
          {!d ? (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-16" />
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {d.scenarios.map((s) => {
                const zone = s.race.form;
                return (
                  <Link key={s.id} to={`/season?race=${e.id}&s=${s.id}`} className="flex items-center gap-3 rounded-2xl border border-line p-3 hover:bg-surface-2">
                    <span className="h-10 w-1 shrink-0 rounded-full" style={{ background: scenarioColor(t, s.id) }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium text-ink">{SCENARIO_NAMES[s.id]}</span>
                      <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: formColor(t, zone) }} />
                        Arrives {ARRIVES[zone] ?? s.race.formLabel.toLowerCase()} · form {signed(s.race.tsb)} · fitness {Math.round(s.race.ctl)}
                      </span>
                    </span>
                    {s.race.ftp != null && (
                      <span className="shrink-0 text-right">
                        <span className={clsx('figure block text-[20px]', s.race.ftp === bestFtp && 'text-good-text')}>{Math.round(s.race.ftp)}</span>
                        <span className="block text-[10.5px] text-muted">W FTP</span>
                      </span>
                    )}
                  </Link>
                );
              })}
              {planned?.warnings.map((w) => (
                <p key={w} className="flex items-start gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  As planned: {w.charAt(0).toLowerCase() + w.slice(1)}
                </p>
              ))}
              {d.now.ftp && (
                <p className="pt-1 text-[12px] text-muted">
                  Today: FTP {d.now.ftp} W, fitness {Math.round(d.now.ctl)}, form {signed(d.now.tsb)}. Each path rides your calendar forward from tomorrow; open one to see it week by week.
                </p>
              )}
            </div>
          )}
        </PanelSection>
      )}

      {e.targetCtl != null && (
        <PanelSection title="Target">
          <p className="text-[13px] text-ink-2">Fitness (CTL) of {e.targetCtl} on the day.</p>
        </PanelSection>
      )}
      {e.description && (
        <PanelSection title="Notes">
          <p className="text-[13px] whitespace-pre-line text-ink-2">{e.description}</p>
        </PanelSection>
      )}
      {!ahead && (
        <p className="pt-2 text-[13px] text-muted">
          {days === 0 ? 'Race day is today. Good luck!' : 'This race is behind you.'} Its day holds what you rode.
        </p>
      )}
      {followed && <p className="mt-6 text-[12px] text-muted">Planned in TrainerRoad: change it there, and it follows here within the hour.</p>}
    </PanelShell>
  );
}

function EditRace({ e, onDone }: { e: RaceEvent; onDone: () => void }) {
  const [name, setName] = useState(e.name);
  const [date, setDate] = useState(e.date);
  const [priority, setPriority] = useState(e.priority);
  const save = useAction((b: Partial<RaceEvent>) => http(`/events/${e.id}`, { method: 'PATCH', json: b }), { onSuccess: onDone, success: 'Race saved' });
  return (
    <div className="mb-2 grid grid-cols-2 gap-3 rounded-2xl border border-line p-3">
      <Field label="Name" className="col-span-2">
        <Input value={name} onChange={(x) => setName(x.target.value)} />
      </Field>
      <Field label="Date">
        <Input type="date" value={date} onChange={(x) => setDate(x.target.value)} />
      </Field>
      <Field label="Priority">
        <Segmented value={priority} onChange={setPriority} options={[{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }]} />
      </Field>
      <div className="col-span-2 flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" loading={save.isPending} disabled={!name.trim() || !date} onClick={() => save.mutate({ name: name.trim(), date, priority })}>
          Save
        </Button>
      </div>
    </div>
  );
}
