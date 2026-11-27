import { useMemo, type ReactNode } from 'react';
import { decodePolyline } from '../../shared/polyline';

/** Tiny SVG rendering of an encoded polyline (equirectangular projection). */
/** Without a route (indoors, a pool), `fallback` sits in a tile of the same size, so rows still line up. */
export function RouteThumb({ polyline, size = 44, color = 'var(--accent)', className, fallback }: { polyline: string | null; size?: number; color?: string; className?: string; fallback?: ReactNode }) {
  const path = useMemo(() => {
    if (!polyline) return null;
    const pts = decodePolyline(polyline);
    if (pts.length < 2) return null;
    const lat0 = pts[0][0];
    const k = Math.cos((lat0 * Math.PI) / 180);
    const xs = pts.map((p) => p[1] * k);
    const ys = pts.map((p) => -p[0]);
    const minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const pad = 3;
    const s = (size - pad * 2) / span;
    const ox = pad + (size - pad * 2 - (maxX - minX) * s) / 2;
    const oy = pad + (size - pad * 2 - (maxY - minY) * s) / 2;
    return xs.map((x, i) => `${i ? 'L' : 'M'}${(ox + (x - minX) * s).toFixed(1)},${(oy + (ys[i] - minY) * s).toFixed(1)}`).join('');
  }, [polyline, size]);
  if (!path)
    return (
      <div className={`flex shrink-0 items-center justify-center rounded-lg ${fallback ? 'bg-surface-2' : ''} ${className ?? ''}`} style={{ width: size, height: size }}>
        {fallback}
      </div>
    );
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={`shrink-0 ${className ?? ''}`} aria-hidden>
      <path d={path} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
