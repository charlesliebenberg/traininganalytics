import {
  LayoutDashboard,
  ListOrdered,
  TrendingUp,
  Zap,
  BarChart3,
  Trophy,
  Map as MapIcon,
  CalendarDays,
  Dumbbell,
  Flag,
  Gauge,
  Mountain,
  Bike,
  Settings,
  Telescope,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** extra words the command palette matches on */
  keywords?: string;
}

export const NAV: { group: string | null; items: NavItem[] }[] = [
  { group: null, items: [{ to: '/', label: 'Dashboard', icon: LayoutDashboard, keywords: 'home today overview' }] },
  {
    group: 'Analyze',
    items: [
      { to: '/journal', label: 'Journal', icon: BookOpen, keywords: 'weeks review diary log history season timeline sleep missed' },
      { to: '/activities', label: 'Activities', icon: ListOrdered, keywords: 'rides runs swims list' },
      { to: '/fitness', label: 'Fitness & Form', icon: TrendingUp, keywords: 'pmc ctl atl tsb fatigue aerobic sleep hrv' },
      { to: '/performance', label: 'Power & Performance', icon: Zap, keywords: 'power curve cp w prime durability profile' },
      { to: '/trends', label: 'Trends', icon: BarChart3, keywords: 'volume review week intensity polarization' },
      { to: '/thresholds', label: 'Thresholds', icon: Gauge, keywords: 'ftp lthr css pace max hr critical power' },
      { to: '/records', label: 'Records', icon: Trophy, keywords: 'best efforts personal bests pb pr' },
      { to: '/map', label: 'Heatmap', icon: MapIcon, keywords: 'routes map gps' },
    ],
  },
  {
    group: 'Plan',
    items: [
      { to: '/forecast', label: 'Forecast', icon: Telescope, keywords: 'race day predict projection scenario what if taper ftp future best path' },
      { to: '/comeback', label: 'Comeback', icon: Mountain, keywords: 'peak capacity return' },
      { to: '/calendar', label: 'Calendar', icon: CalendarDays, keywords: 'schedule planned workouts week' },
      { to: '/trainerroad', label: 'TrainerRoad', icon: Bike, keywords: 'tr ai ftp detection progression levels' },
      { to: '/workouts', label: 'Workout Builder', icon: Dumbbell, keywords: 'intervals structured zwo erg export library' },
      { to: '/season', label: 'Season Planner', icon: Flag, keywords: 'periodisation plan race goal events taper' },
    ],
  },
];

export const SETTINGS_ITEM: NavItem = { to: '/settings', label: 'Settings & Sync', icon: Settings, keywords: 'strava eight sleep import preferences units zones data' };

export const ALL_PAGES: NavItem[] = [...NAV.flatMap((g) => g.items), SETTINGS_ITEM];

/** The page title for a path, or null for a path that sets its own (an activity). */
export function pageTitle(pathname: string): string | null {
  if (pathname === '/') return null;
  return ALL_PAGES.find((p) => p.to === pathname)?.label ?? null;
}
