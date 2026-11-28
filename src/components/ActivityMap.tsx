import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { Maximize2 } from 'lucide-react';
import { decodePolyline } from '../../shared/polyline';
import { qs, useApi } from '../lib/api';
import { useTokens } from '../lib/theme';
import { useInspect } from '../lib/inspect';
import { fmtDate } from '../lib/format';
import { Button, Segmented } from './ui';
import { tileLayer } from './RouteMap';

interface Row {
  id: number;
  sport: string;
  name: string;
  local_date: string;
  polyline: string;
}

/**
 * Everything you've done in the range, as routes on one map: where you ride most, lit by how
 * often. A route opens its activity beside the map.
 */
export function ActivityMap({ from, to, sport }: { from: string; to: string; sport: string }) {
  const t = useTokens();
  const inspect = useInspect();
  // the routes are drawn once per data; their clicks always use today's location
  const open = useRef(inspect.open);
  open.current = inspect.open;
  const [style, setStyle] = useState<'heat' | 'sport'>('heat');
  const { data } = useApi<Row[]>(`/heatmap${qs({ from, to, sport })}`);
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const tiles = useRef<L.Layer | null>(null);
  const allBounds = useRef<L.LatLngBounds | null>(null);
  const [elsewhere, setElsewhere] = useState(0);

  useEffect(() => {
    if (!el.current) return;
    const m = L.map(el.current, { preferCanvas: true, zoomControl: true });
    m.setView([45, 5], 4);
    map.current = m;
    tiles.current = tileLayer(t.dark).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    const ro = new ResizeObserver(() => m.invalidateSize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!map.current || !tiles.current) return;
    tiles.current.remove();
    tiles.current = tileLayer(t.dark).addTo(map.current);
  }, [t.dark]);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g || !data) return;
    g.clearLayers();
    const renderer = L.canvas({ padding: 0.5 });
    const heatColor = t.series[1];
    const tracks = data.map((r) => ({ r, pts: decodePolyline(r.polyline) })).filter((x) => x.pts.length >= 2);
    // open on where you ride most — the ~100 km square with the most route starts, and its
    // neighbours — rather than zooming out to fit every trip abroad
    const cell = (p: [number, number]) => [Math.floor(p[0]), Math.floor(p[1])];
    const counts = new Map<string, number>();
    for (const { pts } of tracks) {
      const k = cell(pts[0]).join(',');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const home = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0].split(',').map(Number);
    let bounds: L.LatLngBounds | null = null;
    let all: L.LatLngBounds | null = null;
    let away = 0;
    for (const { r, pts } of tracks) {
      const line = L.polyline(pts, {
        renderer,
        color: style === 'heat' ? heatColor : t.sport[r.sport] ?? t.accent,
        weight: 2.5,
        opacity: style === 'heat' ? 0.22 : 0.6,
      });
      line.bindTooltip(`${r.name} · ${fmtDate(r.local_date, 'd MMM yyyy')}`, { sticky: true });
      line.on('click', () => open.current('a', r.id));
      line.addTo(g);
      all = all ? all.extend(line.getBounds()) : L.latLngBounds(line.getBounds().getSouthWest(), line.getBounds().getNorthEast());
      const [a, b] = cell(pts[0]);
      if (home && Math.abs(a - home[0]) <= 1 && Math.abs(b - home[1]) <= 1) bounds = bounds ? bounds.extend(line.getBounds()) : L.latLngBounds(line.getBounds().getSouthWest(), line.getBounds().getNorthEast());
      else away++;
    }
    allBounds.current = all;
    setElsewhere(away);
    if (bounds) m.fitBounds(bounds, { padding: [30, 30] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, style, t]);

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2.5">
        <span className="min-w-0 flex-1 text-[12.5px] text-muted">
          {data ? `${data.length.toLocaleString()} routes${elsewhere ? ` · showing where you ride most, ${elsewhere} elsewhere` : ''} · virtual rides left out` : 'Loading routes…'}
        </span>
        {elsewhere > 0 && (
          <Button size="sm" variant="ghost" icon={<Maximize2 className="h-3.5 w-3.5" />} onClick={() => allBounds.current && map.current?.fitBounds(allBounds.current, { padding: [30, 30] })}>
            Show all
          </Button>
        )}
        <Segmented size="sm" value={style} onChange={setStyle} options={[{ value: 'heat', label: 'Heat' }, { value: 'sport', label: 'By sport' }]} />
      </div>
      <div ref={el} style={{ height: 'calc(100dvh - 300px)', minHeight: 440 }} />
    </div>
  );
}
