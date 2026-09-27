import FitParser from 'fit-file-parser';
import { XMLParser } from 'fast-xml-parser';
import { gunzipSync, unzipSync } from 'fflate';
import { format } from 'date-fns';
import { normalizeStreams, type RawSamples } from '../../shared/analytics/metrics';
import type { Sport } from '../../shared/types';
import { saveActivity, type ActivityInput, type LapInput } from '../ingest';

export interface ImportResult {
  file: string;
  status: 'imported' | 'duplicate' | 'error' | 'skipped';
  id?: number;
  message?: string;
}

function sportFrom(s: string | undefined | null): Sport {
  const v = (s ?? '').toLowerCase();
  if (/cycl|bik|ride|e_bik/.test(v)) return 'ride';
  if (/run/.test(v)) return 'run';
  if (/swim/.test(v)) return 'swim';
  if (/walk/.test(v)) return 'walk';
  if (/hik/.test(v)) return 'hike';
  if (/train|strength|fitness/.test(v)) return 'strength';
  if (/ski/.test(v)) return 'ski';
  if (/row|paddl|kayak/.test(v)) return 'row';
  return 'other';
}

const localDate = (d: Date) => format(d, 'yyyy-MM-dd');

const SPORT_NAME: Record<Sport, string> = { ride: 'Ride', run: 'Run', swim: 'Swim', walk: 'Walk', hike: 'Hike', strength: 'Workout', ski: 'Ski', row: 'Row', other: 'Activity' };
/** Strava-style default name, e.g. "Morning Ride". */
function defaultName(sport: Sport, start: Date, indoor = false): string {
  const h = start.getHours();
  const part = h < 5 ? 'Night' : h < 12 ? 'Morning' : h < 14 ? 'Lunch' : h < 18 ? 'Afternoon' : h < 22 ? 'Evening' : 'Night';
  return `${part} ${indoor && sport === 'ride' ? 'Indoor Ride' : SPORT_NAME[sport]}`;
}

function finish(name: string, sport: Sport, start: Date, raw: RawSamples, laps: LapInput[] | null, extra: Partial<ActivityInput> = {}): ActivityInput {
  const streams = normalizeStreams(raw);
  if (!streams) throw new Error('No samples found');
  return {
    source: 'file',
    externalId: `${start.toISOString()}`,
    name,
    sport,
    startTime: start.toISOString(),
    localDate: localDate(start),
    streams,
    laps,
    ...extra,
  };
}

export async function parseFit(buf: Uint8Array): Promise<ActivityInput> {
  const parser = new FitParser({ force: true, speedUnit: 'm/s', lengthUnit: 'm', temperatureUnit: 'celsius', mode: 'list' });
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  const data: any = await parser.parseAsync(ab);
  const records: any[] = (data.records ?? []).filter((r: any) => r.timestamp);
  if (!records.length) throw new Error('FIT file has no records');
  const session = data.sessions?.[0] ?? {};
  const start = new Date(session.start_time ?? records[0].timestamp);
  const t0 = start.getTime();
  const raw: RawSamples = { time: [], watts: [], heartrate: [], cadence: [], speed: [], distance: [], altitude: [], lat: [], lng: [], temp: [] };
  let lastT = -1;
  for (const r of records) {
    const t = Math.round((new Date(r.timestamp).getTime() - t0) / 1000);
    if (t <= lastT || t < 0) continue;
    lastT = t;
    raw.time.push(t);
    raw.watts!.push(r.power ?? null);
    raw.heartrate!.push(r.heart_rate ?? null);
    raw.cadence!.push(r.cadence ?? null);
    raw.speed!.push(r.enhanced_speed ?? r.speed ?? null);
    raw.distance!.push(r.distance ?? null);
    raw.altitude!.push(r.enhanced_altitude ?? r.altitude ?? null);
    raw.lat!.push(r.position_lat ?? null);
    raw.lng!.push(r.position_long ?? null);
    raw.temp!.push(r.temperature ?? null);
  }
  const laps: LapInput[] = (data.laps ?? []).map((l: any, i: number) => ({
    name: `Lap ${i + 1}`,
    start: Math.max(0, Math.round((new Date(l.start_time).getTime() - t0) / 1000)),
    duration: Math.round(l.total_elapsed_time ?? l.total_timer_time ?? 0),
  }));
  const sport = sportFrom(session.sport ?? data.sports?.[0]?.sport);
  const sub = String(session.sub_sport ?? '');
  const device = data.file_ids?.[0]?.manufacturer ? `${data.file_ids[0].manufacturer} ${data.file_ids[0].product_name ?? data.file_ids[0].product ?? ''}`.trim() : null;
  const indoor = /virtual|indoor|trainer/.test(sub);
  return finish(defaultName(sport, start, indoor), sport, start, raw, laps, { trainer: indoor, device });
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, isArray: (n) => ['Lap', 'Trackpoint', 'trkpt', 'trkseg', 'Activity', 'Track'].includes(n) });

