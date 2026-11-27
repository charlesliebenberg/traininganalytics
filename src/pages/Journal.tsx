import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { parseISO } from 'date-fns';
import clsx from 'clsx';
import { BookOpen, ChevronDown, ClipboardCopy, Moon, XCircle } from 'lucide-react';
import type { Review } from '../../shared/analytics/review';
import { http, qs } from '../lib/api';
import { useTokens } from '../lib/theme';
import { fmtDate, fmtDuration, fmtNum, iso } from '../lib/format';
import { activityTitle, sessionBrief, typeColor } from '../lib/session';
import { copyText } from '../lib/clipboard';
import { toast } from '../lib/toast';
import { Button, Card, Empty, PageHeader, Spinner, SportIcon } from '../components/ui';
import { Chart, axisStyle, legendStyle, tipRow, tooltipStyle, valueAxis } from '../components/Chart';
import { NoteList, ReviewHeadline, reviewText, type DayActs, type TrainingReviewData } from '../components/review';
import { surveyFailed, surveyText } from '../components/trainerroad';

// ---------- the API (server/journal.ts) ----------
interface Planned {
  id: number;
  date: string;
  sport: string;
  title: string;
  tss: number | null;
  duration: number | null;
  done: boolean;
  missed: boolean;
  source: string | null;
}
interface Week {
  start: string;
  end: string;
  partial: boolean;
  phase: string | null;
  review: Review;
  baseline: TrainingReviewData['baseline'];
  daily: DayActs[];
  pmc: { ctl0: number | null; ctl1: number | null; atl1: number | null; tsb1: number | null };
  ftp: [number, number];
  planned: Planned[];
  sleep: { nights: number; asleep: number | null; typical: number | null; score: number | null; hrv: number | null; hr: number | null; hrvStatus: 'low' | 'normal' | 'high' | null; hrvVsNormal: number | null; hrStatus: 'low' | 'normal' | 'high' | null; call: 'train' | 'easy' | null } | null;
}
interface Gap {
  gap: true;
  from: string;
  to: string;
  weeks: number;
}
interface Page {
  weeks: (Week | Gap)[];
  next: string | null;
  season: { weeks: { start: string; tss: number; hours: number; ctl: number | null; ftp: number }[] } | null;
}

const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const hrs = (s: number) => `${(s / 3600).toFixed(1)} h`;

/** The week's review as the review card has it, for copying. */
function asReview(w: Week): TrainingReviewData {
  return {
    from: w.start,
    to: w.end,
    end: w.partial ? iso(new Date()) : w.end,
    weeks: 1,
    days: 7,
    review: w.review,
    daily: w.daily,
    pmc: w.pmc.ctl1 != null ? [{ date: w.end, ctl: w.pmc.ctl1, atl: w.pmc.atl1 ?? 0, tsb: w.pmc.tsb1 ?? 0 }] : [],
    baseline: w.baseline,
  };
}

// ---------- the season at a glance ----------
function SeasonStrip({ season, onPick }: { season: NonNullable<Page['season']>; onPick: (week: string) => void }) {
  const t = useTokens();
  const option = useMemo(() => {
    const w = season.weeks;
    return {
      animation: false,
      grid: { left: 44, right: 48, top: 34, bottom: 24 },
      legend: { ...legendStyle(t), data: ['Load', 'Load that holds fitness', 'FTP'] },
      tooltip: {
        trigger: 'axis',
        ...tooltipStyle(t),
        formatter: (ps: any) => {
          const x = w[ps[0]?.dataIndex];
          if (!x) return '';
          return `<b>Week of ${fmtDate(x.start, 'd MMM')}</b>${tipRow(t.ink2, 'Load', `${x.tss} TSS · ${x.hours} h`)}${x.ctl != null ? tipRow(t.ctl, 'Fitness', x.ctl.toFixed(0)) : ''}${tipRow(t.power, 'FTP', `${x.ftp} W`)}<div style="opacity:.6;font-size:11px;margin-top:4px">Click to open the week</div>`;
        },
      },
      xAxis: { type: 'category', data: w.map((x) => fmtDate(x.start, 'd MMM')), ...axisStyle(t, { grid: false }) },
      yAxis: [
        valueAxis(t, { name: 'TSS', nameTextStyle: { color: t.muted, fontSize: 10, align: 'left', padding: [0, 0, 0, -30] } }),
        valueAxis(t, { scale: true, minInterval: 1, splitLine: { show: false }, axisLabel: { color: t.muted, fontSize: 10, formatter: '{value} W' } }),
      ],
      series: [
        { type: 'bar', name: 'Load', data: w.map((x) => x.tss), barMaxWidth: 16, itemStyle: { color: t.lineStrong, borderRadius: [2, 2, 0, 0] }, emphasis: { itemStyle: { color: t.ink2 } } },
        // a week's load that holds fitness where it is: 7 × CTL. Above it a week builds, below it fitness falls
        { type: 'line', name: 'Load that holds fitness', data: w.map((x) => (x.ctl != null ? Math.round(x.ctl * 7) : null)), showSymbol: false, smooth: 0.3, lineStyle: { color: t.ctl, width: 2 }, itemStyle: { color: t.ctl } },
        { type: 'line', name: 'FTP', yAxisIndex: 1, step: 'end', data: w.map((x) => x.ftp), showSymbol: false, lineStyle: { color: t.power, width: 2 }, itemStyle: { color: t.power } },
      ],
    };
  }, [season, t]);
  return <Chart option={option} height={180} onEvents={{ click: (p: any) => p.dataIndex != null && onPick(season.weeks[p.dataIndex].start) }} />;
}

