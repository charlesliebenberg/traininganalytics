/**
 * The race-day forecast (server/forecast.ts): the plan as it stands, its gaps filled, the best
 * path within your limits, and your own — each run forward to race day.
 */
import { useQuery } from '@tanstack/react-query';
import type { Tokens } from './theme';
import { http } from './api';
import { fmtNum } from './format';

export type ScenarioId = 'planned' | 'filled' | 'best' | 'custom';

export interface RaceDay {
  date: string;
  ctl: number;
  tsb: number;
  form: string;
  formLabel: string;
  ratio: number | null;
  ftp: number | null;
  ftpLow: number | null;
  ftpHigh: number | null;
  p5: number | null;
  p20: number | null;
  p60: number | null;
}

export interface Scenario {
  id: ScenarioId;
  days: { date: string; load: number; ctl: number; atl: number; tsb: number; cap: number | null; capLow: number | null; capHigh: number | null }[];
  weeks: { start: string; tss: number; hours: number; ctl: number; tsb: number; ramp: number }[];
  race: RaceDay;
  totals: { tss: number; hours: number; maxWeekHours: number; maxRamp: number; peakCtl: number };
  warnings: string[];
}

export interface Limits {
  maxRamp: number;
  maxHours: number;
  target: number;
}

export interface ForecastData {
  today: string;
  end: string;
  race: { id: number; name: string; date: string; priority: string } | null;
  events: { id: number; name: string; date: string; priority: string }[];
  now: { ctl: number; atl: number; tsb: number; form: string; formLabel: string; ftp: number | null; weight: number };
  habits: { rideShare: number; tssPerHour: number; biggestWeek: number; shape: number[] };
  constraints: Limits;
  history: { date: string; ctl: number; atl: number; tsb: number; load: number }[];
  weeks: { start: string; planned: number; done: number | null; phase: string | null }[];
  scenarios: Scenario[];
  trainerRoad: { now: number | null; predicted: { date: string; value: number }[] } | null;
  model: { tau: number; taus: number[]; quantile: number; observations: number; validation: { from: string; mae: number; maeCtl: number } | null; informative: boolean } | null;
}

export interface ForecastBody {
  eventId: number | null;
  constraints: Partial<Limits> | null;
  custom: Record<string, number> | null;
}

export function useForecast(body: ForecastBody, enabled = true) {
  return useQuery<ForecastData | null>({
    queryKey: ['/forecast', body],
    queryFn: () => http<ForecastData | null>('/forecast', { method: 'POST', json: body }),
    placeholderData: (p) => p,
    staleTime: 60_000,
    enabled,
  });
}

export const SCENARIO_NAMES: Record<ScenarioId, string> = { planned: 'As planned', filled: 'Fill the gaps', best: 'Best path', custom: 'Your plan' };

export function scenarioColor(t: Tokens, id: ScenarioId) {
  return { planned: t.ink2, filled: t.series[1], best: t.series[2], custom: t.series[6] }[id];
}

export function scenarioBlurb(id: ScenarioId, d: Pick<ForecastData, 'constraints' | 'scenarios'>) {
  const l = d.constraints;
  switch (id) {
    case 'planned':
      return `The calendar as it stands${d.scenarios.some((s) => s.id === 'filled') ? '; days with nothing planned count as rest' : ''}.`;
    case 'filled':
      return 'The plan, with its empty days ridden just enough to arrive fresh.';
    case 'best':
      return `The most race-day power within your limits: up to ${fmtNum(l.maxRamp, 1)} fitness a week and ${fmtNum(l.maxHours, 1)} h, a recovery week every fourth, then a taper.`;
    default:
      return 'The weekly loads you set, spread over each week in your usual rhythm.';
  }
}

/** How a form zone arrives at a race, in words. */
export const ARRIVES: Record<string, string> = { transition: 'detrained', fresh: 'fresh', neutral: 'neither fresh nor fit', optimal: 'still tired from training', overload: 'overreached' };

export const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