export function parseTcx(text: string): ActivityInput {
  const doc = xml.parse(text);
  const act = doc.TrainingCenterDatabase?.Activities?.Activity?.[0];
  if (!act) throw new Error('No activity in TCX');
  const laps: any[] = act.Lap ?? [];
  const points: any[] = laps.flatMap((l) => (l.Track ?? []).flatMap((t: any) => t.Trackpoint ?? []));
  if (!points.length) throw new Error('TCX has no trackpoints');
  const start = new Date(act.Id ?? points[0].Time);
  const t0 = start.getTime();
  const raw: RawSamples = { time: [], watts: [], heartrate: [], cadence: [], distance: [], altitude: [], lat: [], lng: [], speed: [] };
  let lastT = -1;
  for (const p of points) {
    const t = Math.round((Date.parse(p.Time) - t0) / 1000);
    if (t <= lastT || t < 0) continue;
    lastT = t;
    const ext = p.Extensions?.TPX ?? p.Extensions?.['TPX'] ?? {};
    raw.time.push(t);
    raw.watts!.push(ext.Watts != null ? Number(ext.Watts) : null);
    raw.speed!.push(ext.Speed != null ? Number(ext.Speed) : null);
    raw.heartrate!.push(p.HeartRateBpm?.Value != null ? Number(p.HeartRateBpm.Value) : null);
    raw.cadence!.push(p.Cadence != null ? Number(p.Cadence) : ext.RunCadence != null ? Number(ext.RunCadence) * 2 : null);
    raw.distance!.push(p.DistanceMeters != null ? Number(p.DistanceMeters) : null);
    raw.altitude!.push(p.AltitudeMeters != null ? Number(p.AltitudeMeters) : null);
    raw.lat!.push(p.Position?.LatitudeDegrees != null ? Number(p.Position.LatitudeDegrees) : null);
    raw.lng!.push(p.Position?.LongitudeDegrees != null ? Number(p.Position.LongitudeDegrees) : null);
  }
  if (!raw.speed!.some((v) => v != null)) delete raw.speed;
  const lapInputs: LapInput[] = laps.map((l, i) => ({
    name: `Lap ${i + 1}`,
    start: Math.max(0, Math.round((Date.parse(l['@StartTime']) - t0) / 1000)),
    duration: Math.round(Number(l.TotalTimeSeconds ?? 0)),
  }));
  const sport = sportFrom(act['@Sport']);
  return finish(defaultName(sport, start), sport, start, raw, lapInputs);
}

function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function parseGpx(text: string): ActivityInput {
  const doc = xml.parse(text);
  const trk = doc.gpx?.trk;
  const track = Array.isArray(trk) ? trk[0] : trk;
  const pts: any[] = (track?.trkseg ?? []).flatMap((s: any) => s.trkpt ?? []);
  if (!pts.length) throw new Error('GPX has no track points');
  const start = new Date(pts[0].time);
  const t0 = start.getTime();
  const raw: RawSamples = { time: [], heartrate: [], cadence: [], watts: [], distance: [], altitude: [], lat: [], lng: [], temp: [] };
  let dist = 0;
  let prev: [number, number] | null = null;
  let lastT = -1;
  for (const p of pts) {
    if (!p.time) continue;
    const t = Math.round((Date.parse(p.time) - t0) / 1000);
    if (t <= lastT) continue;
    lastT = t;
    const ll: [number, number] = [Number(p['@lat']), Number(p['@lon'])];
    if (prev) dist += haversine(prev, ll);
    prev = ll;
    const ext = p.extensions?.TrackPointExtension ?? p.extensions ?? {};
    raw.time.push(t);
    raw.lat!.push(ll[0]);
    raw.lng!.push(ll[1]);
    raw.distance!.push(dist);
    raw.altitude!.push(p.ele != null ? Number(p.ele) : null);
    raw.heartrate!.push(ext.hr != null ? Number(ext.hr) : null);
    raw.cadence!.push(ext.cad != null ? Number(ext.cad) : null);
    raw.temp!.push(ext.atemp != null ? Number(ext.atemp) : null);
    raw.watts!.push(p.extensions?.power != null ? Number(p.extensions.power) : null);
  }
  const type = track?.type ?? '';
  const sport = sportFrom(String(type)) === 'other' ? 'ride' : sportFrom(String(type));
  return finish(track?.name ? String(track.name) : defaultName(sport, start), sport, start, raw, null);
}

async function parseOne(name: string, data: Uint8Array): Promise<ActivityInput | null> {
  let n = name.toLowerCase();
  let buf = data;
  if (n.endsWith('.gz')) {
    buf = gunzipSync(buf);
    n = n.slice(0, -3);
  }
  if (n.endsWith('.fit')) return parseFit(buf);
  if (n.endsWith('.tcx')) return parseTcx(new TextDecoder().decode(buf));
  if (n.endsWith('.gpx')) return parseGpx(new TextDecoder().decode(buf));
  return null;
}

/** Import one uploaded file (FIT/TCX/GPX, optionally gzipped, or a ZIP of those). */
export async function importFile(name: string, data: Uint8Array): Promise<ImportResult[]> {
  if (name.toLowerCase().endsWith('.zip')) {
    const entries = unzipSync(data);
    const out: ImportResult[] = [];
    for (const [entry, bytes] of Object.entries(entries)) {
      if (entry.endsWith('/')) continue;
      out.push(...(await importFile(entry.split('/').pop()!, bytes)));
    }
    return out;
  }
  try {
    const input = await parseOne(name, data);
    if (!input) return [{ file: name, status: 'skipped', message: 'Unsupported file type' }];
    const id = saveActivity(input);
    return [id ? { file: name, status: 'imported', id } : { file: name, status: 'duplicate', message: 'Already imported from another source' }];
  } catch (e) {
    return [{ file: name, status: 'error', message: (e as Error).message }];
  }
}
