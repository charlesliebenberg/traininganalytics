import { CalendarRange, Gauge, ListOrdered, Settings, Sunrise, type LucideIcon } from 'lucide-react';

/**
 * The app is four places, not a list of pages:
 *  - Today: how you are and what to do now
 *  - Season: your training as one timeline — the weeks behind you reviewed, the weeks ahead
 *    planned, and where they take you on race day
 *  - Performance: what you can do and how it's changing — power, thresholds, records, peaks
 *  - Activities: everything you've done, as a list or a map
 * Anything in them (a ride, a day, a week, a race) opens in the inspector beside the page.
 */
export interface Space {
  to: string;
  label: string;
  icon: LucideIcon;
  /** what it holds, in a line */
  blurb: string;
  match: (path: string) => boolean;
}

export const SPACES: Space[] = [
  { to: '/', label: 'Today', icon: Sunrise, blurb: 'How you are and what to do now', match: (p) => p === '/' },
  { to: '/season', label: 'Season', icon: CalendarRange, blurb: 'Your weeks behind and ahead, and where they lead', match: (p) => p.startsWith('/season') },
  { to: '/performance', label: 'Performance', icon: Gauge, blurb: 'What you can do and how it’s changing', match: (p) => p.startsWith('/performance') },
  { to: '/activities', label: 'Activities', icon: ListOrdered, blurb: 'Everything you’ve done, as a list or a map', match: (p) => p.startsWith('/activities') },
];

export const SETTINGS: Space = { to: '/settings', label: 'Settings', icon: Settings, blurb: 'Connections, athlete, preferences, data', match: (p) => p.startsWith('/settings') };

/**
 * Where to go for each thing you might look for — including the names of the pages the app used
 * to have, so they still find their new home from the search.
 */
export interface Destination {
  to: string;
  label: string;
  hint: string;
  keywords: string;
  icon: LucideIcon;
}

export const DESTINATIONS: Destination[] = [
  { to: '/', label: 'Today', hint: 'Today', keywords: 'home dashboard today call readiness sleep hrv', icon: Sunrise },
  { to: '/season', label: 'Season', hint: 'Weeks, plan and forecast', keywords: 'timeline calendar journal weeks review plan forecast race taper fitness form pmc ctl atl tsb', icon: CalendarRange },
  { to: '/season/year', label: 'The year', hint: 'Season', keywords: 'volume trends heatmap year over year polarization load calendar', icon: CalendarRange },
  { to: '/season/workouts', label: 'Workout builder', hint: 'Season', keywords: 'workouts library intervals structured zwo erg export builder', icon: CalendarRange },
  { to: '/performance', label: 'Performance', hint: 'Power, thresholds, records', keywords: 'power ftp w/kg', icon: Gauge },
  { to: '/performance/power', label: 'Power curve', hint: 'Performance', keywords: 'mean max curve cp w prime durability profile model', icon: Gauge },
  { to: '/performance/thresholds', label: 'Thresholds', hint: 'Performance', keywords: 'ftp lthr css pace max hr critical power estimates history', icon: Gauge },
  { to: '/performance/endurance', label: 'Aerobic fitness', hint: 'Performance', keywords: 'aerobic decoupling efficiency heart rate endurance durability', icon: Gauge },
  { to: '/performance/sessions', label: 'Key sessions', hint: 'Performance', keywords: 'interval sets progression trends improving trainerroad levels', icon: Gauge },
  { to: '/performance/records', label: 'Records', hint: 'Performance', keywords: 'best efforts personal bests pb pr', icon: Gauge },
  { to: '/performance/peaks', label: 'Peaks and comeback', hint: 'Performance', keywords: 'comeback peak capacity return break', icon: Gauge },
  { to: '/performance/trainerroad', label: 'TrainerRoad', hint: 'Performance', keywords: 'tr ai ftp detection progression levels survey', icon: Gauge },
  { to: '/activities', label: 'Activities', hint: 'All of them', keywords: 'rides runs swims list', icon: ListOrdered },
  { to: '/activities?view=map', label: 'Map', hint: 'Activities', keywords: 'heatmap routes gps', icon: ListOrdered },
  { to: '/settings', label: 'Settings', hint: 'Connections, athlete, data', keywords: 'strava eight sleep trainerroad import preferences units zones', icon: Settings },
];

/** The title for a path's tab, or null for a path that sets its own (an activity). */
export function pageTitle(pathname: string): string | null {
  if (pathname === '/') return null;
  if (pathname.startsWith('/activities/')) return null;
  if (pathname.startsWith('/season/workouts')) return 'Workout builder';
  return [...SPACES, SETTINGS].find((s) => s.match(pathname))?.label ?? null;
}