// ---------- a week ----------
function DayCell({ day, planned, today }: { day: DayActs; planned: Planned[]; today: string }) {
  const t = useTokens();
  const ahead = planned.filter((p) => !p.done && !p.missed);
  const missed = planned.filter((p) => p.missed);
  const empty = !day.acts.length && !planned.some((p) => !p.done);
  const isToday = day.date === today;
  return (
    <div className={clsx('min-w-0 rounded-lg p-1.5', isToday ? 'bg-accent-soft/50' : 'bg-surface-2/40')}>
      <div className={clsx('mb-1 flex items-baseline justify-between px-0.5 text-[11px]', isToday ? 'font-semibold text-accent' : 'text-muted')}>
        <span>{fmtDate(day.date, 'EEE')}</span>
        <span className="tabular-nums">{fmtDate(day.date, 'd')}</span>
      </div>
      <div className="space-y-1">
        {day.acts.map((a) => {
          const brief = sessionBrief({ sport: a.sport, sessionType: a.type, sessionLong: a.long, mainSet: a.mainSet });
          const failed = a.felt && surveyFailed(a.felt);
          return (
            <Link
              key={a.id}
              to={`/activities/${a.id}`}
              className={clsx('block rounded-md border bg-surface px-1.5 py-1 hover:border-line-strong', failed ? 'border-critical/60' : 'border-line')}
              style={{ borderLeft: `3px solid ${a.type ? typeColor(t, a.type) : `var(--sport-${a.sport})`}` }}
              title={[activityTitle(a) !== a.name ? a.name : null, brief, a.felt ? `Felt: ${surveyText(a.felt)}` : null].filter(Boolean).join('\n')}
            >
              <div className="flex items-center gap-1">
                <SportIcon sport={a.sport as never} className="h-3 w-3" />
                <span className="truncate text-[11px] font-medium text-ink">{activityTitle(a)}</span>
              </div>
              <div className="truncate text-[10px] text-ink-2">{brief ?? fmtDuration(a.moving, { short: true })}</div>
              <div className="flex items-center justify-between gap-1 text-[10px] text-muted">
                <span className="tabular-nums">{a.tss} TSS</span>
                {a.felt && <span className={clsx('truncate', failed ? 'font-medium text-critical' : '')}>{failed ? "didn't pass" : a.felt.rating?.toLowerCase()}</span>}
              </div>
            </Link>
          );
        })}
        {missed.map((p) => (
          <div key={p.id} className="rounded-md border border-dashed border-critical/50 px-1.5 py-1 opacity-80" title="Planned, not ridden">
            <div className="flex items-center gap-1 text-[11px] font-medium text-ink-2">
              <XCircle className="h-3 w-3 shrink-0 text-critical" />
              <span className="truncate">{p.title}</span>
            </div>
            <div className="text-[10px] text-muted">missed · {fmtNum(p.tss)} TSS</div>
          </div>
        ))}
        {ahead.map((p) => (
          <div key={p.id} className="rounded-md border border-dashed border-line-strong px-1.5 py-1" title="Planned">
            <div className="truncate text-[11px] font-medium text-ink-2">{p.title}</div>
            <div className="text-[10px] text-muted">
              {p.duration ? `${fmtDuration(p.duration, { short: true })} · ` : ''}
              {fmtNum(p.tss)} TSS
            </div>
          </div>
        ))}
        {empty && <div className="px-0.5 py-1 text-[10px] text-muted">{day.date < today ? 'Rest' : '—'}</div>}
      </div>
    </div>
  );
}

