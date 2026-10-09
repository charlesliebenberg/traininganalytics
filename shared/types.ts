// Domain types shared by server and client.
import type { SessionAnalysis, SessionType } from './analytics/session';

export type Sport =
  | 'ride'
  | 'run'
  | 'swim'
  | 'walk'
  | 'hike'
  | 'strength'
  | 'ski'
  | 'row'
  | 'other';

export type Source = 'strava' | 'file' | 'demo' | 'manual';

export type TssMethod = 'power' | 'pace' | 'swim' | 'hr' | 'estimate' | 'manual' | 'none';

/** 1 Hz resampled activity streams. Every array has the same length (= elapsed seconds). */
export interface Streams {
  time: number[];
  watts?: number[] | null;
  heartrate?: (number | null)[] | null;
  cadence?: (number | null)[] | null;
  /** metres per second */
  speed?: (number | null)[] | null;
  /** metres from start */
  distance?: (number | null)[] | null;
  /** metres above sea level */
  altitude?: (number | null)[] | null;
  lat?: (number | null)[] | null;
  lng?: (number | null)[] | null;
  temp?: (number | null)[] | null;
  /** percent */
  grade?: (number | null)[] | null;
  /** 1 moving, 0 stopped */
  moving?: number[] | null;
}

export type StreamKey = Exclude<keyof Streams, 'time'>;

export interface Thresholds {
  /** Effective-from date, YYYY-MM-DD */
  date: string;
  /** Functional threshold power, W */
  ftp: number;
  /** Critical power, W — from the automatic estimate; W′ balance uses it (falls back to FTP) */
  cp?: number;
  /** W' (anaerobic work capacity), J */
  wPrime: number;
  /** Lactate threshold heart rate (bike), bpm */
  lthr: number;
  /** Lactate threshold heart rate (run), bpm */
  runLthr: number;
  maxHr: number;
  restHr: number;
  /** Run threshold speed, m/s */
  runThresholdSpeed: number;
  /** Swim critical swim speed, m/s */
  swimCss: number;
  /** kg */
  weight: number;
  /** Where ftp / runThresholdSpeed / swimCss came from for this date */
  sources?: { ftp: ThresholdSource; run: ThresholdSource; swim: ThresholdSource; hr?: ThresholdSource };
}

export type ThresholdSource = 'auto' | 'manual' | 'default';

export interface Lap {
  name: string;
  start: number; // seconds from activity start
  duration: number; // seconds
  distance?: number | null;
  avgPower?: number | null;
  np?: number | null;
  avgHr?: number | null;
  maxHr?: number | null;
  avgCadence?: number | null;
  avgSpeed?: number | null;
  elevationGain?: number | null;
}

export interface ActivityCurves {
  /** mean-max power, aligned to CURVE_DURATIONS */
  power?: (number | null)[];
  /** max normalized power, aligned to CURVE_DURATIONS */
  np?: (number | null)[];
  /** mean-max heart rate */
  hr?: (number | null)[];
  /** mean-max speed m/s */
  speed?: (number | null)[];
  /** best climbing rate (VAM, m/h) */
  vam?: (number | null)[];
  /** mean-max power after N kJ of work, keyed by kJ threshold */
  fatigue?: Record<string, (number | null)[]>;
}

export interface Activity {
  id: number;
  source: Source;
  externalId: string | null;
  name: string;
  sport: Sport;
  startTime: string; // ISO UTC
  localDate: string; // YYYY-MM-DD in athlete local time
  elapsedTime: number;
  movingTime: number;
  distance: number | null;
  elevationGain: number | null;
  avgPower: number | null;
  maxPower: number | null;
  np: number | null;
  intensity: number | null;
  tss: number | null;
  tssMethod: TssMethod;
  vi: number | null;
  ef: number | null;
  decoupling: number | null;
  work: number | null; // kJ
  calories: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  trimp: number | null;
  avgTemp: number | null;
  wbalMin: number | null;
  hasPower: boolean;
  hasHr: boolean;
  hasGps: boolean;
  trainer: boolean;
  commute: boolean;
  polyline: string | null;
  description: string | null;
  rpe: number | null;
  feel: number | null;
  device: string | null;
  detailed: boolean;
  ftpUsed: number | null;
  zones: { power?: number[]; hr?: number[]; pace?: number[]; seiler?: number[] } | null;
  bestEfforts: Record<string, number> | null;
  laps: Lap[] | null;
  plannedId: number | null;
  /** what the session was and how it went (detail only) */
  session?: SessionAnalysis | null;
  /** its kind, and whether it was long for the sport (lists too) */
  sessionType?: SessionType | null;
  sessionLong?: boolean;
}

