// Google encoded polyline algorithm (as used by Strava summary_polyline).

export function decodePolyline(str: string, precision = 5): [number, number][] {
  const coords: [number, number][] = [];
  const factor = 10 ** precision;
  let index = 0,
    lat = 0,
    lng = 0;
  while (index < str.length) {
    let result = 0,
      shift = 0,
      b: number;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      b = str.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    coords.push([lat / factor, lng / factor]);
  }
  return coords;
}

export function encodePolyline(coords: [number, number][], precision = 5): string {
  const factor = 10 ** precision;
  let out = '';
  let pLat = 0,
    pLng = 0;
  const enc = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) {
      s += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, ln] of coords) {
    const lat = Math.round(la * factor);
    const lng = Math.round(ln * factor);
    out += enc(lat - pLat) + enc(lng - pLng);
    pLat = lat;
    pLng = lng;
  }
  return out;
}

/** Douglas–Peucker-lite: keep every nth point so previews stay small. */
export function simplifyTrack(lat: (number | null)[], lng: (number | null)[], maxPoints = 400): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < lat.length; i++) {
    const a = lat[i];
    const b = lng[i];
    if (a != null && b != null && (a !== 0 || b !== 0)) pts.push([a, b]);
  }
  if (pts.length <= maxPoints) return pts;
  const step = pts.length / maxPoints;
  const out: [number, number][] = [];
  for (let i = 0; i < maxPoints; i++) out.push(pts[Math.floor(i * step)]);
  out.push(pts[pts.length - 1]);
  return out;
}
