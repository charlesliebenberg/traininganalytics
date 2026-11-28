/**
 * A training week as the server reviews it (server/journal.ts): what was done against the plan,
 * what it did for fitness, and how you slept — shared by the Season timeline and the week panel.
 */
import type { Review } from '../../shared/analytics/review';
import type { DayActs, TrainingReviewData } from '../components/review';
import { iso } from './format';

export interface WeekPlanned {
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

export interface WeekSleep {
  nights: number;
  asleep: number | null;
  typical: number | null;
  score: number | null;
  hrv: number | null;
  hr: number | null;
  hrvStatus: 'low' | 'normal' | 'high' | null;
  hrvVsNormal: number | null;
  hrStatus: 'low' | 'normal' | 'high' | null;
  call: 'train' | 'easy' | null;
}

export interface JournalWeek {
  start: string;
  end: string;
  partial: boolean;
  phase: string | null;
  review: Review;
  baseline: TrainingReviewData['baseline'];
  daily: DayActs[];
  pmc: { ctl0: number | null; ctl1: number | null; atl1: number | null; tsb1: number | null };
  ftp: [number, number];
  planned: WeekPlanned[];
  sleep: WeekSleep | null;
}

export interface JournalGap {
  gap: true;
  from: string;
  to: string;
  weeks: number;
}

export interface JournalPage {
  weeks: (JournalWeek | JournalGap)[];
  next: string | null;
  season: { weeks: { start: string; tss: number; hours: number; ctl: number | null; ftp: number }[] } | null;
}

export const isGapEntry = (e: JournalWeek | JournalGap): e is JournalGap => 'gap' in e;

/** The week's review as the review card has it, for copying. */
export function asReview(w: JournalWeek): TrainingReviewData {
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

export const signed = (v: number, digits = 0) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
export const hoursText = (s: number) => `${(s / 3600).toFixed(1)} h`;
