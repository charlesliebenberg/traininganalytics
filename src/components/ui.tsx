import clsx from 'clsx';
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
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
            {title && <h3 className="text-[14px] leading-5 font-semibold text-ink">{title}</h3>}
            {subtitle && <p className="mt-0.5 text-[12.5px] leading-[18px] text-muted">{subtitle}</p>}
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
      <div className="eyebrow flex items-center gap-1.5 truncate">
        {accent && <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />}
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1 truncate">
        <span className="figure text-[22px] text-ink">{value}</span>
        {unit && <span className="text-xs font-medium text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-1 truncate text-xs text-ink-2">{sub}</div>}
    </div>
  );
}

type BtnVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
/** A button's look, for a link that should read as one (a link can't contain a <button>). */
export function buttonClass(variant: BtnVariant = 'secondary', size: 'sm' | 'md' = 'md', className?: string) {
  return clsx(
    'inline-flex items-center justify-center gap-1.5 rounded-[10px] font-medium whitespace-nowrap transition-[background-color,color,border-color,box-shadow,filter] select-none disabled:cursor-not-allowed disabled:opacity-50',
    size === 'sm' ? 'h-8 px-2.5 text-[12.5px]' : 'h-9 px-3.5 text-[13px]',
    variant === 'primary' && 'bg-inverse text-inverse-ink shadow-sm hover:opacity-90',
    variant === 'accent' && 'bg-accent text-white shadow-sm hover:brightness-110',
    variant === 'secondary' && 'border border-line bg-surface text-ink shadow-sm hover:border-line-strong hover:bg-surface-2',
    variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
    variant === 'danger' && 'border border-line bg-surface text-critical hover:border-critical hover:bg-critical hover:text-white',
    className,
  );
}

export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || loading} className={buttonClass(variant, size, className)}>
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** A small round button holding only an icon. */
export function IconButton({ label, children, className, active, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={clsx('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-40', active && 'bg-surface-2 text-ink', className)}>
      {children}
    </button>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, size = 'md', className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; title?: string }[]; size?: 'sm' | 'md'; className?: string }) {
  return (
    <div className={clsx('inline-flex max-w-full overflow-x-auto rounded-[10px] bg-surface-2 p-0.5 scrollbar-none', className)} role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-lg font-medium whitespace-nowrap transition-[background-color,color,box-shadow]',
            size === 'sm' ? 'px-2 py-0.5 text-[11.5px]' : 'px-2.5 py-1 text-[12.5px]',
            o.value === value ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx('h-9 rounded-[10px] border border-line bg-surface px-3 text-[13px] text-ink shadow-sm transition-colors placeholder:text-muted hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent-soft focus:outline-none', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx('h-9 rounded-[10px] border border-line bg-surface px-2.5 text-[13px] text-ink shadow-sm transition-colors hover:border-line-strong focus:border-accent focus:ring-3 focus:ring-accent-soft focus:outline-none', className)}>
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
      className={clsx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap', !color && 'bg-surface-2 text-ink-2 ring-1 ring-line ring-inset', className)}
      style={color ? { background: `color-mix(in srgb, ${color} 14%, transparent)`, color: 'var(--ink)' } : undefined}
    >
      {color && <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </span>
  );
}

/** Closes on Escape while open. */
function useEscape(open: boolean, onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && ref.current();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open]);
}

