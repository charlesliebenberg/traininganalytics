import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { FtpEvent } from '../../shared/analytics/trainerroad';
import type { Sport } from '../../shared/types';
import { useApi } from '../lib/api';
import { fmtDate } from '../lib/format';

export interface SurveyAnswer {
  rating: string | null;
  level: number | null;
  reasons: string[];
  rpe: number | null;
  text: string | null;
}

/** A ride as TrainerRoad recorded it (server/trainerroad-insights.ts). */
export interface TrainerRoadRide {
  id: string;
  started: string | null;
  name: string | null;
  sport: Sport;
  duration: number | null;
  tss: number | null;
  if: number | null;
  kj: number | null;
  survey: SurveyAnswer | null;
  activity: { id: number; name: string; tss: number | null } | null;
}

/** "Hard (my legs were heavy) · RPE 3.25" */
export const surveyText = (s: SurveyAnswer) =>
  [s.rating ? `${s.rating}${s.reasons.length ? ` (${s.reasons.join(', ')})` : ''}` : null, s.rpe != null ? `RPE ${s.rpe}` : null, s.text ? `“${s.text}”` : null].filter(Boolean).join(' · ');

/** On an activity: TrainerRoad's record of the same ride, and how you said it felt. */
export function TrainerRoadRideStrip({ ride }: { ride: TrainerRoadRide }) {
  const parts = [
    ride.name,
    ride.tss != null ? `${Math.round(ride.tss)} TSS${ride.if != null ? ` (IF ${ride.if.toFixed(2)})` : ''} by its FTP` : null,
    ride.survey ? `felt ${surveyText(ride.survey)}` : 'survey not answered',
  ].filter(Boolean);
  return (
    <div className="card mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
      <span className="flex h-4 items-center rounded bg-ink px-1 text-[9px] font-bold text-surface">TR</span>
      <span className="font-medium text-ink">TrainerRoad</span>
      <span className="text-ink-2">{parts.join(' · ')}</span>
      <Link to="/trainerroad" className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline">
        More <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}

interface FtpSummary {
  ftp: { trainerRoad: number | null; app: number | null; events: FtpEvent[] } | null;
  ai: { detected: number | null } | null;
}

/** On Thresholds: TrainerRoad's FTP, AI FTP Detection's and its prediction, beside this app's. */
export function TrainerRoadFtpNote() {
  const { data } = useApi<FtpSummary>('/trainerroad/insights');
  const f = data?.ftp;
  if (!f || f.trainerRoad == null) return null;
  const predicted = f.events.find((e) => e.kind === 'predicted');
  const parts = [
    `${f.trainerRoad} W in use`,
    data.ai?.detected != null ? `AI FTP Detection ${data.ai.detected} W` : null,
    predicted ? `${predicted.value} W predicted by ${fmtDate(predicted.date, 'd MMM')}` : null,
  ].filter(Boolean);
  return (
    <div className="card mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-[13px]">
      <span className="flex h-4 items-center rounded bg-ink px-1 text-[9px] font-bold text-surface">TR</span>
      <span className="font-medium text-ink">TrainerRoad</span>
      <span className="text-ink-2">
        {parts.join(' · ')}
        {f.app != null ? `, against this app’s ${f.app} W` : ''}
      </span>
      <Link to="/trainerroad" className="ml-auto flex items-center gap-1 text-xs text-accent hover:underline">
        Compare <ArrowRight className="h-3 w-3" />
      </Link>
    </div>
  );
}
