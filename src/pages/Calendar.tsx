import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { addDays, addMonths, endOfMonth, format, isSameMonth, startOfMonth, startOfWeek } from 'date-fns';
import { ChevronLeft, ChevronRight, Plus, Flag, Download, Trash2, PenLine, PanelRightOpen, PanelRightClose, CheckCircle2, XCircle } from 'lucide-react';
import type { Activity, PlannedWorkout, PmcPoint, RaceEvent, SeasonWeek, Sport, Thresholds, WorkoutTemplate } from '../../shared/types';
import { workoutMetrics, describe } from '../../shared/analytics/workout';
import { http, qs, useAction, useApi } from '../lib/api';
import { useTokens } from '../lib/theme';
import { fmtDate, fmtDistance, fmtDuration, fmtNum, iso, SPORT_LABEL } from '../lib/format';
import { exportWorkout } from '../lib/download';
import { Badge, Button, Field, Input, Modal, PageHeader, Segmented, Select, SportIcon, Spinner, Tabs } from '../components/ui';
import { MiniProfile, WorkoutProfile, formColor } from '../components/charts';
import { formZone } from '../../shared/analytics/pmc';

interface CalendarData {
  activities: Activity[];
  planned: PlannedWorkout[];
  events: RaceEvent[];
  planWeeks: SeasonWeek[];
  pmc: PmcPoint[];
}

