import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { ArrowDown, ArrowUp, Copy, Download, Plus, Repeat, Save, Trash2, CalendarPlus, TrendingUp } from 'lucide-react';
import type { PlannedWorkout, Sport, TargetType, Thresholds, WorkoutBlock, WorkoutIntent, WorkoutStep, WorkoutStructure, WorkoutTemplate } from '../../shared/types';
import { describe, step as mkStep, uid, workoutMetrics } from '../../shared/analytics/workout';
import { POWER_ZONES } from '../../shared/analytics/zones';
import { http, useAction, useApi } from '../lib/api';
import { useTokens, alpha } from '../lib/theme';
import { fmtDuration, fmtNum, fmtPace, iso, SPORT_LABEL } from '../lib/format';
import { exportWorkout } from '../lib/download';
import { Button, Card, Field, Input, PageHeader, Select, SportIcon, Stat, Modal } from '../components/ui';
import { MiniProfile, WorkoutProfile } from '../components/charts';

const INTENTS: { value: WorkoutIntent; label: string }[] = [
  { value: 'warmup', label: 'Warm up' },
  { value: 'active', label: 'Work' },
  { value: 'recovery', label: 'Recovery' },
  { value: 'rest', label: 'Rest' },
  { value: 'cooldown', label: 'Cool down' },
];

function DurationInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(fmtDuration(value));
  useEffect(() => setText(fmtDuration(value)), [value]);
  const commit = () => {
    const parts = text.split(':').map((x) => Number(x) || 0);
    const secs = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0] * 60;
    if (secs > 0) onChange(secs);
    else setText(fmtDuration(value));
  };
  return <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} className="h-8 w-20 px-2 text-center" title="mm:ss or h:mm:ss" />;
}

function PctInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="relative">
      <Input type="number" value={Math.round(value * 100)} onChange={(e) => onChange(Number(e.target.value) / 100)} className="h-8 w-[68px] pr-5 pl-2 text-right" />
      <span className="pointer-events-none absolute top-1.5 right-1.5 text-[11px] text-muted">%</span>
    </div>
  );
}

