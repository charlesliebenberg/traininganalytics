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
    // two days ago: 2 × 10 min at 330 and 336 W with 4 minutes at 150 W between — no new best
    // at any one duration, but more than the model could repeat
    const { saveStreams } = await import('./db');
    const reps = [
      { start: 600, end: 1200, out: 330 },
      { start: 1440, end: 2040, out: 336 },
    ];
    const watts = Array.from({ length: 2640 }, (_, i) => (i >= 600 && i < 1200 ? 330 : i >= 1440 && i < 2040 ? 336 : 150));
    const d2 = iso(subDays(new Date(), 2));
    const r = q.run(
      "INSERT INTO activities(source, external_id, name, sport, start_time, local_date, has_power, detailed, curves, session) VALUES('file', ?, '2 × 10', 'ride', ?, ?, 1, 1, ?, ?)",
      `reps-${d2}`,
      `${d2}T08:00:00.000Z`,
      d2,
      JSON.stringify({ power: series.CURVE_DURATIONS.map((t) => (t <= 600 ? 336 : t <= 1200 ? 300 : null)) }),
      JSON.stringify({ type: 'threshold', main: { kind: 'reps', reps, out: 333, rest: 240 } }),
    );
    saveStreams(Number(r.lastInsertRowid), { time: watts.map((_, i) => i), watts });
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

  it('raises CP on the day of an interval set the model could not repeat', () => {
    const s = estimates.computeSeries('ride');
    const before = s.find((e) => e.date === iso(subDays(new Date(), 3)))!;
    const on = s.find((e) => e.date === iso(subDays(new Date(), 2)))!;
    expect(on.cpRaised?.by).toBe('reps');
    expect(on.cp).toBeGreaterThan(before.cp + 1);
    expect(on.threshold).toBeGreaterThanOrEqual(before.threshold);
  });

  it('gives each day the estimate a from-scratch fit of its own 6 months gives', () => {
    const s = estimates.computeSeries('ride');
    for (const e of s) {
      const f = estimates.estimateOn('ride', e.date)!;
      expect(f.raw).toBeCloseTo(e.raw, 9);
      expect(f.activities).toBe(e.activities);
      if (e.threshold <= e.raw + 1e-9) expect(f.cp).toBeCloseTo(e.cp, 9);
    }
  });

  it('includes the day itself in the window', () => {
    const w = estimates.windowOf('2026-10-15');
    expect(w.windowTo).toBe('2026-10-15');
    expect(w.windowFrom).toBe(iso(addDays(subDays(new Date('2026-10-15T12:00:00'), 182), 1)));
  });
});
