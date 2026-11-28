import { StrictMode, lazy, useEffect, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { http, queryClient, setUnauthorizedHandler, useApi } from './lib/api';
import { Login } from './pages/Login';
import { ThemeContext, useThemeState } from './lib/theme';
import { RangeProvider } from './lib/range';
import { setUnits } from './lib/format';
import { Layout } from './components/Layout';
import { Button, Empty, Spinner } from './components/ui';
import { Toaster } from './lib/toast';
import type { Preferences } from '../shared/types';

const page = <K extends string>(name: K, loader: () => Promise<Record<K, React.ComponentType>>) => lazy(() => loader().then((m) => ({ default: m[name] })));
const Today = page('Today', () => import('./pages/Today'));
const Season = page('Season', () => import('./pages/season/Season'));
const Performance = page('Performance', () => import('./pages/performance/Performance'));
const Activities = page('Activities', () => import('./pages/Activities'));
const ActivityDetail = page('ActivityDetail', () => import('./pages/ActivityDetail'));
const Workouts = page('Workouts', () => import('./pages/Workouts'));
const Settings = page('Settings', () => import('./pages/Settings'));

/**
 * The pages the app used to have, sent to where they live now — so bookmarks, old links and
 * muscle memory still land in the right place, with what they asked for.
 */
function Moved({ to }: { to: (q: URLSearchParams) => string }) {
  const loc = useLocation();
  return <Navigate to={to(new URLSearchParams(loc.search))} replace />;
}
const withQ = (path: string, q: URLSearchParams, keep: Record<string, string>) => {
  const out = new URLSearchParams();
  for (const [from, to] of Object.entries(keep)) {
    const v = q.get(from);
    if (v) out.set(to, v);
  }
  const s = out.toString();
  return s ? `${path}${path.includes('?') ? '&' : '?'}${s}` : path;
};

setUnauthorizedHandler(() => queryClient.invalidateQueries({ queryKey: ['/session'] }));

/** Shows the login screen when the server is password protected and we have no session. */
function AuthGate({ children }: { children: ReactNode }) {
  const { data, isLoading, error } = useApi<{ required: boolean; authenticated: boolean }>('/session', { staleTime: Infinity });
  if (isLoading) return null;
  if (error) return <div className="p-10 text-center text-sm text-muted">Can't reach the server: {(error as Error).message}</div>;
  if (data?.required && !data.authenticated) return <Login />;
  return <>{children}</>;
}

function Prefs({ children }: { children: ReactNode }) {
  const { data, error, refetch } = useApi<Preferences>('/preferences');
  useEffect(() => {
    if (data) {
      setUnits(data.units);
      queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== '/preferences' });
    }
  }, [data?.units]);
  // the server's "today" follows the athlete's time zone. A first visit sets it from the browser;
  // after that a browser elsewhere (travel, a coach, a work machine on UTC) only offers to change
  // it (TimezoneNotice), rather than moving everyone's day boundaries without a word
  useEffect(() => {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (data && tz && !data.timezone)
      http('/preferences', { method: 'PUT', json: { timezone: tz } })
        .then(() => queryClient.invalidateQueries())
        .catch(() => {});
  }, [!!data, data?.timezone]);
  if (!data) {
    if (error) return (
      <div role="alert" className="p-10 text-center text-sm text-muted">
        <p>Can't load preferences: {error.message}</p>
        <Button className="mt-3" onClick={() => void refetch()}>Retry</Button>
      </div>
    );
    return <Spinner />;
  }
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
            <AuthGate>
            <Prefs>
              <Routes>
                <Route element={<Layout />}>
                  <Route index element={<Today />} />
                  <Route path="season" element={<Season />} />
                  <Route path="season/year" element={<Season />} />
                  <Route path="season/workouts" element={<Workouts />} />
                  <Route path="performance" element={<Performance />} />
                  <Route path="performance/:lens" element={<Performance />} />
                  <Route path="activities" element={<Activities />} />
                  <Route path="activities/:id" element={<ActivityDetail />} />
                  <Route path="settings" element={<Settings />} />
                  {/* where the old pages went */}
                  <Route path="journal" element={<Moved to={(q) => withQ('/season', q, { week: 'week' })} />} />
                  <Route path="calendar" element={<Moved to={() => '/season'} />} />
                  <Route path="forecast" element={<Moved to={(q) => withQ('/season', q, { event: 'race', s: 's' })} />} />
                  <Route path="fitness" element={<Moved to={() => '/season'} />} />
                  <Route path="trends" element={<Moved to={() => '/season/year'} />} />
                  <Route path="thresholds" element={<Moved to={() => '/performance/thresholds'} />} />
                  <Route path="records" element={<Moved to={() => '/performance/records'} />} />
                  <Route path="comeback" element={<Moved to={() => '/performance/peaks'} />} />
                  <Route path="trainerroad" element={<Moved to={() => '/performance/trainerroad'} />} />
                  <Route path="map" element={<Moved to={() => '/activities?view=map'} />} />
                  <Route path="workouts" element={<Moved to={(q) => withQ('/season/workouts', q, { planned: 'planned', template: 'template' })} />} />
                  <Route path="*" element={<Empty title="Page not found"><Link className="text-accent underline" to="/">Back to today</Link></Empty>} />
                </Route>
              </Routes>
            </Prefs>
            </AuthGate>
          </BrowserRouter>
          <Toaster />
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
