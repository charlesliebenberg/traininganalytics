/** Form (TSB) in colour and in words, for anywhere — without pulling in the charts. */
import type { Tokens } from './theme';

/** A form zone's colour: state, so the status palette. */
export function formColor(t: Tokens, id: string): string {
  switch (id) {
    case 'transition':
      return t.muted;
    case 'fresh':
      return t.accent;
    case 'neutral':
      return t.lineStrong;
    case 'optimal':
      return t.good;
    default:
      return t.critical;
  }
}

/** Signed TSB, as form reads: +12 fresh, −20 tired. */
export function fmtForm(tsb: number): string {
  const r = Math.round(tsb);
  return r > 0 ? `+${r}` : r < 0 ? `−${-r}` : '0';
}
