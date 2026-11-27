import { useState } from 'react';
import { Pin, X } from 'lucide-react';
import clsx from 'clsx';
import { http, useAction } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Field, Input } from '../../components/ui';
import type { PeakCard } from './types';

export function PeakCards({ peaks, selected, onSelect }: { peaks: PeakCard[]; selected: string | null; onSelect: (d: string) => void }) {
  const unpin = useAction((d: string) => http(`/comeback/pins/${d}`, { method: 'DELETE' }), { success: 'Pin removed' });
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {peaks.map((p) => (
        <button
          key={p.date}
          onClick={() => onSelect(p.date)}
          className={clsx('card relative p-4 text-left transition-colors', selected === p.date ? 'border-accent ring-1 ring-accent' : 'hover:border-line-strong')}
        >
          <div className="flex items-center justify-between">
            <span className="text-[13px] font-semibold">{p.label ?? fmtDate(p.date, 'MMMM yyyy')}</span>
            {p.pinned ? (
              <span className="flex items-center gap-1">
                <Badge>Pinned</Badge>
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    e.stopPropagation();
                    unpin.mutate(p.date);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    e.stopPropagation();
                    unpin.mutate(p.date);
                  }}
                  className="rounded p-0.5 text-muted hover:text-critical"
                  aria-label="Remove pin"
                >
                  <X className="h-3.5 w-3.5" />
                </span>
              </span>
            ) : (
              <Badge>#{p.rank}</Badge>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-muted" title={p.pinned ? undefined : 'The day of the effort that set this FTP'}>
            {fmtDate(p.date, 'd MMM yyyy')}
          </div>
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold">{p.ftp ?? '–'}</span>
            <span className="text-xs text-muted">W FTP{p.wkg ? ` · ${p.wkg.toFixed(2)} W/kg` : ''}</span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]" title={`Best power from ${fmtDate(p.periodFrom, 'd MMM')} to ${fmtDate(p.periodTo, 'd MMM yyyy')}`}>
            <div>
              <div className="text-muted">5 min</div>
              <div className="font-medium">{p.p5 ?? '–'}</div>
            </div>
            <div title={p.p20Date ? `Ridden on ${fmtDate(p.p20Date, 'd MMM yyyy')}` : undefined}>
              <div className="text-muted">20 min</div>
              <div className="font-medium">{p.p20 ?? '–'}</div>
            </div>
            <div title="Riding CTL on the day">
              <div className="text-muted">CTL</div>
              <div className="font-medium">{p.ctl ?? '–'}</div>
            </div>
            <div title="20-min power the training supported at the time (capacity model)">
              <div className="text-muted">Capacity</div>
              <div className="font-medium">{p.capacity != null ? Math.round(p.capacity) : '–'}</div>
            </div>
          </div>
          {p.margin != null && (
            <div className="mt-2 text-[11px] text-ink-2">
              {p.margin >= 0.05 ? `Sharpened: best efforts ${Math.round(p.margin * 100)}% above capacity` : p.margin >= -0.02 ? 'Built on load: efforts at capacity' : 'Efforts below capacity around this date'}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Pin a date the data can't see (a season before your power meter, say). Collapsed to a button
 * until wanted, so it doesn't sit above the peaks it adds to.
 */
export function PinForm({ startOpen = false }: { startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const pin = useAction(() => http('/comeback/pins', { method: 'POST', json: { date, label } }), { onSuccess: () => (setDate(''), setLabel(''), setOpen(startOpen)), success: 'Peak pinned' });
  if (!open)
    return (
      <Button size="sm" variant="ghost" icon={<Pin className="h-3.5 w-3.5" />} onClick={() => setOpen(true)} title="Add a peak from before your data, e.g. a season without a power meter">
        Pin a peak
      </Button>
    );
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (date) pin.mutate(undefined);
      }}
    >
      <Field label="Pin a peak the data doesn't show">
        <Input type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} className="h-8" autoFocus={!startOpen} />
      </Field>
      <Input placeholder="Label, e.g. Nationals 2019" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-56" aria-label="Label" />
      <Button type="submit" size="sm" variant="primary" icon={<Pin className="h-3.5 w-3.5" />} disabled={!date} loading={pin.isPending}>
        Pin
      </Button>
      {!startOpen && (
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      )}
    </form>
  );
}
