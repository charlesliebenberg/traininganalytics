import { useMemo, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { parseISO } from 'date-fns';
import { Activity, ArrowDownRight, ArrowUpRight, Flame, HeartPulse, Minus, Timer, TrendingUp, Trophy, Zap } from 'lucide-react';
import clsx from 'clsx';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDurLabel, fmtDuration, fmtPace } from '../lib/format';
import { breakNames, makeTimeline, type Gap } from '../lib/timeline';

// ---------- API shapes (server/aerobic.ts) ----------
export type AerobicSport = 'ride' | 'run';
export interface Band {
  value: number;
  lo: number;
  hi: number;
}
export interface Trend {
  pct: number;
  sdPct: number;
  from: string;
  fromValue: number;
}
export interface AerobicModelSummary {
  refHr: number;
  heat: number;
  fatigue: number;
  indoor: number;
  dayNoise: number;
  drift: number;
  condition: number;
  conditionDays: number;
  activities: number;
}
export interface AerobicPointOut {
  id: number;
  date: string;
  value: number;
  fitness: number;
  lo: number;
  hi: number;
}
export interface AerobicInsight {
  sport: AerobicSport;
  method: 'steady' | 'kinetic';
  refHr: number;
  value: number;
  expected: Band | null;
  fitnessBefore: Band | null;
  fitnessAfter: Band;
  z: number | null;
  zFitness: number | null;
  conditionPct: number;
  rank: { beat: number | null; of: number };
  raw: { hr: number; out: number; n: number; cost: number; expectedHr: number };
  adjust: { heat: number; fatigue: number; indoor: number; temp: number | null; tsb: number | null; isIndoor: boolean };
  model: AerobicModelSummary;
  trend: Trend | null;
  stretchFrom: string;
  recent: AerobicPointOut[];
}
export interface EffortFinding {
  kind: 'pb' | 'model' | 'best90' | 'durability' | 'near';
  duration?: number;
  meters?: number;
  kj?: number;
  value: number;
  ref: number;
}
export interface Verdict {
  tone: 'up' | 'flat' | 'down' | 'none';
  title: string;
}
export interface ActivityInsights {
  verdict: Verdict;
  aerobic: AerobicInsight | null;
  unread: 'hard' | 'short' | null;
  /** where aerobic fitness stands (dashboard) */
  fitness?: { sport: AerobicSport; refHr: number; current: Band; change: Trend | null } | null;
  efforts: EffortFinding[];
  tsb: number | null;
}
export interface AerobicTrendData {
  sport: AerobicSport;
  model: AerobicModelSummary;
  current: Band & { date: string };
  change: Trend | null;
  change6: Trend | null;
  points: (AerobicPointOut & { z: number | null; zFitness: number | null; n: number })[];
}

