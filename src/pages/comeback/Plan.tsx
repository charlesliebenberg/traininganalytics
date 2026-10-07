import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { addDays, parseISO } from 'date-fns';
import { AlertTriangle, Wand2 } from 'lucide-react';
import type { BuildSummary } from '../../../shared/analytics/comeback';
import { Button, Card, Field, Input, Segmented, Spinner, Stat, Toggle } from '../../components/ui';
import { Chart, axisStyle, tipRow, tooltipStyle, valueAxis } from '../../components/Chart';
import { http, useAction } from '../../lib/api';
import { alpha, useTokens } from '../../lib/theme';
import { fmtDate, fmtNum } from '../../lib/format';
import { PlanChart } from '../Season';
import { peakName, type PeakCard, type Preview } from './types';

/**
 * A plan that ramps to the chosen steady load and holds it until the capacity model says the
 * peak's level is back — then creates it and fills the next four weeks of the calendar.
 */
export function PlanSection({ peak, weeklyTss, setWeeklyTss, mix, buildTssPerHour, recentTssPerHour }: { peak: PeakCard; weeklyTss: number; setWeeklyTss: (n: number) => void; mix: BuildSummary['mix'] | null; buildTssPerHour: number | null; recentTssPerHour: number }) {
  const t = useTokens();
  const nav = useNavigate();
  const name = peakName(peak);
  const [initialRamp, setInitialRamp] = useState(3);
  const [ramp, setRamp] = useState(5);
  const [pattern, setPattern] = useState<'2:1' | '3:1' | '4:1'>('3:1');
  const [copyMix, setCopyMix] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  const target = peak.capacity ?? 0;
  useEffect(() => {
    const h = setTimeout(
      () =>
        http<Preview>('/comeback/plan-preview', {
          method: 'POST',
          json: { weeklyTss, targetCapacity: target, initialRamp, maxRamp: ramp, pattern, mix: copyMix && mix ? mix : undefined, tssPerHour: copyMix && buildTssPerHour ? buildTssPerHour : recentTssPerHour },
        })
          .then(setPreview)
          .catch(() => setPreview(null)),
      250,
    );
    return () => clearTimeout(h);
  }, [weeklyTss, target, initialRamp, ramp, pattern, copyMix, mix, buildTssPerHour, recentTssPerHour]);
  const create = useAction(
    async () => {
      const plan = await http<{ id: number }>('/plans', { method: 'POST', json: { name: `Comeback → ${name} capacity`, config: preview!.config } });
      return http(`/plans/${plan.id}/apply`, { method: 'POST', json: { weeks: 4 } });
    },
    { onSuccess: () => nav('/calendar') },
  );

  const capOption = useMemo(() => {
    if (!preview || !preview.weeks.some((w) => w.capacity != null)) return null;
    const cats = preview.weeks.map((w) => fmtDate(w.weekStart, 'd MMM'));
    const ws = preview.weeks;
    return {
      animation: false,
      grid: { left: 48, right: 16, top: 16, bottom: 24 },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const w = ws[ps[0].dataIndex];
          return `<b>Week of ${fmtDate(w.weekStart, 'd MMM yyyy')}</b>${tipRow(t.accent, 'Capacity', `${w.capacity} W`)}<div style="opacity:.6;font-size:11px;margin-top:4px">plausible range ${w.low}–${w.high} W</div>`;
        },
      },
      xAxis: { type: 'category', data: cats, ...axisStyle(t, { grid: false }), axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true } },
      yAxis: valueAxis(t, { scale: true }),
      series: [
        { type: 'line', stack: 'band', silent: true, showSymbol: false, data: ws.map((w) => w.low), lineStyle: { opacity: 0 }, tooltip: { show: false } },
        { type: 'line', stack: 'band', silent: true, showSymbol: false, data: ws.map((w) => (w.high ?? 0) - (w.low ?? 0)), lineStyle: { opacity: 0 }, areaStyle: { color: alpha(t.accent, 0.12) }, tooltip: { show: false } },
        {
          type: 'line',
          showSymbol: false,
          data: ws.map((w) => w.capacity),
          lineStyle: { color: t.accent, width: 2 },
          itemStyle: { color: t.accent },
          markLine: target ? { symbol: 'none', silent: true, data: [{ yAxis: Math.round(target) }], lineStyle: { color: t.series[1], width: 1.5, type: 'solid' }, label: { formatter: `${name} · ${Math.round(target)} W`, color: t.ink2, fontSize: 10, position: 'insideEndTop' } } : undefined,
        },
      ],
    };
  }, [preview, t, target, name]);

  const end = preview?.weeks[preview.weeks.length - 1];
  const hold = preview ? Math.max(...preview.weeks.map((w) => w.hours)) : 0;
  return (
    <Card
      className="mt-4"
      title="Your plan"
      subtitle={
        preview && !preview.gentle
          ? `Ramps to your steady load at up to ${ramp} CTL a week, then holds it with recovery weeks in your rhythm, alternating 4-week base and build blocks. No gentle start: you've ridden consistently for ${preview.ridingMonths} months.`
          : 'A gentle first month (tendons and joints adapt slower than fitness), then up to your steady load, held with recovery weeks in your rhythm, alternating 4-week base and build blocks.'
      }
    >
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <div className="grid h-fit grid-cols-2 gap-3">
          <Field label="Steady weekly load (TSS)" className="col-span-2" hint="same as the slider above">
            <Input type="number" step={10} value={weeklyTss} onChange={(e) => setWeeklyTss(Math.max(100, Math.min(1500, Number(e.target.value) || 0)))} />
          </Field>
          {preview?.gentle !== false && (
            <Field label="First 4 weeks" hint="CTL / week">
              <Input type="number" step={0.5} value={initialRamp} onChange={(e) => setInitialRamp(Number(e.target.value))} />
            </Field>
          )}
          <Field label={preview?.gentle === false ? 'Ramp' : 'Then up to'} hint="CTL / week" className={preview?.gentle === false ? 'col-span-2' : undefined}>
            <Input type="number" step={0.5} value={ramp} onChange={(e) => setRamp(Number(e.target.value))} />
          </Field>
          <Field label="Rhythm" className="col-span-2">
            <Segmented value={pattern} onChange={setPattern} options={[{ value: '2:1', label: '2:1' }, { value: '3:1', label: '3:1' }, { value: '4:1', label: '4:1' }]} />
          </Field>
          {mix && (
            <div className="col-span-2">
              <Toggle checked={copyMix} onChange={setCopyMix} label={`Train like the build to ${name} (${mix.quality.toFixed(1)} quality sessions a week, ${Math.round(mix.vo2Share * 100)}% VO2${mix.longRides >= 0.4 ? ', long rides' : ''}${buildTssPerHour ? `, ~${Math.round(buildTssPerHour)} TSS/h` : ''})`} />
            </div>
          )}
          <Button className="col-span-2 mt-2" variant="primary" icon={<Wand2 className="h-4 w-4" />} disabled={!preview} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            Create plan & fill next 4 weeks
          </Button>
          <p className="col-span-2 text-[11px] text-muted">Saved as your active season plan; fill later weeks from the Season Planner as you go.</p>
        </div>
        <div className="min-w-0">
          {!preview ? (
            <Spinner />
          ) : (
            <>
              {!preview.reached && target > 0 && (
                <div className="mb-3 flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-xs">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-label="warning" />
                  <span>
                    At {fmtNum(weeklyTss)} TSS a week your capacity doesn't reach the {name} level within two years
                    {preview.arrivalRange ? ` (the models that get there do so ${fmtDate(preview.arrivalRange[0], 'MMM yyyy')} – ${fmtDate(preview.arrivalRange[1], 'MMM yyyy')})` : ''}. The plan shows a year of it; raise the load to get there sooner.
                  </span>
                </div>
              )}
              <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                  label="Back to capacity"
                  value={preview.arrival ? fmtDate(preview.arrival, 'MMM yyyy') : '–'}
                  sub={preview.arrivalRange && preview.arrivalRange[0] !== preview.arrivalRange[1] ? `range ${fmtDate(preview.arrivalRange[0], 'MMM yy')} – ${fmtDate(preview.arrivalRange[1], 'MMM yy')}` : undefined}
                />
                <Stat label="Plan length" value={preview.weeks.length} unit="weeks" sub={end ? `to ${fmtDate(addDays(parseISO(end.weekStart), 6), 'd MMM yyyy')}` : undefined} />
                <Stat label="CTL" value={`${preview.startCtl} → ${Math.round(weeklyTss / 7)}`} sub="then held" />
                <Stat label="Hours" value={`≈ ${preview.holdHours.toFixed(1)}`} unit="h / week" sub={`load weeks up to ${hold.toFixed(1)} h`} />
              </div>
              <PlanChart weeks={preview.weeks} />
              {capOption && (
                <>
                  <div className="mt-2 text-xs font-medium text-ink-2">Your 20-minute capacity along the way</div>
                  <Chart option={capOption} height={170} />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
