import clsx from 'clsx';
import { AlertTriangle, PenLine, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { useTokens } from '../../lib/theme';
import { fmtDate, fmtNum } from '../../lib/format';
import { ARRIVES, SCENARIO_NAMES, scenarioColor, signed, type ForecastData, type Limits, type Scenario, type ScenarioId } from '../../lib/forecast';
import { formColor } from '../../components/charts';
import { Button, Field, Input, Menu } from '../../components/ui';

/**
 * The ways to race day, side by side: where each leaves your FTP, form and fitness on the day.
 * Picking one draws it on the chart and fills the weeks ahead with it.
 */
export function ScenarioStrip({ d, selected, onSelect, onStartCustom }: { d: ForecastData; selected: ScenarioId; onSelect: (id: ScenarioId) => void; onStartCustom: () => void }) {
  const t = useTokens();
  const topFtp = Math.max(...d.scenarios.map((s) => s.race.ftp ?? -Infinity));
  const freshest = d.scenarios.map((s) => ({ id: s.id, off: Math.abs(s.race.tsb / Math.max(s.race.ctl, 1) - d.constraints.target) })).sort((a, b) => a.off - b.off)[0]?.id;
  const ids: ScenarioId[] = ['planned', 'filled', 'best', 'custom'];
  return (
    <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {ids.map((id) => {
        const s = d.scenarios.find((x) => x.id === id);
        if (!s) {
          if (id !== 'custom') return null;
          return (
            <button key={id} type="button" onClick={onStartCustom} className="flex min-h-[132px] flex-col items-start justify-between rounded-2xl border border-dashed border-line-strong p-4 text-left transition-colors hover:border-ink-2 hover:bg-surface">
              <span className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                <PenLine className="h-4 w-4" style={{ color: scenarioColor(t, 'custom') }} />
                Your own plan
              </span>
              <span className="text-[12px] leading-5 text-muted">Start from the best path and set any week’s load: race day follows as you type.</span>
            </button>
          );
        }
        return <Card key={id} s={s} d={d} selected={selected === id} onSelect={() => onSelect(id)} topFtp={s.race.ftp === topFtp} freshest={freshest === id} />;
      })}
    </div>
  );
}

function Card({ s, d, selected, onSelect, topFtp, freshest }: { s: Scenario; d: ForecastData; selected: boolean; onSelect: () => void; topFtp: boolean; freshest: boolean }) {
  const t = useTokens();
  const r = s.race;
  const gain = r.ftp != null && d.now.ftp ? r.ftp - d.now.ftp : null;
  const color = scenarioColor(t, s.id);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={clsx('relative flex min-w-0 flex-col rounded-2xl border bg-surface p-4 text-left shadow-sm transition-[box-shadow,border-color]', selected ? 'border-transparent' : 'border-line hover:border-line-strong')}
      style={selected ? { boxShadow: `0 0 0 2px ${color}, 0 8px 24px -12px ${color}` } : undefined}
    >
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
        <span className="truncate text-[13px] font-semibold text-ink">{SCENARIO_NAMES[s.id]}</span>
        {s.warnings.length > 0 && <AlertTriangle className="ml-auto h-3.5 w-3.5 shrink-0 text-warning" aria-label={s.warnings.join('. ')} />}
      </div>
      <div className="mt-3 flex items-baseline gap-1.5">
        <span className={clsx('figure text-[30px]', topFtp && d.scenarios.length > 1 ? 'text-good-text' : 'text-ink')}>{r.ftp != null ? Math.round(r.ftp) : '–'}</span>
        <span className="text-[12px] font-medium text-muted">W</span>
        {gain != null && <span className={clsx('tnum ml-auto text-[12px] font-semibold', gain > 0.5 ? 'text-good-text' : gain < -0.5 ? 'text-critical' : 'text-muted')}>{signed(gain)}</span>}
      </div>
      <div className="mt-0.5 text-[11px] text-muted">{r.ftpLow != null && r.ftpHigh != null && Math.round(r.ftpHigh) - Math.round(r.ftpLow) >= 1 ? `FTP ${d.race ? 'on race day' : 'then'}, likely ${Math.round(r.ftpLow)}–${Math.round(r.ftpHigh)}` : `FTP ${d.race ? 'on race day' : 'then'}`}</div>
      <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-[11.5px] text-ink-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: formColor(t, r.form) }} />
        <span className={clsx('tnum font-semibold', freshest && 'text-good-text')}>{signed(r.tsb)}</span>
        <span className="truncate text-muted">{ARRIVES[r.form] ?? r.formLabel.toLowerCase()}</span>
        <span className="tnum ml-auto shrink-0 text-muted">CTL {Math.round(r.ctl)}</span>
      </div>
    </button>
  );
}

