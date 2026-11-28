import { useRef } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { addDays, parseISO } from 'date-fns';
import { ClipboardCopy, Moon, XCircle } from 'lucide-react';
import { useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, fmtDuration, fmtNum, iso } from '../../lib/format';
import { activityTitle, sessionBrief, typeColor } from '../../lib/session';
import { copyText } from '../../lib/clipboard';
import { toast } from '../../lib/toast';
import { asReview, hoursText, signed, type JournalWeek } from '../../lib/weeks';
import { NoteList, ReviewHeadline, reviewText } from '../review';
import { surveyFailed, surveyText } from '../trainerroad';
import { IconButton, SportIcon, buttonClass } from '../ui';
import { PanelLoading, PanelSection, PanelShell } from './Inspector';

/** A week: what was done against the plan, what it did for fitness, how you slept — and its review. */
export function WeekPanel({ start, onClose }: { start: string; onClose: () => void }) {
  const t = useTokens();
  const { data: w, isLoading } = useApi<JournalWeek | null>(`/journal/week?start=${start}`);
  const inspectLink = useInspectLink();
  const body = useRef<HTMLDivElement>(null);
  if (isLoading) return <PanelLoading onClose={onClose} />;
  const end = iso(addDays(parseISO(w?.start ?? start), 6));
  const range = `${fmtDate(w?.start ?? start, 'd MMM')} – ${fmtDate(end, 'd MMM yyyy')}`;
  if (!w)
    return (
      <PanelShell eyebrow="Week" title={range} onClose={onClose}>
        <p className="pt-2 text-[13px] text-muted">Nothing done or planned this week.</p>
      </PanelShell>
    );

  const r = w.review;
  const today = iso(new Date());
  const plannedTss = w.planned.reduce((s, p) => s + (p.tss ?? 0), 0);
  const done = w.planned.filter((p) => p.done).length;
  const missed = w.planned.filter((p) => p.missed).length;
  const ctlDelta = w.pmc.ctl0 != null && w.pmc.ctl1 != null ? w.pmc.ctl1 - w.pmc.ctl0 : null;
  const ftpDelta = w.ftp[1] - w.ftp[0];
  const target = Math.max(plannedTss, w.baseline?.tss ?? 0);
  const copy = () => copyText(reviewText(asReview(w), body.current)).then(() => toast('Week copied: paste it into a message'), (e: Error) => toast(e.message, 'error'));

  return (
    <PanelShell
      eyebrow={[w.partial ? 'This week' : 'Week', w.phase].filter(Boolean).join(' · ')}
      title={range}
      subtitle={<ReviewHeadline r={r} weeks={1} className="!text-[13px]" />}
      actions={
        <IconButton label="Copy the week as text, for a coach" onClick={copy}>
          <ClipboardCopy className="h-4 w-4" />
        </IconButton>
      }
      onClose={onClose}
      footer={
        <>
          <Link to={`/season?week=${w.start}`} className={buttonClass('primary')}>
            See it in the season
          </Link>
          <button type="button" onClick={copy} className={buttonClass('secondary')}>
            <ClipboardCopy className="h-4 w-4" />
            Copy for a coach
          </button>
        </>
      }
    >
      {/* the week in numbers */}
      <div className="grid grid-cols-3 gap-x-4 gap-y-4">
        <Fig label="Load" value={`${Math.round(r.stats.tss)}`} unit="TSS" sub={plannedTss > 0 ? `of ${Math.round(plannedTss)} planned` : w.baseline ? `usual ${Math.round(w.baseline.tss)}` : undefined} />
        <Fig label="Time" value={r.stats.hours.toFixed(1)} unit="h" sub={`${r.stats.sessions} sessions`} />
        <Fig label="Plan" value={w.planned.length ? `${done}/${w.planned.length}` : '–'} sub={missed ? `${missed} missed` : w.planned.length ? 'done' : 'nothing planned'} tone={missed ? 'bad' : undefined} />
        {w.pmc.ctl1 != null && <Fig label="Fitness" value={`${Math.round(w.pmc.ctl1)}`} sub={ctlDelta != null ? `${signed(ctlDelta, 1)} over the week` : undefined} tone={ctlDelta != null ? (ctlDelta > 0.5 ? 'good' : ctlDelta < -0.5 ? 'bad' : undefined) : undefined} color={t.ctl} />}
        {w.pmc.tsb1 != null && <Fig label="Form" value={signed(w.pmc.tsb1)} sub="at the week’s end" color={t.tsb} />}
        <Fig label="FTP" value={`${w.ftp[1]}`} unit="W" sub={ftpDelta ? `${signed(ftpDelta)} W` : 'unchanged'} tone={ftpDelta > 0 ? 'good' : ftpDelta < 0 ? 'bad' : undefined} color={t.power} />
      </div>
      {target > 0 && (
        <div className="mt-4">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-ink/80" style={{ width: `${Math.min(100, (r.stats.tss / target) * 100)}%` }} />
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-muted">
            <span>{Math.round((r.stats.tss / target) * 100)}% of {plannedTss > 0 ? 'the plan' : 'your usual week'}</span>
            {w.baseline && <span>usual {Math.round(w.baseline.tss)} TSS · {w.baseline.hours.toFixed(1)} h</span>}
          </div>
        </div>
      )}
      {w.sleep && (
        <div className={clsx('mt-4 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2 text-[12.5px]', w.sleep.call === 'easy' ? 'text-ink' : 'text-ink-2')}>
          <Moon className="h-4 w-4 shrink-0 text-muted" />
          <span>
            {w.sleep.asleep != null ? `${hoursText(w.sleep.asleep)} a night` : 'Sleep'}
            {w.sleep.hrv != null ? ` · HRV ${Math.round(w.sleep.hrv)} ms${w.sleep.hrvStatus === 'low' ? ', below your normal' : w.sleep.hrvStatus === 'high' ? ', above your normal' : ''}` : ''}
            {w.sleep.hr != null ? ` · ${Math.round(w.sleep.hr)} bpm asleep` : ''}
          </span>
        </div>
      )}

      {/* day by day */}
      <PanelSection title="Day by day">
        <div className="divide-y divide-line rounded-2xl border border-line">
          {w.daily.map((d) => {
            const planned = w.planned.filter((p) => p.date === d.date && !p.done);
            const isToday = d.date === today;
            const empty = !d.acts.length && !planned.length;
            return (
              <div key={d.date} className={clsx('flex gap-3 px-3 py-2.5', isToday && 'bg-accent-soft/60')}>
                <Link {...inspectLink('d', d.date)} className="w-11 shrink-0 pt-0.5 text-center hover:text-accent">
                  <div className={clsx('text-[10.5px] font-semibold uppercase', isToday ? 'text-accent' : 'text-muted')}>{fmtDate(d.date, 'EEE')}</div>
                  <div className="tnum text-[15px] font-semibold">{fmtDate(d.date, 'd')}</div>
                </Link>
                <div className="min-w-0 flex-1 space-y-1">
                  {d.acts.map((a) => {
                    const brief = sessionBrief({ sport: a.sport, sessionType: a.type, sessionLong: a.long, mainSet: a.mainSet });
                    const failed = a.felt && surveyFailed(a.felt);
                    return (
                      <Link key={a.id} {...inspectLink('a', a.id)} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-surface-2" title={a.felt ? `Felt: ${surveyText(a.felt)}` : undefined}>
                        <span className="h-7 w-1 shrink-0 rounded-full" style={{ background: a.type ? typeColor(t, a.type) : `var(--sport-${a.sport})` }} />
                        <SportIcon sport={a.sport as never} className="h-3.5 w-3.5" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">{activityTitle(a)}</span>
                          <span className="block truncate text-[11.5px] text-muted">{[brief, fmtDuration(a.moving, { short: true })].filter(Boolean).join(' · ')}</span>
                        </span>
                        <span className="tnum shrink-0 text-right text-[12px] text-ink-2">
                          {a.tss} <span className="text-muted">TSS</span>
                          {a.felt?.rating && <span className={clsx('block text-[10.5px]', failed ? 'font-medium text-critical' : 'text-muted')}>{failed ? 'didn’t pass' : a.felt.rating.toLowerCase()}</span>}
                        </span>
                      </Link>
                    );
                  })}
                  {planned.map((p) => (
                    <Link key={p.id} {...inspectLink('p', p.id)} className={clsx('flex items-center gap-2.5 rounded-lg border border-dashed px-1.5 py-1 hover:bg-surface-2', p.missed ? 'border-critical/50' : 'border-line-strong')}>
                      {p.missed ? <XCircle className="h-3.5 w-3.5 shrink-0 text-critical" /> : <SportIcon sport={p.sport as never} className="h-3.5 w-3.5" colored={false} />}
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2">{p.title}</span>
                      <span className="tnum shrink-0 text-[11.5px] text-muted">
                        {p.missed ? 'missed · ' : ''}
                        {p.duration ? `${fmtDuration(p.duration, { short: true })} · ` : ''}
                        {fmtNum(p.tss)} TSS
                      </span>
                    </Link>
                  ))}
                  {empty && <div className="py-1 text-[12px] text-muted">{d.date < today ? 'Rest' : '—'}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </PanelSection>

      <div ref={body}>
        <PanelSection title="Signs of fitness">
          {r.signals.length ? (
            <div data-review="signals">
              <NoteList notes={r.signals} r={r} weeks={1} />
            </div>
          ) : (
            <p className="text-[13px] text-muted">No new bests or clear changes this week.</p>
          )}
        </PanelSection>
        <PanelSection title="The week">
          <div data-review="notes">
            <NoteList notes={r.notes} r={r} weeks={1} />
          </div>
        </PanelSection>
      </div>
    </PanelShell>
  );
}

function Fig({ label, value, unit, sub, tone, color }: { label: string; value: string; unit?: string; sub?: string; tone?: 'good' | 'bad'; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
        {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-0.5">
        <span className="figure text-[19px]">{value}</span>
        {unit && <span className="text-[11px] font-medium text-muted">{unit}</span>}
      </div>
      {sub && <div className={clsx('mt-0.5 truncate text-[11px]', tone === 'good' ? 'text-good-text' : tone === 'bad' ? 'text-serious' : 'text-muted')}>{sub}</div>}
    </div>
  );
}
