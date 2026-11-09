import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, format, subDays } from 'date-fns';

// a throwaway database before the server modules load
const dir = mkdtempSync(join(tmpdir(), 'ta-forecast-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.TZ = 'Australia/Sydney';
const iso = (d: Date) => format(d, 'yyyy-MM-dd');

describe('the capacity model’s forecast for a date', () => {
  let comeback: typeof import('./comeback');

  beforeAll(async () => {
    const { q } = await import('./db');
    const { CURVE_DURATIONS } = await import('../shared/analytics/series');
    comeback = await import('./comeback');
    // a year and a half of daily riding, in 60-day blocks of 50 and 110 TSS a day, with
    // 20-minute power following the long-term load
    const p20 = CURVE_DURATIONS.indexOf(1200);
    let ltl = 70;
    for (let n = 540; n >= 0; n--) {
      const d = iso(subDays(new Date(), n));
      const load = Math.floor(n / 60) % 2 ? 50 : 110;
      ltl += (load - ltl) / 90;
      const power = new Array(CURVE_DURATIONS.length).fill(null);
      power[p20] = Math.round(200 + 0.8 * ltl);
      q.run(
        "INSERT INTO activities(source, external_id, name, sport, start_time, local_date, detailed, tss, moving_time, curves) VALUES('file', ?, 'Ride', 'ride', ?, ?, 1, ?, 5400, ?)",
        d,
        `${d}T08:00:00.000Z`,
        d,
        load,
        JSON.stringify({ power }),
      );
    }
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('expects more by a date from riding more until then, and less from resting', () => {
    const to = iso(addDays(new Date(), 42));
    const hard = comeback.capacityChange(to, () => 150)!;
    const rest = comeback.capacityChange(to, () => 0)!;
    expect(hard.ratio).toBeGreaterThan(1.01);
    expect(rest.ratio).toBeLessThan(0.99);
    // the best model's answer sits within the plausible ones'
    for (const c of [hard, rest]) {
      expect(c.range[0]).toBeLessThanOrEqual(c.ratio + 1e-9);
      expect(c.range[1]).toBeGreaterThanOrEqual(c.ratio - 1e-9);
    }
    // only the load planned before the date counts
    const late = comeback.capacityChange(to, (d) => (d > to ? 500 : 0))!;
    expect(late.ratio).toBeCloseTo(rest.ratio, 10);
    // nothing to forecast for today or a day gone
    expect(comeback.capacityChange(iso(new Date()), () => 100)).toBeNull();
  });
});
