import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TrainerRoad } from '../pages/TrainerRoad';

function render(read: string | null, mode: 'account' | 'calendar' | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['/trainerroad/insights'], {
    status: { mode, lastSyncAt: read, lastError: null, syncing: false }, read,
    ftp: null, ai: null, levels: [], levelsAt: null, plan: null,
    rides: read ? [{ id: 'saved-ride', started: '2026-11-01T08:00:00Z', name: 'Saved interval workout', duration: 3600, tss: 70, if: 0.83, kj: 700, survey: null, activity: null }] : [],
  });
  try {
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(TrainerRoad))));
  } finally { client.clear(); }
}

describe('saved TrainerRoad analysis', () => {
  it.each([null, 'calendar'] as const)('shows saved rides when account sync is unavailable (%s)', mode => {
    const html = render('2026-11-09T09:00:00Z', mode);
    expect(html).toContain('Saved interval workout');
    expect(html).toContain('Showing saved TrainerRoad data');
  });
  it('still explains setup when no saved data exists', () => {
    expect(render(null, null)).toContain('TrainerRoad isn’t set up yet');
  });
});
