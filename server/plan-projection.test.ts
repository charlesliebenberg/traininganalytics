import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, format, parseISO, startOfWeek } from 'date-fns';

const dir = mkdtempSync(join(tmpdir(), 'ta-projection-'));
process.env.DB_PATH = join(dir, 'test.db');
let db: typeof import('./db');
let aggregate: typeof import('./aggregate');

beforeAll(async () => {
  db = await import('./db');
  aggregate = await import('./aggregate');
});
afterAll(() => {
  db.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

describe('a season plan in the projections', () => {
  it('rides a plan kept with its days on each free day, and a plain one only in empty weeks', () => {
    const t = aggregate.today();
    // the week after next, and the one after: both entirely in the future
    const w1 = iso(addDays(startOfWeek(parseISO(t), { weekStartsOn: 1 }), 14));
    const w2 = iso(addDays(parseISO(w1), 7));
    const day = (w: string, i: number) => iso(addDays(parseISO(w), i));
    // a workout on the first week's Wednesday: it stays in charge of its day
    db.q.run("INSERT INTO planned_workouts(date, sport, title, planned_tss, source) VALUES(?, 'ride', 'Planned', 80, 'manual')", day(w1, 2));

    const keep = (weeks: unknown[]) => {
      db.q.run('DELETE FROM season_plans');
      db.q.run("INSERT INTO season_plans(name, config, weeks) VALUES('p', '{}', ?)", JSON.stringify(weeks));
    };
    keep([
      { weekStart: w1, tss: 700, days: [100, 0, 150, 120, null, 200, 130] },
      { weekStart: w2, tss: 350, days: [50, 50, 50, 50, 50, 50, 50] },
    ]);
    let p = aggregate.planProjection(day(w2, 6));
    expect(p.get(day(w1, 0))).toBe(100);
    expect(p.has(day(w1, 2))).toBe(false); // the planned workout's day
    expect(p.has(day(w1, 4))).toBe(false); // a day the plan left out
    expect(p.get(day(w1, 5))).toBe(200);
    expect(p.get(day(w2, 3))).toBe(50);

    // a plan of weekly totals only: spread evenly, and nothing in a week with a workout in it
    keep([
      { weekStart: w1, tss: 700 },
      { weekStart: w2, tss: 350 },
    ]);
    p = aggregate.planProjection(day(w2, 6));
    expect(p.has(day(w1, 0))).toBe(false);
    expect(p.get(day(w2, 0))).toBeCloseTo(50, 9);
  });
});