export function Modal({ open, onClose, title, children, width = 560, footer }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEscape(open, onClose);
  const id = useId();
  if (!open) return null;
  return (
    <div className="animate-fade fixed inset-0 z-[1100] flex items-end justify-center overflow-y-auto bg-black/40 backdrop-blur-[3px] sm:items-start sm:p-4 sm:pt-[8vh]" onMouseDown={onClose}>
      <div className="animate-sheet-up w-full rounded-t-2xl border border-line bg-surface shadow-lg sm:rounded-2xl" style={{ maxWidth: width }} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal aria-labelledby={id}>
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <h2 id={id} className="min-w-0 text-[16px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose} className="-mr-2 h-8 w-8">
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="max-h-[72vh] overflow-y-auto px-5 pb-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted [&>svg]:h-6 [&>svg]:w-6">{icon}</div>}
      <div className="text-[14px] font-semibold text-ink">{title}</div>
      {children && <div className="max-w-md text-[12.5px] leading-5 text-muted">{children}</div>}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center justify-center py-16 text-muted', className)} role="status" aria-label="Loading">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

/** A placeholder block while something loads. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={clsx('skeleton', className)} style={style} aria-hidden />;
}

/**
 * A page shown inside another (a lens of Performance, say) keeps its own controls, but its title
 * reads as a section of the page it's in rather than a page of its own.
 */
export const EmbedContext = createContext<{ embedded: boolean; title?: ReactNode; subtitle?: ReactNode }>({ embedded: false });

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  const embed = useContext(EmbedContext);
  if (embed.embedded) return <SectionHeader title={embed.title ?? title} subtitle={embed.subtitle ?? subtitle} actions={actions} />;
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-1.5">{eyebrow}</div>}
        <h1 className="text-[26px] leading-8 font-semibold tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-3xl text-[13.5px] leading-5 text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** A heading inside a page: a part of it, not a new page. */
export function SectionHeader({ title, subtitle, actions, id, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; id?: string; className?: string }) {
  return (
    <div id={id} className={clsx('mb-4 flex scroll-mt-28 flex-wrap items-end justify-between gap-x-4 gap-y-2', className)}>
      <div className="min-w-0">
        <h2 className="text-[18px] leading-6 font-semibold tracking-[-0.015em] text-ink">{title}</h2>
        {subtitle && <p className="mt-1 max-w-3xl text-[13px] leading-5 text-muted">{subtitle}</p>}
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

/** A sport's icon in a soft tile of its colour. */
export function SportBadge({ sport, size = 32 }: { sport: Sport; size?: number }) {
  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-[10px]" style={{ width: size, height: size, background: `color-mix(in srgb, var(--sport-${sport}) 13%, transparent)` }}>
      <SportIcon sport={sport} className={size >= 32 ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
    </span>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode }[] }) {
  return (
    // scrolls sideways on a phone rather than pushing the page wider
    <div className="-mx-4 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0" role="tablist">
      <div className="flex min-w-max gap-5 border-b border-line">
        {tabs.map((t) => (
          <button
            key={t.value}
            role="tab"
            aria-selected={t.value === value}
            onClick={() => onChange(t.value)}
            className={clsx('-mb-px border-b-2 py-2.5 text-[13.5px] font-medium whitespace-nowrap transition-colors', t.value === value ? 'border-ink text-ink' : 'border-transparent text-muted hover:text-ink')}
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
      <span className={clsx('relative inline-block h-[18px] w-8 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3')}>
        <span className={clsx('absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all', checked ? 'left-4' : 'left-0.5')} />
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * A menu that drops from its button: the items are whatever you put in it. Closes on a click
 * outside it, Escape, or choosing an item (any button or link inside).
 */
export function Menu({ button, children, align = 'right', className, label }: { button: (p: { open: boolean; toggle: () => void }) => ReactNode; children: ReactNode; align?: 'left' | 'right'; className?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEscape(open, () => setOpen(false));
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {button({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div
          role="menu"
          aria-label={label}
          onClick={(e) => (e.target as HTMLElement).closest('a,button:not([data-keep-open])') && setOpen(false)}
          className={clsx('animate-rise absolute top-full z-[1050] mt-2 min-w-56 rounded-2xl border border-line bg-surface p-1.5 shadow-lg', align === 'right' ? 'right-0' : 'left-0', className)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, className, hint }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; className?: string; hint?: ReactNode }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className={clsx('flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[13px] text-ink-2 hover:bg-surface-2 hover:text-ink', className)}>
      {icon && <span className="text-muted [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </button>
  );
}

