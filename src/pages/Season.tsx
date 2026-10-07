import { useEffect, useMemo, useState } from 'react';
import { Flag, Trash2, Wand2, Save, Plus } from 'lucide-react';
import type { RaceEvent, SeasonPlan, SeasonPlanConfig, SeasonWeek, Sport } from '../../shared/types';
import { http, useAction, useApi } from '../lib/api';
import { alpha, useTokens, type Tokens } from '../lib/theme';
import { fmtDate, fmtNum, SPORT_LABEL, iso } from '../lib/format';
import { Badge, Button, Card, Field, Input, PageHeader, Segmented, Select, Spinner, Stat, Empty } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';

const PHASES = ['Prep', 'Base', 'Build', 'Peak', 'Taper', 'Race', 'Recovery'];
export function phaseColor(t: Tokens, phase: string): string {
  const p = phase.split(' ')[0];
  switch (p) {
    case 'Prep':
      return alpha(t.ink2, 0.5);
    case 'Base':
      return t.series[0];
    case 'Build':
      return t.series[1];
    case 'Peak':
      return t.series[4];
    case 'Taper':
      return t.series[2];
    case 'Race':
      return t.series[7];
    default:
      return alpha(t.muted, 0.55);
  }
}

export function PlanChart({ weeks }: { weeks: SeasonWeek[] }) {
  const t = useTokens();
  const option = useMemo(() => {
    const cats = weeks.map((w) => fmtDate(w.weekStart, 'd MMM'));
    return {
      animation: false,
      grid: [
        { left: 48, right: 12, top: 34, height: 150 },
        { left: 48, right: 12, top: 222, height: 120 },
      ],
      legend: { ...legendStyle(t), data: ['Fitness (CTL)', 'Fatigue (ATL)', 'Form (TSB)'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const w = weeks[ps[0].dataIndex];
          return `<b>Week of ${fmtDate(w.weekStart, 'd MMM yyyy')}</b><div style="margin:2px 0 4px;opacity:.7">${w.phase}${w.event ? ` · ${w.event}` : ''}</div>${tipRow(phaseColor(t, w.phase), 'Weekly TSS', String(w.tss))}${tipRow('transparent', 'Hours', `${w.hours}`)}${tipRow(t.ctl, 'CTL (end)', w.ctl.toFixed(0))}${tipRow(t.atl, 'ATL (end)', w.atl.toFixed(0))}${tipRow(t.tsb, 'TSB (end)', w.tsb.toFixed(0))}`;
        },
      },
      xAxis: [0, 1].map((i) => ({ type: 'category', gridIndex: i, data: cats, ...axisStyle(t, { grid: false }), axisLabel: { show: i === 1, color: t.muted, fontSize: 10, hideOverlap: true } })),
      yAxis: [
        valueAxis(t, { gridIndex: 0, name: 'Weekly TSS', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
        valueAxis(t, { gridIndex: 1, name: 'CTL / ATL / TSB', nameTextStyle: { color: t.ink2, fontSize: 11, align: 'left', padding: [0, 0, 0, -40] } }),
      ],
      series: [
        {
          type: 'bar',
          xAxisIndex: 0,
          yAxisIndex: 0,
          barCategoryGap: '18%',
          data: weeks.map((w) => ({ value: w.tss, itemStyle: { color: phaseColor(t, w.phase), borderRadius: [3, 3, 0, 0] } })),
          markLine: {
            symbol: 'none',
            silent: true,
            data: weeks.filter((w) => w.event).map((w) => ({ xAxis: fmtDate(w.weekStart, 'd MMM'), label: { formatter: w.event!, color: t.ink2, fontSize: 10, position: 'insideEndTop' }, lineStyle: { color: t.critical, type: 'solid', width: 1 } })),
          },
        },
        { type: 'line', name: 'Fitness (CTL)', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, smooth: 0.3, data: weeks.map((w) => w.ctl), lineStyle: { color: t.ctl, width: 2.5 }, itemStyle: { color: t.ctl } },
        { type: 'line', name: 'Fatigue (ATL)', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, smooth: 0.3, data: weeks.map((w) => w.atl), lineStyle: { color: t.atl, width: 1.5 }, itemStyle: { color: t.atl } },
        { type: 'bar', name: 'Form (TSB)', xAxisIndex: 1, yAxisIndex: 1, barMaxWidth: 8, data: weeks.map((w) => ({ value: w.tsb, itemStyle: { color: alpha(t.tsb, 0.7) } })), itemStyle: { color: t.tsb } },
      ],
    };
  }, [weeks, t]);
  return <Chart option={option} height={370} />;
}

function EventsCard({ events }: { events: RaceEvent[] }) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(iso(new Date()));
  const [priority, setPriority] = useState<'A' | 'B' | 'C'>('A');
  const [sport, setSport] = useState<Sport>('ride');
  const add = useAction(() => http('/events', { method: 'POST', json: { name, date, priority, sport } }), { onSuccess: () => setName('') });
  const del = useAction((id: number) => http(`/events/${id}`, { method: 'DELETE' }));
  const upcoming = events.filter((e) => e.date >= iso(new Date()));
  const color = { A: 'var(--critical)', B: 'var(--serious)', C: 'var(--muted)' } as const;
  return (
    <Card title="Goal events" subtitle="A = peak for it · B = important, short taper · C = train through">
      <div className="space-y-1">
        {upcoming.length === 0 && <p className="py-3 text-xs text-muted">No upcoming events.</p>}
        {upcoming.map((e) => (
          <div key={e.id} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-surface-2">
            <Flag className="h-4 w-4" style={{ color: color[e.priority] }} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{e.name}</div>
              <div className="text-[11px] text-muted">
                {fmtDate(e.date)} · {SPORT_LABEL[e.sport]}
              </div>
            </div>
            <Badge>{e.priority}</Badge>
            <button onClick={() => del.mutate(e.id)} className="rounded p-1 text-muted hover:text-critical" aria-label="Delete">
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-line pt-3">
        <Input placeholder="Event name" value={name} onChange={(e) => setName(e.target.value)} className="col-span-2" />
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <Select value={sport} onChange={(e) => setSport(e.target.value as Sport)}>
          {Object.entries(SPORT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Segmented value={priority} onChange={setPriority} options={[{ value: 'A', label: 'A race' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }]} />
        <Button icon={<Plus className="h-4 w-4" />} disabled={!name} loading={add.isPending} onClick={() => add.mutate(undefined)}>
          Add event
        </Button>
      </div>
    </Card>
  );
}

export function Season() {
  const t = useTokens();
  const defaults = useApi<SeasonPlanConfig & { eventId: number | null }>('/plans/defaults');
  const events = useApi<RaceEvent[]>('/events');
  const plans = useApi<SeasonPlan[]>('/plans');
  const [cfg, setCfg] = useState<SeasonPlanConfig | null>(null);
  const [name, setName] = useState('Season plan');
  const [eventId, setEventId] = useState<number | null>(null);
  const [preview, setPreview] = useState<SeasonWeek[] | null>(null);
  const [applyWeeks, setApplyWeeks] = useState(4);
  useEffect(() => {
    if (defaults.data && !cfg) {
      const { eventId: ev, ...c } = defaults.data;
      setCfg(c);
      setEventId(ev);
      const e = events.data?.find((x) => x.id === ev);
      if (e) setName(`Road to ${e.name}`);
    }
  }, [defaults.data, cfg, events.data]);
  useEffect(() => {
    if (!cfg) return;
    const h = setTimeout(() => http<SeasonWeek[]>('/plans/preview', { method: 'POST', json: cfg }).then(setPreview).catch(() => setPreview(null)), 200);
    return () => clearTimeout(h);
  }, [cfg]);
  const save = useAction(() => http<SeasonPlan>('/plans', { method: 'POST', json: { name, config: cfg, eventId } }));
  const del = useAction((id: number) => http(`/plans/${id}`, { method: 'DELETE' }));
  const apply = useAction((id: number) => http<{ created: number }>(`/plans/${id}/apply`, { method: 'POST', json: { weeks: applyWeeks } }), { onSuccess: (r) => alert(`Added ${r.created} workouts to your calendar.`) });

  if (!cfg) return <Spinner />;
  const set = <K extends keyof SeasonPlanConfig>(k: K, v: SeasonPlanConfig[K]) => setCfg({ ...cfg, [k]: v });
  const aRaces = (events.data ?? []).filter((e) => e.date > iso(new Date()));
  const last = preview?.[preview.length - 1];
  const peak = preview ? Math.max(...preview.map((w) => w.ctl)) : null;
  const totalHours = preview?.reduce((a, w) => a + w.hours, 0);

  return (
    <div>
      <PageHeader title="Season Planner" subtitle="Periodise backwards from your goal event: base → build → peak → taper, with recovery weeks and a safe ramp rate" />
      <div className="grid gap-4 xl:grid-cols-[340px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Card title="Plan settings">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Plan name" className="col-span-2">
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field label="Goal event" className="col-span-2">
                <Select
                  value={eventId ?? ''}
                  onChange={(e) => {
                    const ev = aRaces.find((x) => x.id === Number(e.target.value));
                    setEventId(ev?.id ?? null);
                    if (ev) {
                      set('raceDate', ev.date);
                      setName(`Road to ${ev.name}`);
                    }
                  }}
                >
                  <option value="">Custom date</option>
                  {aRaces.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.priority} · {e.name} ({fmtDate(e.date, 'd MMM')})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Start">
                <Input type="date" value={cfg.startDate} onChange={(e) => set('startDate', e.target.value)} />
              </Field>
              <Field label="Race day">
                <Input type="date" value={cfg.raceDate} onChange={(e) => set('raceDate', e.target.value)} />
              </Field>
              <Field label="Current CTL" hint="From your PMC">
                <Input type="number" value={cfg.startCtl} onChange={(e) => set('startCtl', Number(e.target.value))} />
              </Field>
              <Field label="Target CTL" hint="Fitness on race day">
                <Input type="number" value={cfg.targetCtl} onChange={(e) => set('targetCtl', Number(e.target.value))} />
              </Field>
              <Field label="Max ramp" hint="CTL / week">
                <Input type="number" step={0.5} value={cfg.maxRamp} onChange={(e) => set('maxRamp', Number(e.target.value))} />
              </Field>
              <Field label="Max hours / week">
                <Input type="number" value={cfg.maxWeeklyHours} onChange={(e) => set('maxWeeklyHours', Number(e.target.value))} />
              </Field>
              <Field label="Loading pattern" hint="load weeks : recovery week">
                <Segmented value={cfg.pattern} onChange={(v) => set('pattern', v)} options={[{ value: '2:1', label: '2:1' }, { value: '3:1', label: '3:1' }, { value: '4:1', label: '4:1' }]} />
              </Field>
              <Field label="Taper weeks">
                <Segmented value={cfg.taperWeeks} onChange={(v) => set('taperWeeks', v)} options={[{ value: 1, label: '1' }, { value: 2, label: '2' }, { value: 3, label: '3' }]} />
              </Field>
            </div>
            <Button variant="primary" className="mt-4 w-full" icon={<Save className="h-4 w-4" />} loading={save.isPending} onClick={() => save.mutate(undefined)}>
              Save plan
            </Button>
          </Card>
          <EventsCard events={events.data ?? []} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <Card title="Plan preview" subtitle="Weekly TSS by phase and the fitness/form it produces" actions={<div className="flex flex-wrap gap-2">{PHASES.map((p) => <span key={p} className="inline-flex items-center gap-1 text-[11px] text-ink-2"><span className="h-2 w-2 rounded-sm" style={{ background: phaseColor(t, p) }} />{p}</span>)}</div>}>
            {preview ? (
              <>
                <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-5">
                  <Stat label="Weeks" value={preview.length} />
                  <Stat label="Peak CTL" value={fmtNum(peak)} sub={`from ${cfg.startCtl}`} />
                  <Stat label="Race-day CTL" value={fmtNum(last?.ctl)} />
                  <Stat label="Race-day TSB" value={fmtNum(last?.tsb)} sub={last && last.tsb > 5 ? 'fresh' : 'consider longer taper'} />
                  <Stat label="Total hours" value={fmtNum(totalHours)} />
                </div>
                <PlanChart weeks={preview} />
              </>
            ) : (
              <Spinner />
            )}
          </Card>
          {preview && (
            <Card title="Weekly breakdown" pad={false}>
              <div className="max-h-[420px] overflow-y-auto">
                <table className="tnum w-full text-[13px]">
                  <thead className="sticky top-0 bg-surface">
                    <tr className="border-b border-line text-left text-[11px] tracking-wide text-muted uppercase">
                      <th className="py-2 pl-5 font-medium">Week of</th>
                      <th className="px-3 font-medium">Phase</th>
                      <th className="px-3 text-right font-medium">TSS</th>
                      <th className="px-3 text-right font-medium">Hours</th>
                      <th className="px-3 text-right font-medium">CTL</th>
                      <th className="px-3 text-right font-medium">TSB</th>
                      <th className="px-3 pr-5 font-medium">Event</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((w) => (
                      <tr key={w.weekStart} className="border-b border-line/60 last:border-0">
                        <td className="py-1.5 pl-5">{fmtDate(w.weekStart, 'd MMM yyyy')}</td>
                        <td className="px-3">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-sm" style={{ background: phaseColor(t, w.phase) }} />
                            {w.phase}
                          </span>
                        </td>
                        <td className="px-3 text-right font-medium">{w.tss}</td>
                        <td className="px-3 text-right text-ink-2">{w.hours}</td>
                        <td className="px-3 text-right">{w.ctl.toFixed(0)}</td>
                        <td className="px-3 text-right text-ink-2">{w.tsb.toFixed(0)}</td>
                        <td className="px-3 pr-5 text-ink-2">{w.event ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
          <Card title="Saved plans" subtitle="The latest plan drives calendar week targets and long-range PMC projection">
            {!plans.data?.length ? (
              <Empty title="No saved plans yet">Tune the settings, then save to use the plan across the app.</Empty>
            ) : (
              <div className="space-y-2">
                {plans.data.map((p, i) => (
                  <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        {p.name} {i === 0 && <Badge color={t.accent}>Active</Badge>}
                      </div>
                      <div className="text-[11px] text-muted">
                        {fmtDate(p.config.startDate, 'd MMM')} → {fmtDate(p.config.raceDate, 'd MMM yyyy')} · {p.weeks.length} weeks · target CTL {p.config.targetCtl}
                      </div>
                    </div>
                    <Select value={applyWeeks} onChange={(e) => setApplyWeeks(Number(e.target.value))} className="h-8 w-28">
                      {[1, 2, 4, 8, 52].map((n) => (
                        <option key={n} value={n}>
                          {n === 52 ? 'All weeks' : `Next ${n} wk${n > 1 ? 's' : ''}`}
                        </option>
                      ))}
                    </Select>
                    <Button size="sm" variant="primary" icon={<Wand2 className="h-3.5 w-3.5" />} loading={apply.isPending} onClick={() => apply.mutate(p.id)}>
                      Fill calendar
                    </Button>
                    <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => del.mutate(p.id)} />
                  </div>
                ))}
                <p className="text-[11px] text-muted">“Fill calendar” generates structured workouts per phase (e.g. sweet spot in base, threshold + VO2 in build, openers in race week) sized to each week's TSS. Existing generated workouts in that window are replaced.</p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

