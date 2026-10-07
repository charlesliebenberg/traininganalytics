import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { startOfYear, subDays, subYears, endOfYear } from 'date-fns';
import { iso } from './format';

export type RangePreset = '7d' | '28d' | '42d' | '90d' | '180d' | '365d' | '730d' | 'ytd' | 'lastyear' | 'all' | 'custom';

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
  label: string;
}

export const PRESETS: { value: RangePreset; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '28d', label: 'Last 28 days' },
  { value: '42d', label: 'Last 6 weeks' },
  { value: '90d', label: 'Last 90 days' },
  { value: '180d', label: 'Last 6 months' },
  { value: '365d', label: 'Last 12 months' },
  { value: '730d', label: 'Last 2 years' },
  { value: 'ytd', label: 'This year' },
  { value: 'lastyear', label: 'Last year' },
  { value: 'all', label: 'All time' },
];

export function resolvePreset(preset: RangePreset, custom?: { from: string; to: string }): DateRange {
  const now = new Date();
  const t = iso(now);
  const label = PRESETS.find((p) => p.value === preset)?.label ?? 'Custom';
  switch (preset) {
    case '7d':
      return { preset, from: iso(subDays(now, 6)), to: t, label };
    case '28d':
      return { preset, from: iso(subDays(now, 27)), to: t, label };
    case '42d':
      return { preset, from: iso(subDays(now, 41)), to: t, label };
    case '90d':
      return { preset, from: iso(subDays(now, 89)), to: t, label };
    case '180d':
      return { preset, from: iso(subDays(now, 179)), to: t, label };
    case '365d':
      return { preset, from: iso(subDays(now, 364)), to: t, label };
    case '730d':
      return { preset, from: iso(subDays(now, 729)), to: t, label };
    case 'ytd':
      return { preset, from: iso(startOfYear(now)), to: t, label };
    case 'lastyear': {
      const ly = subYears(now, 1);
      return { preset, from: iso(startOfYear(ly)), to: iso(endOfYear(ly)), label };
    }
    case 'all':
      return { preset, from: '2000-01-01', to: t, label };
    default:
      return { preset: 'custom', from: custom?.from ?? iso(subDays(now, 89)), to: custom?.to ?? t, label: `${custom?.from} → ${custom?.to}` };
  }
}

const Ctx = createContext<{ range: DateRange; setRange: (r: DateRange) => void } | null>(null);

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<DateRange>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('range') ?? 'null');
      if (saved?.preset) return resolvePreset(saved.preset, saved);
    } catch {}
    return resolvePreset('90d');
  });
  const value = useMemo(
    () => ({
      range,
      setRange: (r: DateRange) => {
        setRangeState(r);
        try {
          localStorage.setItem('range', JSON.stringify(r));
        } catch {}
      },
    }),
    [range],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRange() {
  const c = useContext(Ctx);
  if (!c) throw new Error('RangeProvider missing');
  return c;
}
