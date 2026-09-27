import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import { useTokens } from '../lib/theme';

export interface RouteMapHandle {
  setHover: (index: number | null) => void;
}

export function tileLayer(dark: boolean) {
  return L.tileLayer(`https://{s}.basemaps.cartocdn.com/${dark ? 'dark_all' : 'light_all'}/{z}/{x}/{y}{r}.png`, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  });
}

/** Route map with a hover marker and a highlighted sub-range, driven imperatively for smooth hover sync. */
export const RouteMap = forwardRef<RouteMapHandle, { lat: (number | null)[]; lng: (number | null)[]; highlight?: [number, number] | null; height?: number | string; color?: string }>(
  function RouteMap({ lat, lng, highlight, height = 360, color }, ref) {
    const t = useTokens();
    const el = useRef<HTMLDivElement>(null);
    const map = useRef<L.Map | null>(null);
    const marker = useRef<L.CircleMarker | null>(null);
    const hl = useRef<L.Polyline | null>(null);
    const tiles = useRef<L.TileLayer | null>(null);

    const pointAt = (i: number): L.LatLngExpression | null => {
      for (let k = i; k >= 0 && k > i - 30; k--) if (lat[k] != null && lng[k] != null) return [lat[k]!, lng[k]!];
      return null;
    };

    useEffect(() => {
      if (!el.current) return;
      const m = L.map(el.current, { zoomControl: true, attributionControl: true, scrollWheelZoom: false });
      map.current = m;
      tiles.current = tileLayer(t.dark).addTo(m);
      const pts: L.LatLngExpression[] = [];
      for (let i = 0; i < lat.length; i += 2) if (lat[i] != null && lng[i] != null) pts.push([lat[i]!, lng[i]!]);
      if (pts.length) {
        L.polyline(pts, { color: t.surface, weight: 6, opacity: 0.9 }).addTo(m);
        const line = L.polyline(pts, { color: color ?? t.accent, weight: 3.5, opacity: 1 }).addTo(m);
        m.fitBounds(line.getBounds(), { padding: [20, 20] });
        L.circleMarker(pts[0], { radius: 5, color: t.surface, weight: 2, fillColor: t.good, fillOpacity: 1 }).addTo(m);
        L.circleMarker(pts[pts.length - 1], { radius: 5, color: t.surface, weight: 2, fillColor: t.critical, fillOpacity: 1 }).addTo(m);
      }
      marker.current = L.circleMarker([0, 0], { radius: 6, color: t.surface, weight: 2, fillColor: t.ink, fillOpacity: 1, opacity: 0 }).addTo(m);
      const ro = new ResizeObserver(() => m.invalidateSize());
      ro.observe(el.current);
      return () => {
        ro.disconnect();
        m.remove();
        map.current = null;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [lat, lng]);

    useEffect(() => {
      const m = map.current;
      if (!m || !tiles.current) return;
      tiles.current.remove();
      tiles.current = tileLayer(t.dark).addTo(m);
      tiles.current.bringToBack();
    }, [t.dark]);

    useEffect(() => {
      const m = map.current;
      if (!m) return;
      hl.current?.remove();
      hl.current = null;
      if (!highlight) return;
      const pts: L.LatLngExpression[] = [];
      for (let i = highlight[0]; i < highlight[1]; i++) if (lat[i] != null && lng[i] != null) pts.push([lat[i]!, lng[i]!]);
      if (pts.length > 1) {
        hl.current = L.polyline(pts, { color: t.serious, weight: 5, opacity: 1 }).addTo(m);
        m.fitBounds(hl.current.getBounds(), { padding: [30, 30], maxZoom: 15 });
      }
    }, [highlight, lat, lng, t.serious]);

    useImperativeHandle(ref, () => ({
      setHover(i) {
        const mk = marker.current;
        if (!mk) return;
        const p = i == null ? null : pointAt(i);
        if (!p) mk.setStyle({ opacity: 0, fillOpacity: 0 });
        else {
          mk.setLatLng(p);
          mk.setStyle({ opacity: 1, fillOpacity: 1 });
        }
      },
    }));

    return <div ref={el} style={{ height, width: '100%' }} className="overflow-hidden rounded-xl" />;
  },
);