function compliance(p: PlannedWorkout, a: Activity | undefined): { ratio: number | null; color: string; label: string } {
  const today = iso(new Date());
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

const PRIORITY_COLOR: Record<string, string> = { A: 'var(--critical)', B: 'var(--serious)', C: 'var(--muted)' };

function AddModal({ date, onClose, templates }: { date: string; onClose: () => void; templates: WorkoutTemplate[] }) {
  const [tab, setTab] = useState<'library' | 'quick' | 'event'>('library');
  const [sport, setSport] = useState<Sport>('ride');
  const [title, setTitle] = useState('');
  const [minutes, setMinutes] = useState(60);
  const [tss, setTss] = useState(60);
  const [desc, setDesc] = useState('');
  const [priority, setPriority] = useState<'A' | 'B' | 'C'>('B');
  const [search, setSearch] = useState('');
  const add = useAction((b: unknown) => http('/planned', { method: 'POST', json: b }), { onSuccess: onClose });
  const addEvent = useAction((b: unknown) => http('/events', { method: 'POST', json: b }), { onSuccess: onClose });
  const filtered = templates.filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.category.toLowerCase().includes(search.toLowerCase()));
  return (
    <Modal open onClose={onClose} title={`Add to ${fmtDate(date, 'EEEE d MMMM')}`} width={620}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'library', label: 'From library' }, { value: 'quick', label: 'Quick workout' }, { value: 'event', label: 'Race / event' }]} />
      <div className="pt-4">
        {tab === 'library' && (
          <>
            <Input placeholder="Search workouts" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3 w-full" />
            <div className="max-h-[48vh] space-y-1 overflow-y-auto">
              {filtered.map((w) => {
                const m = workoutMetrics(w.structure);
                return (
                  <button
                    key={w.id}
                    onClick={() => add.mutate({ date, sport: w.sport, title: w.name, description: w.description, structure: w.structure })}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-surface-2"
                  >
                    <SportIcon sport={w.sport} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{w.name}</div>
                      <div className="text-[11px] text-muted">
                        {w.category} · {fmtDuration(m.duration, { short: true })} · {Math.round(m.tss)} TSS · IF {m.if.toFixed(2)}
                      </div>
                    </div>
                    <div className="w-28">
                      <MiniProfile structure={w.structure} height={24} />
                    </div>
                  </button>
                );
              })}
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
            <Field label="Event name" className="col-span-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Gran Fondo" />
            </Field>
            <Field label="Priority" hint="A = season goal, B = important, C = training race">
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
              <Button variant="primary" loading={addEvent.isPending} disabled={!title} onClick={() => addEvent.mutate({ date, name: title, priority, sport })}>
                Add event
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PlannedModal({ p, activity, onClose, th }: { p: PlannedWorkout; activity?: Activity; onClose: () => void; th?: Thresholds }) {
  const nav = useNavigate();
  const [date, setDate] = useState(p.date);
  const [title, setTitle] = useState(p.title);
  const update = useAction((b: unknown) => http(`/planned/${p.id}`, { method: 'PATCH', json: b }), { onSuccess: onClose });
  const del = useAction(() => http(`/planned/${p.id}`, { method: 'DELETE' }), { onSuccess: onClose });
  const m = p.structure ? workoutMetrics(p.structure, th?.ftp) : null;
  const c = compliance(p, activity);
  return (
    <Modal
      open
      onClose={onClose}
      width={680}
      title={
        <span className="flex items-center gap-2">
          <SportIcon sport={p.sport} />
          {p.title}
        </span>
      }
      footer={
        <>
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={del.isPending} onClick={() => del.mutate(undefined)}>
            Delete
          </Button>
          {p.structure && (
            <Button icon={<PenLine className="h-4 w-4" />} onClick={() => nav(`/workouts?planned=${p.id}`)}>
              Edit in builder
            </Button>
          )}
          <Button variant="primary" loading={update.isPending} onClick={() => update.mutate({ date, title })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-3 rounded-lg bg-surface-2 p-3 text-center">
        <div>
          <div className="text-[11px] text-muted uppercase">Duration</div>
          <div className="font-semibold">{fmtDuration(p.plannedDuration, { short: true })}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">TSS</div>
          <div className="font-semibold">{fmtNum(p.plannedTss)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">IF</div>
          <div className="font-semibold">{fmtNum(p.plannedIf, 2)}</div>
        </div>
        <div>
          <div className="text-[11px] text-muted uppercase">{m?.work ? 'Work' : 'Status'}</div>
          <div className="font-semibold">{m?.work ? `${Math.round(m.work)} kJ` : c.label}</div>
        </div>
      </div>
      {p.structure && (
        <>
          <div className="mt-4">
            <WorkoutProfile structure={p.structure} ftp={th?.ftp} height={170} />
          </div>
          <p className="mt-2 text-xs text-ink-2">{describe(p.structure)}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {(['zwo', 'erg', 'mrc'] as const).map((f) => (
              <Button key={f} size="sm" icon={<Download className="h-3.5 w-3.5" />} onClick={() => exportWorkout(f, { name: p.title, description: p.description, sport: p.sport, structure: p.structure! }, th?.ftp ?? 250)}>
                .{f}
              </Button>
            ))}
          </div>
        </>
      )}
      {p.description && <p className="mt-3 text-[13px] whitespace-pre-line text-ink-2">{p.description}</p>}
      {activity && (
        <Link to={`/activities/${activity.id}`} className="mt-4 flex items-center gap-3 rounded-lg border border-line p-3 hover:bg-surface-2">
          <CheckCircle2 className="h-5 w-5" style={{ color: c.color }} />
          <div className="flex-1 text-[13px]">
            Completed: <b>{activity.name}</b> · {fmtDuration(activity.movingTime)} · {fmtNum(activity.tss)} TSS
          </div>
          {c.ratio != null && <Badge>{Math.round(c.ratio * 100)}%</Badge>}
        </Link>
      )}
    </Modal>
  );
}

export function Calendar() {
  const t = useTokens();
  const [month, setMonth] = useState(() => startOfMonth(new Date()));
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<PlannedWorkout | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [panel, setPanel] = useState(() => window.innerWidth >= 1700);
  const gridStart = startOfWeek(month, { weekStartsOn: 1 });
  const gridEnd = addDays(startOfWeek(endOfMonth(month), { weekStartsOn: 1 }), 6);
  const { data, isLoading } = useApi<CalendarData>(`/calendar${qs({ from: iso(gridStart), to: iso(gridEnd) })}`, { placeholderData: (p) => p });
  const templates = useApi<WorkoutTemplate[]>('/templates');
  const th = useApi<{ current: Thresholds }>('/thresholds');
  const move = useAction(({ id, date }: { id: number; date: string }) => http(`/planned/${id}`, { method: 'PATCH', json: { date } }));
  const create = useAction((b: unknown) => http('/planned', { method: 'POST', json: b }));

  const byDay = useMemo(() => {
    const m = new Map<string, { acts: Activity[]; planned: PlannedWorkout[]; events: RaceEvent[] }>();
    const get = (d: string) => m.get(d) ?? (m.set(d, { acts: [], planned: [], events: [] }), m.get(d)!);
    data?.activities.forEach((a) => get(a.localDate).acts.push(a));
    data?.planned.forEach((p) => get(p.date).planned.push(p));
    data?.events.forEach((e) => get(e.date).events.push(e));
    return m;
  }, [data]);
  const actById = useMemo(() => new Map(data?.activities.map((a) => [a.id, a]) ?? []), [data]);
  const pmcByDay = useMemo(() => new Map(data?.pmc.map((p) => [p.date, p]) ?? []), [data]);

  const weeks: Date[][] = [];
  for (let d = gridStart; d <= gridEnd; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  const today = iso(new Date());

  const onDrop = (date: string, e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const pid = e.dataTransfer.getData('planned');
    const tid = e.dataTransfer.getData('template');
    if (pid) move.mutate({ id: Number(pid), date });
    else if (tid) {
      const w = templates.data?.find((x) => x.id === Number(tid));
      if (w) create.mutate({ date, sport: w.sport, title: w.name, description: w.description, structure: w.structure });
    }
  };

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Plan workouts, drag to reschedule, and track compliance against your plan"
        actions={
          <>
            <Button variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => setMonth(addMonths(month, -1))} />
            <Button onClick={() => setMonth(startOfMonth(new Date()))}>Today</Button>
            <Button variant="ghost" icon={<ChevronRight className="h-4 w-4" />} onClick={() => setMonth(addMonths(month, 1))} />
            <div className="w-40 text-center text-[15px] font-semibold">{format(month, 'MMMM yyyy')}</div>
            <Button variant="ghost" icon={panel ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />} onClick={() => setPanel(!panel)} title="Workout library" />
          </>
        }
      />
      <div className="flex gap-4">
        <div className="card min-w-0 flex-1 overflow-x-auto">
          <div className="grid min-w-[880px] grid-cols-[repeat(7,minmax(96px,1fr))_150px]">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Week'].map((d) => (
              <div key={d} className="border-b border-line px-2.5 py-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
                {d}
              </div>
            ))}
            {isLoading && !data ? (
              <div className="col-span-8">
                <Spinner />
              </div>
            ) : (
              weeks.map((week) => {
                const ws = iso(week[0]);
                const we = iso(week[6]);
                const planWeek = data?.planWeeks.find((w) => w.weekStart === ws);
                let aTss = 0,
                  aTime = 0,
                  aDist = 0,
                  pTss = 0,
                  pTime = 0;
                week.forEach((d) => {
                  const e = byDay.get(iso(d));
                  e?.acts.forEach((a) => {
                    aTss += a.tss ?? 0;
                    aTime += a.movingTime;
                    aDist += a.distance ?? 0;
                  });
                  e?.planned.forEach((p) => {
                    pTss += p.plannedTss ?? 0;
                    pTime += p.plannedDuration ?? 0;
                  });
                });
                const endPmc = pmcByDay.get(we <= today ? we : today >= ws ? today : we);
                const target = planWeek?.tss ?? (pTss || null);
                return (
                  <div key={ws} className="contents">
                    {week.map((d) => {
                      const ds = iso(d);
                      const e = byDay.get(ds);
                      const inMonth = isSameMonth(d, month);
                      return (
                        <div
                          key={ds}
                          onDragOver={(ev) => {
                            ev.preventDefault();
                            setDragOver(ds);
                          }}
                          onDragLeave={() => setDragOver((x) => (x === ds ? null : x))}
                          onDrop={(ev) => onDrop(ds, ev)}
                          className={clsx('group relative min-h-[132px] border-r border-b border-line p-1.5', !inMonth && 'bg-page/40', dragOver === ds && 'bg-accent-soft')}
                        >
                          <div className="mb-1 flex items-center justify-between px-1">
                            <span className={clsx('text-xs font-medium', ds === today ? 'flex h-5 w-5 items-center justify-center rounded-full bg-accent text-white' : inMonth ? 'text-ink-2' : 'text-muted')}>{format(d, 'd')}</span>
                            <button onClick={() => setAdding(ds)} className="rounded p-0.5 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-3 hover:text-ink" aria-label="Add">
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                          </div>
                          <div className="space-y-1">
                            {e?.events.map((ev) => (
                              <div key={ev.id} className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-semibold" style={{ background: `color-mix(in srgb, ${PRIORITY_COLOR[ev.priority]} 18%, transparent)` }}>
                                <Flag className="h-3 w-3" style={{ color: PRIORITY_COLOR[ev.priority] }} />
                                <span className="truncate">
                                  {ev.priority} · {ev.name}
                                </span>
                              </div>
                            ))}
                            {e?.acts.map((a) => {
                              const p = e.planned.find((pp) => pp.activityId === a.id);
                              const c = p ? compliance(p, a) : null;
                              return (
                                <Link key={a.id} to={`/activities/${a.id}`} className="block rounded-md border border-line bg-surface-2 px-1.5 py-1 hover:border-line-strong" style={{ borderLeft: `3px solid ${c ? c.color : `var(--sport-${a.sport})`}` }} title={c ? `${c.label}${c.ratio != null ? ` · ${Math.round(c.ratio * 100)}%` : ''}` : undefined}>
                                  <div className="flex items-center gap-1">
                                    <SportIcon sport={a.sport} className="h-3 w-3" />
                                    <span className="truncate text-[11px] font-medium">{a.name}</span>
                                  </div>
                                  <div className="tnum text-[10px] text-muted">
                                    {fmtDuration(a.movingTime, { short: true })} · {fmtNum(a.tss)} TSS{a.distance ? ` · ${fmtDistance(a.distance, 0, a.sport)}` : ''}
                                  </div>
                                </Link>
                              );
                            })}
                            {e?.planned
                              .filter((p) => !p.activityId || !actById.has(p.activityId))
                              .map((p) => {
                                const c = compliance(p, undefined);
                                const missed = c.label === 'Missed';
                                return (
                                  <div
                                    key={p.id}
                                    draggable
                                    onDragStart={(ev) => ev.dataTransfer.setData('planned', String(p.id))}
                                    onClick={() => setOpen(p)}
                                    className={clsx('cursor-grab rounded-md border border-dashed px-1.5 py-1 hover:bg-surface-2 active:cursor-grabbing', missed ? 'border-critical/60 opacity-70' : 'border-line-strong')}
                                  >
                                    <div className="flex items-center gap-1">
                                      {missed ? <XCircle className="h-3 w-3 text-critical" /> : <SportIcon sport={p.sport} className="h-3 w-3" />}
                                      <span className="truncate text-[11px] font-medium">{p.title}</span>
                                    </div>
                                    <div className="tnum text-[10px] text-muted">
                                      {fmtDuration(p.plannedDuration, { short: true })} · {fmtNum(p.plannedTss)} TSS
                                    </div>
                                    {p.structure && <MiniProfile structure={p.structure} height={14} className="mt-0.5" />}
                                  </div>
                                );
                              })}
                          </div>
                        </div>
                      );
                    })}
                    <div className="border-b border-line bg-surface-2/50 p-2.5 text-[11px]">
                      {planWeek && (
                        <div className="mb-1.5 flex items-center justify-between">
                          <Badge>{planWeek.phase}</Badge>
                          <span className="text-muted">target {planWeek.tss}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted">TSS</span>
                        <span className="tnum font-semibold">
                          {Math.round(aTss)}
                          {target ? <span className="font-normal text-muted"> / {Math.round(target)}</span> : null}
                        </span>
                      </div>
                      {target ? (
                        <div className="my-1 h-1 overflow-hidden rounded-full bg-surface-3">
                          <div className="h-full rounded-full" style={{ width: `${Math.min(100, (aTss / target) * 100)}%`, background: aTss / target > 1.2 ? t.warning : t.accent }} />
                        </div>
                      ) : null}
                      <div className="flex justify-between">
                        <span className="text-muted">Time</span>
                        <span className="tnum">
                          {fmtDuration(aTime, { short: true })}
                          {pTime ? <span className="text-muted"> / {fmtDuration(pTime, { short: true })}</span> : null}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">Distance</span>
                        <span className="tnum">{fmtDistance(aDist, 0)}</span>
                      </div>
                      {endPmc && (
                        <div className="mt-1.5 flex justify-between border-t border-line pt-1.5">
                          <span className="text-muted">{endPmc.projected ? 'Proj. ' : ''}CTL</span>
                          <span className="tnum">
                            {Math.round(endPmc.ctl)} <span style={{ color: formColor(t, formZone(endPmc.tsb, endPmc.ctl).id) }}>({endPmc.tsb >= 0 ? '+' : ''}{Math.round(endPmc.tsb)})</span>
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        {panel && (
          <aside className="card hidden w-56 shrink-0 self-start p-3 lg:block">
            <div className="mb-2 px-1 text-[13px] font-semibold">Workout library</div>
            <p className="mb-3 px-1 text-[11px] text-muted">Drag onto a day to schedule.</p>
            <div className="max-h-[70vh] space-y-1 overflow-y-auto">
              {templates.data?.map((w) => (
                <div key={w.id} draggable onDragStart={(ev) => ev.dataTransfer.setData('template', String(w.id))} className="cursor-grab rounded-lg border border-line px-2 py-1.5 hover:bg-surface-2" title={w.description}>
                  <div className="flex items-center gap-1.5">
                    <SportIcon sport={w.sport} className="h-3 w-3" />
                    <span className="truncate text-[12px] font-medium">{w.name}</span>
                  </div>
                  <MiniProfile structure={w.structure} height={16} className="mt-1" />
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
      {adding && templates.data && <AddModal date={adding} onClose={() => setAdding(null)} templates={templates.data} />}
      {open && <PlannedModal p={open} activity={open.activityId ? actById.get(open.activityId) : undefined} onClose={() => setOpen(null)} th={th.data?.current} />}
    </div>
  );
}