// ---------- words ----------
export const outText = (sport: AerobicSport, v: number) => (sport === 'ride' ? `${Math.round(v)} W` : fmtPace(v, 'run'));
const noun = (sport: AerobicSport) => (sport === 'ride' ? 'ride' : 'run');
const signed = (v: number, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}`;
const distLabel = (m: number) => (m >= 21000 ? 'half marathon' : m >= 1000 ? `${Math.round(m / 1000)} km` : `${m} m`);

/** The heart-rate evidence, in sentences: what the activity was worth, and why. */
export function aerobicSentences(a: AerobicInsight) {
  const n = noun(a.sport);
  const main = a.fitnessBefore
    ? `Worth ${outText(a.sport, a.value)} at ${a.refHr} bpm, against ${outText(a.sport, a.fitnessBefore.value)} for your fitness going in.`
    : `Worth ${outText(a.sport, a.value)} at ${a.refHr} bpm — the first of this stretch, so there's nothing to compare with yet.`;
  const allow: string[] = [];
  if (Math.abs(a.adjust.fatigue) >= 1 && a.adjust.tsb != null) allow.push(`the fatigue you carried in (TSB ${Math.round(a.adjust.tsb)} holds heart rate ${Math.abs(a.adjust.fatigue).toFixed(0)} bpm ${a.adjust.fatigue < 0 ? 'down' : 'up'})`);
  if (Math.abs(a.adjust.heat) >= 1 && a.adjust.temp != null) allow.push(`${Math.round(a.adjust.temp)} °C (${signed(a.adjust.heat)} bpm)`);
  if (a.adjust.isIndoor && Math.abs(a.adjust.indoor) >= 1) allow.push(`riding indoors (${signed(a.adjust.indoor)} bpm)`);
  const since = fmtDate(a.stretchFrom, 'MMMM');
  const beat = a.rank.beat;
  const rank = beat == null || a.rank.of < 10 ? '' : beat >= 0.5 ? ` Better than ${Math.round(beat * 100)}% of your ${n}s since ${since}.` : ` Below most of your ${n}s since ${since} — ${Math.round((1 - beat) * 100)}% were better.`;
  const how = a.method === 'kinetic' ? `No long steady stretch, so read from the whole ${n}, allowing for heart rate's lag behind ${a.sport === 'ride' ? 'power' : 'pace'}. ` : '';
  const at = a.sport === 'run' ? `${outText(a.sport, a.raw.out)} grade-adjusted` : outText(a.sport, a.raw.out);
  const high = (a.zFitness ?? 0) >= 1.5 || (a.z ?? 0) >= 1.5 ? ' Heat beyond what the model allows for, dehydration, a short night or a cold coming on can all do this — one day means little; several in a row are worth an easy day.' : '';
  const detail = `${how}Heart rate ${a.raw.hr} at ${at}, where your curve says ${a.raw.expectedHr}${allow.length ? `, allowing for ${allow.join(' and ')}` : ''}.${rank}${high}`;
  const t = a.trend;
  const fitness = `Aerobic fitness ${outText(a.sport, a.fitnessAfter.value)} at ${a.refHr} bpm${t ? `, ${signed(t.pct)}% since ${fmtDate(t.from, 'd MMM')} (±${Math.max(1, Math.round(t.sdPct))}%)` : ''}.`;
  const c = a.conditionPct;
  const condition =
    Math.abs(c) >= 3
      ? `Recent ${n}s are running ${Math.abs(c).toFixed(0)}% ${c > 0 ? 'above' : 'below'} that level — ${c > 0 ? 'a good spell, or a gain the next few rides will confirm' : 'heat, fatigue, illness or poor sleep can do this; spells usually pass within a week'}.`
      : null;
  return { main, detail, fitness, condition };
}

/** An effort finding in a sentence. */
export function effortSentence(e: EffortFinding): string {
  const run = e.meters != null;
  const label = run ? distLabel(e.meters!) : fmtDurLabel(e.duration!);
  const val = (v: number) => (run ? fmtDuration(v) : `${Math.round(v)} W`);
  switch (e.kind) {
    case 'pb':
      return `New best ${label}: ${val(e.value)} (was ${val(e.ref)}).`;
    case 'best90':
      return `Best ${label} in 90 days: ${val(e.value)} (was ${val(e.ref)}).`;
    case 'near':
      return run ? `${label} in ${val(e.value)}, within ${Math.round((e.value / e.ref - 1) * 100)}% of your 90-day best (${val(e.ref)}).` : `${label} at ${val(e.value)}: ${Math.round((e.value / e.ref) * 100)}% of your 90-day best (${val(e.ref)}).`;
    case 'durability':
      return `Best ${label} after ${(e.kj! / 1000).toFixed(0)},000 kJ in 90 days: ${val(e.value)} (was ${val(e.ref)}) — power held deep into a long ride.`;
    case 'model':
      return `${label} at ${val(e.value)} — more than your current model says you can hold (${val(e.ref)}). Your FTP estimate should rise.`;
  }
}

const EFFORT_ICON: Record<EffortFinding['kind'], ReactNode> = {
  pb: <Trophy className="h-4 w-4" />,
  model: <Zap className="h-4 w-4" />,
  best90: <TrendingUp className="h-4 w-4" />,
  durability: <Timer className="h-4 w-4" />,
  near: <Activity className="h-4 w-4" />,
};

// ---------- pieces ----------
export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  const t = useTokens();
  const icon =
    verdict.tone === 'up' ? <ArrowUpRight className="h-4 w-4" style={{ color: t.good }} /> : verdict.tone === 'down' ? <ArrowDownRight className="h-4 w-4" style={{ color: t.warning }} /> : <Minus className="h-4 w-4 text-muted" />;
  return (
    <div className={clsx('inline-flex items-center gap-1.5 text-[15px] font-semibold', verdict.tone === 'up' ? 'text-good-text' : verdict.tone === 'none' ? 'text-muted' : 'text-ink', className)}>
      {icon}
      {verdict.title}
    </div>
  );
}

function Evidence({ icon, children, sub }: { icon: ReactNode; children: ReactNode; sub?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 shrink-0 text-muted">{icon}</span>
      <div className="min-w-0">
        <div className="text-[13px] leading-snug text-ink">{children}</div>
        {sub && <div className="mt-0.5 text-xs leading-snug text-ink-2">{sub}</div>}
      </div>
    </li>
  );
}

