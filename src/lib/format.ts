import { format, parseISO } from 'date-fns';
import type { Sport } from '../../shared/types';

export type Units = 'metric' | 'imperial';

let units: Units = 'metric';
export const setUnits = (u: Units) => (units = u);
export const getUnits = () => units;

const MI = 1609.344;
const FT = 0.3048;

export function fmtDuration(sec: number | null | undefined, opts: { short?: boolean; seconds?: boolean } = {}): string {
  if (sec == null || !Number.isFinite(sec)) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (opts.short) {
    if (h) return `${h}h${m ? ` ${m}m` : ''}`;
    if (m) return `${m}m${s && opts.seconds ? ` ${s}s` : ''}`;
    return `${s}s`;
  }
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Axis-friendly duration label for power curves: 5s, 1m, 20m, 1h, 2h30 */
export function fmtDurLabel(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return sec % 60 ? `${Math.floor(sec / 60)}m${sec % 60}s` : `${sec / 60}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

export function fmtDistance(m: number | null | undefined, digits = 1, sport?: Sport): string {
  if (m == null) return '–';
  if (sport === 'swim') return units === 'metric' ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m / 0.9144).toLocaleString()} yd`;
  return units === 'metric' ? `${(m / 1000).toFixed(digits)} km` : `${(m / MI).toFixed(digits)} mi`;
}
export const distValue = (m: number) => (units === 'metric' ? m / 1000 : m / MI);
export const distUnit = () => (units === 'metric' ? 'km' : 'mi');

export function fmtElevation(m: number | null | undefined): string {
  if (m == null) return '–';
  return units === 'metric' ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m / FT).toLocaleString()} ft`;
}
export const elevValue = (m: number) => (units === 'metric' ? m : m / FT);
export const elevUnit = () => (units === 'metric' ? 'm' : 'ft');

export function fmtSpeed(ms: number | null | undefined): string {
  if (ms == null || !ms) return '–';
  return units === 'metric' ? `${(ms * 3.6).toFixed(1)} km/h` : `${(ms * 2.23694).toFixed(1)} mph`;
}
export const speedValue = (ms: number) => (units === 'metric' ? ms * 3.6 : ms * 2.23694);
export const speedUnit = () => (units === 'metric' ? 'km/h' : 'mph');

/** Pace in seconds per km / mile (or per 100 m for swimming). */
export function paceSeconds(ms: number, sport?: Sport): number {
  if (sport === 'swim') return 100 / ms;
  return (units === 'metric' ? 1000 : MI) / ms;
}
export function fmtPace(ms: number | null | undefined, sport?: Sport, withUnit = true): string {
  if (ms == null || ms <= 0.3) return '–';
  const s = paceSeconds(ms, sport);
  if (s > 3600) return '–';
  const txt = `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`.replace(/:60$/, ':59');
  if (!withUnit) return txt;
  return `${txt} ${sport === 'swim' ? '/100m' : units === 'metric' ? '/km' : '/mi'}`;
}
export const paceUnit = (sport?: Sport) => (sport === 'swim' ? '/100m' : units === 'metric' ? '/km' : '/mi');
export const fmtPaceSec = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function fmtNum(v: number | null | undefined, digits = 0, suffix = ''): string {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}${suffix}`;
}

export function fmtDate(d: string | Date, f = 'EEE d MMM yyyy'): string {
  const date = typeof d === 'string' ? (d.length === 10 ? parseISO(d) : new Date(d)) : d;
  return format(date, f);
}

export const fmtTemp = (c: number | null | undefined) => (c == null ? '–' : units === 'metric' ? `${Math.round(c)}°C` : `${Math.round((c * 9) / 5 + 32)}°F`);

export const SPORT_LABEL: Record<Sport, string> = {
  ride: 'Ride',
  run: 'Run',
  swim: 'Swim',
  walk: 'Walk',
  hike: 'Hike',
  strength: 'Strength',
  ski: 'Ski',
  row: 'Row',
  other: 'Other',
};

export const TSS_METHOD_LABEL: Record<string, string> = {
  power: 'TSS (power)',
  pace: 'rTSS (pace)',
  swim: 'sTSS (swim)',
  hr: 'hrTSS',
  estimate: 'Estimated',
  manual: 'Manual',
  none: '–',
};

export const iso = (d: Date) => format(d, 'yyyy-MM-dd');
