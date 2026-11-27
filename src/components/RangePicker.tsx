import { useEffect, useRef, useState } from 'react';
import { CalendarRange, Check, ChevronDown } from 'lucide-react';
import clsx from 'clsx';
import { PRESETS, resolvePreset, useRange, type DateRange } from '../lib/range';
import { Button, Input } from './ui';

export function RangePicker({ value, onChange, presets = PRESETS.map((p) => p.value) }: { value?: DateRange; onChange?: (r: DateRange) => void; presets?: string[] }) {
  const global = useRange();
  const range = value ?? global.range;
  const set = onChange ?? global.setRange;
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  // opens under the button, toward whichever side has room for it (a phone puts it at either edge)
  const [alignLeft, setAlignLeft] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    setAlignLeft(!!r && r.right < 256 + 8);
    setFrom(range.from);
    setTo(range.to);
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', h);
    document.addEventListener('keydown', k);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const valid = !!from && !!to && from <= to;
  return (
    <div className="relative" ref={ref}>
      <Button onClick={() => setOpen(!open)} icon={<CalendarRange className="h-4 w-4 text-muted" />} aria-haspopup="listbox" aria-expanded={open}>
        {range.label}
        <ChevronDown className="h-3.5 w-3.5 text-muted" />
      </Button>
      {open && (
        <div className={clsx('card absolute z-50 mt-1.5 w-64 p-1.5', alignLeft ? 'left-0' : 'right-0')}>
          {PRESETS.filter((p) => presets.includes(p.value)).map((p) => (
            <button
              key={p.value}
              onClick={() => {
                set(resolvePreset(p.value));
                setOpen(false);
              }}
              className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-2"
            >
              <span className={clsx(range.preset === p.value && 'font-semibold')}>{p.label}</span>
              {range.preset === p.value && <Check className="h-4 w-4 stroke-[3]" />}
            </button>
          ))}
          <div className="mt-1.5 border-t border-line px-1 pt-2.5 pb-1">
            <div className="mb-1.5 text-[11px] font-medium text-muted uppercase">Custom range</div>
            <div className="flex flex-col gap-1.5">
              <Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className="h-8 w-full" aria-label="From" />
              <Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="h-8 w-full" aria-label="To" />
              <Button
                size="sm"
                variant="primary"
                disabled={!valid}
                title={valid ? undefined : 'The start must be on or before the end'}
                onClick={() => {
                  set(resolvePreset('custom', { from, to }));
                  setOpen(false);
                }}
              >
                Apply
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
