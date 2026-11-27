import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import L from 'leaflet';
import { useTokens } from '../lib/theme';

export interface RouteMapHandle {
  setHover: (index: number | null) => void;
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const ESRI_ATTRIBUTION = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> — Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * The basemap under every route: a muted grey canvas (with place names on top) that keeps the
 * routes the brightest thing on the map, in the theme's light or dark. Esri's Canvas tiles need
 * no key. To use another provider, set VITE_MAP_TILES_LIGHT / VITE_MAP_TILES_DARK (Leaflet URL
 * templates, e.g. with your own key) and VITE_MAP_ATTRIBUTION at build time.
 */
export function tileLayer(dark: boolean): L.Layer {
  const env = import.meta.env;
  const custom = dark ? env.VITE_MAP_TILES_DARK : env.VITE_MAP_TILES_LIGHT;
  if (custom) return L.tileLayer(custom, { attribution: env.VITE_MAP_ATTRIBUTION ?? '', maxZoom: 19, detectRetina: true });
  const name = dark ? 'Dark' : 'Light';
  // the canvas has data to zoom 16; beyond that its tiles are scaled up
  const opts = { maxZoom: 19, maxNativeZoom: 16 };
  return L.layerGroup([
    L.tileLayer(`${ESRI}/World_${name}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, { ...opts, attribution: ESRI_ATTRIBUTION }),
    L.tileLayer(`${ESRI}/World_${name}_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, { ...opts, zIndex: 2 }),
  ]);
}

/** Route map with a hover marker and a highlighted sub-range, driven imperatively for smooth hover sync. */
export const RouteMap = forwardRef<RouteMapHandle, { lat: (number | null)[]; lng: (number | null)[]; highlight?: [number, number] | null; height?: number | string; color?: string }>(
  function RouteMap({ lat, lng, highlight, height = 360, color }, ref) {
    const t = useTokens();
    const el = useRef<HTMLDivElement>(null);
    const map = useRef<L.Map | null>(null);
    const marker = useRef<L.CircleMarker | null>(null);
    const hl = useRef<L.Polyline | null>(null);
    const tiles = useRef<L.Layer | null>(null);

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
