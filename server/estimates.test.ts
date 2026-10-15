import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, format, subDays } from 'date-fns';

// a throwaway database: estimates.ts reads activities straight from it
const dir = mkdtempSync(join(tmpdir(), 'ta-estimates-'));
process.env.DB_PATH = join(dir, 'test.db');
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

describe('daily threshold estimates', () => {
  let estimates: typeof import('./estimates');
  let series: typeof import('../shared/analytics/series');
  beforeAll(async () => {
    const { q } = await import('./db');
    series = await import('../shared/analytics/series');
    estimates = await import('./estimates');
    // ten weeks of rides on a CP 280 W / W′ 20 kJ curve, held to 30 minutes, then easier
    const curve = (cp: number, long: number) => series.CURVE_DURATIONS.map((t) => (t <= 1800 ? cp + 20000 / t : t <= 3600 ? long : null));
    const add = (date: string, power: (number | null)[]) =>
      q.run("INSERT INTO activities(source, external_id, name, sport, start_time, local_date, has_power, detailed, curves) VALUES('file', ?, 'Ride', 'ride', ?, ?, 1, 1, ?)", date + Math.random(), `${date}T08:00:00.000Z`, date, JSON.stringify({ power }));
    for (let i = 70; i >= 8; i -= 3) add(iso(subDays(new Date(), i)), curve(280, 260));
    // a week ago: 40 minutes at 300 W, a new best
    add(iso(subDays(new Date(), 7)), series.CURVE_DURATIONS.map((t) => (t <= 1800 ? 280 + 20000 / t : t <= 2400 ? 300 : t <= 3600 ? 270 : null)));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('moves FTP on the day of the ride that sets a new best, and holds it after', () => {
    const s = estimates.computeSeries('ride');
    const pb = iso(subDays(new Date(), 7));
    const before = s.find((e) => e.date === iso(subDays(new Date(), 8)))!;
    const on = s.find((e) => e.date === pb)!;
    const after = s.find((e) => e.date === iso(subDays(new Date(), 3)))!;
    expect(on.threshold).toBeGreaterThan(before.threshold + 5);
    expect(on.effort?.date).toBe(pb);
    expect(after.threshold).toBeCloseTo(on.threshold, 6);
    // one estimate per day, through today
    expect(s[s.length - 1].date).toBe(iso(new Date()));
    expect(new Set(s.map((e) => e.date)).size).toBe(s.length);
  });

  it('gives each day the estimate a from-scratch fit of its own 6 months gives', () => {
    const s = estimates.computeSeries('ride');
    for (const e of s) {
      const f = estimates.estimateOn('ride', e.date)!;
      expect(f.raw).toBeCloseTo(e.raw, 9);
      expect(f.activities).toBe(e.activities);
    }
  });

  it('includes the day itself in the window', () => {
    const w = estimates.windowOf('2026-10-15');
    expect(w.windowTo).toBe('2026-10-15');
    expect(w.windowFrom).toBe(iso(addDays(subDays(new Date('2026-10-15T12:00:00'), 182), 1)));
  });
});
