import { StrictMode, lazy, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { queryClient, useApi } from './lib/api';
import { ThemeContext, useThemeState } from './lib/theme';
import { RangeProvider } from './lib/range';
import { setUnits } from './lib/format';
import { Layout } from './components/Layout';
import type { Preferences } from '../shared/types';

const page = <K extends string>(name: K, loader: () => Promise<Record<K, React.ComponentType>>) => lazy(() => loader().then((m) => ({ default: m[name] })));
const Dashboard = page('Dashboard', () => import('./pages/Dashboard'));
const Activities = page('Activities', () => import('./pages/Activities'));
const ActivityDetail = page('ActivityDetail', () => import('./pages/ActivityDetail'));
const Fitness = page('Fitness', () => import('./pages/Fitness'));
const Performance = page('Performance', () => import('./pages/Performance'));
const Trends = page('Trends', () => import('./pages/Trends'));
const Records = page('Records', () => import('./pages/Records'));
const Heatmap = page('Heatmap', () => import('./pages/Heatmap'));
const Calendar = page('Calendar', () => import('./pages/Calendar'));
const Workouts = page('Workouts', () => import('./pages/Workouts'));
const Season = page('Season', () => import('./pages/Season'));
const Settings = page('Settings', () => import('./pages/Settings'));

function Prefs({ children }: { children: ReactNode }) {
  const { data } = useApi<Preferences>('/preferences');
  useEffect(() => {
    if (data) {
      setUnits(data.units);
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '/preferences' });
    }
  }, [data?.units]);
  if (!data) return null;
  setUnits(data.units);
  return <>{children}</>;
}

function Root() {
  const theme = useThemeState();
  return (
    <ThemeContext.Provider value={theme}>
      <QueryClientProvider client={queryClient}>
        <RangeProvider>
          <BrowserRouter>
            <Prefs>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Dashboard />} />
                  <Route path="activities" element={<Activities />} />
                  <Route path="activities/:id" element={<ActivityDetail />} />
                  <Route path="fitness" element={<Fitness />} />
                  <Route path="performance" element={<Performance />} />
                  <Route path="trends" element={<Trends />} />
                  <Route path="records" element={<Records />} />
                  <Route path="map" element={<Heatmap />} />
                  <Route path="calendar" element={<Calendar />} />
                  <Route path="workouts" element={<Workouts />} />
                  <Route path="season" element={<Season />} />
                  <Route path="settings" element={<Settings />} />
                </Route>
              </Routes>
            </Prefs>
          </BrowserRouter>
        </RangeProvider>
      </QueryClientProvider>
    </ThemeContext.Provider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
