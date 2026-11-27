import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { differenceInCalendarDays, parseISO } from 'date-fns';
import { ArrowRight, BatteryCharging, CheckCircle2, Coffee, Flame, Moon, Telescope } from 'lucide-react';
import type { Activity, PlannedWorkout, PmcPoint, WorkoutStep, WorkoutStructure } from '../../shared/types';
import { sleepAdvice, type SleepRead } from '../../shared/analytics/sleep';
import { formZone } from '../../shared/analytics/pmc';
import { useApi } from '../lib/api';
import { useTokens } from '../lib/theme';
import { fmtDate, fmtDuration, fmtNum, iso } from '../lib/format';
import { activityTitle, sessionBrief } from '../lib/session';
import { MiniProfile, formColor } from './charts';
import { SportIcon } from './ui';

/** The heart of a workout, in watts at today's FTP: "4 × 5 min at 378–390 W", "Endurance at 200–240 W". */
export function keySet(s: WorkoutStructure, ftp: number | null): string | null {
  const dur = (sec: number) => (sec < 90 ? `${sec} s` : sec % 60 === 0 ? `${sec / 60} min` : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`);
  const at = (st: WorkoutStep) => {
    if (s.target === 'power' && ftp) {
      const lo = Math.round(st.low * ftp);
      const hi = Math.round(st.high * ftp);
      return lo === hi ? `${lo} W` : `${Math.min(lo, hi)}–${Math.max(lo, hi)} W`;
    }
    const lo = Math.round(st.low * 100);
    const hi = Math.round(st.high * 100);
    return `${lo === hi ? lo : `${lo}–${hi}`}% ${s.target === 'pace' ? 'of threshold pace' : 'of LTHR'}`;
  };
  // the block with the most hard work in it: time, weighted steeply by intensity
  let best: string | null = null;
  let score = 0;
  for (const b of s.blocks) {
    if (b.kind === 'repeat') {
      const work = b.steps.filter((x) => x.intent === 'active').sort((a, c) => c.high - a.high)[0];
      const v = work ? b.count * work.duration * work.high ** 4 : 0;
      if (work && work.high >= 0.75 && v > score) {
        score = v;
        best = `${b.count} × ${dur(work.duration)} at ${at(work)}`;
      }
    } else if (b.intent === 'active' && b.high >= 0.75) {
      const v = b.duration * b.high ** 4;
      if (v > score) {
        score = v;
        best = `${dur(b.duration)} at ${at(b)}`;
      }
    }
  }
  if (best) return best;
  const steps = s.blocks.flatMap((b) => (b.kind === 'repeat' ? b.steps : [b])).filter((x) => x.intent === 'active');
  const main = [...steps].sort((a, c) => c.duration - a.duration)[0];
  return main ? `Steady at ${at(main)}` : null;
}

interface ForecastLite {
  race: { id: number; name: string; date: string; priority: string } | null;
  now: { ftp: number | null };
  scenarios: { id: 'planned' | 'filled' | 'best' | 'custom'; race: { ftp: number | null; tsb: number; ctl: number; form: string; formLabel: string } }[];
}

type Tone = 'good' | 'neutral' | 'warning';

/** The day's call without a night's sleep to go on: from form alone. */
function formCall(tsb: number | null, ctl: number | null, planned: PlannedWorkout[]): { title: string; detail: string; tone: Tone } {
  if (tsb == null || ctl == null) return { title: 'Train as planned', detail: 'Not enough history yet to read your form.', tone: 'neutral' };
  const z = formZone(tsb, ctl);
  const hard = planned.some((p) => (p.plannedIf ?? 0) >= 0.8);
  switch (z.id) {
    case 'overload':
      return { title: hard ? 'Think twice about the hard session' : 'Keep it easy', detail: `Form ${Math.round(tsb)}: fatigue is well above your fitness. Easy riding or rest lets the training land.`, tone: 'warning' };
    case 'optimal':
      return { title: 'Train as planned', detail: `Form ${Math.round(tsb)}: tired but productive, the range that builds fitness.`, tone: 'good' };
    case 'fresh':
      return { title: hard ? 'A good day for the key session' : 'Fresh', detail: `Form +${Math.round(tsb)}: rested enough to go hard${hard ? '' : ', or to race'}.`, tone: 'good' };
    case 'transition':
      return { title: 'Fresh, maybe too fresh', detail: `Form +${Math.round(tsb)}: well rested; days like this in a row cost fitness.`, tone: 'neutral' };
    default:
      return { title: 'Train as planned', detail: `Form ${Math.round(tsb)}: neither tired nor fresh.`, tone: 'neutral' };
  }
}

const ToneIcon = ({ tone }: { tone: Tone }) =>
  tone === 'good' ? <CheckCircle2 className="h-5 w-5 text-good" /> : tone === 'warning' ? <Coffee className="h-5 w-5 text-warning" /> : <BatteryCharging className="h-5 w-5 text-accent" />;

/**
 * Today, in one place: the day's call from last night's recovery and your form, what's planned
 * (its key set in watts) or done, and the race ahead with where the training is taking you.
 */
export function TodayHero({ today: point, sleep, upcoming, recent, ftp }: { today: PmcPoint | undefined; sleep: SleepRead | null; upcoming: PlannedWorkout[]; recent: Activity[]; ftp: number | null }) {
  const t = useTokens();
  const forecast = useApi<ForecastLite | null>('/forecast');
  const day = iso(new Date());
  const planned = upcoming.filter((p) => p.date === day);
  const done = recent.filter((a) => a.localDate === day);
  const fresh = sleep && sleep.night.date === day ? sleep : null;
  const call = fresh ? sleepAdvice(fresh, point?.tsb ?? null, planned.map((p) => ({ title: p.title, plannedIf: p.plannedIf }))) : formCall(point?.tsb ?? null, point?.ctl ?? null, planned);
  const zone = point ? formZone(point.tsb, point.ctl) : null;
  const f = forecast.data;
  const plan = f?.scenarios.find((s) => s.id === 'planned');
  const best = f?.scenarios.find((s) => s.id === 'best');
  const daysTo = f?.race ? differenceInCalendarDays(parseISO(f.race.date), parseISO(day)) : null;

  return (
    <section className="card mb-4 grid gap-0 overflow-hidden lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.25fr)_minmax(0,1fr)]">
      {/* the call */}
      <div className="border-b border-line p-5 lg:border-r lg:border-b-0">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">Today’s call</div>
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 shrink-0">
            <ToneIcon tone={call.tone} />
          </span>
          <div className="min-w-0">
            <div className="text-[16px] leading-snug font-semibold text-ink">{call.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-ink-2">{call.detail}</p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
          {zone && point && (
            <Link to="/fitness" className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-ink-2 hover:text-ink">
              <span className="h-2 w-2 rounded-sm" style={{ background: formColor(t, zone.id) }} />
              Form {point.tsb > 0 ? '+' : ''}
              {Math.round(point.tsb)} · {zone.label.toLowerCase()}
            </Link>
          )}
          {fresh?.hrv && (
            <Link to="/fitness#recovery" className={clsx('inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 hover:text-ink', fresh.hrv.status === 'low' ? 'text-warning' : 'text-ink-2')}>
              HRV {Math.round(fresh.hrv.value)} ms{fresh.hrv.status === 'low' ? ' · low' : fresh.hrv.status === 'high' ? ' · high' : ' · normal'}
            </Link>
          )}
          {fresh?.asleep && (
            <Link to="/fitness#recovery" className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-ink-2 hover:text-ink">
              <Moon className="h-3 w-3" />
              {fmtDuration(fresh.asleep.value, { short: true })} asleep
            </Link>
          )}
          {!fresh && sleep && <span className="rounded-md bg-surface-2 px-2 py-1 text-muted">No sleep data for last night yet</span>}
        </div>
      </div>

      {/* what's planned, or done */}
      <div className="border-b border-line p-5 lg:border-r lg:border-b-0">
        <div className="mb-2 flex items-center justify-between text-[11px] font-medium tracking-wide text-muted uppercase">
          <span>{fmtDate(day, 'EEEE d MMMM')}</span>
          <Link to={`/calendar?m=${day.slice(0, 7)}`} className="flex items-center gap-1 font-normal tracking-normal text-accent normal-case hover:underline">
            Calendar <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="space-y-2.5">
          {done.map((a) => (
            <Link key={a.id} to={`/activities/${a.id}`} className="flex items-center gap-2.5 rounded-lg bg-surface-2/60 px-3 py-2 hover:bg-surface-2">
              <CheckCircle2 className="h-4 w-4 shrink-0 text-good" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium text-ink">Done: {activityTitle(a)}</div>
                <div className="truncate text-[11px] text-muted">
                  {[sessionBrief(a), fmtDuration(a.movingTime, { short: true }), `${fmtNum(a.tss)} TSS`].filter(Boolean).join(' · ')}
                </div>
              </div>
            </Link>
          ))}
          {planned.map((p) => {
            const key = p.structure ? keySet(p.structure, ftp) : null;
            return (
              <Link key={p.id} to={`/calendar?m=${day.slice(0, 7)}`} className="block rounded-lg border border-line px-3 py-2.5 hover:border-line-strong">
                <div className="flex items-center gap-2">
                  <SportIcon sport={p.sport} />
                  <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{p.title}</span>
                  {p.source === 'trainerroad' && <span className="rounded bg-ink px-1 text-[9px] font-bold text-surface">TR</span>}
                </div>
                <div className="mt-0.5 text-[11px] text-muted">
                  {[p.plannedDuration ? fmtDuration(p.plannedDuration, { short: true }) : null, p.plannedTss ? `${Math.round(p.plannedTss)} TSS` : null, p.plannedIf ? `IF ${p.plannedIf.toFixed(2)}` : null].filter(Boolean).join(' · ')}
                </div>
                {key && (
                  <div className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium text-ink">
                    <Flame className="h-3.5 w-3.5 shrink-0 text-serious" />
                    {key}
                  </div>
                )}
                {p.structure && <MiniProfile structure={p.structure} height={26} className="mt-2" />}
              </Link>
            );
          })}
          {!done.length && !planned.length && (
            <div className="rounded-lg bg-surface-2/60 px-3 py-3 text-[13px] text-ink-2">
              Nothing planned today.{' '}
              {call.tone === 'warning' ? 'A good day to rest.' : (
                <>
                  Rest, or <Link to="/workouts" className="text-accent hover:underline">build a workout</Link>.
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {/* the race ahead */}
      <div className="p-5">
        <div className="mb-2 text-[11px] font-medium tracking-wide text-muted uppercase">The race ahead</div>
        {f?.race && plan ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[14px] font-semibold text-ink">
                {f.race.priority} · {f.race.name}
              </span>
              <span className="shrink-0 text-[12px] text-muted">
                <b className="text-[20px] text-ink tabular-nums">{daysTo}</b> days
              </span>
            </div>
            <div className="mt-3 space-y-1.5 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-ink-2">As planned</span>
                <span className="tabular-nums text-ink">
                  {plan.race.ftp != null ? `${Math.round(plan.race.ftp)} W · ` : ''}form {plan.race.tsb > 0 ? '+' : ''}
                  {Math.round(plan.race.tsb)} <span className="text-muted">{plan.race.formLabel.toLowerCase()}</span>
                </span>
              </div>
              {best && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ink-2">Best path</span>
                  <span className="font-medium tabular-nums text-good-text">
                    {best.race.ftp != null ? `${Math.round(best.race.ftp)} W · ` : ''}form {best.race.tsb > 0 ? '+' : ''}
                    {Math.round(best.race.tsb)} <span className="font-normal text-muted">{best.race.formLabel.toLowerCase()}</span>
                  </span>
                </div>
              )}
            </div>
            <Link to="/forecast" className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
              <Telescope className="h-3.5 w-3.5" /> Open the forecast
            </Link>
          </>
        ) : (
          <p className="text-xs text-ink-2">
            No race ahead. <Link to="/season" className="text-accent hover:underline">Add one</Link> and the <Link to="/forecast" className="text-accent hover:underline">forecast</Link> shows where your training takes you by race day.
          </p>
        )}
      </div>
    </section>
  );
}
