import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { addDays, format, parseISO } from 'date-fns';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronLeft, ChevronRight, Minus } from 'lucide-react';
import clsx from 'clsx';
import type { Review, ReviewActivity, ReviewNote, ReviewTitle } from '../../shared/analytics/review';
import type { SessionType } from '../../shared/analytics/session';
import { qs, useApi } from '../lib/api';
import { alpha, useTokens } from '../lib/theme';
import { fmtDate, fmtDuration, fmtNum } from '../lib/format';
import { GROUP_LABEL, GROUP_OF, SESSION_GROUPS, TYPE_LABEL, TYPE_SHORT, groupColor, outText, setLabel, typeColor, type SessionGroup } from '../lib/session';
import { effortSentence } from './insights';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from './Chart';
import { Button, Card, Segmented, Spinner, Stat } from './ui';

// ---------- API shape (server/sessions.ts) ----------
export interface DayActs {
  date: string;
  future: boolean;
  tss: number;
  acts: { id: number; sport: string; name: string; type: SessionType | null; long: boolean; tss: number; moving: number }[];
}
export interface TrainingReviewData {
  from: string;
  to: string;
  end: string;
  weeks: number;
  days: number;
  review: Review;
  daily: DayActs[];
  pmc: { date: string; ctl: number; atl: number; tsb: number }[];
  baseline: { weeks: number; tss: number; hours: number; sessions: number; hard: number; long: number; intensity: number | null; restDays: number } | null;
}