function SleepChip({ s }: { s: NonNullable<Week['sleep']> }) {
  const tone = s.call === 'easy' ? 'text-warning' : 'text-ink-2';
  const hrv = s.hrv != null ? `HRV ${Math.round(s.hrv)} ms${s.hrvStatus === 'low' ? ', below normal' : s.hrvStatus === 'high' ? ', above normal' : ''}` : null;
  const short = s.asleep != null && s.typical != null && s.asleep < s.typical - 1800;
  return (
    <span className={clsx('inline-flex items-center gap-1', tone)} title={`${s.nights} nights${s.score != null ? ` · sleep score ${Math.round(s.score)}` : ''}${s.hr != null ? ` · heart rate asleep ${Math.round(s.hr)} bpm${s.hrStatus === 'high' ? ', above normal' : ''}` : ''}`}>
      <Moon className="h-3.5 w-3.5" />
      {s.asleep != null ? hrs(s.asleep) : '–'}
      {short ? ' (short)' : ''}
      {hrv ? ` · ${hrv}` : ''}
    </span>
  );
}

function WeekCard({ w, today, open, onToggle }: { w: Week; today: string; open: boolean; onToggle: () => void }) {
  const r = w.review;
  const body = useRef<HTMLDivElement>(null);
  const plannedTss = w.planned.reduce((s, p) => s + (p.tss ?? 0), 0);
  const missed = w.planned.filter((p) => p.missed).length;
  const done = w.planned.filter((p) => p.done).length;
  const ctlDelta = w.pmc.ctl0 != null && w.pmc.ctl1 != null ? w.pmc.ctl1 - w.pmc.ctl0 : null;
  const ftpDelta = w.ftp[1] - w.ftp[0];
  const warn = r.notes.filter((n) => n.tone === 'warn');
  const highlights = [...r.signals.slice(0, 3), ...warn.slice(0, 2)];
  return (
    <section id={`week-${w.start}`} className="card scroll-mt-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-5 pt-4">
        <h2 className="text-[14px] font-semibold text-ink">
          Week of {fmtDate(w.start, 'd MMM yyyy')}
          {w.partial && <span className="ml-1.5 text-xs font-normal text-muted">so far</span>}
        </h2>
        {w.phase && <span className="rounded-md bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-ink-2">{w.phase}</span>}
        <ReviewHeadline r={r} weeks={1} className="!text-[13px]" />
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            icon={<ClipboardCopy className="h-3.5 w-3.5" />}
            title="Copy the week's review as text, to send to a coach"
            onClick={() => copyText(reviewText(asReview(w), body.current)).then(() => toast('Week copied: paste it into a message'), (e: Error) => toast(e.message, 'error'))}
          >
            Copy
          </Button>
          <Button variant="ghost" size="sm" onClick={onToggle} aria-expanded={open} icon={<ChevronDown className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />}>
            {open ? 'Less' : 'Full review'}
          </Button>
        </div>
      </header>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 px-5 text-xs text-ink-2">
        <span>
          <b className="text-ink tabular-nums">{Math.round(r.stats.tss)}</b> TSS
          {plannedTss > 0 && <span className="text-muted"> of {Math.round(plannedTss)} planned</span>}
          {w.baseline && <span className="text-muted"> · usual {Math.round(w.baseline.tss)}</span>}
        </span>
        <span>
          <b className="text-ink tabular-nums">{r.stats.hours.toFixed(1)}</b> h · {r.stats.sessions} sessions
          {w.planned.length > 0 && (
            <span className={missed ? 'text-critical' : 'text-muted'}>
              {' '}
              · {done}/{w.planned.length} planned done{missed ? `, ${missed} missed` : ''}
            </span>
          )}
        </span>
        {w.pmc.ctl1 != null && (
          <span>
            CTL <b className="text-ink tabular-nums">{Math.round(w.pmc.ctl1)}</b>
            {ctlDelta != null && <span className={clsx('tabular-nums', ctlDelta > 0.5 ? 'text-good-text' : ctlDelta < -0.5 ? 'text-serious' : 'text-muted')}> {signed(ctlDelta, 1)}</span>}
            {w.pmc.tsb1 != null && <span className="text-muted"> · form {signed(w.pmc.tsb1)}</span>}
          </span>
        )}
        <span>
          FTP <b className="text-ink tabular-nums">{w.ftp[1]}</b>
          {ftpDelta !== 0 && <span className={clsx('tabular-nums', ftpDelta > 0 ? 'text-good-text' : 'text-serious')}> {signed(ftpDelta)} W</span>}
        </span>
        {w.sleep && <SleepChip s={w.sleep} />}
      </div>
      {/* the week's days: seven across on a wide screen, wrapping on a narrow one */}
      <div className="mt-3 grid grid-cols-2 gap-1.5 px-5 sm:grid-cols-4 lg:grid-cols-7">
        {w.daily.map((d) => (
          <DayCell key={d.date} day={d} planned={w.planned.filter((p) => p.date === d.date && !p.done)} today={today} />
        ))}
      </div>
      <div ref={body} className="px-5 pt-3 pb-4">
        {open ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div className="min-w-0">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Signs of fitness</div>
              {r.signals.length ? (
                <div data-review="signals">
                  <NoteList notes={r.signals} r={r} weeks={1} />
                </div>
              ) : (
                <p className="text-[13px] text-ink-2">No new bests or clear changes this week.</p>
              )}
            </div>
            <div className="min-w-0">
              <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">The week</div>
              <div data-review="notes">
                <NoteList notes={r.notes} r={r} weeks={1} />
              </div>
            </div>
          </div>
        ) : highlights.length ? (
          <NoteList notes={highlights} r={r} weeks={1} />
        ) : (
          <p className="text-xs text-muted">Nothing stood out: a week that builds quietly.</p>
        )}
      </div>
    </section>
  );
}

