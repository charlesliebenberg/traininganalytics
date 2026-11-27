import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'ta-weight-'));
process.env.DB_PATH = join(dir, 'test.db');
let db: typeof import('./db');

beforeAll(async () => {
  db = await import('./db');
  db.setPreferences({ autoThresholds: { ride: false, run: false, swim: false, hr: false } });
});
afterAll(() => {
  db.db.close();
  rmSync(dir, { recursive: true, force: true });
});

const weighIns = (list: unknown) => {
  db.q.run("INSERT INTO trainerroad_data(key, data) VALUES('weight', ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data", JSON.stringify(list));
  db.invalidateWeighIns();
};

describe('the weight W/kg uses', () => {
  it('is the newest of an entry here and a weigh-in in TrainerRoad, on each day', () => {
    db.upsertThresholds({ ...db.DEFAULT_THRESHOLDS, date: '2016-09-15', weight: 68 });
    weighIns([
      { value: 75, units: 0, date: '2026-03-01' },
      { value: 165, units: 1, date: '2026-09-01T00:00:00' },
    ]);
    // before any weigh-in: the entry here
    expect(db.thresholdsFor('2019-06-01')).toMatchObject({ weight: 68, weightDate: '2016-09-15', sources: { weight: 'manual' } });
    // a newer weigh-in wins from its day on; pounds become kilograms
    expect(db.thresholdsFor('2026-05-01')).toMatchObject({ weight: 75, weightDate: '2026-03-01', sources: { weight: 'trainerroad' } });
    expect(db.thresholdsFor('2026-10-01')).toMatchObject({ weight: 74.8, weightDate: '2026-09-01', sources: { weight: 'trainerroad' } });
    // an entry here newer than the weigh-in wins again
    db.upsertThresholds({ ...db.DEFAULT_THRESHOLDS, date: '2026-10-15', weight: 73 });
    expect(db.thresholdsFor('2026-11-01')).toMatchObject({ weight: 73, weightDate: '2026-10-15', sources: { weight: 'manual' } });
  });

  it('ignores weigh-ins it cannot read', () => {
    weighIns([{ value: 0, date: '2026-03-01' }, { value: 75 }, { value: 900, units: 0, date: '2026-04-01' }, 'x']);
    expect(db.thresholdsFor('2026-05-01').sources?.weight).toBe('manual');
  });
});