/** The limits the best path and the gaps' fill keep to. */
export function LimitsMenu({ d, limits, setLimits }: { d: ForecastData; limits: Limits; setLimits: (l: Limits) => void }) {
  return (
    <Menu
      label="Your limits"
      button={({ open, toggle }) => (
        <Button icon={<SlidersHorizontal className="h-4 w-4" />} onClick={toggle} aria-expanded={open}>
          Limits
        </Button>
      )}
      className="w-80 !p-4"
    >
      <div className="space-y-4" onClick={(e) => e.stopPropagation()}>
        <div>
          <div className="text-[13px] font-semibold text-ink">Your limits</div>
          <p className="mt-0.5 text-[12px] text-muted">The best path and the filled gaps keep to these; your own plan is checked against them.</p>
        </div>
        <Field label="Fitness gained a week, at most" hint="CTL a week. 5 is a solid build; above 8, injury and illness risk climb">
          <Input type="number" step={0.5} min={0} max={12} value={limits.maxRamp} onChange={(e) => setLimits({ ...limits, maxRamp: Number(e.target.value) || 0 })} />
        </Field>
        <Field label="Hours a week, at most" hint={`Your biggest week lately: ${d.habits.biggestWeek.toFixed(1)} h`}>
          <Input type="number" step={0.5} min={2} max={40} value={limits.maxHours} onChange={(e) => setLimits({ ...limits, maxHours: Number(e.target.value) || 0 })} />
        </Field>
        <Field label={`Form on race morning: ${Math.round(limits.target * 100)}% of fitness`} hint="5–25% is fresh. Lower keeps more fitness; higher, more freshness">
          <input type="range" min={5} max={25} step={1} value={Math.round(limits.target * 100)} onChange={(e) => setLimits({ ...limits, target: Number(e.target.value) / 100 })} className="w-full accent-[var(--accent)]" />
        </Field>
      </div>
    </Menu>
  );
}

/** Your own plan's tools: start again from any way forward, or scale every week. */
export function CustomTools({ d, setCustom }: { d: ForecastData; setCustom: (c: Record<string, number> | null) => void }) {
  const t = useTokens();
  const from = (id: ScenarioId) => {
    const s = d.scenarios.find((x) => x.id === id);
    if (s) setCustom(Object.fromEntries(s.weeks.map((w) => [w.start, Math.round(w.tss / 5) * 5])));
  };
  const mine = d.scenarios.find((s) => s.id === 'custom');
  const scale = (f: number) => mine && setCustom(Object.fromEntries(mine.weeks.map((w) => [w.start, Math.round((w.tss * f) / 5) * 5])));
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-2xl border border-line bg-surface px-3 py-2">
      <span className="mr-1 text-[12px] font-medium text-ink">Your plan</span>
      <span className="text-[12px] text-muted">set any week’s load in its row below ·</span>
      <span className="text-[12px] text-muted">start from</span>
      {d.scenarios
        .filter((s) => s.id !== 'custom')
        .map((s) => (
          <Button key={s.id} size="sm" variant="ghost" onClick={() => from(s.id)} icon={<span className="h-2 w-2 rounded-full" style={{ background: scenarioColor(t, s.id) }} />}>
            {SCENARIO_NAMES[s.id]}
          </Button>
        ))}
      <span className="mx-1 h-4 w-px bg-line" />
      <Button size="sm" variant="ghost" onClick={() => scale(0.9)}>
        −10%
      </Button>
      <Button size="sm" variant="ghost" onClick={() => scale(1.1)}>
        +10%
      </Button>
      <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => setCustom(null)}>
        Clear
      </Button>
    </div>
  );
}