export interface ActivityDetail extends Activity {
  curves: ActivityCurves | null;
  streams: Streams | null;
  thresholds: Thresholds;
}

export type WorkoutIntent = 'warmup' | 'active' | 'recovery' | 'rest' | 'cooldown';

export interface WorkoutStep {
  kind: 'step';
  id: string;
  label?: string;
  intent: WorkoutIntent;
  /** seconds */
  duration: number;
  /** Fraction of threshold (FTP, threshold pace, or LTHR). For ramps low→high */
  low: number;
  high: number;
  ramp?: boolean;
  cadence?: number | null;
}

export interface WorkoutRepeat {
  kind: 'repeat';
  id: string;
  count: number;
  steps: WorkoutStep[];
}

export type WorkoutBlock = WorkoutStep | WorkoutRepeat;

export type TargetType = 'power' | 'pace' | 'hr';

export interface WorkoutStructure {
  target: TargetType;
  blocks: WorkoutBlock[];
}

export interface WorkoutTemplate {
  id: number;
  name: string;
  sport: Sport;
  category: string;
  description: string;
  structure: WorkoutStructure;
  builtin: boolean;
}

export interface PlannedWorkout {
  id: number;
  date: string; // YYYY-MM-DD
  sport: Sport;
  title: string;
  description: string | null;
  structure: WorkoutStructure | null;
  plannedDuration: number | null; // s
  plannedDistance: number | null; // m
  plannedTss: number | null;
  plannedIf: number | null;
  activityId: number | null;
  source: Source;
  externalId: string | null;
  sortOrder: number;
}

export type EventPriority = 'A' | 'B' | 'C';

export interface RaceEvent {
  id: number;
  date: string;
  name: string;
  sport: Sport;
  priority: EventPriority;
  description: string | null;
  targetCtl: number | null;
}

export interface Connection {
  provider: 'strava';
  connected: boolean;
  configured: boolean;
  athleteName: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  pending: number;
  webhook: boolean;
}

export interface SyncStatus {
  running: boolean;
  queue: number;
  message: string | null;
  connections: Connection[];
  activityCount: number;
}

export interface Preferences {
  units: 'metric' | 'imperial';
  ctlDays: number;
  atlDays: number;
  weekStart: 1 | 0;
  athleteName: string;
  crankLength: number; // mm
  /** Use rolling 6-month estimates (critical power / critical speed) instead of manual values */
  autoThresholds: { ride: boolean; run: boolean; swim: boolean; hr: boolean };
}

export interface DailyLoad {
  date: string;
  tss: number;
  planned: number;
  duration: number;
  distance: number;
}

export interface PmcPoint {
  date: string;
  tss: number;
  ctl: number;
  atl: number;
  tsb: number;
  ramp: number;
  projected: boolean;
}

export interface SeasonWeek {
  weekStart: string;
  phase: string;
  tss: number;
  hours: number;
  ctl: number;
  atl: number;
  tsb: number;
  recovery: boolean;
  event: string | null;
}

export interface SeasonPlan {
  id: number;
  name: string;
  startDate: string;
  eventId: number | null;
  config: SeasonPlanConfig;
  weeks: SeasonWeek[];
  createdAt: string;
}

export interface SeasonPlanConfig {
  startDate: string;
  raceDate: string;
  startCtl: number;
  startAtl: number;
  targetCtl: number;
  maxRamp: number; // CTL per week
  pattern: '3:1' | '2:1' | '4:1';
  taperWeeks: number;
  maxWeeklyHours: number;
  sport: Sport;
  /** 'race' (default) peaks and tapers for race day; 'fitness' builds to the target and holds */
  goal?: 'race' | 'fitness';
  /** gentler ramp for the first weeks (e.g. returning from a break) */
  initialRamp?: number;
  initialWeeks?: number;
  /** the athlete's typical TSS per hour, for converting load to hours (default: from phase IF) */
  tssPerHour?: number;
  /** session mix to copy when filling the calendar (e.g. from a past peak) */
  mix?: { quality: number; vo2Share: number; longRides: number; days: number };
}