/**
 * What an activity says about fitness: the verdict, the heart-rate evidence, efforts in
 * context, and (unless compact) the activity among its recent ones on the fitness band.
 */
export function InsightPanel({ insights, compact = false }: { insights: ActivityInsights; compact?: boolean }) {
  const a = insights.aerobic;
  const s = a ? aerobicSentences(a) : null;
  const efforts = compact ? insights.efforts.slice(0, 1) : insights.efforts;
  return (
    <div className={clsx(!compact && a && 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]')}>
      <div className="min-w-0">
        <VerdictBadge verdict={insights.verdict} />
        <ul className="mt-3 space-y-3">
          {s && (
            <Evidence icon={<HeartPulse className="h-4 w-4" />} sub={compact ? undefined : s.detail}>
              {s.main}
            </Evidence>
          )}
          {efforts.map((e, i) => (
            <Evidence key={i} icon={EFFORT_ICON[e.kind]}>
              {effortSentence(e)}
            </Evidence>
          ))}
          {s && (
            <Evidence icon={<TrendingUp className="h-4 w-4" />} sub={compact ? undefined : s.condition}>
              {s.fitness}
            </Evidence>
          )}
          {!a && insights.unread === 'hard' && (
            <Evidence icon={<HeartPulse className="h-4 w-4" />}>
              Too hard and surgy to read aerobic fitness from: surges hold heart rate up in a way that would look like lost fitness. Steady and easy rides read best.
            </Evidence>
          )}
          {!a && insights.unread === 'short' && (
            <Evidence icon={<HeartPulse className="h-4 w-4" />}>Not enough riding with heart rate to read aerobic fitness from — it needs about 10 minutes.</Evidence>
          )}
          {!a && insights.fitness && (
            <Evidence icon={<TrendingUp className="h-4 w-4" />}>
              Aerobic fitness {outText(insights.fitness.sport, insights.fitness.current.value)} at {insights.fitness.refHr} bpm
              {insights.fitness.change ? `, ${signed(insights.fitness.change.pct)}% since ${fmtDate(insights.fitness.change.from, 'd MMM')} (±${Math.max(1, Math.round(insights.fitness.change.sdPct))}%)` : ''}.
            </Evidence>
          )}
          {!a && !insights.unread && !insights.efforts.length && (
            <li className="text-[13px] text-ink-2">Nothing here to read fitness from: no heart rate, and no effort near your recent bests.</li>
          )}
        </ul>
        {!compact && a && (
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            <Flame className="mr-1 inline h-3 w-3" />
            Learned from your {a.model.activities} {noun(a.sport)}s: heat {a.model.heat.toFixed(1)} bpm per °C, fatigue {(a.model.fatigue * 10).toFixed(1)} bpm per 10 points of TSB
            {a.model.indoor ? `, indoors ${signed(a.model.indoor)} bpm` : ''}. Day-to-day noise is about ±{a.model.dayNoise} bpm, so one {noun(a.sport)} is evidence, not proof.
          </p>
        )}
      </div>
      {!compact && a && a.recent.length >= 3 && (
        <div className="min-w-0">
          <div className="mb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
            Your last 8 weeks · output at {a.refHr} bpm
          </div>
          <AerobicChart sport={a.sport} points={a.recent} highlight={insights.aerobic ? a.recent[a.recent.length - 1].id : undefined} height={190} compact />
        </div>
      )}
    </div>
  );
}

// ---------- the chart ----------
const DAY = 86400000;

/**
 * Aerobic fitness through time: the fitness level (line, ±1 sd band) and each activity's own
 * reading under standard conditions (dots). Long breaks are squeezed. Runs plot speed so that
 * up is better, labelled as pace.
 */
export function AerobicChart({ sport, points, highlight, height = 300, compact = false }: { sport: AerobicSport; points: AerobicPointOut[]; highlight?: number; height?: number; compact?: boolean }) {
  const t = useTokens();
  const nav = useNavigate();
  const option = useMemo(() => {
    const ts = points.map((p) => parseISO(p.date).getTime());
    const gaps: Gap[] = [];
    for (let i = 1; i < points.length; i++) {
      const days = Math.round((ts[i] - ts[i - 1]) / DAY);
      if (days >= 90) gaps.push({ from: fmtDate(new Date(ts[i - 1] + DAY), 'yyyy-MM-dd'), to: fmtDate(new Date(ts[i] - DAY), 'yyyy-MM-dd'), days: days - 1 });
    }
    const tl = makeTimeline(gaps);
    const X = ts.map((v) => tl.toX(v));
    const broken = (i: number) => i > 0 && tl.breaks.some((g) => g.a > ts[i - 1] && g.a < ts[i]);
    const line = (get: (p: AerobicPointOut) => number) => {
      const out: (number | null)[][] = [];
      points.forEach((p, i) => {
        if (broken(i)) out.push([(X[i - 1] + X[i]) / 2, null]);
        out.push([X[i], get(p)]);
      });
      return out;
    };
    const fmt = (v: number) => outText(sport, v);
    const axisFmt = (v: number) => (sport === 'ride' ? `${Math.round(v)}` : fmtPace(v, 'run', false));
    const byX = new Map(X.map((x, i) => [x, points[i]]));
    const color = t.accent;
    const span = X[X.length - 1] - X[0];
    return {
      animation: false,
      grid: { left: 44, right: 12, top: compact ? 10 : 34, bottom: 26 },
      legend: compact ? undefined : { ...legendStyle(t), data: ['Fitness', 'Each ' + noun(sport)] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        axisPointer: { type: 'line', lineStyle: { color: t.line } },
        formatter: (ps: any) => {
          const p = byX.get(ps.find((x: any) => x.seriesName.startsWith('Each'))?.value?.[0] ?? ps[0]?.value?.[0]);
          if (!p) return '';
          return `<b>${fmtDate(p.date, 'EEE d MMM yyyy')}</b>${tipRow(alpha(t.ink2, 0.6), `This ${noun(sport)}`, fmt(p.value))}${tipRow(color, 'Fitness', `${fmt(p.fitness)} <span style="opacity:.6">(${fmt(p.lo)}–${fmt(p.hi)})</span>`)}<div style="opacity:.6;font-size:11px;margin-top:4px">Under standard conditions · click to open</div>`;
        },
      },
      xAxis: {
        type: 'value',
        min: X[0] - Math.max(DAY, span * 0.02),
        max: X[X.length - 1] + Math.max(DAY, span * 0.02),
        ...axisStyle(t, { grid: false }),
        splitNumber: compact ? 4 : 8,
        axisLabel: { color: t.muted, fontSize: 10, hideOverlap: true, formatter: (v: number) => (tl.inBreak(v) ? '' : fmtDate(new Date(tl.fromX(v)), span > 200 * DAY ? 'MMM yy' : 'd MMM')) },
      },
      yAxis: valueAxis(t, { scale: true, axisLabel: { color: t.muted, fontSize: 10, formatter: axisFmt } }),
      series: [
        // ±1 sd band: a transparent base plus the band's height, stacked
        { type: 'line', name: 'band-base', stack: 'band', silent: true, showSymbol: false, connectNulls: false, data: line((p) => p.lo), lineStyle: { opacity: 0 }, tooltip: { show: false } },
        { type: 'line', name: 'band', stack: 'band', silent: true, showSymbol: false, connectNulls: false, data: line((p) => p.hi - p.lo), lineStyle: { opacity: 0 }, areaStyle: { color: alpha(color, 0.14) }, tooltip: { show: false } },
        {
          type: 'line',
          name: 'Fitness',
          showSymbol: false,
          connectNulls: false,
          data: line((p) => p.fitness),
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          markArea: tl.breaks.length
            ? { silent: true, itemStyle: { color: alpha(t.muted, 0.12) }, label: { show: !compact, position: 'insideTop', color: t.muted, fontSize: 10, lineHeight: 13, formatter: (p: any) => p.name }, data: tl.breaks.map((g, i, all) => [{ xAxis: g.x0, name: breakNames(all)[i] }, { xAxis: g.x1 }]) }
            : undefined,
        },
        {
          type: 'scatter',
          name: 'Each ' + noun(sport),
          symbolSize: (_: unknown, p: any) => (points[p.dataIndex]?.id === highlight ? 12 : compact ? 7 : 6),
          z: 5,
          cursor: 'pointer',
          data: points.map((p, i) => ({
            value: [X[i], p.value],
            itemStyle: p.id === highlight ? { color, borderColor: t.surface, borderWidth: 2 } : { color: alpha(t.ink2, 0.45) },
          })),
          itemStyle: { color: alpha(t.ink2, 0.45) },
        },
      ],
    };
  }, [points, sport, highlight, compact, t]);
  return (
    <Chart
      option={option}
      height={height}
      onEvents={{
        click: (e: any) => {
          if (e.seriesName?.startsWith('Each')) {
            const p = points[e.dataIndex];
            if (p) nav(`/activities/${p.id}`);
          }
        },
      }}
    />
  );
}
