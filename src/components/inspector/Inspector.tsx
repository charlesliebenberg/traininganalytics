import { Component, lazy, Suspense, useEffect, useRef, type ErrorInfo, type ReactNode } from 'react';
import clsx from 'clsx';
import { AlertTriangle, X } from 'lucide-react';
import { useInspect, type InspectTarget } from '../../lib/inspect';
import { Empty, IconButton, Skeleton } from '../ui';

const ActivityPanel = lazy(() => import('./ActivityPanel').then((m) => ({ default: m.ActivityPanel })));
const WeekPanel = lazy(() => import('./WeekPanel').then((m) => ({ default: m.WeekPanel })));
const DayPanel = lazy(() => import('./DayPanel').then((m) => ({ default: m.DayPanel })));
const EventPanel = lazy(() => import('./EventPanel').then((m) => ({ default: m.EventPanel })));
const PlannedPanel = lazy(() => import('./PlannedPanel').then((m) => ({ default: m.PlannedPanel })));

/** Is a modal open above everything (it gets Escape first)? */
const modalOpen = () => !!document.querySelector('[role="dialog"][aria-modal="true"]');

/**
 * The panel beside the page that shows whatever was opened in it. On a wide screen the page stays
 * live next to it — open another ride and the panel follows; on a phone it's a sheet over the page.
 */
export function Inspector() {
  const { current, close } = useInspect();
  const panel = useRef<HTMLElement>(null);
  const key = current ? `${current.kind}:${current.id}` : null;
  useEffect(() => {
    if (!key) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && !e.defaultPrevented && !modalOpen() && close();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [key, close]);
  // keyboard focus moves into the panel when something new opens in it
  useEffect(() => {
    if (key) panel.current?.focus({ preventScroll: true });
  }, [key]);
  if (!current) return null;
  return (
    <>
      <div className="animate-fade fixed inset-0 z-[940] bg-black/35 md:hidden" onClick={close} aria-hidden />
      <aside
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-label="Details"
        className={clsx(
          'fixed inset-x-0 bottom-0 z-[950] flex max-h-[92dvh] flex-col rounded-t-3xl border border-line bg-surface shadow-lg outline-none',
          'animate-sheet-up md:animate-sheet-right md:top-14 md:right-0 md:left-auto md:max-h-none md:w-[min(500px,100vw)] md:rounded-none md:border-y-0 md:border-r-0 2xl:w-[540px]',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-surface-3 md:hidden" aria-hidden />
        <PanelBoundary resetKey={key!} onClose={close}>
          <Suspense fallback={<PanelLoading onClose={close} />}>
            <Panel key={key} target={current} onClose={close} />
          </Suspense>
        </PanelBoundary>
      </aside>
    </>
  );
}

function Panel({ target, onClose }: { target: InspectTarget; onClose: () => void }) {
  switch (target.kind) {
    case 'a':
      return <ActivityPanel id={Number(target.id)} onClose={onClose} />;
    case 'w':
      return <WeekPanel start={target.id} onClose={onClose} />;
    case 'd':
      return <DayPanel date={target.id} onClose={onClose} />;
    case 'e':
      return <EventPanel id={Number(target.id)} onClose={onClose} />;
    case 'p':
      return <PlannedPanel id={Number(target.id)} onClose={onClose} />;
  }
}

/** A panel's frame: what it is at the top, its body scrolling, its actions along the bottom. */
export function PanelShell({ icon, eyebrow, title, subtitle, actions, footer, children, onClose }: { icon?: ReactNode; eyebrow?: ReactNode; title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; footer?: ReactNode; children?: ReactNode; onClose: () => void }) {
  return (
    <>
      <header className="flex shrink-0 items-start gap-3 px-5 pt-4 pb-3">
        {icon && <div className="pt-0.5">{icon}</div>}
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="eyebrow mb-0.5">{eyebrow}</div>}
          <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.015em] text-ink">{title}</h2>
          {subtitle && <div className="mt-0.5 text-[12.5px] leading-[18px] text-muted">{subtitle}</div>}
        </div>
        <div className="-mt-1 -mr-2 flex shrink-0 items-center gap-0.5">
          {actions}
          <IconButton label="Close (Esc)" onClick={onClose}>
            <X className="h-4.5 w-4.5" />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-1 pb-6">{children}</div>
      {footer && <footer className="pb-safe flex shrink-0 flex-wrap items-center gap-2 border-t border-line px-5 py-3">{footer}</footer>}
    </>
  );
}

export function PanelLoading({ onClose }: { onClose: () => void }) {
  return (
    <PanelShell title={<Skeleton className="h-5 w-48" />} subtitle={<Skeleton className="mt-1.5 h-3.5 w-32" />} onClose={onClose}>
      <div className="grid grid-cols-3 gap-3 pt-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-14" />
        ))}
      </div>
      <Skeleton className="mt-5 h-28" />
      <Skeleton className="mt-3 h-20" />
    </PanelShell>
  );
}

export function PanelMissing({ title, children, onClose }: { title: string; children?: ReactNode; onClose: () => void }) {
  return (
    <PanelShell title={title} onClose={onClose}>
      <Empty icon={<AlertTriangle />} title={title}>
        {children}
      </Empty>
    </PanelShell>
  );
}

/** A heading for a part of a panel. */
export function PanelSection({ title, children, className, aside }: { title: ReactNode; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={clsx('mt-6', className)}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

class PanelBoundary extends Component<{ children: ReactNode; resetKey: string; onClose: () => void }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <PanelMissing title="This couldn't be shown" onClose={this.props.onClose}>
        {this.state.error.message}
      </PanelMissing>
    );
  }
}
