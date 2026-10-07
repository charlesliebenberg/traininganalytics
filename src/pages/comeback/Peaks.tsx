import { useState } from 'react';
import { Pin, X } from 'lucide-react';
import clsx from 'clsx';
import { http, useAction } from '../../lib/api';
import { fmtDate } from '../../lib/format';
import { Badge, Button, Field, Input } from '../../components/ui';
import type { PeakCard } from './types';

export function PeakCards({ peaks, selected, onSelect }: { peaks: PeakCard[]; selected: string | null; onSelect: (d: string) => void }) {
  const unpin = useAction((d: string) => http(`/comeback/pins/${d}`, { method: 'DELETE' }));
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
                  onClick={(e) => {
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
          <div className="mt-0.5 text-[11px] text-muted">{p.label ? fmtDate(p.date, 'd MMM yyyy') : `week of ${fmtDate(p.date, 'd MMM')}`}</div>
          <div className="mt-3 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold">{p.ftp ?? '–'}</span>
            <span className="text-xs text-muted">W FTP{p.wkg ? ` · ${p.wkg.toFixed(2)} W/kg` : ''}</span>
          </div>
          <div className="mt-2 grid grid-cols-4 gap-2 text-[11px]">
            <div>
              <div className="text-muted">5 min</div>
              <div className="font-medium">{p.p5 ?? '–'}</div>
            </div>
            <div>
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

export function PinForm() {
  const [date, setDate] = useState('');
  const [label, setLabel] = useState('');
  const pin = useAction(() => http('/comeback/pins', { method: 'POST', json: { date, label } }), { onSuccess: () => (setDate(''), setLabel('')) });
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Pin a peak the data doesn't show">
        <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-8" />
      </Field>
      <Input placeholder="Label, e.g. Nationals 2019" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-56" />
      <Button size="sm" icon={<Pin className="h-3.5 w-3.5" />} disabled={!date} loading={pin.isPending} onClick={() => pin.mutate(undefined)}>
        Pin
      </Button>
    </div>
  );
}
