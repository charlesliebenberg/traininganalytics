import { useEffect, useState } from 'react';

export const APP_NAME = 'Training Analytics';

/** `value`, once it has stopped changing for `ms`: typing doesn't send a request per keystroke. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** The browser tab's title while this page is open, e.g. "Threshold 2×20 · Training Analytics". */
export function useDocumentTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    document.title = `${title} · ${APP_NAME}`;
  }, [title]);
}

/** Is the event's target somewhere the user types (so a single-key shortcut shouldn't fire)? */
export function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}
