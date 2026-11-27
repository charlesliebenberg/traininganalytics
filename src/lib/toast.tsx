import { useSyncExternalStore } from 'react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';

export interface Toast {
  id: number;
  kind: 'success' | 'error';
  text: string;
}

let toasts: Toast[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/** A short message in the corner: what an action did, or why it didn't. Errors stay longer. */
export function toast(text: string, kind: Toast['kind'] = 'success') {
  const id = next++;
  // the same message twice in a row replaces the first rather than stacking
  toasts = [...toasts.filter((t) => t.text !== text), { id, kind, text }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), kind === 'error' ? 7000 : 3000);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[1200] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2" aria-live="polite" role="status">
      {list.map((t) => (
        <div key={t.id} className={clsx('card pointer-events-auto flex items-start gap-2.5 px-3.5 py-3 text-[13px] shadow-lg', t.kind === 'error' && 'border-critical/40')} role={t.kind === 'error' ? 'alert' : undefined}>
          {t.kind === 'error' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-critical" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-good" />}
          <span className="min-w-0 flex-1 text-ink">{t.text}</span>
          <button onClick={() => dismiss(t.id)} className="-mr-1 rounded p-0.5 text-muted hover:text-ink" aria-label="Dismiss">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