function StepRow({ s, onChange, onRemove, onMove, onDup, target, th }: { s: WorkoutStep; onChange: (s: WorkoutStep) => void; onRemove: () => void; onMove: (d: -1 | 1) => void; onDup: () => void; target: TargetType; th?: Thresholds }) {
  const t = useTokens();
  const hint =
    target === 'power' && th
      ? `${Math.round(s.low * th.ftp)}${s.low !== s.high ? `–${Math.round(s.high * th.ftp)}` : ''} W`
      : target === 'pace' && th
        ? `${fmtPace(s.low * th.runThresholdSpeed, 'run', false)}${s.low !== s.high ? `–${fmtPace(s.high * th.runThresholdSpeed, 'run', false)}` : ''}`
        : target === 'hr' && th
          ? `${Math.round(s.low * th.lthr)}–${Math.round(s.high * th.lthr)} bpm`
          : '';
  const zoneIdx = POWER_ZONES.findIndex((z) => (s.low + s.high) / 2 < z.max);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface px-2 py-1.5">
      <span className="h-8 w-1.5 shrink-0 rounded-full" style={{ background: alpha(t.power, 0.3 + (0.7 * Math.max(0, zoneIdx)) / 6) }} />
      <Select value={s.intent} onChange={(e) => onChange({ ...s, intent: e.target.value as WorkoutIntent })} className="h-8 w-28 text-xs">
        {INTENTS.map((i) => (
          <option key={i.value} value={i.value}>
            {i.label}
          </option>
        ))}
      </Select>
      <DurationInput value={s.duration} onChange={(duration) => onChange({ ...s, duration })} />
      <PctInput value={s.low} onChange={(low) => onChange({ ...s, low, high: s.low === s.high && !s.ramp ? low : s.high })} />
      <span className="text-muted">–</span>
      <PctInput value={s.high} onChange={(high) => onChange({ ...s, high })} />
      <label className="flex items-center gap-1 text-[11px] text-ink-2" title="Ramp linearly from low to high">
        <input type="checkbox" checked={!!s.ramp} onChange={(e) => onChange({ ...s, ramp: e.target.checked })} />
        Ramp
      </label>
      <Input value={s.cadence ?? ''} onChange={(e) => onChange({ ...s, cadence: e.target.value ? Number(e.target.value) : null })} placeholder="rpm" className="h-8 w-14 px-2 text-center text-xs" title="Target cadence" />
      <Input value={s.label ?? ''} onChange={(e) => onChange({ ...s, label: e.target.value || undefined })} placeholder="Label" className="h-8 w-28 min-w-0 flex-1 px-2 text-xs" />
      <span className="tnum w-24 text-right text-[11px] text-muted">{hint}</span>
      <div className="flex">
        <button onClick={() => onMove(-1)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Move up">
          <ArrowUp className="h-3.5 w-3.5" />
        </button>
        <button onClick={() => onMove(1)} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Move down">
          <ArrowDown className="h-3.5 w-3.5" />
        </button>
        <button onClick={onDup} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Duplicate">
          <Copy className="h-3.5 w-3.5" />
        </button>
        <button onClick={onRemove} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-critical" aria-label="Remove">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function move<T>(arr: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const c = arr.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

const cloneStep = (s: WorkoutStep): WorkoutStep => ({ ...s, id: uid() });
const cloneBlock = (b: WorkoutBlock): WorkoutBlock => (b.kind === 'step' ? cloneStep(b) : { ...b, id: uid(), steps: b.steps.map(cloneStep) });

interface Draft {
  id: number | null;
  plannedId: number | null;
  name: string;
  sport: Sport;
  category: string;
  description: string;
  structure: WorkoutStructure;
  builtin: boolean;
}

const EMPTY: Draft = {
  id: null,
  plannedId: null,
  name: 'New workout',
  sport: 'ride',
  category: 'Custom',
  description: '',
  structure: { target: 'power', blocks: [mkStep('warmup', 10, 0.45, 0.7, { ramp: true }), mkStep('active', 20, 0.88, 0.92), mkStep('cooldown', 10, 0.6, 0.4, { ramp: true })] },
  builtin: false,
};

export function Workouts() {
  const t = useTokens();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const templates = useApi<WorkoutTemplate[]>('/templates');
  const th = useApi<{ current: Thresholds }>('/thresholds');
  const plannedId = params.get('planned');
  const planned = useApi<PlannedWorkout[]>(plannedId ? `/planned?from=2000-01-01&to=2100-01-01` : null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filter, setFilter] = useState<Sport | ''>('');
  const [search, setSearch] = useState('');
  const [scheduling, setScheduling] = useState(false);
  const [schedDate, setSchedDate] = useState(iso(new Date()));
  const [highlight, setHighlight] = useState<string | null>(null);

  useEffect(() => {
    const p = planned.data?.find((x) => x.id === Number(plannedId));
    if (p?.structure) setDraft({ id: null, plannedId: p.id, name: p.title, sport: p.sport, category: 'Planned', description: p.description ?? '', structure: p.structure, builtin: false });
  }, [planned.data, plannedId]);

  const ftp = th.data?.current.ftp;
  const m = useMemo(() => workoutMetrics(draft.structure, ftp), [draft.structure, ftp]);
  const blocks = draft.structure.blocks;
  const setBlocks = (b: WorkoutBlock[]) => setDraft({ ...draft, structure: { ...draft.structure, blocks: b } });
  const updateBlock = (i: number, b: WorkoutBlock) => setBlocks(blocks.map((x, k) => (k === i ? b : x)));

  const save = useAction(
    () => {
      const body = { name: draft.name, sport: draft.sport, category: draft.category, description: draft.description, structure: draft.structure };
      if (draft.plannedId) return http(`/planned/${draft.plannedId}`, { method: 'PATCH', json: { title: draft.name, description: draft.description, structure: draft.structure, sport: draft.sport } });
      if (draft.id && !draft.builtin) return http<WorkoutTemplate>(`/templates/${draft.id}`, { method: 'PUT', json: body });
      return http<WorkoutTemplate>('/templates', { method: 'POST', json: body });
    },
    { onSuccess: (r: any) => r?.id && !draft.plannedId && setDraft((d) => ({ ...d, id: r.id, builtin: false })) },
  );
  const del = useAction(() => http(`/templates/${draft.id}`, { method: 'DELETE' }), { onSuccess: () => setDraft(EMPTY) });
  const schedule = useAction(() => http('/planned', { method: 'POST', json: { date: schedDate, sport: draft.sport, title: draft.name, description: draft.description, structure: draft.structure } }), {
    onSuccess: () => {
      setScheduling(false);
      nav('/calendar');
    },
  });

  const list = (templates.data ?? []).filter((w) => (!filter || w.sport === filter) && (w.name.toLowerCase().includes(search.toLowerCase()) || w.category.toLowerCase().includes(search.toLowerCase())));
  const groups = list.reduce<Record<string, WorkoutTemplate[]>>((a, w) => ((a[w.category] ??= []).push(w), a), {});
  const unitLabel = draft.structure.target === 'power' ? '% FTP' : draft.structure.target === 'pace' ? '% threshold pace' : '% LTHR';

  return (
    <div>
      <PageHeader
        title="Workout Builder"
        subtitle={draft.plannedId ? 'Editing a planned workout' : 'Design structured workouts, save them to your library, schedule and export to Zwift / TrainerRoad / Wahoo'}
        actions={
          <>
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setDraft({ ...EMPTY, structure: JSON.parse(JSON.stringify(EMPTY.structure)) })}>
              New
            </Button>
            <Button icon={<CalendarPlus className="h-4 w-4" />} onClick={() => setScheduling(true)}>
              Schedule
            </Button>
            <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              {draft.plannedId ? 'Save planned workout' : draft.id && !draft.builtin ? 'Save' : 'Save to library'}
            </Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Card title="Library" pad={false}>
          <div className="flex gap-2 px-4 pb-2">
            <Input placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 min-w-0 flex-1" />
            <Select value={filter} onChange={(e) => setFilter(e.target.value as Sport | '')} className="h-8 w-24">
              <option value="">All</option>
              <option value="ride">Ride</option>
              <option value="run">Run</option>
            </Select>
          </div>
          <div className="max-h-[calc(100vh-220px)] overflow-y-auto px-2 pb-3">
            {Object.entries(groups).map(([cat, ws]) => (
              <div key={cat} className="mb-2">
                <div className="px-2 py-1 text-[11px] font-semibold tracking-wide text-muted uppercase">{cat}</div>
                {ws.map((w) => {
                  const wm = workoutMetrics(w.structure);
                  return (
                    <button
                      key={w.id}
                      onClick={() => setDraft({ id: w.id, plannedId: null, name: w.name, sport: w.sport, category: w.category, description: w.description, structure: JSON.parse(JSON.stringify(w.structure)), builtin: w.builtin })}
                      className={clsx('mb-0.5 block w-full rounded-lg px-2 py-1.5 text-left hover:bg-surface-2', draft.id === w.id && 'bg-accent-soft')}
                    >
                      <div className="flex items-center gap-1.5">
                        <SportIcon sport={w.sport} className="h-3.5 w-3.5" />
                        <span className="truncate text-[13px] font-medium">{w.name}</span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <div className="flex-1">
                          <MiniProfile structure={w.structure} height={18} />
                        </div>
                        <span className="tnum shrink-0 text-[10px] text-muted">
                          {fmtDuration(wm.duration, { short: true })} · {Math.round(wm.tss)}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </Card>

        <div className="flex min-w-0 flex-col gap-4">
          <Card>
            <div className="grid gap-3 md:grid-cols-[minmax(0,2fr)_140px_140px_150px]">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="Sport">
                <Select value={draft.sport} onChange={(e) => setDraft({ ...draft, sport: e.target.value as Sport, structure: { ...draft.structure, target: e.target.value === 'ride' ? 'power' : 'pace' } })}>
                  {(['ride', 'run', 'swim', 'row', 'ski', 'other'] as Sport[]).map((s) => (
                    <option key={s} value={s}>
                      {SPORT_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Category">
                <Input value={draft.category} onChange={(e) => setDraft({ ...draft, category: e.target.value })} />
              </Field>
              <Field label="Target">
                <Select value={draft.structure.target} onChange={(e) => setDraft({ ...draft, structure: { ...draft.structure, target: e.target.value as TargetType } })}>
                  <option value="power">Power (% FTP)</option>
                  <option value="pace">Pace (% threshold)</option>
                  <option value="hr">Heart rate (% LTHR)</option>
                </Select>
              </Field>
              <Field label="Description" className="md:col-span-4">
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Purpose, cues, fuelling…" />
              </Field>
            </div>
            {draft.builtin && <p className="mt-2 text-[11px] text-muted">Built-in workout — saving creates a copy in your library.</p>}
          </Card>

          <Card title="Profile" subtitle={describe(draft.structure)}>
            <WorkoutProfile structure={draft.structure} ftp={draft.structure.target === 'power' ? ftp : undefined} height={200} highlight={highlight} />
            <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Duration" value={fmtDuration(m.duration)} />
              <Stat label="TSS" value={Math.round(m.tss)} />
              <Stat label="IF" value={m.if.toFixed(2)} />
              <Stat label="Avg intensity" value={`${Math.round(m.avg * 100)}%`} sub={unitLabel} />
              {draft.structure.target === 'power' && <Stat label="Work" value={m.work ? fmtNum(m.work) : '–'} unit="kJ" sub={ftp ? `at FTP ${ftp} W` : undefined} />}
              <Stat label="Above threshold" value={fmtDuration(m.timeAboveThreshold, { short: true })} />
            </div>
            <div className="mt-4 flex h-2.5 overflow-hidden rounded-full">
              {m.zoneSeconds.map((z, i) =>
                z ? <div key={i} style={{ width: `${(z / m.duration) * 100}%`, background: alpha(t.power, 0.3 + (0.7 * i) / 6) }} title={`${POWER_ZONES[i].id} ${POWER_ZONES[i].name}: ${fmtDuration(z, { short: true })}`} className="border-r border-surface last:border-0" /> : null,
              )}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted">
              <span>Time in zones</span>
              <span>Z1 → Z7</span>
            </div>
          </Card>

          <Card
            title="Structure"
            subtitle={`Targets in ${unitLabel}. Durations as mm:ss.`}
            actions={
              <>
                <Button size="sm" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setBlocks([...blocks, mkStep('active', 10, 0.75, 0.75)])}>
                  Step
                </Button>
                <Button size="sm" icon={<Repeat className="h-3.5 w-3.5" />} onClick={() => setBlocks([...blocks, { kind: 'repeat', id: uid(), count: 4, steps: [mkStep('active', 4, 1.05, 1.1), mkStep('recovery', 3, 0.5, 0.5)] }])}>
                  Interval set
                </Button>
                <Button size="sm" icon={<TrendingUp className="h-3.5 w-3.5" />} onClick={() => setBlocks([...blocks, mkStep('active', 10, 0.6, 0.9, { ramp: true })])}>
                  Ramp
                </Button>
              </>
            }
          >
            <div className="space-y-2">
              {blocks.map((b, i) =>
                b.kind === 'step' ? (
                  <StepRow
                    key={b.id}
                    s={b}
                    target={draft.structure.target}
                    th={th.data?.current}
                    onChange={(s) => updateBlock(i, s)}
                    onRemove={() => setBlocks(blocks.filter((_, k) => k !== i))}
                    onMove={(d) => setBlocks(move(blocks, i, d))}
                    onDup={() => setBlocks([...blocks.slice(0, i + 1), cloneBlock(b), ...blocks.slice(i + 1)])}
                  />
                ) : (
                  <div key={b.id} className="rounded-xl border border-line-strong bg-surface-2 p-2" onMouseEnter={() => setHighlight(b.id)} onMouseLeave={() => setHighlight(null)}>
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <Repeat className="h-4 w-4 text-accent" />
                      <span className="text-[13px] font-medium">Repeat</span>
                      <Input type="number" min={1} value={b.count} onChange={(e) => updateBlock(i, { ...b, count: Math.max(1, Number(e.target.value)) })} className="h-7 w-16 px-2 text-center" />
                      <span className="text-xs text-muted">times</span>
                      <div className="ml-auto flex">
                        <Button size="sm" variant="ghost" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => updateBlock(i, { ...b, steps: [...b.steps, mkStep('active', 2, 0.9, 0.9)] })}>
                          Step
                        </Button>
                        <button onClick={() => setBlocks(move(blocks, i, -1))} className="rounded p-1 text-muted hover:text-ink" aria-label="Move up">
                          <ArrowUp className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setBlocks(move(blocks, i, 1))} className="rounded p-1 text-muted hover:text-ink" aria-label="Move down">
                          <ArrowDown className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setBlocks([...blocks.slice(0, i + 1), cloneBlock(b), ...blocks.slice(i + 1)])} className="rounded p-1 text-muted hover:text-ink" aria-label="Duplicate">
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setBlocks(blocks.filter((_, k) => k !== i))} className="rounded p-1 text-muted hover:text-critical" aria-label="Remove">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-1.5 pl-4">
                      {b.steps.map((s, k) => (
                        <StepRow
                          key={s.id}
                          s={s}
                          target={draft.structure.target}
                          th={th.data?.current}
                          onChange={(ns) => updateBlock(i, { ...b, steps: b.steps.map((x, j) => (j === k ? ns : x)) })}
                          onRemove={() => updateBlock(i, { ...b, steps: b.steps.filter((_, j) => j !== k) })}
                          onMove={(d) => updateBlock(i, { ...b, steps: move(b.steps, k, d) })}
                          onDup={() => updateBlock(i, { ...b, steps: [...b.steps.slice(0, k + 1), cloneStep(s), ...b.steps.slice(k + 1)] })}
                        />
                      ))}
                    </div>
                  </div>
                ),
              )}
            </div>
          </Card>

          <Card title="Export" subtitle="Download for your trainer app or head unit">
            <div className="flex flex-wrap gap-2">
              <Button icon={<Download className="h-4 w-4" />} onClick={() => exportWorkout('zwo', draft, ftp ?? 250)}>
                Zwift (.zwo)
              </Button>
              <Button icon={<Download className="h-4 w-4" />} onClick={() => exportWorkout('erg', draft, ftp ?? 250)} disabled={draft.structure.target !== 'power'}>
                ERG (.erg, watts)
              </Button>
              <Button icon={<Download className="h-4 w-4" />} onClick={() => exportWorkout('mrc', draft, ftp ?? 250)} disabled={draft.structure.target !== 'power'}>
                MRC (.mrc, % FTP)
              </Button>
              <Button icon={<Download className="h-4 w-4" />} onClick={() => exportWorkout('json', draft, ftp ?? 250)}>
                JSON
              </Button>
              {draft.id && !draft.builtin && (
                <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => confirm('Delete this workout from your library?') && del.mutate(undefined)}>
                  Delete from library
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
      <Modal
        open={scheduling}
        onClose={() => setScheduling(false)}
        title="Schedule workout"
        width={420}
        footer={
          <Button variant="primary" loading={schedule.isPending} onClick={() => schedule.mutate(undefined)}>
            Add to calendar
          </Button>
        }
      >
        <Field label="Date">
          <Input type="date" value={schedDate} onChange={(e) => setSchedDate(e.target.value)} />
        </Field>
        <p className="mt-3 text-xs text-muted">
          {draft.name} · {fmtDuration(m.duration, { short: true })} · {Math.round(m.tss)} TSS
        </p>
      </Modal>
    </div>
  );
}
