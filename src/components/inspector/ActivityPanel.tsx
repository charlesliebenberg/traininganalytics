import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, ExternalLink } from 'lucide-react';
import type { ActivityDetail, PlannedWorkout } from '../../../shared/types';
import type { SleepRead } from '../../../shared/analytics/sleep';
import { useApi } from '../../lib/api';
import { useTokens } from '../../lib/theme';
import { useInspectLink } from '../../lib/inspect';
import { fmtDate, fmtDistance, fmtDuration, fmtElevation, fmtNum, fmtPace, fmtSpeed, iso, SPORT_LABEL, TSS_METHOD_LABEL } from '../../lib/format';
import { activityTitle, sessionBrief } from '../../lib/session';
import { InsightPanel, type ActivityInsights } from '../insights';
import { NightBefore } from '../sleep';
import { TrainerRoadRideStrip, type TrainerRoadRide } from '../trainerroad';
import { MiniProfile } from '../charts';
import { RouteThumb } from '../RouteThumb';
import { compliance } from '../planning';
import { Badge, SportBadge, buttonClass } from '../ui';
import { PanelLoading, PanelMissing, PanelSection, PanelShell } from './Inspector';

type Lite = ActivityDetail & { nav: { prev: number | null; next: number | null }; planned: PlannedWorkout | null; sleep: SleepRead | null; trainerRoad: TrainerRoadRide | null };

