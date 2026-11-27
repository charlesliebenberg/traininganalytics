import { useState } from 'react';
import { Globe2, X } from 'lucide-react';
import type { Preferences } from '../../shared/types';
import { http, useAction, useApi } from '../lib/api';
import { Button } from './ui';

const browserZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
};
const key = (from: string, to: string) => `tz-keep:${from}>${to}`;

/** "Europe/London" → "London", for a sentence. */
export const zoneName = (tz: string) => tz.split('/').pop()!.replace(/_/g, ' ');

/**
 * When this browser is in another time zone than the one the athlete's days follow, offer to
 * switch (travelling to a race) or keep it (a coach elsewhere). Keeping is remembered here.
 */
export function TimezoneNotice() {
  const { data } = useApi<Preferences>('/preferences');
  const here = browserZone();
  const set = data?.timezone;
  const [kept, setKept] = useState(() => {
    try {
      return !!(set && here && localStorage.getItem(key(set, here)));
    } catch {
      return false;
    }
  });
  const change = useAction(() => http('/preferences', { method: 'PUT', json: { timezone: here } }), { success: `Your training days now follow ${here ? zoneName(here) : 'this time zone'}` });
  if (!set || !here || set === here || kept) return null;
  const keep = () => {
    try {
      localStorage.setItem(key(set, here), '1');
    } catch {}
    setKept(true);
  };
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line bg-surface px-4 py-2.5 text-[13px]" role="status">
      <Globe2 className="h-4 w-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1 text-ink-2">
        Your days follow <b className="text-ink">{zoneName(set)}</b> time; this browser is in <b className="text-ink">{zoneName(here)}</b>. Switch if you've travelled; keep it if someone else is looking.
      </span>
      <Button size="sm" variant="primary" loading={change.isPending} onClick={() => change.mutate(undefined)}>
        Use {zoneName(here)}
      </Button>
      <Button size="sm" onClick={keep}>
        Keep {zoneName(set)}
      </Button>
      <button onClick={keep} className="rounded p-1 text-muted hover:text-ink" aria-label="Dismiss">
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
