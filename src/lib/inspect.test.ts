import { describe, expect, it } from 'vitest';
import { parseInspect } from './inspect';

describe('what the inspector shows, from the URL', () => {
  it('reads each kind of thing by its id or date', () => {
    expect(parseInspect('a:1361')).toEqual({ kind: 'a', id: '1361' });
    expect(parseInspect('w:2026-11-23')).toEqual({ kind: 'w', id: '2026-11-23' });
    expect(parseInspect('d:2026-11-27')).toEqual({ kind: 'd', id: '2026-11-27' });
    expect(parseInspect('e:1')).toEqual({ kind: 'e', id: '1' });
    expect(parseInspect('p:42')).toEqual({ kind: 'p', id: '42' });
  });

  it('opens nothing for anything else', () => {
    expect(parseInspect(null)).toBeNull();
    expect(parseInspect('')).toBeNull();
    expect(parseInspect('x:1')).toBeNull();
    expect(parseInspect('a:')).toBeNull();
    expect(parseInspect('a:abc')).toBeNull();
    expect(parseInspect('w:yesterday')).toBeNull();
    expect(parseInspect('d:2026-11')).toBeNull();
    expect(parseInspect('e:1;drop')).toBeNull();
  });
});
