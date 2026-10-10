/**
 * Best efforts for any duration: every activity's best average power (rides), speed (runs) or
 * heart rate over a window of exactly that length, all of them ranked. Exact for any duration —
 * read from compact 1 Hz copies of the streams, kept in memory and in the database so a
 * restart doesn't have to unpack every activity again.
 */
import { bestWindow, fillGaps, hasData } from '../shared/analytics/series';
import { cleanRunSpeed } from '../shared/analytics/running';
import { db, loadStreams, q, streamEvents, thresholdsFor } from './db';

export type EffortMetric = 'power' | 'pace' | 'hr';

/** Bump when the compact series are built differently. */
const SERIES_VERSION = 1;

db.exec(`CREATE TABLE IF NOT EXISTS effort_series (
  activity_id INTEGER PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  v INTEGER NOT NULL, sport TEXT NOT NULL, power BLOB, speed BLOB, hr BLOB
);`);

interface Series {
  sport: string;
  /** W, whole */
  power: Uint16Array | null;
  /** cm/s — the run speed with GPS glitches taken out, as the run curves use */
  speed: Uint16Array | null;
  /** bpm, gaps filled */
  hr: Uint8Array | null;
}

const mem = new Map<number, Series>();
let loaded = false;

const blob = (a: Uint16Array | Uint8Array | null) => (a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : null);
const u16 = (b: unknown) => {
  if (!b) return null;
  const u = b as Uint8Array;
  // copy into an aligned buffer: SQLite hands back a view at any offset
  const copy = new Uint8Array(u.byteLength);
  copy.set(u);
  return new Uint16Array(copy.buffer);
};
const u8 = (b: unknown) => (b ? new Uint8Array(b as Uint8Array) : null);

function load() {
  if (loaded) return;
  for (const r of q.all('SELECT activity_id, sport, power, speed, hr FROM effort_series WHERE v = ?', SERIES_VERSION)) {
    mem.set(r.activity_id as number, { sport: r.sport as string, power: u16(r.power), speed: u16(r.speed), hr: u8(r.hr) });
  }
  loaded = true;
}

/** Saved streams make the compact copy stale. */
streamEvents.onSaved.push((id) => {
  mem.delete(id);
  q.run('DELETE FROM effort_series WHERE activity_id = ?', id);
});

/** The compact series of an activity, built from its streams once. */
function build(id: number, sport: string): Series {
  const s = loadStreams(id);
  const out: Series = { sport, power: null, speed: null, hr: null };
  if (s) {
    if (s.watts && hasData(s.watts, 30)) out.power = Uint16Array.from(s.watts, (v) => Math.max(0, Math.min(65535, Math.round(v ?? 0))));
    if (sport === 'run' && s.speed && hasData(s.speed, 30)) out.speed = Uint16Array.from(cleanRunSpeed(s.speed), (v) => Math.max(0, Math.min(65535, Math.round(v * 100))));
    if (s.heartrate && hasData(s.heartrate, 30)) {
      const h = fillGaps(s.heartrate);
      if (h) out.hr = Uint8Array.from(h, (v) => Math.max(0, Math.min(255, Math.round(v))));
    }
  }
  q.run(
    'INSERT INTO effort_series(activity_id, v, sport, power, speed, hr) VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(activity_id) DO UPDATE SET v = excluded.v, sport = excluded.sport, power = excluded.power, speed = excluded.speed, hr = excluded.hr',
    id,
    SERIES_VERSION,
    sport,
    blob(out.power),
    blob(out.speed),
    blob(out.hr),
  );
  mem.set(id, out);
  return out;
}

function series(id: number, sport: string): Series {
  load();
  const s = mem.get(id);
  // a sport change (ride → run) changes what's kept
  return s && s.sport === sport ? s : build(id, sport);
}

/** Build the compact series for activities that don't have them yet, yielding as it goes. */
export async function warmEffortSeries(): Promise<number> {
  load();
  const rows = q.all(
    `SELECT a.id, a.sport FROM activities a LEFT JOIN effort_series e ON e.activity_id = a.id AND e.v = ?
     WHERE a.detailed = 1 AND e.activity_id IS NULL AND ((a.sport = 'ride' AND a.has_power = 1) OR a.sport = 'run' OR a.has_hr = 1)`,
    SERIES_VERSION,
  );
  for (let i = 0; i < rows.length; i++) {
    build(rows[i].id as number, rows[i].sport as string);
    if (i % 10 === 9) await new Promise((r) => setImmediate(r));
  }
  return rows.length;
}

export interface EffortRow {
  rank: number;
  id: number;
  date: string;
  name: string;
  sport: string;
  trainer: boolean;
  /** W, m/s or bpm */
  value: number;
  /** seconds from the activity's start */
  start: number;
  /** W/kg, with the weight on record that day (power) */
  wkg: number | null;
  /** mean heart rate during the effort (power and pace) */
  hr: number | null;
}

const FILTER: Record<EffortMetric, string> = {
  power: "sport = 'ride' AND has_power = 1",
  pace: "sport = 'run'",
  hr: 'has_hr = 1',
};

/**
 * Every activity's best effort of exactly `duration` seconds in [from, to], best first — one
 * per activity (a ride's second-best 20 minutes overlaps or follows its best).
 */
export function topEfforts(metric: EffortMetric, duration: number, from: string, to: string) {
  const d = Math.round(duration);
  const acts = q.all(`SELECT id, local_date, name, sport, trainer FROM activities WHERE detailed = 1 AND local_date BETWEEN ? AND ? AND ${FILTER[metric]}`, from, to);
  const weight = new Map<string, number>();
  const rows: Omit<EffortRow, 'rank'>[] = [];
  let considered = 0;
  for (const a of acts) {
    const s = series(a.id as number, a.sport as string);
    const arr = metric === 'power' ? s.power : metric === 'pace' ? s.speed : s.hr;
    if (!arr) continue;
    considered++;
    const w = bestWindow(arr, d);
    if (!w) continue;
    const date = a.local_date as string;
    const value = metric === 'pace' ? w.value / 100 : w.value;
    let hr: number | null = null;
    if (metric !== 'hr' && s.hr && s.hr.length >= w.start + d) {
      let h = 0;
      for (let i = w.start; i < w.start + d; i++) h += s.hr[i];
      hr = h / d;
    }
    let wkg: number | null = null;
    if (metric === 'power') {
      if (!weight.has(date)) weight.set(date, thresholdsFor(date).weight);
      const kg = weight.get(date)!;
      wkg = kg > 0 ? value / kg : null;
    }
    rows.push({ id: a.id as number, date, name: a.name as string, sport: a.sport as string, trainer: !!a.trainer, value, start: w.start, wkg, hr });
  }
  rows.sort((x, y) => y.value - x.value || x.date.localeCompare(y.date));
  const items: EffortRow[] = rows.map((r, i) => ({ ...r, rank: i + 1, value: metric === 'pace' ? Math.round(r.value * 1000) / 1000 : Math.round(r.value * 10) / 10, wkg: r.wkg != null ? Math.round(r.wkg * 100) / 100 : null, hr: r.hr != null ? Math.round(r.hr) : null }));
  return { metric, duration: d, from, to, total: items.length, /** activities with the data but shorter than the duration */ tooShort: considered - items.length, items };
}