/** The ways forward side by side, the best of each row marked. */
export function Comparison({ d }: { d: ForecastData }) {
  const t = useTokens();
  const s = d.scenarios;
  const onRace = d.race ? 'on race day' : `on ${fmtDate(d.end, 'd MMM')}`;
  type Row = { label: string; title?: string; value: (x: Scenario) => number | null; fmt: (v: number) => string; better?: 'high' | 'low' | 'target' };
  const rows: Row[] = [
    { label: `FTP ${onRace}`, value: (x) => x.race.ftp, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '5-minute power', value: (x) => x.race.p5, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '20-minute power', value: (x) => x.race.p20, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: '60-minute power', value: (x) => x.race.p60, fmt: (v) => `${Math.round(v)} W`, better: 'high' },
    { label: `Fitness ${onRace}`, value: (x) => x.race.ctl, fmt: (v) => fmtNum(v), better: 'high' },
    { label: `Form ${d.race ? 'on race morning' : 'then'}`, title: `Best close to ${Math.round(d.constraints.target * 100)}% of fitness: fresh, without losing fitness`, value: (x) => x.race.tsb, fmt: (v) => signed(v), better: d.race ? 'target' : undefined },
    { label: 'Riding to then', value: (x) => x.totals.hours, fmt: (v) => `${Math.round(v)} h` },
    { label: 'Biggest week', value: (x) => x.totals.maxWeekHours, fmt: (v) => `${v.toFixed(1)} h` },
    { label: 'Steepest week', title: 'Most fitness gained in a calendar week', value: (x) => x.totals.maxRamp, fmt: (v) => `${signed(v, 1)}` },
  ];
  const bestOf = (r: Row): number | null => {
    const vs = s.map((x) => r.value(x)).filter((v): v is number => v != null);
    if (!r.better || vs.length < 2) return null;
    if (r.better === 'high') return Math.max(...vs);
    if (r.better === 'low') return Math.min(...vs);
    const goal = d.constraints.target;
    return s.map((x) => ({ v: r.value(x), off: Math.abs(x.race.tsb / Math.max(x.race.ctl, 1) - goal) })).sort((a, b) => a.off - b.off)[0].v;
  };
  return (
    <div className="overflow-x-auto">
      <table className="tnum w-full min-w-[560px] text-[13px]">
        <thead>
          <tr className="border-b border-line text-left">
            <th className="py-2 pr-3" />
            {s.map((x) => (
              <th key={x.id} className="px-3 py-2 text-right text-[12px] font-semibold whitespace-nowrap text-ink">
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full" style={{ background: scenarioColor(t, x.id) }} />
                {SCENARIO_NAMES[x.id]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows
            .filter((r) => s.some((x) => r.value(x) != null))
            .map((r) => {
              const b = bestOf(r);
              return (
                <tr key={r.label} className="border-b border-line/60 last:border-0">
                  <td className="py-2 pr-3 text-ink-2" title={r.title}>
                    {r.label}
                  </td>
                  {s.map((x) => {
                    const v = r.value(x);
                    return (
                      <td key={x.id} className={clsx('px-3 py-2 text-right', v != null && b != null && Math.abs(v - b) < 1e-9 ? 'font-semibold text-good-text' : 'text-ink')}>
                        {v == null ? '–' : r.fmt(v)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          <tr>
            <td className="py-2 pr-3 align-top text-ink-2">To watch</td>
            {s.map((x) => (
              <td key={x.id} className="px-3 py-2 text-right align-top text-[11.5px] text-ink-2">
                {x.warnings.length ? x.warnings.map((w) => <div key={w}>{w}</div>) : <span className="text-muted">nothing</span>}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** How the forecast is made, for anyone who wants to know before trusting it. */
export function HowItWorks({ d }: { d: ForecastData }) {
  const m = d.model;
  const shape = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((n, i) => `${n} ${Math.round(d.habits.shape[i] * 100)}%`);
  return (
    <ul className="space-y-2.5 text-[13px] leading-relaxed text-ink-2">
      <li>
        <b className="font-semibold text-ink">Fitness and form</b> are the same performance management numbers as everywhere in the app, ridden forward day by day from today.
      </li>
      <li>
        <b className="font-semibold text-ink">Power</b> comes from your capacity model: your 20-minute power follows a long-term average of your riding load
        {m ? `, over about ${m.tau >= 365 ? `${(m.tau / 365).toFixed(1).replace('.0', '')} year${m.tau >= 730 ? 's' : ''}` : `${Math.round(m.tau / 30)} months`} for you` : ''}, learned from your own history
        {m?.validation ? ` (checked on your comeback, it was within ±${Math.round(m.validation.mae)} W a month, against ±${Math.round(m.validation.maeCtl)} W for a model on fitness alone)` : ''}. Every time constant that fits about as well gives its own answer: that’s the range.
      </li>
      <li>
        <b className="font-semibold text-ink">Your habits</b> turn weekly loads into days and hours: {Math.round(d.habits.rideShare * 100)}% of your load is riding, about {Math.round(d.habits.tssPerHour)} TSS an hour, and a week goes {shape.join(', ')}.
      </li>
      <li>
        <b className="font-semibold text-ink">Not modelled:</b> illness, heat, travel, or the extra few percent fresh legs give on the day. Treat a range as a range.
      </li>
    </ul>
  );
}

export function copyPlan(d: ForecastData, s: Scenario) {
  const lines = [`${SCENARIO_NAMES[s.id]} to ${d.race ? `${d.race.name}, ${fmtDate(d.race.date, 'd MMM yyyy')}` : fmtDate(d.end, 'd MMM yyyy')}`];
  for (const w of s.weeks) lines.push(`Week of ${fmtDate(w.start, 'd MMM')}: ${w.tss} TSS, about ${w.hours.toFixed(1)} h (fitness ${Math.round(w.ctl)}, form ${signed(w.tsb)})`);
  const r = s.race;
  lines.push(`${d.race ? 'Race day' : 'Then'}: fitness ${Math.round(r.ctl)}, form ${signed(r.tsb)} (${r.formLabel.toLowerCase()})${r.ftp != null ? `, FTP about ${Math.round(r.ftp)} W${r.ftpLow != null && r.ftpHigh != null ? ` (${Math.round(r.ftpLow)}–${Math.round(r.ftpHigh)})` : ''}` : ''}`);
  return lines.join('\n');
}
