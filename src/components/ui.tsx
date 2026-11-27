import clsx from 'clsx';
import { useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { X, Loader2, Bike, Footprints, Waves, Dumbbell, Mountain, Snowflake, Ship, Activity as ActivityIcon, PersonStanding } from 'lucide-react';
import type { Sport } from '../../shared/types';

/**
 * A titled panel. With `fill`, the card is a column whose body takes the height left over —
 * for a chart that should grow to match a taller neighbour in the same grid row rather than
 * leave the card half empty.
 */
export function Card({ title, subtitle, actions, children, className, bodyClassName, pad = true, fill = false, id }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; bodyClassName?: string; pad?: boolean; fill?: boolean; id?: string }) {
  return (
    <section id={id} className={clsx('card min-w-0', fill && 'flex flex-col', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-5 pt-4">
          <div className="min-w-[160px] flex-1">
            {title && <h3 className="text-[13px] font-semibold text-ink">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(pad && 'px-5 pb-5', pad && (title || actions) ? 'pt-3' : pad && 'pt-5', fill && 'flex min-h-0 flex-1 flex-col', bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * A chart area that fills whatever height its flex parent gives it (at least `min` px). The chart
 * inside should take `height="100%"`.
 */
export function FillBox({ min, children, className }: { min: number; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('relative min-h-0 flex-1', className)} style={{ minHeight: min }}>
      <div className="absolute inset-0">{children}</div>
    </div>
  );
}

export function Stat({ label, value, unit, sub, accent, className, title }: { label: ReactNode; value: ReactNode; unit?: ReactNode; sub?: ReactNode; accent?: string; className?: string; title?: string }) {
  return (
    <div className={clsx('min-w-0', className)} title={title}>
      <div className="flex items-center gap-1.5 truncate text-[11px] font-medium tracking-wide text-muted uppercase">
        {accent && <span className="inline-block h-2 w-2 shrink-0 rounded-sm" style={{ background: accent }} />}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1 truncate">
        <span className="text-xl font-semibold text-ink">{value}</span>
        {unit && <span className="text-xs text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-0.5 truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
/** A button's look, for a link that should read as one (a link can't contain a <button>). */
export function buttonClass(variant: BtnVariant = 'secondary', size: 'sm' | 'md' = 'md', className?: string) {
  return clsx(
    'inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-[13px]',
    variant === 'primary' && 'bg-accent text-white hover:brightness-110',
    variant === 'secondary' && 'border border-line bg-surface-2 text-ink hover:bg-surface-3',
    variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
    variant === 'danger' && 'border border-line bg-surface-2 text-critical hover:bg-critical hover:text-white',
    className,
  );
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || loading}
      className={buttonClass(variant, size, className)}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: 'sm' | 'md' }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md font-medium whitespace-nowrap transition-colors',
            size === 'sm' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
            o.value === value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx('h-9 rounded-lg border border-line bg-surface-2 px-3 text-[13px] text-ink placeholder:text-muted focus:border-accent focus:outline-none', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx('h-9 rounded-lg border border-line bg-surface-2 px-2.5 text-[13px] text-ink focus:border-accent focus:outline-none', className)}>
      {children}
    </select>
  );
}

export function Field({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={clsx('flex flex-col gap-1.5', className)}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', !color && 'bg-surface-3 text-ink-2', className)}
      style={color ? { background: `color-mix(in srgb, ${color} 16%, transparent)`, color: 'var(--ink)' } : undefined}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

export function Modal({ open, onClose, title, children, width = 560, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="card w-full" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal aria-labelledby="modal-title">
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 id="modal-title" className="text-[15px] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="text-muted">{icon}</div>}
      <div className="text-sm font-medium text-ink">{title}</div>
      {children && <div className="max-w-md text-xs text-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center py-16 text-muted', className)}>
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <p className="mt-1 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const SPORT_ICONS: Record<Sport, typeof Bike> = {
  ride: Bike,
  run: Footprints,
  swim: Waves,
  strength: Dumbbell,
  walk: PersonStanding,
  hike: Mountain,
  ski: Snowflake,
  row: Ship,
  other: ActivityIcon,
};

export function SportIcon({ sport, className, colored = true }: { sport: Sport; className?: string; colored?: boolean }) {
  const Icon = SPORT_ICONS[sport] ?? ActivityIcon;
  return <Icon className={clsx('shrink-0', className ?? 'h-4 w-4')} style={colored ? { color: `var(--sport-${sport})` } : undefined} />;
}

export function SportDot({ sport, size = 8 }: { sport: Sport; size?: number }) {
  return <span className="inline-block shrink-0 rounded-full" style={{ width: size, height: size, background: `var(--sport-${sport})` }} />;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    // scrolls sideways on a phone rather than pushing the page wider
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0" role="tablist">
      <div className="flex min-w-max gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={t.value === value}
          onClick={() => onChange(t.value)}
          className={clsx('-mb-px border-b-2 px-3 py-2 text-[13px] font-medium whitespace-nowrap transition-colors', t.value === value ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink')}
        >
          {t.label}
        </button>
      ))}
      </div>
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex cursor-pointer items-center gap-2 rounded-md text-left text-xs text-ink-2 select-none hover:text-ink">
      <span className={clsx('relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}>
        <span className={clsx('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-all', checked ? 'left-3.5' : 'left-0.5')} />
      </span>
      <span>{label}</span>
    </button>
  );
}