// ---------- the page ----------
export function Journal() {
  const today = iso(new Date());
  const [params] = useSearchParams();
  const wanted = params.get('week');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const q = useInfiniteQuery<Page>({
    queryKey: ['/journal'],
    queryFn: ({ pageParam }) => http<Page>(`/journal${qs({ before: pageParam as string | null })}`),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
  });
  const entries = q.data?.pages.flatMap((p) => p.weeks) ?? [];
  const season = q.data?.pages[0]?.season ?? null;
  const sentinel = useRef<HTMLDivElement>(null);

  // more weeks as you scroll to the end
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((xs) => xs[0].isIntersecting && q.hasNextPage && !q.isFetchingNextPage && q.fetchNextPage(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [q.hasNextPage, q.isFetchingNextPage, q.fetchNextPage]);

  // a week asked for by link (?week=…): load back to it, open it and bring it into view
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || scrolled.current === wanted || !q.data) return;
    const ws = entries.find((e): e is Week => !('gap' in e) && e.start <= wanted && e.end >= wanted);
    if (ws) {
      scrolled.current = wanted;
      setOpen((o) => new Set(o).add(ws.start));
      requestAnimationFrame(() => document.getElementById(`week-${ws.start}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } else if (q.hasNextPage && !q.isFetchingNextPage && (q.data?.pages.length ?? 0) < 30) q.fetchNextPage();
  });

  const pick = (week: string) => {
    const el = document.getElementById(`week-${week}`);
    if (el) {
      setOpen((o) => new Set(o).add(week));
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  return (
    <div>
      <PageHeader title="Journal" subtitle="Your training week by week: what you did against the plan, what it did for your fitness, and how you recovered" />
      {q.isLoading ? (
        <Spinner />
      ) : !entries.length ? (
        <Card>
          <Empty icon={<BookOpen className="h-8 w-8" />} title="Nothing in the journal yet">
            Every week you train appears here with its review. <Link to="/settings?tab=import" className="text-accent hover:underline">Import activities</Link> or connect Strava.
          </Empty>
        </Card>
      ) : (
        <>
          {season && (
            <Card className="mb-4" title="The last six months" subtitle="Each week's load against the load that holds your fitness (7 × CTL): above the line a week builds, below it fitness falls · FTP on the right · click a week to open it">
              <SeasonStrip season={season} onPick={pick} />
            </Card>
          )}
          <div className="space-y-4">
            {entries.map((e) =>
              'gap' in e ? (
                <div key={`gap-${e.from}`} className="flex items-center gap-3 px-2 text-xs text-muted">
                  <span className="h-px flex-1 bg-line" />
                  {e.weeks} {e.weeks === 1 ? 'week' : 'weeks'} without training · {fmtDate(e.from, 'd MMM yyyy')} – {fmtDate(e.to, 'd MMM yyyy')}
                  <span className="h-px flex-1 bg-line" />
                </div>
              ) : (
                <WeekCard
                  key={e.start}
                  w={e}
                  today={today}
                  open={open.has(e.start)}
                  onToggle={() =>
                    setOpen((o) => {
                      const n = new Set(o);
                      if (n.has(e.start)) n.delete(e.start);
                      else n.add(e.start);
                      return n;
                    })
                  }
                />
              ),
            )}
          </div>
          <div ref={sentinel} className="flex justify-center py-6">
            {q.isFetchingNextPage ? <Spinner className="py-2" /> : q.hasNextPage ? <Button onClick={() => q.fetchNextPage()}>Earlier weeks</Button> : <span className="text-xs text-muted">The start of your history: {fmtDate(parseISO(entries[entries.length - 1] && 'gap' in entries[entries.length - 1] ? (entries[entries.length - 1] as Gap).from : (entries[entries.length - 1] as Week).start), 'd MMM yyyy')}</span>}
          </div>
        </>
      )}
    </div>
  );
}