/** A ride (or run, or swim) at a glance: its numbers, what it says, and how it fit the plan. */
export function ActivityPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const t = useTokens();
  const { data: a, isLoading } = useApi<Lite>(`/activities/${id}?lite=1`);
  const insights = useApi<ActivityInsights>(`/activities/${id}/insights`);
  const inspectLink = useInspectLink();
  if (isLoading) return <PanelLoading onClose={onClose} />;
  if (!a) return <PanelMissing title="Activity not found" onClose={onClose} />;

  const th = a.thresholds;
  const pace = a.sport === 'run' || a.sport === 'swim' || a.sport === 'walk' || a.sport === 'hike';
  const wkg = a.np && th.weight ? (a.np / th.weight).toFixed(2) : null;
  const nums: { label: string; value: string; unit?: string; sub?: string; color?: string }[] = [
    { label: 'Time', value: fmtDuration(a.movingTime, { short: true }), sub: a.elapsedTime - a.movingTime > 300 ? `${fmtDuration(a.elapsedTime, { short: true })} elapsed` : undefined },
    ...(a.distance ? [{ label: 'Distance', value: fmtDistance(a.distance, a.sport === 'swim' ? 0 : 1, a.sport) }] : []),
    { label: TSS_METHOD_LABEL[a.tssMethod] ?? 'TSS', value: fmtNum(a.tss), sub: a.intensity ? `IF ${a.intensity.toFixed(2)}` : undefined },
    ...(a.np ? [{ label: 'Normalized', value: `${a.np}`, unit: 'W', sub: wkg ? `${wkg} W/kg` : undefined, color: t.power }] : a.avgPower ? [{ label: 'Power', value: `${a.avgPower}`, unit: 'W', color: t.power }] : []),
    ...(a.avgHr ? [{ label: 'Heart rate', value: `${a.avgHr}`, unit: 'bpm', sub: a.maxHr ? `max ${a.maxHr}` : undefined, color: t.hr }] : []),
    ...(a.avgSpeed && pace ? [{ label: 'Pace', value: fmtPace(a.avgSpeed, a.sport, false), unit: a.sport === 'swim' ? '/100m' : undefined, color: t.speed }] : a.avgSpeed ? [{ label: 'Speed', value: fmtSpeed(a.avgSpeed), color: t.speed }] : []),
    ...(a.elevationGain ? [{ label: 'Climbing', value: fmtElevation(a.elevationGain) }] : []),
    ...(a.work ? [{ label: 'Work', value: fmtNum(a.work), unit: 'kJ' }] : []),
  ].slice(0, 6);
  const c = a.planned ? compliance(a.planned, a, iso(new Date())) : null;
  const brief = sessionBrief(a);

  return (
    <PanelShell
      icon={<SportBadge sport={a.sport} size={38} />}
      eyebrow={fmtDate(a.startTime, 'EEEE d MMMM yyyy · HH:mm')}
      title={activityTitle(a)}
      subtitle={[brief, SPORT_LABEL[a.sport], a.trainer ? 'Indoor' : null].filter(Boolean).join(' · ')}
      onClose={onClose}
      footer={
        <>
          <Link to={`/activities/${a.id}`} className={buttonClass('primary')}>
            Full analysis
            <ArrowUpRight className="h-4 w-4" />
          </Link>
          <Link {...inspectLink('w', a.localDate)} className={buttonClass('secondary')}>
            <CalendarDays className="h-4 w-4" />
            Its week
          </Link>
          {a.source === 'strava' && a.externalId && (
            <a href={`https://www.strava.com/activities/${a.externalId}`} target="_blank" rel="noreferrer" className={buttonClass('ghost', 'md', 'ml-auto')}>
              Strava
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </>
      }
    >
      <div className="flex gap-4">
        <div className="grid min-w-0 flex-1 grid-cols-3 gap-x-4 gap-y-4">
          {nums.map((n) => (
            <div key={n.label} className="min-w-0">
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
                {n.color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: n.color }} />}
                {n.label}
              </div>
              <div className="mt-1 flex items-baseline gap-0.5 truncate">
                <span className="figure text-[19px]">{n.value}</span>
                {n.unit && <span className="text-[11px] font-medium text-muted">{n.unit}</span>}
              </div>
              {n.sub && <div className="mt-0.5 truncate text-[11px] text-muted">{n.sub}</div>}
            </div>
          ))}
        </div>
        {a.polyline && (
          <div className="hidden shrink-0 rounded-2xl bg-surface-2 p-2 sm:block">
            <RouteThumb polyline={a.polyline} size={92} color={`var(--sport-${a.sport})`} />
          </div>
        )}
      </div>

      {a.planned && c && (
        <Link {...inspectLink('p', a.planned.id)} className="mt-5 flex items-center gap-3 rounded-2xl border border-line p-3 hover:bg-surface-2">
          <span className="h-9 w-1 shrink-0 rounded-full" style={{ background: c.color }} />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] text-muted">Planned</span>
            <span className="block truncate text-[13px] font-medium text-ink">{a.planned.title}</span>
          </span>
          <span className="shrink-0 text-right">
            <Badge>{c.label}</Badge>
            {c.ratio != null && <span className="tnum mt-1 block text-[11px] text-muted">{Math.round(c.ratio * 100)}% of planned</span>}
          </span>
          {a.planned.structure && (
            <span className="hidden w-24 shrink-0 sm:block">
              <MiniProfile structure={a.planned.structure} height={22} />
            </span>
          )}
        </Link>
      )}

      {insights.data && (insights.data.aerobic || insights.data.efforts.length > 0 || insights.data.session) && (
        <PanelSection title={`What this ${a.sport === 'run' ? 'run' : a.sport === 'ride' ? 'ride' : 'session'} says`}>
          <InsightPanel insights={insights.data} compact />
        </PanelSection>
      )}

      {(a.sleep || a.trainerRoad) && (
        <PanelSection title="Around it">
          <div className="divide-y divide-line rounded-2xl border border-line">
            {a.sleep && <NightBefore read={a.sleep} className="px-4 py-3" />}
            {a.trainerRoad && <TrainerRoadRideStrip ride={a.trainerRoad} className="px-4 py-3" />}
          </div>
        </PanelSection>
      )}

      {a.description && (
        <PanelSection title="Notes">
          <p className="text-[13px] whitespace-pre-line text-ink-2">{a.description}</p>
        </PanelSection>
      )}
    </PanelShell>
  );
}