// ---------- words ----------
const TITLES: Record<ReviewTitle, [string, string]> = {
  none: ['No training', 'No training'],
  rest: ['Rest week', 'Rest block'],
  recovery: ['Recovery week', 'Recovery block'],
  light: ['Light week', 'Light block'],
  steady: ['Steady week', 'Steady block'],
  build: ['Build week', 'Building'],
  big: ['Big week', 'Big block'],
  spike: ['Big jump in load', 'Load climbing fast'],
};
const day = (d: string) => fmtDate(d, 'EEE d MMM');
const HARD_WORDS: Partial<Record<SessionType, string>> = { threshold: 'threshold', vo2: 'VO2max', anaerobic: 'anaerobic intervals', sprint: 'sprints', race: 'group ride or race' };
const signedPct = (v: number, digits = 0) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}%`;
const noun = (sport: string) => (sport === 'run' ? 'run' : sport === 'ride' ? 'ride' : 'session');
const ActLink = ({ a, children }: { a: Pick<ReviewActivity, 'id'>; children: ReactNode }) => (
  <Link to={`/activities/${a.id}`} className="font-medium text-ink hover:text-accent hover:underline">
    {children}
  </Link>
);

/** One observation as a sentence (activities link to themselves). */
function NoteText({ n, r, weeks }: { n: ReviewNote; r: Review; weeks: number }) {
  const period = weeks === 1 ? (r.partial ? 'so far this week' : 'this week') : `over these ${weeks} weeks`;
  switch (n.kind) {
    case 'load': {
      const per = r.stats.perWeek.tss;
      const vs = n.base ? per / n.base - 1 : null;
      const usual = n.base ? ` — ${vs! >= 0.1 ? `${Math.round(vs! * 100)}% above` : vs! <= -0.1 ? `${Math.round(-vs! * 100)}% below` : 'in line with'} your usual ${Math.round(n.base)} a week` : '';
      if (weeks > 1) return <>{fmtNum(Math.round(per))} TSS and {r.stats.perWeek.hours.toFixed(1)} h a week{usual}.</>;
      if (r.partial) return <>{fmtNum(Math.round(n.tss))} TSS in {n.hours.toFixed(1)} h so far, on course for about {fmtNum(Math.round(per))}{usual}.</>;
      return <>{fmtNum(Math.round(n.tss))} TSS in {n.hours.toFixed(1)} h over {n.sessions} sessions{usual}.</>;
    }
    case 'ctl':
      return (
        <>
          Fitness (CTL) {Math.round(n.from)} → {Math.round(n.to)}
          {n.perWeek >= 8 ? `: ${n.perWeek.toFixed(1)} a week, a steep ramp — hold the next week steadier to absorb it.` : n.perWeek < -2 ? ', easing off — as a lighter week should.' : '.'}
        </>
      );
    case 'form':
      return (
        <>
          Form {Math.round(n.tsb)} at the end
          {n.tsb <= -30 ? ': deep fatigue — a few easy days will let the work land.' : n.tsb <= -10 ? ': the productive range, tired but training.' : n.tsb >= 10 ? ': fresh — ready to race, or to build again.' : ': fresh enough to train hard.'}
        </>
      );
    case 'aerobic':
      return (
        <>
          Aerobic fitness {signedPct(n.pct, 1)} (±{Math.max(1, Math.round(n.sdPct))}%) {period}, read from heart rate on {n.sport === 'run' ? 'runs' : 'rides'}.
        </>
      );
    case 'ftp':
      return (
        <>
          FTP estimate {n.from} → {n.to} W.
        </>
      );
    case 'set': {
      const s = n.act.set!;
      const ch = s.change!;
      const hr = s.hrChange != null && Math.abs(s.hrChange) >= 1 ? `, heart rate ${Math.round(Math.abs(s.hrChange))} bpm ${s.hrChange < 0 ? 'lower' : 'higher'}` : '';
      const vs = s.lastDate ? ` ${Math.abs(ch) < 0.01 ? 'level with' : `${signedPct(ch * 100, 1)} on`} ${fmtDate(s.lastDate, 'd MMM')}${hr}` : '';
      const best = s.rank === 1 && s.of >= 3 ? ` — your best of ${s.of} in a year` : '';
      return (
        <>
          {day(n.act.date)}: <ActLink a={n.act}>{setLabel(s)}</ActLink> at {outText(n.act.sport, s.out)},{vs}
          {best}.
        </>
      );
    }
    case 'effort':
      return (
        <>
          {day(n.act.date)}: <ActLink a={n.act}>{effortSentence(n.finding).replace(/\.$/, '')}</ActLink>.
        </>
      );
    case 'aerobicDay':
      return (
        <>
          {day(n.act.date)}: <ActLink a={n.act}>a better heart-rate reading than your fitness predicted</ActLink>.
        </>
      );
    case 'hrHigh':
      return (
        <>
          Heart rate ran high on {n.acts.length} {n.acts.length === 1 ? noun(n.acts[0].sport) : `${noun(n.acts[0].sport)}s`} (
          {n.acts.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ', '}
              <ActLink a={a}>{fmtDate(a.date, 'EEE d')}</ActLink>
            </span>
          ))}
          ) — heat, fatigue or a cold coming on. Worth an easy day if it continues.
        </>
      );
    case 'mix': {
      if (!n.hard.length) return <>No hard sessions{n.base ? ` — you usually do ${n.base.toFixed(1)} a week` : ''}.</>;
      const usual = n.base != null ? ` — ${weeks > 1 ? `${n.perWeek.toFixed(1)} a week, against ` : ''}${n.base.toFixed(1)} a week usually` : '';
      return (
        <>
          {n.hard.length} hard session{n.hard.length === 1 ? '' : 's'}
          {weeks === 1 && (
            <>
              :{' '}
              {n.hard.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ', '}
                  <ActLink a={a}>
                    {HARD_WORDS[a.type!] ?? TYPE_LABEL[a.type!].toLowerCase()} on {fmtDate(a.date, 'EEE')}
                  </ActLink>
                </span>
              ))}
            </>
          )}
          {usual}.
        </>
      );
    }
    case 'long':
      return weeks === 1 ? (
        <>
          Long{' '}
          {n.acts.map((a, i) => (
            <span key={a.id}>
              {i > 0 && ', '}
              <ActLink a={a}>
                {noun(a.sport)} {fmtDate(a.date, 'EEE')} ({fmtDuration(a.moving, { short: true })})
              </ActLink>
            </span>
          ))}
          .
        </>
      ) : (
        <>
          {n.acts.length} long sessions — the longest {fmtDuration(Math.max(...n.acts.map((a) => a.moving)), { short: true })}.
        </>
      );
    case 'noLong':
      return <>No long ride or run, after {n.streak} weeks in a row with one.</>;
    case 'intensity':
      return (
        <>
          {Math.round(n.share * 100)}% of the time above your first threshold (LT1), against {Math.round(n.base * 100)}% usually — {n.share > n.base ? 'more' : 'less'} intensity than you normally carry.
        </>
      );
    case 'rest':
      return (
        <>
          {n.restDays === 0 ? 'No rest day' : `${n.restDays} rest day${n.restDays === 1 ? '' : 's'}`}
          {n.backToBack.length ? `; hard days back to back on ${n.backToBack.map(([a, b]) => `${fmtDate(a, 'EEE')}–${fmtDate(b, 'EEE')}`).join(' and ')}` : ''}.
        </>
      );
  }
}

function ToneIcon({ tone }: { tone: ReviewNote['tone'] | 'none' }) {
  const t = useTokens();
  if (tone === 'up') return <ArrowUpRight className="h-4 w-4" style={{ color: t.good }} />;
  if (tone === 'down') return <ArrowDownRight className="h-4 w-4" style={{ color: t.serious }} />;
  if (tone === 'warn') return <AlertTriangle className="h-4 w-4" style={{ color: t.warning }} />;
  return <Minus className="h-4 w-4 text-muted" />;
}

function NoteList({ notes, r, weeks, limit }: { notes: ReviewNote[]; r: Review; weeks: number; limit?: number }) {
  return (
    <ul className="space-y-2.5">
      {notes.slice(0, limit).map((n, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-0.5 shrink-0">
            <ToneIcon tone={n.tone} />
          </span>
          <span className="min-w-0 text-[13px] leading-snug text-ink">
            <NoteText n={n} r={r} weeks={weeks} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ReviewHeadline({ r, weeks, className }: { r: Review; weeks: number; className?: string }) {
  const title = TITLES[r.title][weeks === 1 ? 0 : 1];
  return (
    <div className={clsx('inline-flex items-center gap-1.5 text-[15px] font-semibold', r.tone === 'up' ? 'text-good-text' : r.tone === 'none' ? 'text-muted' : 'text-ink', className)}>
      <ToneIcon tone={r.tone} />
      {title}
      {r.partial && <span className="text-xs font-normal text-muted">so far</span>}
    </div>
  );
}

// ---------- the week, day by day ----------
function DayStrip({ daily }: { daily: DayActs[] }) {
  const t = useTokens();
  const max = Math.max(60, ...daily.map((d) => d.tss));
  return (
    <div className="grid grid-cols-7 gap-1.5">
      {daily.map((d) => (
        <div key={d.date} className={clsx('min-w-0 rounded-lg border border-line p-1.5', d.future && 'opacity-45')}>
          <div className="flex items-baseline justify-between gap-1 text-[10px] text-muted">
            <span className="font-medium text-ink-2">{fmtDate(d.date, 'EEE')}</span>
            <span className="hidden sm:inline">{fmtDate(d.date, 'd')}</span>
          </div>
          <div className="mt-1 h-10 rounded bg-surface-2">
            <div className="flex h-full flex-col justify-end overflow-hidden rounded">
              {d.acts.map((a) => (
                <div key={a.id} title={`${a.name} · ${a.type ? TYPE_LABEL[a.type] : 'No analysis'} · ${a.tss} TSS`} style={{ height: `${(a.tss / max) * 100}%`, background: a.type ? typeColor(t, a.type) : alpha(t.muted, 0.4), borderTop: `1px solid ${t.surface}` }} />
              ))}
            </div>
          </div>
          <div className="mt-1 space-y-0.5">
            {d.acts.length === 0 && !d.future && <div className="truncate text-[10px] text-muted">Rest</div>}
            {d.acts.map((a) => (
              <Link key={a.id} to={`/activities/${a.id}`} className="block truncate text-[10px] leading-tight text-ink-2 hover:text-accent" title={`${a.name}${a.type ? ` · ${TYPE_LABEL[a.type]}` : ''}`}>
                <span className="sm:hidden">{a.type ? TYPE_SHORT[a.type] : a.sport}</span>
                <span className="hidden sm:inline">
                  {a.type ? TYPE_LABEL[a.type] : a.sport}
                  {a.long ? ' · long' : ''}
                </span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A block, week by week: TSS stacked by kind of session, against the usual week. */
function WeekBars({ daily, base, weeks }: { daily: DayActs[]; base: number | null; weeks: number }) {
  const t = useTokens();
  const option = useMemo(() => {
    const rows = Array.from({ length: weeks }, (_, w) => daily.slice(w * 7, w * 7 + 7));
    const groups: (SessionGroup | 'other')[] = [...SESSION_GROUPS, 'other'];
    const used = groups.filter((g) => rows.some((r) => r.some((d) => d.acts.some((a) => (a.type ? GROUP_OF[a.type] : 'other') === g))));
    const color = (g: SessionGroup | 'other') => (g === 'other' ? alpha(t.muted, 0.35) : groupColor(t, g));
    const label = (g: SessionGroup | 'other') => (g === 'other' ? 'Other' : GROUP_LABEL[g]);
    return {
      animation: false,
      grid: { left: 40, right: 10, top: 34, bottom: 24 },
      legend: { ...legendStyle(t), data: used.map(label) },
      tooltip: {
        trigger: 'axis' as const,
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const r = rows[ps[0].dataIndex];
          const total = r.reduce((s, d) => s + d.tss, 0);
          return `<b>Week of ${fmtDate(r[0].date, 'd MMM')}</b>${ps.filter((p: any) => p.value).map((p: any) => tipRow(p.color, p.seriesName, `${Math.round(p.value)} TSS`)).join('')}${tipRow('transparent', 'Total', `${Math.round(total)} TSS`)}`;
        },
      },
      xAxis: { type: 'category' as const, data: rows.map((r) => fmtDate(r[0].date, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: valueAxis(t, { splitNumber: 3 }),
      series: used.map((g, i) => ({
        type: 'bar' as const,
        name: label(g),
        stack: 'tss',
        barMaxWidth: 28,
        itemStyle: { color: color(g), borderColor: t.surface, borderWidth: 1, borderRadius: i === used.length - 1 ? [3, 3, 0, 0] : 0 },
        data: rows.map((r) => Math.round(r.reduce((s, d) => s + d.acts.filter((a) => (a.type ? GROUP_OF[a.type] : 'other') === g).reduce((x, a) => x + a.tss, 0), 0))),
        markLine: i === 0 && base ? { symbol: 'none', silent: true, data: [{ yAxis: Math.round(base) }], lineStyle: { color: t.muted, type: 'dashed' as const, width: 1 }, label: { formatter: 'usual week', color: t.muted, fontSize: 10, position: 'insideEndTop' as const } } : undefined,
      })),
    };
  }, [daily, base, weeks, t]);
  return <Chart option={option} height={220} />;
}

// ---------- the card ----------
const SCOPES = [
  { value: 1, label: 'Week' },
  { value: 4, label: '4 weeks' },
  { value: 12, label: '12 weeks' },
];

function periodText(d: TrainingReviewData) {
  if (d.weeks === 1) return d.review.partial ? `This week so far · ${fmtDate(d.from, 'd MMM')} – ${fmtDate(d.end, 'd MMM')}` : `Week of ${fmtDate(d.from, 'd MMM')} – ${fmtDate(d.to, 'd MMM yyyy')}`;
  return `${d.weeks} weeks · ${fmtDate(d.from, 'd MMM')} – ${fmtDate(d.end, 'd MMM yyyy')}${d.review.partial ? ' (so far)' : ''}`;
}

/** The training review: a week or a block against the athlete's normal, with what it showed. */
export function ReviewCard() {
  const [weeks, setWeeks] = useState(1);
  const [anchor, setAnchor] = useState(() => format(new Date(), 'yyyy-MM-dd'));
  const { data, isLoading, error } = useApi<TrainingReviewData>(`/review${qs({ date: anchor, weeks })}`);
  const today = format(new Date(), 'yyyy-MM-dd');
  const step = (dir: number) => setAnchor((a) => format(addDays(parseISO(a), dir * weeks * 7), 'yyyy-MM-dd'));
  const atNow = data ? data.to >= today : true;
  return (
    <Card
      title="Training review"
      subtitle={data ? periodText(data) : 'How the training went, against your own normal'}
      actions={
        <>
          <Segmented size="sm" value={weeks} onChange={setWeeks} options={SCOPES} />
          <div className="flex">
            <Button variant="ghost" size="sm" icon={<ChevronLeft className="h-4 w-4" />} onClick={() => step(-1)} title="Earlier" />
            <Button variant="ghost" size="sm" icon={<ChevronRight className="h-4 w-4" />} onClick={() => step(1)} disabled={atNow} title="Later" />
          </div>
        </>
      }
    >
      {isLoading ? <Spinner /> : error || !data ? <p className="py-6 text-center text-xs text-muted">Nothing to review for this period.</p> : <ReviewBody d={data} />}
    </Card>
  );
}

function ReviewBody({ d }: { d: TrainingReviewData }) {
  const r = d.review;
  const s = r.stats;
  const b = d.baseline;
  const p0 = d.pmc[0];
  const p1 = d.pmc[d.pmc.length - 1];
  const ctl0 = (r.notes.find((n) => n.kind === 'ctl') as Extract<ReviewNote, { kind: 'ctl' }> | undefined)?.from ?? p0?.ctl;
  // a block's figures per week of training lived (the current week may be partway through)
  const per = (v: number, key: 'tss' | 'hours') => (d.weeks === 1 ? v : r.stats.perWeek[key]);
  return (
    <div>
      <ReviewHeadline r={r} weeks={d.weeks} />
      <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label={d.weeks === 1 ? 'Load' : 'Load a week'} value={fmtNum(Math.round(per(s.tss, 'tss')))} unit="TSS" sub={b ? `usual ${Math.round(b.tss)}` : undefined} />
        <Stat label={d.weeks === 1 ? 'Time' : 'Time a week'} value={per(s.hours, 'hours').toFixed(1)} unit="h" sub={b ? `usual ${b.hours.toFixed(1)} h` : undefined} />
        <Stat label="Sessions" value={s.sessions} sub={`${s.hard} hard · ${s.long} long`} />
        <Stat label="Fitness · CTL" value={p1 ? Math.round(p1.ctl) : '–'} sub={ctl0 != null && p1 ? `${p1.ctl - ctl0 >= 0 ? '+' : '−'}${Math.abs(p1.ctl - ctl0).toFixed(1)} from ${Math.round(ctl0)}` : undefined} />
        <Stat label="Form · TSB" value={p1 ? Math.round(p1.tsb) : '–'} sub={p1 ? `fatigue ${Math.round(p1.atl)}` : undefined} />
      </div>
      <div className="mt-5 grid gap-6 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Signs of fitness</div>
          {r.signals.length ? <NoteList notes={r.signals} r={r} weeks={d.weeks} limit={6} /> : <p className="text-[13px] text-ink-2">No new bests or clear changes {d.weeks === 1 ? 'this week' : 'in this block'} — most training builds quietly; the reviews of longer blocks show where it's heading.</p>}
        </div>
        <div className="min-w-0">
          <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">{d.weeks === 1 ? 'The week' : 'The block'}</div>
          <NoteList notes={r.notes} r={r} weeks={d.weeks} />
        </div>
      </div>
      <div className="mt-5">{d.weeks === 1 ? <DayStrip daily={d.daily} /> : <WeekBars daily={d.daily} base={b?.tss ?? null} weeks={d.weeks} />}</div>
    </div>
  );
}

/** The current week on the dashboard: the headline and the strongest few lines. */
export function WeekCard() {
  const nav = useNavigate();
  const { data } = useApi<TrainingReviewData>(`/review${qs({ date: format(new Date(), 'yyyy-MM-dd'), weeks: 1 })}`);
  if (!data) return null;
  const r = data.review;
  const lines = [...r.signals.slice(0, 2), ...r.notes.filter((n) => n.kind === 'load' || n.tone === 'warn').slice(0, 2)];
  return (
    <Card
      title="This week"
      subtitle={`${fmtDate(data.from, 'd MMM')} – ${fmtDate(data.to, 'd MMM')}`}
      actions={
        <button onClick={() => nav('/trends')} className="text-xs text-accent hover:underline">
          Review →
        </button>
      }
    >
      <ReviewHeadline r={r} weeks={1} />
      <div className="mt-3">
        <NoteList notes={lines} r={r} weeks={1} />
      </div>
    </Card>
  );
}
