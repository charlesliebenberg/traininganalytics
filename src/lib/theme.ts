import { createContext, useContext, useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Tokens {
  dark: boolean;
  page: string;
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  lineStrong: string;
  ink: string;
  ink2: string;
  muted: string;
  accent: string;
  good: string;
  warning: string;
  serious: string;
  critical: string;
  power: string;
  hr: string;
  cadence: string;
  speed: string;
  altitude: string;
  temp: string;
  wbal: string;
  ctl: string;
  atl: string;
  tsb: string;
  series: string[];
  sport: Record<string, string>;
}

function readTokens(): Tokens {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(`--${n}`).trim();
  const dark = cs.colorScheme.includes('dark') || v('page').toLowerCase() === '#0d0d0d';
  return {
    dark,
    page: v('page'),
    surface: v('surface'),
    surface2: v('surface-2'),
    surface3: v('surface-3'),
    line: v('line'),
    lineStrong: v('line-strong'),
    ink: v('ink'),
    ink2: v('ink-2'),
    muted: v('muted'),
    accent: v('accent'),
    good: v('good'),
    warning: v('warning'),
    serious: v('serious'),
    critical: v('critical'),
    power: v('s-power'),
    hr: v('s-hr'),
    cadence: v('s-cadence'),
    speed: v('s-speed'),
    altitude: v('s-altitude'),
    temp: v('s-temp'),
    wbal: v('s-wbal'),
    ctl: v('s-ctl'),
    atl: v('s-atl'),
    tsb: v('s-tsb'),
    series: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => v(`s-${i}`)),
    sport: Object.fromEntries(['ride', 'run', 'swim', 'strength', 'walk', 'hike', 'ski', 'row', 'other'].map((s) => [s, v(`sport-${s}`)])),
  };
}

export const ThemeContext = createContext<{ tokens: Tokens; mode: ThemeMode; setMode: (m: ThemeMode) => void } | null>(null);

export function useThemeState() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    try {
      return (localStorage.getItem('theme') as ThemeMode) || 'system';
    } catch {
      return 'system';
    }
  });
  const [tokens, setTokens] = useState<Tokens>(() => readTokens());
  useEffect(() => {
    const el = document.documentElement;
    if (mode === 'system') delete el.dataset.theme;
    else el.dataset.theme = mode;
    try {
      localStorage.setItem('theme', mode);
    } catch {}
    setTokens(readTokens());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setTokens(readTokens());
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [mode]);
  return { tokens, mode, setMode: setModeState };
}

export function useTokens(): Tokens {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeContext missing');
  return ctx.tokens;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('ThemeContext missing');
  return ctx;
}

/** Hex colour with alpha. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Zone colours: a single-hue sequential ramp from recessive to strong (ordinal zones). */
export function zoneColors(t: Tokens, n: number, base = t.power): string[] {
  return Array.from({ length: n }, (_, i) => alpha(base, 0.28 + (0.72 * i) / Math.max(1, n - 1)));
}
