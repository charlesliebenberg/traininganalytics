/**
 * The inspector: anything — a ride, a day, a week, a race, a planned workout — opens in a panel
 * beside the page you're on, so looking at it never loses your place. Which one is open lives in
 * the URL (?i=a:1361), so it can be linked to and the back button closes it.
 */
import { useCallback } from 'react';
import { useLocation, useNavigate, useSearchParams, type To } from 'react-router-dom';

export type InspectKind = 'a' | 'd' | 'w' | 'e' | 'p';
export interface InspectTarget {
  kind: InspectKind;
  id: string;
}

const KINDS = new Set<InspectKind>(['a', 'd', 'w', 'e', 'p']);

export function parseInspect(v: string | null): InspectTarget | null {
  if (!v) return null;
  const [kind, ...rest] = v.split(':');
  const id = rest.join(':');
  if (!KINDS.has(kind as InspectKind) || !id) return null;
  if ((kind === 'd' || kind === 'w') && !/^\d{4}-\d{2}-\d{2}$/.test(id)) return null;
  if ((kind === 'a' || kind === 'e' || kind === 'p') && !/^\d+$/.test(id)) return null;
  return { kind: kind as InspectKind, id };
}

/**
 * How many panels deep we are: each thing opened from the page or from another panel is a step
 * Back takes you back through; closing leaves them all at once.
 */
const depthOf = (state: unknown, hasPanel: boolean) => {
  const d = (state as { inspector?: unknown } | null)?.inspector;
  return hasPanel && typeof d === 'number' && d > 0 ? d : 0;
};

/**
 * Props for a <Link> that opens a thing in the inspector over the current page:
 * `<Link {...inspectLink('a', 1361)}>`. A real link, so it can open in a new tab too.
 */
export function useInspectLink() {
  const loc = useLocation();
  return useCallback(
    (kind: InspectKind, id: string | number): { to: To; state: { inspector: number } } => {
      const p = new URLSearchParams(loc.search);
      const depth = depthOf(loc.state, p.has('i'));
      p.set('i', `${kind}:${id}`);
      return { to: { pathname: loc.pathname, search: `?${p}`, hash: loc.hash }, state: { inspector: depth + 1 } };
    },
    [loc.pathname, loc.search, loc.hash, loc.state],
  );
}

export function useInspect() {
  const [params] = useSearchParams();
  const loc = useLocation();
  const nav = useNavigate();
  const current = parseInspect(params.get('i'));
  const open = useCallback(
    (kind: InspectKind, id: string | number) => {
      const p = new URLSearchParams(loc.search);
      const depth = depthOf(loc.state, p.has('i'));
      p.set('i', `${kind}:${id}`);
      nav({ pathname: loc.pathname, search: `?${p}`, hash: loc.hash }, { state: { inspector: depth + 1 } });
    },
    [loc.pathname, loc.search, loc.hash, loc.state, nav],
  );
  const close = useCallback(() => {
    const depth = depthOf(loc.state, !!current);
    // back past every panel opened since the page; a link straight to a panel just drops it
    if (depth > 0 && window.history.length > depth) {
      nav(-depth);
      return;
    }
    const p = new URLSearchParams(loc.search);
    p.delete('i');
    const s = p.toString();
    nav({ pathname: loc.pathname, search: s ? `?${s}` : '', hash: loc.hash }, { replace: true });
  }, [loc.pathname, loc.search, loc.hash, loc.state, current, nav]);
  return { current, open, close };
}
